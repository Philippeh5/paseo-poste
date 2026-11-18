// Gestion de la liste des services suivis (page « Services ») : ajout, retrait, rangement par groupe, et croisement
// des ports en écoute avec cette liste pour proposer les serveurs « détectés » non suivis. Fonctions pures (aucune
// écriture ici) : le handler (handlers/services.mjs) persiste le résultat via le store, après sauvegarde horodatée.
// Les entrées existantes ne sont jamais réécrites champ par champ : on copie l'objet tel quel pour préserver les
// champs inconnus (warn, unit, match, modes… édités à la main).
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export const GROUP_MAX = 40;
export const NAME_MAX = 60;
export const CMD_MAX = 500;
const DEFAULT_GROUP = "Divers";

const cleanText = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const cleanGroup = (v) => cleanText(v, GROUP_MAX) || DEFAULT_GROUP;

export function slugId(name, taken) {
  const base = cleanText(name, NAME_MAX).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "service";
  let id = base.slice(0, 40); let n = 2;
  while (taken.has(id)) id = `${base.slice(0, 36)}-${n++}`;
  return id;
}

// Ports déjà portés par un service suivi : champ `port` ou port d'une variante de lancement.
export function trackedPorts(services) {
  const set = new Set();
  for (const s of services) {
    if (Number.isInteger(s.port)) set.add(s.port);
    for (const m of s.modes || []) if (Number.isInteger(m.port)) set.add(m.port);
  }
  return set;
}

export function addService(services, spec) {
  const name = cleanText(spec.name, NAME_MAX);
  if (!name) throw new Error("un nom est requis");
  const port = spec.port === undefined || spec.port === null || spec.port === "" ? null : Number(spec.port);
  if (port !== null && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new Error("port entre 1024 et 65535");
  const cmd = cleanText(spec.cmd, CMD_MAX);
  if (!port && !cmd) throw new Error("indiquez un port ou une commande");
  const cwd = spec.cwd ? String(spec.cwd).slice(0, 300) : null;
  if (cwd && !cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd)) throw new Error("le dossier doit être un chemin absolu");
  if (cmd && !cwd) throw new Error("une commande demande un dossier de travail");
  const id = slugId(spec.id || name, new Set(services.map((s) => s.id)));
  const entry = { id, group: cleanGroup(spec.group), name, ...(cwd ? { cwd } : {}), ...(port ? { port } : {}), ...(cmd ? { modes: [{ id: "run", label: "Lancer", cmd }] } : {}), added: "manual" };
  return { services: [...services, entry], entry };
}

export function removeService(services, id) {
  const i = services.findIndex((s) => s.id === id);
  if (i === -1) throw new Error("service inconnu");
  return { services: services.filter((_, j) => j !== i), removed: services[i] };
}

export function setGroup(services, id, group) {
  const i = services.findIndex((s) => s.id === id);
  if (i === -1) throw new Error("service inconnu");
  const next = services.slice();
  next[i] = { ...services[i], group: cleanGroup(group) };
  return { services: next, entry: next[i] };
}

// Groupe proposé pour un dossier : le projet suivi dont le chemin est un préfixe du dossier, sinon le dossier de premier
// niveau sous le répertoire des projets, sinon « Divers ».
export function suggestGroup(cwd, projects = [], projectsRoot = null) {
  if (!cwd) return DEFAULT_GROUP;
  let best = null;
  for (const p of projects) {
    const dir = String(p.dir || "").replace(/[\\/]+$/, "");
    if (dir && (cwd === dir || cwd.startsWith(`${dir}/`)) && (!best || dir.length > best.dir.length)) best = { dir, name: p.name || basename(dir) };
  }
  if (best) return cleanGroup(best.name);
  if (projectsRoot && cwd.startsWith(`${projectsRoot}/`)) return cleanGroup(cwd.slice(projectsRoot.length + 1).split("/")[0]);
  return DEFAULT_GROUP;
}

// ports : sortie de listPorts() ; snapPorts : Map port -> pid ; coveredPids : pids déjà attribués à un service suivi
// (lui-même ou ses descendants) ; ignored : ports masqués par l'utilisateur ; info(pid) -> { cwd, cmd }.
// Ports que le poste ouvre lui-même pour ses outils (terminaux Paseo, agents, Chrome distant…) : jamais proposés.
const TOOL_PROCESSES = /^(paseo|claude|codex|opencode|agent-browser|chrome|chromium|tailscaled?|cloudflared)/i;
// Plage des ports éphémères Linux : ports d'outils de passage, masqués par défaut dans la vue (`temp`).
export const EPHEMERAL_FROM = 32768;

export function detect({ ports, services, snapPorts, coveredPids = new Set(), ignored = [], info = () => ({}), projects = [], projectsRoot = null }) {
  const tracked = trackedPorts(services);
  const hidden = new Set(ignored.map(Number));
  const out = [];
  for (const p of ports) {
    if (tracked.has(p.port) || hidden.has(p.port)) continue;
    const pid = snapPorts.get(p.port) ?? null;
    if (pid && coveredPids.has(pid)) continue;
    if (p.process && TOOL_PROCESSES.test(p.process)) continue;
    const { cwd = null, cmd = null } = pid ? info(pid) : {};
    out.push({ port: p.port, temp: p.port >= EPHEMERAL_FROM, process: p.process || null, pid, cwd, cmd, loopbackOnly: !!p.loopbackOnly, addr: p.addr, suggestedGroup: suggestGroup(cwd, projects, projectsRoot) });
  }
  return out;
}

// Sauvegarde horodatée du fichier avant écriture ; on garde les `keep` dernières.
export function backupFile(file, keep = 10, now = new Date()) {
  if (!existsSync(file)) return null;
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dest = `${file}.bak-${stamp}`;
  copyFileSync(file, dest);
  const dir = join(file, "..");
  const mine = readdirSync(dir).filter((f) => f.startsWith(`${basename(file)}.bak-`)).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - keep))) rmSync(join(dir, f), { force: true });
  return dest;
}
