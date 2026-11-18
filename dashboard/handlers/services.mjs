// Pilotage des bots et serveurs (vue « Bots & serveurs »).
// Trois choses, toutes côté poste (aucune commande ne vient du navigateur : le client ne désigne qu'un id de la liste) :
//   1. SERVICES : processus longs (serveurs BlastWin, tunnel Cloudflare, Hermes, daemon Paseo, serveur FreqUI de
//      FreqTrade…). Lancer / arrêter / relancer, état (processus lancé ici, OU déjà vivant et reconnu par sa ligne de
//      commande / son port : les fenêtres ouvertes à la main par les .bat du bureau sont donc « adoptées » et peuvent
//      être arrêtées d'ici).
//      Liste dans data/services.json (créée au premier démarrage à partir de DEFAULT_SERVICES ; modifiable à la main).
//      Le bot Telegram garde son superviseur dédié (telegramctl.mjs) : la vue lui parle directement.
//   2. TÂCHES : commandes qui se terminent (recherche d'offres stage/emploi, repérage des alumni, export CSV) avec un
//      petit formulaire. Les valeurs libres sont validées (lettres, chiffres, espaces, , - ' ; 80 car. au plus) et
//      passées en arguments séparés : jamais de shell, jamais de concaténation de commande.
//   3. DONNÉES : lecture seule des bases SQLite du bot de stage (alumni.db, jobs.db), recherche + filtres + pagination,
//      export CSV/MD téléchargeables (/api/svc/file), changement du suivi d'une offre via la CLI du bot.
// Messages WS : svc.list | svc.start {id, mode?} | svc.stop {id} | svc.restart {id, mode?} | svc.logs {id, lines?}
//   | svc.rename {id, name} | svc.group {group, action: start|stop} | svc.task.run {id, params} | svc.task.cancel {id} | svc.task.logs {id}
//   | svc.data.query {dataset, q, facets, offset, limit} | svc.job.status {job_key, profile, value}
// Réponses/diffusions : svc.state (liste complète, diffusée au changement), svc.logs, svc.data.result.
// Les actions (start/stop/restart/group/task.run/job.status) sont refusées à un appel interne (ctx.invoke) : un agent
// ne pilote pas les processus du poste par ce chemin.
import { spawn, execFile } from "node:child_process";
import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync,
  createReadStream, appendFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { redact } from "../lib/redact.mjs";
import { ApiError } from "./agentapi.mjs";

const WIN = process.platform === "win32";
const PROJECTS = process.env.PROJECTS_DIR || (WIN ? "D:\\Projets" : join(homedir(), "Projets"));
const BOT_STAGE = process.env.BOT_STAGE_DIR || join(PROJECTS, "Bot_Stage");
const BLASTWIN = process.env.BLASTWIN_DIR || join(PROJECTS, "BlastWin");
const PME = process.env.PME_SCOUT_DIR || join(PROJECTS, "Automatisation PME");
// Python du bot de stage : environnement virtuel du projet sous Linux, « python » du PATH sous Windows.
// Journal des lancements des bots (partagé avec `python3 -m bot.runlog` / botstatus côté Bot_Stage) : tous les lancements, CLI inclus.
const RUNS_LOG = join(BOT_STAGE, "data", "runs.jsonl");
function runHistory(bot, n = 5) {
  try {
    return readFileSync(RUNS_LOG, "utf8").split("\n").filter(Boolean).slice(-300).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.bot === bot).slice(-n).reverse().map((r) => ({ label: r.label, started: r.started, ended: r.ended, code: r.code }));
  } catch { return []; }
}
function logRun(entry) {
  try { appendFileSync(RUNS_LOG, `${JSON.stringify(entry)}\n`); } catch { /* journal facultatif */ }
}

const PYTHON = process.env.BOT_PYTHON || (WIN ? "python" : join(BOT_STAGE, ".venv", "bin", "python"));
const PASEO_LAB = resolve(import.meta.dirname, "..", "..");
const LOG_MAX = 1_000_000;
const SCAN_TTL_MS = 3_000;

// ---------- FreqTrade : le serveur FreqUI, piloté comme les autres services ----------
// Le projet FreqTrade a plusieurs fichiers de config (futures, FreqIA, essais) et le port du serveur API change de
// l'un à l'autre : chaque config est donc une variante de lancement du service, et son port (lu dans le fichier) sert
// à l'état « en marche » comme au bouton Ouvrir. Le bot qui trade est un autre processus (`freqtrade trade`) : eux
// deux ne peuvent pas tenir le même port en même temps, d'où l'avertissement.
const FREQTRADE_DIR = "/home/USERNAME/Projets/freqtrade";
const FREQTRADE_USERDIR = join(FREQTRADE_DIR, "user_data");
const FREQTRADE_STRATEGY_DIR = join(FREQTRADE_USERDIR, "strategies");
const FREQTRADE_BIN = join(FREQTRADE_DIR, ".venv", "bin", "freqtrade");
const FREQTRADE_HOST = "100.64.0.1"; // même adresse que les autres liens du poste (Tailscale)

// Une variante de lancement par fichier de config : « config.json (port 8085) ».
function freqtradeConfigModes() {
  const modes = [];
  for (const dir of [FREQTRADE_DIR, FREQTRADE_USERDIR, FREQTRADE_STRATEGY_DIR]) {
    let files = [];
    try { files = readdirSync(dir).sort(); } catch { continue; }
    for (const file of files) {
      // Ni espace ni caractère spécial : la commande d'un service passe par un shell (voir startService).
      if (!/^[\w.-]+\.json$/.test(file)) continue;
      let port = 0;
      try { port = Number(JSON.parse(readFileSync(join(dir, file), "utf8")).api_server?.listen_port) || 0; } catch { /* json illisible */ }
      if (!port) continue; // sans serveur API, ce fichier ne peut pas servir FreqUI
      // Le chemin complet (relatif au dossier du projet) sert à la fois d'identifiant de variante et d'argument
      // --config : deux fichiers du même nom (config.json à la racine et dans user_data) restent distincts.
      const path = relative(FREQTRADE_DIR, join(dir, file));
      // readyMs : quand le port est déjà pris par un autre programme, FreqTrade met ~4 s à mourir ; sans cette
      // attente, le poste concluait « lancé » puis la ligne retombait sans explication (voir startService).
      modes.push({ id: `webserver:${path}`, label: `${path} (port ${port})`, port, url: `http://${FREQTRADE_HOST}:${port}`, readyMs: 6000,
        cmd: `${FREQTRADE_BIN} webserver --config ${path} --userdir ${FREQTRADE_USERDIR}` });
    }
  }
  return modes;
}

const FREQTRADE_SERVICE = {
  id: "freqtrade-server", group: "Trading", name: "FreqTrade — serveur FreqUI",
  cwd: FREQTRADE_DIR, modes: WIN ? [] : freqtradeConfigModes(),
  match: ["freqtrade", "webserver"],
  warn: "Le bot qui trade (freqtrade trade) n'est pas ce serveur : s'il tourne, il occupe déjà le port de la config choisie.",
};

