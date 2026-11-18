// Page « Connexions » : catalogue des outils, fournisseurs et services que le poste peut brancher, détection de ce qui est
// déjà installé / connecté sur CETTE machine, installation par commande fixe (liste blanche), clés d'API stockées en 600,
// et dossier de skills partagé entre agents. Aucun secret n'est jamais renvoyé au navigateur (seulement « configuré : oui/non »).
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, symlinkSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { redact } from "./redact.mjs";

const HOME = homedir();
export const SHARED_SKILLS_DIR = process.env.PASEO_SHARED_SKILLS || join(HOME, ".paseo-skills");
// Où chaque agent lit ses skills : le dossier partagé y est relié par liens symboliques (jamais de copie, jamais d'écrasement).
export const SKILL_TARGETS = [
  { id: "claude", label: "Claude Code", dir: join(HOME, ".claude", "skills") },
  { id: "pi", label: "Pi", dir: join(HOME, ".pi", "agent", "skills") },
  { id: "codex", label: "Codex", dir: join(HOME, ".codex", "skills") },
  { id: "agents", label: "Agents (agy, opencode…)", dir: join(HOME, ".agents", "skills") },
];

// Groupes affichés dans la page.
export const GROUPS = [
  { id: "reseau", label: "Machines et réseau" },
  { id: "agents", label: "Agents de code" },
  { id: "fournisseurs", label: "Fournisseurs de modèles (LLM)" },
  { id: "apps", label: "Applications et messagerie" },
];

// kind : "bin" (programme sur le PATH), "key" (clé d'API dans l'environnement), "dir" (dossier de config).
// check  : commande courte (argv) dont le code 0 prouve que le compte est CONNECTÉ (sinon « installé » seulement).
// install: argv fixe exécutable depuis la page (confirm:true) ; sinon `hint` = commande à copier dans un terminal.
// authFile: fichiers dont la SEULE PRÉSENCE (statSync, jamais le contenu) prouve la connexion quand `check` est null.
// login  : commande interactive (ouvre un navigateur ou demande un code), saisie dans un terminal du Bureau par
//          connections.login ; seule la commande du catalogue est utilisée, jamais un texte venant du navigateur.
// envVar : variable d'environnement stockée dans connections.env pour les clés d'API.
export const CATALOG = [
  { id: "tailscale", group: "reseau", label: "Tailscale", desc: "Réseau privé entre vos machines (accès à distance sans ouvrir de port).",
    bin: "tailscale", check: ["tailscale", "status"], install: null,
    hint: "curl -fsSL https://tailscale.com/install.sh | sh", login: "sudo tailscale up" },
  { id: "cloudflared", group: "reseau", label: "Cloudflare Tunnel", desc: "Publier un service local sur un nom de domaine, sans port ouvert.",
    bin: "cloudflared", check: null, authFile: ["~/.cloudflared/cert.pem"], install: null, hint: "Télécharger cloudflared depuis github.com/cloudflare/cloudflared/releases", login: "cloudflared tunnel login" },
  { id: "claude", group: "agents", label: "Claude Code", desc: "Agent de code d'Anthropic (abonnement Claude).",
    bin: "claude", check: null, authFile: ["~/.claude/.credentials.json"], install: ["npm", "install", "-g", "@anthropic-ai/claude-code"], login: "claude   # puis /login" },
  { id: "codex", group: "agents", label: "Codex", desc: "Agent de code d'OpenAI (abonnement ChatGPT).",
    bin: "codex", check: ["codex", "login", "status"], install: ["npm", "install", "-g", "@openai/codex"], login: "codex login" },
  { id: "agy", group: "agents", label: "Antigravity (agy / Gemini)", desc: "Agent Gemini de Google : sièges gemini flash pour le travail courant.",
    bin: "agy", check: null, authFile: ["~/.gemini/antigravity-cli/antigravity-oauth-token"], install: null, hint: "Installer Antigravity depuis antigravity.google puis lancer `agy`", login: "agy" },
  { id: "opencode", group: "agents", label: "OpenCode", desc: "Agent de code libre, compatible avec de nombreux fournisseurs.",
    bin: "opencode", check: null, authFile: ["~/.local/share/opencode/auth.json"], install: ["npm", "install", "-g", "opencode-ai"], login: "opencode auth login" },
  { id: "pi", group: "agents", label: "Pi", desc: "Agent minimaliste, bon pour les modèles NVIDIA / OpenRouter.",
    bin: "pi", check: null, authFile: ["~/.pi/agent/auth.json"], install: ["npm", "install", "-g", "@mariozechner/pi-coding-agent"], login: "pi   # puis /login" },
  { id: "freebuff", group: "agents", label: "FreeBuff", desc: "Agent de code gratuit (terminal, financé par la publicité).",
    bin: "freebuff", check: null, authFile: ["~/.config/manicode/credentials.json"], install: ["npm", "install", "-g", "freebuff"], login: "freebuff" },
  { id: "hermes", group: "agents", label: "Hermes", desc: "Agent assistant personnel (messagerie, outils MCP).",
    bin: "hermes", check: null, authFile: ["~/.hermes/auth.json"], install: null, hint: "Voir la documentation Hermes de votre installation", login: "hermes setup" },
  { id: "gemini", group: "agents", label: "Gemini CLI", desc: "Agent en ligne de commande de Google.",
    bin: "gemini", check: null, authFile: ["~/.gemini/oauth_creds.json"], install: ["npm", "install", "-g", "@google/gemini-cli"], login: "gemini" },
  { id: "openrouter", group: "fournisseurs", label: "OpenRouter", desc: "Un seul compte pour des centaines de modèles (dont des gratuits `:free`).",
    kind: "key", envVar: "OPENROUTER_API_KEY", dir: join(HOME, ".claude-openrouter"), keyUrl: "https://openrouter.ai/keys" },
  { id: "nvidia", group: "fournisseurs", label: "NVIDIA (build.nvidia.com)", desc: "Modèles NVIDIA gratuits via API (alias sans `:free`).",
    kind: "key", envVar: "NVIDIA_API_KEY", dir: join(HOME, ".claude-nvidia"), keyUrl: "https://build.nvidia.com/settings/api-keys" },
  { id: "anthropic", group: "fournisseurs", label: "API Anthropic", desc: "Clé d'API Claude (facturation à l'usage), pour les sièges « api ».",
    kind: "key", envVar: "ANTHROPIC_API_KEY", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "gemini-key", group: "fournisseurs", label: "API Google Gemini", desc: "Clé d'API Gemini (AI Studio).",
    kind: "key", envVar: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "github", group: "apps", label: "GitHub", desc: "Dépôts, publication de la vitrine publique, intégration continue.",
    bin: "gh", check: ["gh", "auth", "status"], install: null, hint: "sudo apt install gh", login: "gh auth login" },
  { id: "composio", group: "apps", label: "Composio", desc: "Plus de 1000 applications (Gmail, Slack, agenda…) avec permissions par agent.",
    bin: "composio", check: ["composio", "whoami"], install: null, hint: "Voir docs.composio.dev (CLI Composio)", login: "composio login" },
  { id: "telegram", group: "apps", label: "Telegram", desc: "Bot de notification et de commande du poste.",
    kind: "key", envVar: "TELEGRAM_BOT_TOKEN", keyUrl: "https://t.me/BotFather" },
];