// Services proposés au premier démarrage. `match` : fragments (tous requis, insensibles à la casse) de la ligne de
// commande d'un processus déjà vivant ; `port` : port TCP en écoute. `modes` : variantes de lancement (shell:true).
const WINDOWS_SERVICES = [
  { id: "blastwin-frontend", group: "BlastWin", name: "Site (frontend)", cwd: join(BLASTWIN, "blastwin-frontend"),
    port: 3000, url: "http://localhost:3000", match: ["blastwin-frontend"],
    modes: [
      { id: "prod", label: "Production", cmd: "npm install && npm run build && npm start" },
      { id: "dev", label: "Dev", cmd: "npm install && npm run dev" },
    ] },
  { id: "blastwin-game", group: "BlastWin", name: "Serveur de jeu", cwd: join(BLASTWIN, "blastwin-game-server"),
    port: 8080, match: ["blastwin-game-server"],
    modes: [
      { id: "prod", label: "Production", cmd: "npm install && npm run build && npm start" },
      { id: "dev", label: "Dev", cmd: "npm install && npm run dev" },
    ] },
  { id: "blastwin-tunnel", group: "BlastWin", name: "Tunnel Cloudflare", cwd: BLASTWIN,
    match: ["cloudflared", "blastwin-dev"], modes: [{ id: "run", label: "Lancer", cmd: "cloudflared tunnel run blastwin-dev" }] },
  { id: "blastwin-chain", group: "BlastWin", name: "Chain watcher", cwd: join(BLASTWIN, "blastwin-chain-watcher"),
    match: ["blastwin-chain-watcher"], optional: true,
    modes: [{ id: "prod", label: "Production", cmd: "npm install && npm run build && npm start" }] },
  { id: "hermes", group: "Assistants", name: "Hermes (passerelle)", cwd: "C:\\Users\\Philippe",
    match: ["hermes_cli.main", "gateway"], modes: [{ id: "run", label: "Lancer", cmd: "hermes gateway run" }] },
  { id: "paseo-daemon", group: "Poste", name: "Daemon Paseo", cwd: PASEO_LAB, port: 6767,
    warn: "Le daemon porte toutes les sessions d'agents de ce poste : elles seront interrompues.",
    match: [["@getpaseo", "supervisor-entrypoint"], ["@getpaseo", "daemon-worker"], ["@getpaseo", "terminal-worker"], ["@getpaseo", "plugin-process"]],
    modes: [{ id: "run", label: "Lancer", cmd: "npx paseo start --home ./home" }] },
];

// Sur Linux (Oracle) : le site de test écoute sur 3100 ; le serveur de jeu et le chain-watcher manipulent de vraies clés et la même
// base que le PC : ils restent « optionnels » et ne se lancent qu'après décision explicite (jamais deux instances en production).
const LINUX_SERVICES = [
  { id: "blastwin-frontend", group: "BlastWin", name: "Site (frontend, test)", cwd: join(BLASTWIN, "blastwin-frontend"),
    port: 3100, url: "http://100.64.0.1:3100", unit: "blastwin-frontend",
    modes: [{ id: "prod", label: "Production (port 3100)", cmd: "npm run build && node node_modules/next/dist/bin/next start -p 3100 -H 0.0.0.0" }] },
  { id: "blastwin-tunnel", group: "BlastWin", name: "Tunnel Cloudflare", cwd: BLASTWIN,
    match: ["cloudflared", "config.yml"],
    warn: "Coupe dev.blast-win.com, ws et api-dev tant qu'il est arrêté. Un seul tunnel au monde : ne jamais le lancer aussi sur le PC.",
    modes: [{ id: "run", label: "Lancer", cmd: "cloudflared tunnel --no-autoupdate --config $HOME/.cloudflared/config.yml run" }] },
  { id: "blastwin-game", group: "BlastWin", name: "Serveur de jeu", cwd: join(BLASTWIN, "blastwin-game-server"),
    port: 8080,   // pas de « match » : sur Oracle le service tourne sous systemd (« node dist/index.js »), reconnu par son port
    warn: "Ne lancer qu'une seule instance de production : arrête d'abord celle du PC, sinon les paris et callbacks seraient traités deux fois.",
    modes: [{ id: "prod", label: "Production", cmd: "npm run build && npm start" }] },
  { id: "blastwin-chain", group: "BlastWin", name: "Chain watcher", cwd: join(BLASTWIN, "blastwin-chain-watcher"),
    match: ["blastwin-chain-watcher"], optional: true,
    warn: "Manipule des fonds : une seule instance au monde. Ne pas lancer tant que le PC l'exécute.",
    modes: [{ id: "prod", label: "Production", cmd: "npm run build && npm start" }] },
  FREQTRADE_SERVICE,
];
export const DEFAULT_SERVICES = WIN ? WINDOWS_SERVICES : LINUX_SERVICES;

// ---------- Aides ----------
const mask = (text) => redact(String(text ?? ""));
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const SECRET_ENV = /PASSWORD|SECRET|TOKEN|API_?KEY|CREDENTIAL|^DASHBOARD_/i;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)));

function tail(file, lines = 120, maxBytes = 128 * 1024) {
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, size - length);
      return mask(buf.toString("utf8")).split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(lines, 500)));
    } finally { closeSync(fd); }
  } catch { return []; }
}

function openLog(file, header) {
  try { if (statSync(file).size > LOG_MAX) renameSync(file, `${file}.1`); } catch { /* pas encore de journal */ }
  const fd = openSync(file, "a");
  writeFileSync(fd, `\n===== ${iso()} — ${header} =====\n`);
  return fd;
}

const run = (file, args, opts = {}) => new Promise((done) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", ...opts },
    (error, stdout, stderr) => done({ ok: !error, stdout: stdout || "", stderr: stderr || "", error }));
});

// Liste des processus (Windows : une seule requête CIM) + ports en écoute, mis en cache quelques secondes.
let scanCache = { at: 0, procs: [], ports: new Map() };
async function scan(force = false) {
  if (!force && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache;
  const procs = [];
  const ports = new Map();
  if (WIN) {
    const ps = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
    { timeout: 20_000 });
    try {
      const raw = JSON.parse(ps.stdout || "[]");
      for (const p of Array.isArray(raw) ? raw : [raw]) {
        procs.push({ pid: p.ProcessId, ppid: p.ParentProcessId, name: String(p.Name || ""), cmd: String(p.CommandLine || "") });
      }
    } catch { /* liste illisible : on garde un état vide, les services apparaîtront « arrêtés » */ }
    const ns = await run("netstat.exe", ["-ano", "-p", "tcp"]);
    for (const line of ns.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m) ports.set(Number(m[1]), Number(m[2]));
    }
  }
  else {
    const ps = await run("ps", ["-eo", "pid=,ppid=,comm=,args="], { timeout: 20_000 });
    for (const line of ps.stdout.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] });
    }
    const ss = await run("ss", ["-ltnpH"]);
    for (const line of ss.stdout.split("\n")) {
      const m = line.match(/:(\d+)\s+\S+\s+.*pid=(\d+)/);
      if (m) ports.set(Number(m[1]), Number(m[2]));
    }
  }
  scanCache = { at: Date.now(), procs, ports };
  return scanCache;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) return false;
  if (WIN) return (await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"])).ok;
  try { process.kill(-pid, "SIGTERM"); return true; } catch { try { process.kill(pid, "SIGTERM"); return true; } catch { return false; } }
}

// Un service peut tourner sous systemd (unité « <id>.service » côté poste) plutôt qu'en simple processus : tuer ses PID
// ne suffit pas, systemd le relance (Restart=). On arrête alors l'unité — sans la désactiver, un reboot la remettrait
// en marche, ce qui est le comportement attendu par Philippe.
async function systemdUnitOf(svc) {
  if (WIN || !svc.unit) return null;
  const name = `${svc.unit}.service`;
  const r = await run("systemctl", ["--user", "list-unit-files", name, "--plain", "--no-legend"], { timeout: 10_000 });
  return r.ok && r.stdout.toLowerCase().includes(name) ? name : null;
}

// Racines des processus d'un service : les pids dont le parent n'est pas lui aussi dans l'ensemble (tuer l'arbre suffit).
function roots(pids, procs) {
  const set = new Set(pids);
  return pids.filter((pid) => !set.has(procs.find((p) => p.pid === pid)?.ppid));
}