const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));
export const getEntry = (id) => BY_ID.get(String(id));

// ---------- Fichier d'environnement (clés d'API) : 600, jamais relu vers le navigateur ----------
export function envFile(dataDir) { return join(dataDir, "connections.env"); }
export function readEnv(dataDir) {
  const out = {};
  try {
    for (const line of readFileSync(envFile(dataDir), "utf8").split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* fichier absent */ }
  return out;
}
export function writeEnvKey(dataDir, name, value) {
  if (!/^[A-Z][A-Z0-9_]{1,60}$/.test(name)) throw new Error("Nom de variable invalide.");
  const v = String(value ?? "").trim();
  if (!v || v.length > 500 || /[\r\n\0]/.test(v)) throw new Error("Clé vide, trop longue ou contenant un retour à la ligne.");
  mkdirSync(dataDir, { recursive: true });
  const env = readEnv(dataDir);
  env[name] = v;
  const file = envFile(dataDir);
  writeFileSync(file, Object.entries(env).map(([k, val]) => `${k}=${val}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}
export function removeEnvKey(dataDir, name) {
  const env = readEnv(dataDir);
  if (!(name in env)) return false;
  delete env[name];
  const file = envFile(dataDir);
  writeFileSync(file, Object.entries(env).map(([k, val]) => `${k}=${val}`).join("\n") + (Object.keys(env).length ? "\n" : ""), { mode: 0o600 });
  chmodSync(file, 0o600);
  return true;
}

// ---------- Détection ----------
export function findBin(name, pathVar = process.env.PATH || "") {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* suivant */ }
  }
  // Emplacements usuels hors PATH d'un service systemd
  for (const dir of [join(HOME, ".local", "bin"), join(HOME, ".local", "node", "bin"), "/usr/local/bin", "/usr/bin"]) {
    const p = join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* suivant */ }
  }
  return null;
}

function runQuick(argv, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const bin = findBin(argv[0]) || argv[0];
    execFile(bin, argv.slice(1), { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, env: { ...process.env, CI: "1", NO_COLOR: "1" } },
      (error) => resolve(!error));
  });
}

// Présence d'un fichier d'identifiants : existence seulement, le contenu n'est jamais lu.
export function hasAuthFile(entry, home = HOME) {
  return (entry.authFile || []).some((f) => {
    try { return statSync(f.startsWith("~/") ? join(home, f.slice(2)) : f).isFile(); } catch { return false; }
  });
}

// Commande à saisir dans le terminal : celle du catalogue sans le commentaire d'aide (« claude   # puis /login »).
export function loginCommand(entry) {
  return entry?.login ? String(entry.login).replace(/\s+#.*$/, "").trim() : null;
}

export async function detectOne(entry, { dataDir, env = process.env, run = runQuick } = {}) {
  const base = { id: entry.id, group: entry.group, label: entry.label, desc: entry.desc, installable: !!entry.install,
    hint: entry.hint ?? null, login: entry.login ?? null, keyUrl: entry.keyUrl ?? null, kind: entry.kind ?? "bin", envVar: entry.envVar ?? null };
  if (entry.kind === "key") {
    const stored = dataDir ? readEnv(dataDir) : {};
    const configured = !!(stored[entry.envVar] || env[entry.envVar]);
    const dirOk = entry.dir ? existsSync(entry.dir) : false;
    return { ...base, status: configured ? "connected" : "missing", detail: configured ? "Clé enregistrée" : (dirOk ? "Dossier de configuration présent, clé non enregistrée ici" : "Aucune clé") };
  }
  const path = findBin(entry.bin);
  if (!path) return { ...base, status: "missing", detail: "Non installé" };
  if (!entry.check) {
    if (hasAuthFile(entry)) return { ...base, status: "connected", detail: "Connecté" };
    return { ...base, status: "installed", detail: entry.authFile ? "Installé, pas connecté" : "Installé (connexion non vérifiable automatiquement)" };
  }
  const ok = await run(entry.check);
  return { ...base, status: ok ? "connected" : "installed", detail: ok ? "Connecté" : "Installé, pas connecté" };
}

export async function detectAll(opts = {}) {
  const items = await Promise.all(CATALOG.map((e) => detectOne(e, opts)));
  return { groups: GROUPS, items };
}

// ---------- Installation (liste blanche : seules les commandes du catalogue, jamais d'argument venant du navigateur) ----------
export function install(id, { run = execFile } = {}) {
  const entry = getEntry(id);
  if (!entry) return Promise.reject(new Error("Connecteur inconnu."));
  if (!entry.install) return Promise.reject(new Error("Pas d'installation automatique : copiez la commande indiquée dans un terminal."));
  const argv = entry.install;
  const bin = findBin(argv[0]) || argv[0];
  return new Promise((resolve, reject) => {
    run(bin, argv.slice(1), { timeout: 5 * 60_000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, CI: "1", NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        const tail = redact(`${stdout ?? ""}\n${stderr ?? ""}`).trim().split(/\r?\n/).slice(-12).join("\n").slice(-1500);
        if (error) reject(new Error(`Échec de l'installation (${error.code ?? error.signal ?? "erreur"}) : ${tail || error.message}`));
        else resolve({ output: tail });
      });
  });
}

// ---------- Skills partagés ----------
const isSkillDir = (dir) => existsSync(join(dir, "SKILL.md"));
export function listSharedSkills(dir = SHARED_SKILLS_DIR) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith(".") && isSkillDir(join(dir, d.name)))
      .map((d) => d.name).sort();
  } catch { return []; }
}

export function skillsStatus({ sharedDir = SHARED_SKILLS_DIR, targets = SKILL_TARGETS } = {}) {
  const shared = listSharedSkills(sharedDir);
  return {
    sharedDir, shared,
    targets: targets.map((t) => {
      const present = existsSync(t.dir);
      let linked = 0; let missing = 0;
      for (const name of shared) {
        const p = join(t.dir, name);
        let exists = false;
        try { lstatSync(p); exists = true; } catch { /* absent */ }
        if (exists) linked++; else missing++;
      }
      return { id: t.id, label: t.label, dir: t.dir, present, linked, missing };
    }),
  };
}

// Relie chaque skill partagé absent dans les dossiers cibles (jamais d'écrasement d'un skill existant du même nom).
export function linkSkills({ sharedDir = SHARED_SKILLS_DIR, targets = SKILL_TARGETS, only = null } = {}) {
  mkdirSync(sharedDir, { recursive: true });
  const created = []; const skipped = [];
  for (const t of targets) {
    if (only && t.id !== only) continue;
    mkdirSync(t.dir, { recursive: true });
    for (const name of listSharedSkills(sharedDir)) {
      const dest = join(t.dir, name);
      let exists = false;
      try { lstatSync(dest); exists = true; } catch { /* libre */ }
      if (exists) { skipped.push(`${t.id}/${name}`); continue; }
      symlinkSync(join(sharedDir, name), dest, "dir");
      created.push(`${t.id}/${name}`);
    }
  }
  return { created, skipped };
}

// Copie un skill existant (dossier avec SKILL.md) dans le dossier partagé ; refuse d'écraser.
export function importSkill(sourceDir, { sharedDir = SHARED_SKILLS_DIR } = {}) {
  const name = String(sourceDir).split("/").filter(Boolean).pop();
  if (!/^[A-Za-z0-9][\w.-]{0,60}$/.test(name || "")) throw new Error("Nom de skill invalide.");
  if (!isSkillDir(sourceDir)) throw new Error("Ce dossier ne contient pas de SKILL.md.");
  const dest = join(sharedDir, name);
  if (existsSync(dest)) throw new Error("Un skill partagé porte déjà ce nom.");
  mkdirSync(sharedDir, { recursive: true });
  cpSync(sourceDir, dest, { recursive: true, dereference: true });
  return name;
}