// ---------- Tâches (Bot de stage) ----------
const FREE_TEXT = /^[\p{L}\p{N} ,'’\-]{0,80}$/u;

function listFreqtradeConfigs() {
  const seen = new Set(); const out = [];
  const dirs = [FREQTRADE_DIR, FREQTRADE_USERDIR, FREQTRADE_STRATEGY_DIR];
  for (const d of dirs) { try { for (const f of readdirSync(d).sort()) { if (f.endsWith(".json") && !seen.has(f)) { seen.add(f); out.push(f); } } } catch {} }
  return out;
}
function listFreqtradeStrategies() {
  try { return readdirSync(FREQTRADE_STRATEGY_DIR).filter((f) => f.endsWith(".py") && !f.startsWith("__") && !f.startsWith("sample_")).sort().map((f) => f.slice(0, -3)); } catch { return []; }
}

const listPresets = () => {
  try { return readdirSync(join(BOT_STAGE, "bot", "presets")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(); }
  catch { return []; }
};
const listProfiles = () => {
  try {
    return readdirSync(join(BOT_STAGE, "bot", "jobs", "profiles")).filter((f) => f.endsWith(".json") && !f.startsWith("dash-"))
      .map((f) => f.slice(0, -5)).sort();
  } catch { return ["stage", "remote"]; }
};

// Pages « bots » de la vue : chacune regroupe ses actions, ses données et ses fichiers.
const BOTS = [
  { id: "emplois", name: "Stages & emplois", desc: "Offres de stage et d'emploi remote (Himalayas, Jobicy) rangées dans jobs.db.", tasks: ["jobs-sync", "jobs-export"], datasets: ["jobs-triage", "jobs"], files: "emplois" },
  { id: "alumni", name: "Alumni EDHEC", desc: "Repérage des alumni en poste dans les entreprises et zones visées (alumni.db).", tasks: ["alumni-build"], datasets: ["alumni"], files: "alumni" },
  { id: "pme", name: "PME Scout (Automatisation IA)", desc: "Découverte de PME françaises par métier et ville, qualification, enrichissement et messages.", tasks: ["pme-scout", "pme-step"], datasets: ["pme-companies", "pme-outreach"], files: "pme" },
  { id: "freqtrade", name: "FreqTrade", desc: "Bot de trading crypto : lancement (dry_run), backtest, hyper optimisation et FreqIA.", tasks: ["freqtrade-run"], datasets: [], files: null },
];
const FILE_DIRS = {
  emplois: { dir: () => join(BOT_STAGE, "data"), keep: (f) => /^offres_.*\.(csv|md)$/i.test(f) },
  alumni: { dir: () => join(BOT_STAGE, "data"), keep: (f) => /\.(csv|md)$/i.test(f) && !/^offres_/i.test(f) },
  pme: { dir: () => join(PME, "data"), keep: (f) => /\.csv$/i.test(f) },
  // CV de Philippe (Bot_Stage/CV) : un lien mailto: ne peut pas joindre de fichier, on le télécharge pour l'attacher à la main.
  cv: { dir: () => join(BOT_STAGE, "CV"), keep: (f) => /\.(pdf|docx)$/i.test(f) },
};
const FILE_TYPES = { ".csv": "text/csv; charset=utf-8", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

function taskDefs() {
  return [
    { id: "jobs-sync", bot: "emplois", name: "Chercher des offres (stage / emploi)",
      help: "Interroge Himalayas et Jobicy avec un profil, puis range les offres dans jobs.db.",
      fields: [
        { key: "profile", label: "Profil", type: "select", options: listProfiles(), value: "stage", required: true },
        { key: "countries", label: "Pays (séparés par des virgules)", type: "text", placeholder: "France, Belgique", value: "" },
        { key: "keywords", label: "Mots-clés (séparés par des virgules)", type: "text", placeholder: "finance, trading", value: "" },
        { key: "pages", label: "Pages max par source", type: "select", options: ["1", "2", "3", "5"], value: "3" },
      ] },
    { id: "jobs-export", bot: "emplois", name: "Exporter les offres",
      help: "Crée un fichier CSV ou Markdown dans Bot_Stage/data (téléchargeable plus bas).",
      fields: [
        { key: "profile", label: "Profil", type: "select", options: listProfiles(), value: "stage", required: true },
        { key: "format", label: "Format", type: "select", options: ["csv", "md"], value: "csv" },
      ] },
    { id: "alumni-build", bot: "alumni", name: "Repérer des alumni",
      help: "Importe dans la base les alumni EDHEC en poste (un préréglage OU une entreprise et/ou un pays) : tous, ou seulement ceux dont l'e-mail perso est disponible (case à cocher, vérification ~5 s par personne).",
      fields: [
        { key: "preset", label: "Préréglage", type: "select", options: ["", ...listPresets()], value: "" },
        { key: "sector", label: "Secteur (un LLM gratuit propose les entreprises)", type: "text", placeholder: "quant, fintech, hedge funds…", value: "" },
        { key: "company", label: "Entreprise (nom exact)", type: "text", placeholder: "OPTIVER", value: "" },
        { key: "country", label: "Pays de l'entreprise", type: "text", placeholder: "Pays-Bas", value: "" },
        { key: "perso", label: "Seulement les contacts avec e-mail perso (décoché : tous les contacts, import rapide)", type: "check", value: true },
      ] },
    { id: "pme-scout", bot: "pme", name: "Chercher des PME (métier + ville)",
      help: "Découvre des entreprises depuis les sources publiques (SIRENE, sites web). Ex. « plomberie chauffage Lille ».",
      fields: [
        { key: "query", label: "Métier et ville", type: "text", placeholder: "plomberie chauffage Lille", value: "", required: true },
        { key: "limit", label: "Nombre max d'entreprises", type: "select", options: ["10", "30", "100"], value: "30" },
        { key: "fast", label: "Rapide (SIRENE seule, sans visiter les sites)", type: "check", value: true },
      ] },
    { id: "pme-step", bot: "pme", name: "Étape suivante du pipeline",
      help: "Qualifier les sites, enrichir (contacts), analyser (intel), puis préparer les messages. Les messages ne sont jamais envoyés.",
      fields: [
        { key: "step", label: "Étape", type: "select", options: ["qualify", "enrich", "intel", "outreach"], value: "qualify", required: true },
        { key: "limit", label: "Nombre max", type: "select", options: ["10", "20", "50"], value: "20" },
      ] },
    { id: "freqtrade-run", bot: "freqtrade", name: "Lancer FreqTrade",
      help: "Assistant de lancement : type → config → stratégie → options.",
      fields: [
        { key: "mode", label: "Type de lancement", type: "select", options: ["trade", "backtest", "hyperopt", "freqai"], value: "trade", required: true },
        { key: "config", label: "Configuration", type: "select", options: listFreqtradeConfigs(), value: "", required: true },
        { key: "strategy", label: "Stratégie", type: "select", options: listFreqtradeStrategies(), value: "", required: true },
        { key: "pairs", label: "Paires (séparées par des virgules)", type: "text", placeholder: "BTC/USDT:USDT, ETH/USDT:USDT", value: "" },
        { key: "timerange", label: "Période (timerange)", type: "text", placeholder: "20250101-20250131", value: "" },
        { key: "maxTrials", label: "Essais HyperOpt", type: "select", options: ["10", "50", "100"], value: "50" },
        { key: "dryRun", label: "Dry-run (simulation)", type: "check", value: true },
      ] },
  ];
}

// Construit { argv, cwd, pre? } pour une tâche, ou lance une erreur lisible.
function buildTask(id, params = {}) {
  const defs = Object.fromEntries(taskDefs().map((t) => [t.id, t]));
  const def = defs[id];
  if (!def) throw new Error("tâche inconnue");
  const val = {};
  for (const f of def.fields) {
    let v = params[f.key];
    if (f.type === "check") { val[f.key] = v === true || v === "true"; continue; }
    v = String(v ?? f.value ?? "").trim();
    if (f.type === "select") { if (!f.options.includes(v)) throw new Error(`valeur invalide pour « ${f.label} »`); }
    else if (!FREE_TEXT.test(v) || v.startsWith("-")) throw new Error(`« ${f.label} » : lettres, chiffres, espaces, virgules et tirets seulement (80 car. max)`);
    if (f.required && !v) throw new Error(`« ${f.label} » est obligatoire`);
    val[f.key] = v;
  }
  const py = ["-X", "utf8"];
  const csv = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  if (id === "jobs-sync") {
    const overrides = { countries: csv(val.countries), keywords: csv(val.keywords) };
    return { cwd: BOT_STAGE, argv: [PYTHON, ...py, "-m", "bot.jobs", "sync", "--profile", val.profile, "--max-pages", val.pages],
      profileOverride: { base: val.profile, overrides } };
  }
  if (id === "jobs-export") {
    const out = `data/offres_${val.profile}_${iso().slice(0, 16).replace(/[-:T]/g, "")}.${val.format}`;
    return { cwd: BOT_STAGE, argv: [PYTHON, ...py, "-m", "bot.jobs", "export", "--profile", val.profile, "--format", val.format, "--output", out] };
  }
  if (id === "alumni-build") {
    const argv = [PYTHON, ...py, "bot/build_db.py"];
    if (val.preset) argv.push("--preset", val.preset);
    if (val.sector) argv.push("--sector", val.sector);
    if (val.company) argv.push("--company", val.company);
    if (val.country) argv.push("--country", val.country);
    if (argv.length === 3) throw new Error("choisis un préréglage, une entreprise ou un pays");
    if (val.perso) argv.push("--perso-only"); // coché : on vérifie chaque personne et on garde celles avec e-mail perso ; toujours en réel
    return { cwd: BOT_STAGE, argv };
  }
  if (id === "pme-scout") {
    const argv = ["node", "src/cli.js", val.query, "--limit", val.limit];
    if (val.fast) argv.push("--fast");
    return { cwd: PME, argv };
  }
  if (id === "pme-step") {
    const extra = { qualify: ["--from-store", "--only-verified-sites"], enrich: ["--from-store", "--only-verified-sites"], intel: ["--from-store"], outreach: [] }[val.step];
    return { cwd: PME, argv: ["node", `src/cli-${val.step}.js`, ...extra, "--limit", val.limit] };
  }
  throw new Error("tâche inconnue");
}

// ---------- Données ----------
const DATASETS = {
  alumni: {
    id: "alumni", name: "Alumni", db: () => join(BOT_STAGE, "data", "alumni.db"),
    table: "people", from: "people", select: "profile_id AS id, fullname, current_company, current_title, current_city, current_country, promos, role_type, seniority, linkedin_url",
    columns: [["fullname", "Nom"], ["current_company", "Entreprise"], ["current_title", "Poste"], ["current_city", "Ville"],
      ["current_country", "Pays"], ["promos", "Promo"], ["role_type", "Rôle"], ["linkedin_url", "LinkedIn"], ["mailto", "Mail"], ["cv", "CV à joindre"]],
    search: ["fullname", "current_company", "current_title", "current_city", "current_country", "parcours"],
    facets: [{ key: "current_company", label: "Entreprise", col: "current_company" }, { key: "current_country", label: "Pays", col: "current_country" },
      { key: "current_city", label: "Ville", col: "current_city" }, { key: "company_category", label: "Type d'entreprise", col: "company_category" },
      { key: "role_type", label: "Rôle", col: "role_type" }, { key: "seniority", label: "Séniorité", col: "seniority" }],
    order: "fullname COLLATE NOCASE",
  },
  jobs: {
    id: "jobs", name: "Offres", db: () => join(BOT_STAGE, "data", "jobs.db"),
    table: "jobs", from: "matches m JOIN jobs j ON j.job_key = m.job_key LEFT JOIN application_tracking t ON t.job_key = j.job_key AND t.profile_name = m.profile_name",
    select: "j.job_key AS id, j.title, j.company, j.location, j.employment_type, j.posted_at, j.url, m.profile_name AS profile, m.score, COALESCE(t.status, 'discovered') AS status",
    columns: [["title", "Titre"], ["company", "Entreprise"], ["location", "Lieu"], ["employment_type", "Contrat"], ["posted_at", "Publiée"],
      ["profile", "Profil"], ["score", "Score"], ["status", "Suivi"], ["url", "Lien"]],
    search: ["j.title", "j.company", "j.location", "j.description"],
    facets: [{ key: "profile", label: "Profil", col: "m.profile_name" }, { key: "status", label: "Suivi", col: "COALESCE(t.status, 'discovered')" },
      { key: "employment_type", label: "Contrat", col: "j.employment_type" }],
    order: "m.score DESC, j.posted_at DESC",
  },
  "jobs-triage": {
    id: "jobs-triage", name: "Triées pour toi", kind: "csv", file: () => join(BOT_STAGE, "data", "triage_stage.csv"), idKey: "id",
    columns: [["fit", "Adaptation"], ["title", "Titre"], ["company", "Entreprise"], ["countries", "Pays"], ["reasons", "Pourquoi"], ["url", "Lien"]],
    search: ["title", "company", "countries", "reasons"], facets: [{ key: "company", label: "Entreprise" }, { key: "countries", label: "Pays" }],
  },
  "pme-companies": {
    id: "pme-companies", name: "Entreprises", kind: "csv", file: () => join(PME, "data", "companies.csv"), idKey: "id", marks: true,
    columns: [["name", "Entreprise"], ["sector", "Secteur"], ["city", "Ville"], ["postal_code", "CP"], ["employee_count", "Effectif"],
      ["website", "Site"], ["phone", "Téléphone"], ["email", "Email"], ["status", "Statut"]],
    search: ["name", "sector", "city", "postal_code", "website", "director"], facets: [{ key: "city", label: "Ville" }, { key: "department", label: "Département" }, { key: "status", label: "Statut" }],
  },
  "pme-outreach": {
    id: "pme-outreach", name: "Messages préparés", kind: "csv", file: () => join(PME, "data", "outreach.csv"), idKey: "siren", marks: true,
    columns: [["entreprise", "Entreprise"], ["email_destinataire", "Destinataire"], ["objet", "Objet"], ["statut", "Statut"], ["destinataire_a_verifier", "À vérifier"], ["mailto", "Mail"]],
    search: ["entreprise", "email_destinataire", "objet", "corps"], facets: [{ key: "statut", label: "Statut" }, { key: "destinataire_a_verifier", label: "À vérifier" }],
    detail: "corps",
  },
};
// Jeux SQLite à cases « Traité » : colonne d'identité côté SQL.
DATASETS.alumni.marks = true; DATASETS.alumni.idCol = "profile_id";

// CSV à point-virgule (BOM, champs entre guillemets, retours à la ligne dans les champs), relu seulement si le fichier change.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
const csvCache = new Map();
function loadCsv(file) {
  const mtime = statSync(file).mtimeMs;
  const hit = csvCache.get(file);
  if (hit?.mtime === mtime) return hit.rows;
  const rows = parseCsv(readFileSync(file, "utf8"));
  csvCache.set(file, { mtime, rows });
  return rows;
}

let readMarks = () => ({});

// Un filtre accepte une valeur ou une liste (cumul « ou » dans un même filtre, « et » entre filtres).
function facetVals(v) {
  const list = Array.isArray(v) ? v : (typeof v === "string" && v ? [v] : []);
  return list.filter((x) => typeof x === "string" && x).slice(0, 60).map((x) => x.slice(0, 120));
}

function queryCsv(ds, m) {
  const file = ds.file();
  if (!existsSync(file)) return { dataset: ds.id, available: false, reason: "Aucune donnée : lance d'abord une recherche.", rows: [], total: 0, facets: {} };
  const all = loadCsv(file);
  const marks = readMarks()[ds.id] || {};
  const q = String(m.q ?? "").trim().toLowerCase().slice(0, 80);
  let rows = all;
  if (q) rows = rows.filter((r) => ds.search.some((k) => String(r[k] ?? "").toLowerCase().includes(q)));
  for (const f of ds.facets) { const vs = facetVals(m.facets?.[f.key]); if (vs.length) { const low = vs.map((x) => x.toLowerCase()); rows = rows.filter((r) => low.includes(String(r[f.key] ?? "").toLowerCase())); } }
  if (m.marked === "yes") rows = rows.filter((r) => marks[r[ds.idKey]]);
  if (m.marked === "no") rows = rows.filter((r) => !marks[r[ds.idKey]]);
  const limit = Math.max(1, Math.min(Number(m.limit) || 50, 200));
  const offset = Math.max(0, Number(m.offset) || 0);
  const facets = {};
  for (const f of ds.facets) {
    const counts = new Map();
    const rep = new Map(); for (const r of all) { const raw = String(r[f.key] ?? ""); if (!raw) continue; const k = raw.toLowerCase(); if (!rep.has(k)) rep.set(k, raw); const v = rep.get(k); counts.set(v, (counts.get(v) || 0) + 1); }
    facets[f.key] = { label: f.label, values: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 1500).map(([value, count]) => ({ value, count })) };
  }
  const pick = ds.columns.map(([k]) => k);
  return { dataset: ds.id, available: true, columns: ds.columns, marks: true, total: rows.length, offset, limit, facets,
    rows: rows.slice(offset, offset + limit).map((r) => ({ id: r[ds.idKey], ...Object.fromEntries(pick.map((k) => [k, r[k] ?? ""])),
      ...(ds.id === "pme-outreach" ? { mailto: pmeMailto(r) } : {}),
      ...(ds.detail ? { _detail: r[ds.detail] } : {}), _marked: !!marks[r[ds.idKey]] })) };
}

// Lien mailto: d'un message PME préparé (destinataire, objet et corps déjà dans outreach.csv).
function pmeMailto(r) {
  const to = String(r.email_destinataire ?? "").trim();
  if (!/^[^\s@;,]+@[^\s@;,]+$/.test(to)) return "";
  return `mailto:${to}?subject=${encodeURIComponent(r.objet ?? "")}&body=${encodeURIComponent(r.corps ?? "")}`;
}

// Liens mailto: (objet + message pré-remplis) écrits par Bot_Stage/bot/messages.py dans data/mailto.json.
function alumniMailto() {
  try { return JSON.parse(readFileSync(join(BOT_STAGE, "data", "mailto.json"), "utf8")); } catch { return {}; }
}

// Langue du message de chaque alumni (data/langs.json) → CV correspondant (Bot_Stage/CV, suffixe « - FR/EN/DE », le plus récent).
function alumniLangs() {
  try { return JSON.parse(readFileSync(join(BOT_STAGE, "data", "langs.json"), "utf8")); } catch { return {}; }
}
function cvFor(lang) {
  if (!lang) return "";
  try {
    const dir = join(BOT_STAGE, "CV");
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf") && new RegExp(`[- ]${lang}\\.pdf$`, "i").test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return files[0]?.f || "";
  } catch { return ""; }
}

// Notes LinkedIn (300 car.) des alumni sans e-mail, écrites par messages.py dans data/notes.json.
function alumniNotes() {
  try { return JSON.parse(readFileSync(join(BOT_STAGE, "data", "notes.json"), "utf8")); } catch { return {}; }
}

function queryDataset(m) {
  const ds = DATASETS[m.dataset];
  if (!ds) throw new Error("jeu de données inconnu");
  if (ds.kind === "csv") return queryCsv(ds, m);
  const file = ds.db();
  if (!existsSync(file)) return { dataset: ds.id, available: false, reason: "Base absente : lance d'abord une recherche.", rows: [], total: 0, facets: {} };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(ds.table)) {
      return { dataset: ds.id, available: false, reason: "Base vide : lance d'abord une recherche.", rows: [], total: 0, facets: {} };
    }
    const limit = Math.max(1, Math.min(Number(m.limit) || 50, 200));
    const offset = Math.max(0, Number(m.offset) || 0);
    const where = [];
    const args = [];
    const q = String(m.q ?? "").trim().slice(0, 80);
    if (q) {
      where.push(`(${ds.search.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      for (let i = 0; i < ds.search.length; i += 1) args.push(like);
    }
    for (const f of ds.facets) {
      const vs = facetVals(m.facets?.[f.key]);
      if (vs.length) { where.push(`${f.col} COLLATE NOCASE IN (${vs.map(() => "?").join(",")})`); args.push(...vs); }
    }
    const mailIds = ds.id === "alumni" ? Object.keys(alumniMailto()).slice(0, 5000) : null;
    if (mailIds && facetVals(m.facets?.has_mail).includes("yes")) {
      where.push(`profile_id IN (${mailIds.map(() => "?").join(",") || "NULL"})`);
      args.push(...mailIds);
    }
    if (ds.idCol && (m.marked === "yes" || m.marked === "no")) {
      const list = Object.keys(readMarks()[ds.id] || {}).slice(0, 5000);
      const holes = list.map(() => "?").join(",") || "NULL";
      where.push(`${ds.idCol} ${m.marked === "yes" ? "IN" : "NOT IN"} (${holes})`);
      args.push(...list);
    }
    const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${ds.from}${w}`).get(...args).n;
    const rows = db.prepare(`SELECT ${ds.select} FROM ${ds.from}${w} ORDER BY ${ds.order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const facets = {};
    for (const f of ds.facets) {
      facets[f.key] = { label: f.label, values: db.prepare(
        `SELECT MIN(${f.col}) AS v, COUNT(*) AS n FROM ${ds.from} WHERE ${f.col} IS NOT NULL AND ${f.col} <> '' GROUP BY ${f.col} COLLATE NOCASE ORDER BY 2 DESC LIMIT 1500`).all().map((r) => ({ value: String(r.v), count: r.n })) };
    }
    if (mailIds) facets.has_mail = { label: "Mail", values: [{ value: "yes", count: mailIds.length }] };
    const done = readMarks()[ds.id] || {};
    return { dataset: ds.id, available: true, columns: ds.columns, marks: !!ds.marks, total, offset, limit, facets,
      rows: rows.map((r) => ({ ...r, ...(ds.id === "alumni" ? { mailto: alumniMailto()[String(r.id)] || "", note: alumniNotes()[String(r.id)] || "", cv: cvFor(alumniLangs()[String(r.id)]) } : {}),
        ...(ds.marks ? { _marked: !!done[r.id] } : {}) })) };
  } finally { db.close(); }
}

function listFiles() {
  const out = [];
  for (const [bot, def] of Object.entries(FILE_DIRS)) {
    try {
      const dir = def.dir();
      for (const name of readdirSync(dir).filter(def.keep)) {
        const st = statSync(join(dir, name));
        out.push({ bot, name, size: st.size, modifiedAt: iso(st.mtimeMs) });
      }
    } catch { /* dossier absent */ }
  }
  return out.sort((x, y) => y.modifiedAt.localeCompare(x.modifiedAt));
}

// Bilan lisible du dernier repérage (écrit par Bot_Stage/bot/report.py) : statut, chiffres, action à faire, suggestions.
function alumniSession() {
  // État de la session EDHEC Alumni gardée par le gardien (Bot_Stage/bot/session_keeper.py) : prête, ou attend une action humaine.
  let flag = null;
  try { flag = JSON.parse(readFileSync(join(BOT_STAGE, "data", "human_needed.json"), "utf8")); } catch { /* pas de drapeau */ }
  let last = "";
  try { last = readFileSync(join(BOT_STAGE, "data", "session_keeper.log"), "utf8").trim().split("\n").slice(-1)[0] || ""; } catch { /* pas de journal */ }
  return { waiting: flag ? flag.kind : null, since: flag?.since ? new Date(flag.since * 1000).toISOString() : null, last };
}

function alumniReport() {
  try { return JSON.parse(readFileSync(join(BOT_STAGE, "data", "last_run.json"), "utf8")); } catch { return null; }
}

// ---------- Enregistrement ----------
export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store, dataDir, log } = ctx;
  const logDir = join(dataDir, "services-logs");
  mkdirSync(logDir, { recursive: true });
  const logOf = (id) => join(logDir, `${id}.log`);

  let services = store.read("services", null);
  if (!Array.isArray(services) || !services.length) {
    services = DEFAULT_SERVICES;
    try { store.write("services", services); } catch { /* disque en lecture seule : liste par défaut en mémoire */ }
  }
  // Le fichier des services est persisté (et modifiable à la main) : les champs ajoutés aux défauts depuis sa
  // création (ex. `unit`, qui dit qu'un service tourne sous systemd et ne doit pas être tué à la PID seule)
  // manquent sur les anciennes copies. On les rattrape sur les entrées connues, sans écraser le reste.
  {
    const defaultsById = new Map(DEFAULT_SERVICES.map((d) => [d.id, d]));
    const before = JSON.stringify(services);
    for (const s of services) {
      const def = defaultsById.get(s.id);
      if (!def) continue;
      for (const [k, v] of Object.entries(def)) if (s[k] === undefined) s[k] = v;
    }
    if (before !== JSON.stringify(services)) {
      try { store.write("services", services); } catch { /* disque en lecture seule : rattrapage en mémoire seulement */ }
    }
  }
  // FreqTrade a une variante de lancement par fichier de config : elles sont recalculées à chaque démarrage du poste
  // (un nouveau config.json apparaît donc tout seul), et le service est ajouté s'il manque dans le fichier.
  {
    const modes = freqtradeConfigModes();
    const i = services.findIndex((s) => s.id === FREQTRADE_SERVICE.id);
    const before = i === -1 ? null : JSON.stringify(services[i].modes);
    if (i === -1) services.push({ ...FREQTRADE_SERVICE });
    else if (modes.length) services[i].modes = modes;
    if (before === null || (modes.length && before !== JSON.stringify(modes))) {
      try { store.write("services", services); } catch { /* disque en lecture seule : liste en mémoire */ }
    }
  }
  // Noms choisis depuis la vue (svc.rename) ; le nom d'origine reste dans `defaultName`.
  const customNames = () => store.read("services-names", {}) || {};
  const stateFile = () => store.read("services-state", {}) || {};
  const saveState = (patch) => { try { store.write("services-state", { ...stateFile(), ...patch }); } catch { /* ignoré */ } };
  const byId = (id) => services.find((s) => s.id === id);
  const runs = new Map(); // taskId -> { child, pid, startedAt, endedAt, code, params, error }

  const refuseInvoke = (ws) => {
    if (!String(ws?._uiId ?? "").startsWith("invoke:")) return false;
    sendError(ws, "Message réservé à l'interface.");
    return true;
  };

  // Processus reconnaissables par leur ligne de commande : seuls ces programmes sont éligibles (jamais un éditeur, un
  // terminal ou une session Claude qui citerait le même chemin), et `match` peut être une liste de listes (alternatives).
  // « freqtrade » en fait partie : Python renomme le processus d'après le script (le serveur FreqUI apparaît sous
  // ce nom, pas sous « python3 »), sinon le poste ne reconnaissait pas un serveur lancé à la main.
  const MATCH_PROGRAMS = /^(node|cmd|cloudflared|python|python3|pythonw|npm|npx|freqtrade)(\.exe)?$/i;
  const matches = (svc, p) => {
    if (!svc.match?.length || !MATCH_PROGRAMS.test(p.name) || /claude|codex/i.test(p.cmd)) return false;
    const groups = Array.isArray(svc.match[0]) ? svc.match : [svc.match];
    const hay = `${p.name} ${p.cmd}`.toLowerCase();
    return groups.some((g) => g.every((n) => hay.includes(String(n).toLowerCase())));
  };
  const descendants = (pids, procs) => {
    const set = new Set(pids);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of procs) if (!set.has(p.pid) && set.has(p.ppid)) { set.add(p.pid); grew = true; }
    }
    return set;
  };

  async function statusOf(svc, snap) {
    const rec = stateFile()[svc.id] || {};
    // Un service peut avoir un port par variante de lancement (FreqTrade : une config = un port) : le mode
    // effectivement lancé fait foi ; sans mode lancé, on retombe sur le port du service lui-même.
    const mode = (svc.modes || []).find((m) => m.id === rec.mode) || null;
    const port = mode?.port ?? svc.port ?? null;
    const pids = [];
    if (rec.pid && alive(rec.pid)) pids.push(rec.pid);
    for (const p of snap.procs) if (p.pid !== process.pid && matches(svc, p) && !pids.includes(p.pid)) pids.push(p.pid);
    const portPid = port ? snap.ports.get(port) : null;
    // Un port seul ne prouve rien (un autre programme peut l'occuper) : il ne compte comme « en marche » que pour un
    // service sans `match`, et il n'est jamais tué pour un service qui en a un.
    if (!svc.match?.length && portPid && !pids.includes(portPid)) pids.push(portPid);
    const running = pids.length > 0;
    return {
      id: svc.id, group: svc.group, name: customNames()[svc.id] || svc.name, defaultName: svc.name, url: mode?.url ?? svc.url ?? null, port, optional: !!svc.optional, warn: svc.warn ?? null,
      modes: (svc.modes || []).map((m) => ({ id: m.id, label: m.label })),
      running, pids, managed: !!(rec.pid && alive(rec.pid)), mode: running ? rec.mode ?? null : null,
      startedAt: running ? rec.startedAt ?? null : null, lastStartedAt: rec.startedAt ?? null, lastError: rec.lastError ?? null,
      listening: port ? (running && !!portPid && descendants(pids, snap.procs).has(portPid)) : null,
    };
  }

  async function buildState(force = false) {
    const snap = await scan(force);
    const list = [];
    for (const s of services) list.push(await statusOf(s, snap));
    const tasks = taskDefs().map((t) => {
      const r = runs.get(t.id);
      const last = stateFile()[`task:${t.id}`] || null;
      return { ...t, run: r ? { running: !r.endedAt, startedAt: iso(r.startedAt), endedAt: r.endedAt ? iso(r.endedAt) : null, code: r.code ?? null, error: r.error ?? null } : null,
        lastRun: last, history: runHistory(t.bot), report: t.id === "alumni-build" ? alumniReport() : null, session: t.id === "alumni-build" ? alumniSession() : null };
    });
    return { type: "svc.state", at: iso(), services: list, tasks, bots: BOTS, datasets: Object.values(DATASETS).map((d) => ({ id: d.id, name: d.name, available: existsSync(d.kind === "csv" ? d.file() : d.db()) })),
      files: listFiles() };
  }

  let lastSig = "";
  async function emit(force = false, ws = null, ref = null) {
    const state = await buildState(force);
    const sig = JSON.stringify({ ...state, at: null });
    if (ws) return send(ws, { ...state, ref });
    if (sig === lastSig) return;
    lastSig = sig;
    broadcast({ ...state, ref: null });
  }

  async function startService(svc, modeId) {
    const mode = (svc.modes || []).find((m) => m.id === modeId) || (svc.modes || [])[0];
    if (!mode) throw new Error("aucun mode de lancement configuré");
    const snap = await scan(true);
    const cur = await statusOf(svc, snap);
    if (cur.running) throw new Error("déjà en marche");
    if (!existsSync(svc.cwd)) throw new Error(`dossier introuvable : ${svc.cwd}`);
    // Service sous systemd (frontend de test) : on lance l'unité, jamais un second processus qui se battrait
    // pour le même port. Le build passe avant (npm run build), l'unité ne fait que « next start ».
    const unit = await systemdUnitOf(svc);
    if (unit) {
      // L'unité tourne déjà ? inutile (et nuisible : le verrou .next) de relancer un build.
      const already = await run("systemctl", ["--user", "is-active", unit], { timeout: 10_000 });
      if (["active", "activating"].includes(already.stdout.trim())) throw new Error("déjà démarré sous systemd : arrête-le d'abord");
      const fd = openLog(logOf(svc.id), `lancement via systemd : ${unit} (build inclus)`);
      // Le build écrit dans le journal (fd) ; la sortie reste capturée par run() pour la remonter en cas d'échec.
      const start = await run("npm", ["run", "build"], { cwd: svc.cwd, timeout: 15 * 60_000 });
      if (!start.ok) {
        const detail = (start.stdout || "").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ") ||
          (start.stderr || "").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ") || "";
        throw new Error(`build échoué${detail ? ` — ${mask(detail)}` : ""}`);
      }
      const go = await run("systemctl", ["--user", "start", unit], { timeout: 30_000 });
      closeSync(fd);
      if (!go.ok) throw new Error(mask(go.stderr || go.error?.message || "échec du lancement systemd"));
      await new Promise((r) => setTimeout(r, 1500));
      // « listening » vaut null quand le service n'a pas de port configuré : on ne contrôle que les services qui en ont un.
      const after = await statusOf(svc, await scan(true));
      if (svc.port && after.listening !== true) {
        const lines = tail(logOf(svc.id), 4);
        saveState({ [svc.id]: { pid: null, mode: mode.id, startedAt: iso(), lastError: `démarré mais sans réponse sur le port ${svc.port}` } });
        throw new Error(`démarré mais sans réponse sur le port ${svc.port}${lines.length ? ` — ${lines.slice(-2).join(" | ")}` : ""}`);
      }
      saveState({ [svc.id]: { pid: null, mode: mode.id, startedAt: iso(), lastError: null } });
      return;
    }
    const fd = openLog(logOf(svc.id), `lancement (${mode.label}) : ${mode.cmd}`);
    const child = spawn(mode.cmd, { cwd: svc.cwd, shell: true, detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: cleanEnv() });
    child.on("error", (e) => saveState({ [svc.id]: { ...(stateFile()[svc.id] || {}), lastError: mask(e.message) } }));
    child.unref();
    closeSync(fd);
    saveState({ [svc.id]: { pid: child.pid, mode: mode.id, startedAt: iso(), lastError: null } });
    await new Promise((r) => setTimeout(r, Number(mode.readyMs) || 2500));
    if (!alive(child.pid) && !(await statusOf(svc, await scan(true))).running) {
      // Les modes « npm install && build && start » peuvent se terminer vite si la commande échoue : on le dit avec le journal.
      const lines = tail(logOf(svc.id), 6);
      const msg = `le processus s'est arrêté dès le lancement${lines.length ? ` — ${lines.slice(-3).join(" | ")}` : ""}`;
      saveState({ [svc.id]: { pid: null, mode: mode.id, startedAt: null, lastError: msg } });
      throw new Error(msg);
    }
  }

  async function stopService(svc) {
    const snap = await scan(true);
    const st = await statusOf(svc, snap);
    if (!st.running) return false;
    // D'abord l'unité systemd (si le service tourne dessus) : tuer ses PID la ferait ressusciter via Restart=.
    const unit = await systemdUnitOf(svc);
    if (unit) {
      const stopped = await run("systemctl", ["--user", "stop", unit], { timeout: 20_000 });
      const log = logOf(svc.id);
      appendFileSync(log, `\n===== ${iso()} — arrêt via systemd : ${unit} ${stopped.ok ? "(ok)" : `(échec : ${mask(stopped.stderr || stopped.error?.message || "").trim()})`} =====\n`);
      await new Promise((r) => setTimeout(r, 600));
      // Le reliquat de processus lancé à la main (port 3247, session ouverte…) est tué après l'unité.
      const after = await scan(true);
      for (const pid of roots((await statusOf(svc, after)).pids, after.procs)) await killTree(pid);
      await new Promise((r) => setTimeout(r, 800));
      saveState({ [svc.id]: { pid: null, mode: null, startedAt: null, lastError: null } });
      scanCache.at = 0;
      return true;
    }
    for (const pid of roots(st.pids, snap.procs)) await killTree(pid);
    await new Promise((r) => setTimeout(r, 800));
    saveState({ [svc.id]: { pid: null, mode: null, startedAt: null, lastError: null } });
    scanCache.at = 0;
    return true;
  }

  const actFns = new Map(); // type -> fn(ws, m) : réutilisé par l'API REST (agents), qui a son propre contrôle d'accès
  const action = (type, fn) => actFns.set(type, fn) && onMessage(type, async (ws, m) => {
    if (refuseInvoke(ws)) return;
    try { await fn(ws, m); } catch (e) { sendError(ws, mask(e?.message || ctx.safeError(e))); }
    await emit(true).catch(() => {});
    await emit(true, ws, m.ref ?? null).catch(() => {});
  });

  let lastListAt = 0; // la vue redemande l'état toutes les 10 s tant qu'elle est ouverte : sinon on ne scrute pas les processus
  onMessage("svc.list", async (ws, m) => { lastListAt = Date.now(); await emit(!!m.force, ws, m.ref ?? null); });
  action("svc.rename", async (_ws, m) => {
    const s = byId(m.id); if (!s) throw new Error("service inconnu");
    const names = { ...customNames() };
    const name = String(m.name ?? "").trim().slice(0, 60);
    if (name && name !== s.name) names[s.id] = name; else delete names[s.id];
    store.write("services-names", names);
  });
  action("svc.start", async (_ws, m) => { const s = byId(m.id); if (!s) throw new Error("service inconnu"); await startService(s, m.mode); });
  action("svc.stop", async (_ws, m) => { const s = byId(m.id); if (!s) throw new Error("service inconnu"); await stopService(s); });
  action("svc.restart", async (_ws, m) => {
    const s = byId(m.id); if (!s) throw new Error("service inconnu");
    const was = (await statusOf(s, await scan(true))).mode;
    await stopService(s);
    await startService(s, m.mode || was || undefined);
  });
  action("svc.group", async (_ws, m) => {
    const members = services.filter((s) => s.group === m.group && !s.optional);
    if (!members.length) throw new Error("groupe inconnu");
    if (m.action === "stop") { for (const s of [...members].reverse()) await stopService(s); return; }
    if (m.action !== "start") throw new Error("action inconnue");
    const errors = [];
    for (const s of members) { try { await startService(s, undefined); } catch (e) { if (e.message !== "déjà en marche") errors.push(`${s.name} : ${e.message}`); } }
    if (errors.length) throw new Error(errors.join(" ; "));
  });
  onMessage("svc.logs", (ws, m) => {
    if (refuseInvoke(ws)) return;
    const id = String(m.id || "");
    if (!byId(id) && !taskDefs().some((t) => `task-${t.id}` === id)) return sendError(ws, "service inconnu");
    send(ws, { type: "svc.logs", id, lines: tail(logOf(id), m.lines), ref: m.ref ?? null });
  });

  // --- Tâches ---
  action("svc.task.run", async (_ws, m) => {
    const id = String(m.id || "");
    const cur = runs.get(id);
    if (cur && !cur.endedAt) throw new Error("cette tâche tourne déjà");
    const t = buildTask(id, m.params || {});
    if (!existsSync(t.cwd)) throw new Error(`dossier introuvable : ${t.cwd}`);
    let argv = t.argv;
    if (t.profileOverride) {
      // Profil temporaire dash-<profil> : le profil d'origine n'est jamais modifié.
      const baseFile = join(t.cwd, "bot", "jobs", "profiles", `${t.profileOverride.base}.json`);
      const base = JSON.parse(readFileSync(baseFile, "utf8"));
      const { countries, keywords } = t.profileOverride.overrides;
      if (countries.length) base.countries = countries;
      if (keywords.length) base.keywords = keywords;
      base.name = `dash-${t.profileOverride.base}`;
      writeFileSync(join(t.cwd, "bot", "jobs", "profiles", `${base.name}.json`), `${JSON.stringify(base, null, 2)}\n`);
      argv = argv.map((a, i) => (argv[i - 1] === "--profile" ? base.name : a));
    }
    const fd = openLog(logOf(`task-${id}`), `${argv.join(" ")}`);
    const rec = { startedAt: Date.now(), params: m.params || {}, code: null, endedAt: null, error: null };
    const child = spawn(argv[0], argv.slice(1), { cwd: t.cwd, windowsHide: true, stdio: ["ignore", fd, fd], env: { ...cleanEnv(), PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" } });
    rec.child = child; rec.pid = child.pid;
    runs.set(id, rec);
    const finish = (code, error) => {
      if (rec.endedAt) return;
      rec.endedAt = Date.now(); rec.code = code; rec.error = error ?? null;
      try { closeSync(fd); } catch { /* déjà fermé */ }
      saveState({ [`task:${id}`]: { endedAt: iso(), code, startedAt: iso(rec.startedAt), params: rec.params, error: rec.error } });
      logRun({ bot: taskDefs().find((d) => d.id === id)?.bot ?? "?", label: `${id} (poste de commande)`, cmd: argv.join(" "), started: iso(rec.startedAt), ended: iso(), code });
      emit(true).catch(() => {});
    };
    child.on("error", (e) => finish(-1, mask(e.message)));
    child.on("exit", (code) => finish(code, code === 0 ? null : "terminé avec une erreur : voir le journal"));
  });
  action("svc.task.cancel", async (_ws, m) => {
    const r = runs.get(String(m.id || ""));
    if (!r || r.endedAt) throw new Error("rien à annuler");
    await killTree(r.pid);
  });
  onMessage("svc.task.logs", (ws, m) => {
    if (refuseInvoke(ws)) return;
    const id = String(m.id || "");
    if (!taskDefs().some((t) => t.id === id)) return sendError(ws, "tâche inconnue");
    send(ws, { type: "svc.logs", id: `task-${id}`, lines: tail(logOf(`task-${id}`), m.lines), ref: m.ref ?? null });
  });

  // --- Données ---
  onMessage("svc.data.query", (ws, m) => {
    try { send(ws, { type: "svc.data.result", ...queryDataset(m), ref: m.ref ?? null }); }
    catch (e) { sendError(ws, mask(e?.message || ctx.safeError(e))); }
  });
  readMarks = () => store.read("svc-marks", {}) || {};
  action("svc.mark", async (_ws, m) => {
    const ds = DATASETS[m.dataset];
    const id = String(m.id ?? "");
    if (!ds?.marks || !id || id.length > 200) throw new Error("paramètres invalides");
    const all = readMarks();
    const set = { ...(all[ds.id] || {}) };
    if (m.on) set[id] = Date.now(); else delete set[id];
    store.write("svc-marks", { ...all, [ds.id]: set });
  });
  const STATUSES = ["discovered", "review", "shortlisted", "prepared", "applied", "interview", "rejected", "withdrawn"];
  action("svc.job.status", async (_ws, m) => {
    const key = String(m.job_key || "");
    const profile = String(m.profile || "");
    if (!/^[\w.:-]{1,120}$/.test(key) || !/^[\w-]{1,60}$/.test(profile) || !STATUSES.includes(m.value)) throw new Error("paramètres invalides");
    const r = await run(PYTHON, ["-X", "utf8", "-m", "bot.jobs", "status", "--profile", profile, "--job", key, "--value", m.value], { cwd: BOT_STAGE });
    if (!r.ok) throw new Error(mask(r.stderr.split(/\r?\n/).filter(Boolean).pop() || "échec de la mise à jour"));
  });


  // --- API REST pour agents (Hermes, postectl) : mêmes fonctions que l'interface, mêmes validations ---
  if (typeof ctx.apiRoute === "function") {
    const api = ctx.apiRoute;
    const bad = (m, code = "bad_request") => new ApiError(400, code, m);
    const confirmed = (body, query) => body?.confirm === true || query?.get("confirm") === "true";
    const act = async (type, m) => {
      try { await actFns.get(type)(null, m); } catch (e) { throw bad(mask(e?.message || ctx.safeError(e))); }
      return buildState(true);
    };
    const view = async (id) => {
      const st = await buildState(true);
      return st.services.find((x) => x.id === id) ?? null;
    };
    api("GET", "/services", async () => {
      const st = await buildState(true);
      return { services: st.services, tasks: st.tasks.map((t) => ({ id: t.id, bot: t.bot, name: t.name, run: t.run, lastRun: t.lastRun, history: t.history, report: t.report, session: t.session })), bots: st.bots };
    });
    api("GET", "/services/:id/logs", async ({ params, query }) => {
      if (!byId(params.id)) throw bad("service inconnu", "not_found");
      return { lines: tail(logOf(params.id), Math.min(Number(query.get("lines")) || 60, 300)) };
    });
    api("POST", "/services/:id/start", async ({ params, body }) => { await act("svc.start", { id: params.id, mode: body?.mode }); return view(params.id); });
    api("POST", "/services/:id/stop", async ({ params, body, query }) => {
      if (!confirmed(body, query)) throw bad("arrêter un service exige confirm: true", "confirm_required");
      await act("svc.stop", { id: params.id }); return view(params.id);
    });
    api("POST", "/services/:id/restart", async ({ params, body, query }) => {
      if (!confirmed(body, query)) throw bad("relancer un service exige confirm: true", "confirm_required");
      await act("svc.restart", { id: params.id, mode: body?.mode }); return view(params.id);
    });
    api("POST", "/bots/tasks/:id/run", async ({ params, body }) => {
      await act("svc.task.run", { id: params.id, params: body?.params || {} });
      return { id: params.id, started: true };
    });
    api("POST", "/bots/tasks/:id/cancel", async ({ params }) => { await act("svc.task.cancel", { id: params.id }); return { id: params.id, cancelled: true }; });
    api("GET", "/bots/tasks/:id/logs", async ({ params, query }) => {
      if (!taskDefs().some((t) => t.id === params.id)) throw bad("tâche inconnue", "not_found");
      const r = runs.get(params.id);
      return { running: !!r && !r.endedAt, code: r?.code ?? null, lines: tail(logOf(`task-${params.id}`), Math.min(Number(query.get("lines")) || 60, 300)) };
    });
    api("GET", "/bots/data", async ({ query }) => {
      try {
        const r = queryDataset({ dataset: query.get("dataset"), q: query.get("q") || "", offset: Number(query.get("offset")) || 0, limit: Math.min(Number(query.get("limit")) || 20, 50), facets: {}, marked: query.get("marked") || "" });
        // Réponse allégée pour un agent : colonnes lisibles, pas de corps de message complet.
        return { dataset: r.dataset, available: r.available, total: r.total, offset: r.offset, columns: (r.columns || []).map((c) => c[0]), rows: (r.rows || []).map(({ _detail, ...x }) => x) };
      } catch (e) { throw bad(mask(e?.message || ctx.safeError(e))); }
    });
  }

  // Téléchargement d'un export : un bot connu, nom de fichier seul qui passe le filtre de ses fichiers.
  ctx.onHttp("/api/svc/file", (req, res, url) => {
    const def = FILE_DIRS[String(url.searchParams.get("bot") || "")];
    const name = basename(String(url.searchParams.get("name") || ""));
    if (!def || !def.keep(name)) { res.writeHead(400); return res.end("refusé"); }
    const file = join(def.dir(), name);
    if (!existsSync(file)) { res.writeHead(404); return res.end("introuvable"); }
    res.writeHead(200, {
      "content-type": FILE_TYPES[name.slice(name.lastIndexOf(".")).toLowerCase()] || "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`, "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(res);
  });

  // Diffusion au changement (processus lancés/arrêtés à la main inclus), seulement si un navigateur est connecté.
  const timer = setInterval(() => { if (Date.now() - lastListAt < 30_000) emit(false).catch(() => {}); }, 6_000);
  timer.unref?.();
  log("services", `${services.length} services, tâches : ${taskDefs().map((t) => t.id).join(", ")}`);
  return () => clearInterval(timer);
}
