// Superviseur du bot Telegram (T48) : le tableau de bord LANCE le bot (D:\Projets\TelegramAssistant), le SURVEILLE et
// offre « Relancer Telegram ». Le Daemon Paseo est un paquet tiers qu'on ne modifie pas : le bot s'accroche donc ici.
//
// PROCÉDURE POUR PHILIPPE
//   - Le raccourci « TelegramAssistant.lnk » du dossier Démarrage de Windows (shell:startup) peut être SUPPRIMÉ : le
//     tableau de bord lance déjà le bot (au démarrage du poste, via tools/start-poste.ps1 -> start-dashboard.ps1).
//     Ce fichier ne supprime rien : le raccourci reste en place tant que tu ne l'enlèves pas.
//   - Tant que le raccourci existe, le superviseur ADOPTE le bot qu'il a lancé (pas de doublon) : au démarrage il
//     cherche un bot déjà vivant (fichier d'état data/telegram-bot.json, .heartbeat.json du bot, liste des processus en
//     lecture seule) et, s'il en trouve un, ne lance rien. Le lancement attend 8 s après le démarrage du tableau de
//     bord pour laisser passer le bot du raccourci. Si un second bot apparaît quand même (deux bots avec le même jeton
//     se battent pour les messages), l'état affiche « Plusieurs instances » ; « Relancer Telegram » n'en garde alors
//     qu'une.
//   - Relancer le tableau de bord ne coupe pas le bot (processus détaché) : le tableau de bord le réadopte au retour.
//   - Fenêtre noire « start_telegram_assistant.bat » ouverte à la main : « Relancer Telegram » la ferme (seul le .bat
//     du dossier du bot est fermé) et relance le bot sans fenêtre. TELEGRAM_AUTOSTART=0 coupe le lancement automatique.
//
// FONCTIONNEMENT
//   - Commande : <TELEGRAM_BOT_DIR>\.venv\Scripts\python.exe main.py, cwd = dossier du bot (défaut
//     D:\Projets\TelegramAssistant). Sans shell (spawn à arguments séparés), fenêtre cachée, DÉTACHÉ. Le bot charge sa
//     propre configuration (.env de son dossier, via config.py) : ce module ne lit JAMAIS .env ni les fichiers de
//     jetons ; l'environnement transmis est celui du tableau de bord SANS les variables PASSWORD / SECRET / TOKEN /
//     API_KEY / CREDENTIAL ni DASHBOARD_*.
//   - Le bot est lancé par un petit relais (ce même fichier lancé avec --relay) qui lit sa sortie, masque les secrets
//     (lib/redact.mjs) et l'écrit dans data/telegram-bot.log (1 Mo au plus, puis rotation vers .log.1). Le relais
//     survit au tableau de bord et s'arrête avec le bot : tuer l'arbre du relais tue le bot, rien d'autre.
//   - Un seul bot à la fois : avant tout lancement, la liste des processus est lue (Get-CimInstance, lecture seule).
//     Un processus est « le bot » si c'est python/node, que sa ligne de commande contient main.py et qu'il porte le
//     dossier du bot (dans sa ligne de commande, dans celle d'un ancêtre, ou comme pid d'un .heartbeat.json de moins de
//     90 s). Aucun arrêt sans cette preuve ; « Relancer » arrête tous les processus ainsi reconnus.
//   - Surveillance : bot mort -> nouvelle tentative après 5 s, 15 s, 60 s, 3 min, 5 min ; abandon au 5e échec de suite
//     (« le bot s'arrête dès le lancement : voir le journal ») ; compteur remis à zéro après 10 min de marche.
//   - Messages WS : telegramctl.get | restart | start | stop | logs {lines?} ; réponses et diffusions
//     telegramctl.state / telegramctl.logs. start/stop/restart/logs sont refusés à un appel interne (ctx.invoke) : un
//     agent ne peut pas piloter le bot. L'heure du dernier battement reste fournie par telegram.mjs (telegram.status).
//   - Tests : sur un dossier de données autre que dashboard/data, le superviseur n'est actif QUE si TELEGRAM_BOT_CMD
//     (tableau JSON, ex. ["node","main.js"]) est donné, et les réglages TELEGRAM_BACKOFF_MS / STOP_GRACE_MS /
//     POLL_MS / VERIFY_MS / STABLE_MS / START_DELAY_MS ne sont lus que dans ce cas : une instance de test (ou un
//     script de vérification qui lance server.mjs) ne touche jamais au vrai bot.
import { spawn } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { redact } from "../lib/redact.mjs";
import { DEFAULT_BOT_DIR, STALE_MS } from "./telegram.mjs";

const HERE = fileURLToPath(import.meta.url);
const REAL_DATA_DIR = resolve(dirname(HERE), "..", "data");
const WIN = process.platform === "win32";
export const LOG_MAX = 1_000_000;
const LOG_LINE_MAX = 600;
const MAX_LOG_LINES = 200;
const MAX_FAILURES = 5;
const BACKOFF_MS = [5_000, 15_000, 60_000, 180_000, 300_000];
const STABLE_MS = 10 * 60_000;
const STOP_GRACE_MS = 10_000;
const START_DELAY_MS = 8_000;
const POLL_MS = 3_000;
const VERIFY_MS = 60_000;

// Masque les secrets (redact.mjs + jeton Telegram « 123456789:AA… » nu) AVANT toute troncature.
export const mask = (text) => redact(String(text).replace(/\b\d{6,}:[A-Za-z0-9_-]{25,}/g, "[masqué]"));
const clipLine = (s) => (s.length > LOG_LINE_MAX ? `${s.slice(0, LOG_LINE_MAX)}…` : s);

// Ajoute au journal ; au-delà de 1 Mo, l'ancien journal devient .log.1 et on repart d'un fichier vide.
export function appendLog(file, text) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { /* pas encore de journal */ }
    if (size + Buffer.byteLength(text) > LOG_MAX) {
      try { renameSync(file, `${file}.1`); } catch { try { writeFileSync(file, ""); } catch { /* ignoré */ } }
    }
    appendFileSync(file, text);
  } catch { /* le journal ne doit jamais faire tomber le superviseur ni le relais */ }
}

export function tailLines(file, limit = 100) {
  const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.trunc(Number(limit)) || 100));
  let text = "";
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally { closeSync(fd); }
  } catch { return []; }
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-n).map((l) => clipLine(mask(l)));
}

// ---------- Relais (lancé avec --relay) : lit la sortie du bot, la masque, l'écrit dans le journal ----------
function relayMain([logFile, cwd, cmdJson]) {
  const [cmd, ...args] = JSON.parse(cmdJson);
  const note = (s) => appendLog(logFile, `${mask(s)}\n`);
  const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      if (buffer.length > 20_000) { parts.push(buffer); buffer = ""; }
      if (parts.length) appendLog(logFile, parts.map((l) => `${clipLine(mask(l))}\n`).join(""));
    });
    stream.on("end", () => { if (buffer) note(clipLine(buffer)); buffer = ""; });
  }
  child.once("error", (e) => {
    note(`[telegramctl] impossible de lancer le bot : ${e.code || e.message}`);
    process.exit(127);
  });
  child.once("close", (code, signal) => {
    note(`[telegramctl] le bot s'est arrêté (code ${code ?? signal})`);
    process.exit(code ?? 1);
  });
}
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === HERE.toLowerCase() && process.argv[2] === "--relay") {
  relayMain(process.argv.slice(3));
}

// ---------- Liste des processus (lecture seule) et reconnaissance du bot ----------
const PS_LIST = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { "
  + "[pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; "
  + "start=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } } "
  + "| ConvertTo-Json -Compress";

// Renvoie [{pid, ppid, name, cmd, start}] ou null si la liste est illisible
// (alors on n'arrête rien et on ne lance rien).
export function listProcesses(timeoutMs = 20_000) {
  if (WIN) {
    return new Promise((done) => {
      let out = "";
      let finished = false;
      const finish = (value) => { if (!finished) { finished = true; clearTimeout(timer); done(value); } };
      const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => { out += d; });
      child.once("error", () => finish(null));
      child.once("close", () => {
        try {
          const data = JSON.parse(out);
          finish((Array.isArray(data) ? data : [data]).filter((p) => p && Number.isInteger(p.pid)));
        } catch { finish(null); }
      });
    });
  }
  // Linux : lecture de /proc (lecture seule, aucun envoi de signal).
  return new Promise((done) => {
    try {
      const procs = [];
      const now = Date.now();
      for (const entry of readdirSync("/proc", { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
          if (cmdline.length === 0) continue;
          let ppid = 0;
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const m = stat.match(/^\(\d+\)\s+\w\s+(\d+)/);
            if (m) ppid = Number(m[1]);
          } catch { /* stat illisible */ }
          const name = cmdline[0].split("/").pop() || `pid-${pid}`;
          const cmd = cmdline.join(" ");
          procs.push({ pid, ppid, name, cmd, start: now });
        } catch { /* processus disparu entre-temps */ }
      }
      done(procs);
    } catch { done(null); }
  });
}

const SEP = WIN ? "\\" : "/";
const norm = (s) => { let r = String(s ?? "").toLowerCase(); return WIN ? r.replaceAll("/", "\\") : r; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RUNTIME = /^(python[\d.]*|pythonw[\d.]*|py|node)(\.exe)?$/i;
// Le dossier du bot comme chemin entier (pas « TelegramAssistant2 »), le script comme argument à part entière.
const dirRegex = (dir) => new RegExp(`${esc(norm(dir).replace(new RegExp(`\\${SEP}+$`), ""))}(?![\\w.-])`);
const scriptRegex = (script) => new RegExp(`(^|[\\s"'${SEP}/])${esc(script.toLowerCase())}($|[\\s"'${SEP}])`);

// Découpe une ligne de commande en mots (guillemets groupés sous Windows, séparation par espaces sous Linux).
export function splitCmd(cmd) {
  const s = String(cmd ?? "");
  if (WIN) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2]);
    return out;
  }
  return s.split(/\s+/).filter(Boolean);
}

// Fonction pure : les processus qui SONT le bot, et leurs racines (ceux dont le parent n'est pas le bot).
// Identification STRICTE (on ne termine que ce qu'on est sûr d'avoir reconnu) : le programme est python/node, la ligne de
// commande n'a QU'UN argument, qui est le script du bot (« main.py » ou le chemin complet du script dans le dossier du bot) —
// donc ni « python -m black ...main.py », ni un autre outil qui cite le dossier — ET le processus prouve qu'il vient du dossier
// du bot : script en chemin complet dans ce dossier, programme du dossier (.venv\\Scripts\\python.exe), ou lancé par le .bat du bot
// (cmd.exe parent dont la ligne de commande contient le dossier suivi de \\ et start_telegram_assistant.bat), ou pid du battement
// de cœur ET même forme de ligne de commande. Un « python main.py » d'un autre projet n'est jamais reconnu.
export function findBot(procs, { dir, script, hbPid = null, selfPid = process.pid }) {
  const base = norm(dir).replace(new RegExp(`\\${SEP}+$`), "");
  const scriptName = String(script).toLowerCase();
  const fullScript = norm(base + SEP + script);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const matched = new Map();
  const shapeOk = (p) => {
    const t = splitCmd(p.cmd);
    if (t.length !== 2) return null;
    const arg = norm(t[1]);
    return arg === scriptName || arg === fullScript ? { exe: norm(t[0]), arg } : null;
  };
  for (const p of procs) {
    if (p.pid === selfPid || !RUNTIME.test(p.name || "")) continue;
    const pc = norm(p.cmd);
    if (/^node(\.exe)?$/i.test(p.name || "") && pc.includes("telegramctl.mjs") && pc.includes("--relay") && pc.includes(base)) {
      matched.set(p.pid, p); // relais lancé par ce superviseur
      continue;
    }
    const shape = shapeOk(p);
    if (!shape) continue;
    let own = shape.arg === fullScript || shape.exe.startsWith(base + SEP) || p.pid === hbPid;
    for (let q = byPid.get(p.ppid), i = 0; !own && q && i < 4; q = byPid.get(q.ppid), i++) {
      const c = norm(q.cmd);
      const viaBotDir = dirRegex(dir).test(c) && c.includes(`start_telegram_assistant${WIN ? ".bat" : ".sh"}`);
      const viaBat = /^cmd(\.exe)?$/i.test(q.name || "") && viaBotDir;
      // Sous Linux, le lanceur peut être sh/bash exécutant start_telegram_assistant.sh
      const viaShell = !WIN && q && /^(sh|bash|dash|zsh)$/i.test(q.name || "") && viaBotDir;
      const viaRelay = /^node(\.exe)?$/i.test(q.name || "") && c.includes("telegramctl.mjs") && c.includes("--relay") && c.includes(base);
      own = viaBat || viaShell || viaRelay;
    }
    if (own) matched.set(p.pid, p);
  }
  const roots = [...matched.values()].filter((p) => !matched.has(p.ppid));
  return { byPid, matched, roots };
}

// Le .bat / .sh de lancement manuel est fermé avec le bot qu'il a lancé.
function killTarget(root, byPid, dir) {
  const parent = byPid.get(root.ppid);
  const cmd = norm(parent?.cmd);
  const viaBotDir = dirRegex(dir).test(cmd) && cmd.includes(`start_telegram_assistant${WIN ? ".bat" : ".sh"}`);
  const viaBat = parent && /^cmd(\.exe)?$/i.test(parent.name) && viaBotDir;
  // Sous Linux, le lanceur peut être sh/bash exécutant start_telegram_assistant.sh
  const viaShell = !WIN && parent && /^(sh|bash|dash|zsh)$/i.test(parent?.name || "") && viaBotDir;
  return parent && (viaBat || viaShell) ? parent.pid : root.pid;
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const taskkill = (args) => new Promise((done) => {
  const child = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
  child.once("error", () => done(-1));
  child.once("close", (code) => done(code ?? -1));
});
async function waitDead(pid, ms) {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await sleep(100);
  return !alive(pid);
}
// Arrêt poli (fenêtre / SIGTERM) puis, après `graceMs`, arrêt forcé de l'arbre de processus. Vrai si le pid est mort.
async function terminate(pid, graceMs) {
  if (!alive(pid)) return true;
  if (WIN) {
    // code 0 = demande envoyée, on attend ; un processus sans fenêtre n'accepte que /F : inutile d'attendre alors
    if ((await taskkill(["/PID", String(pid), "/T"])) === 0) await waitDead(pid, graceMs);
    if (alive(pid)) await taskkill(["/PID", String(pid), "/T", "/F"]);
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /* déjà mort */ }
    if (!(await waitDead(pid, graceMs))) { try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ } }
  }
  return waitDead(pid, 5_000);
}

const SECRET_ENV = /PASSWORD|SECRET|TOKEN|API_?KEY|CREDENTIAL/i;
// réglages du tableau de bord (et du superviseur) : le bot n'a pas à les connaître
const OWN_ENV = new RegExp("^(DASHBOARD_|TELEGRAM_(BOT_DIR|BOT_CMD|AUTOSTART|BACKOFF_MS|STOP_GRACE_MS|POLL_MS|VERIFY_MS"
  + "|STABLE_MS|START_DELAY_MS)$)");
export const botEnv = (env = process.env) => ({
  ...Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k) && !OWN_ENV.test(k))),
  PYTHONUNBUFFERED: "1",
  PYTHONIOENCODING: "utf-8",
});

// Pid écrit par le bot dans .heartbeat.json, seulement si le battement est frais
// (un vieux fichier peut citer un pid réutilisé par un autre programme).
function readHeartbeatPid(dir) {
  try {
    const hb = JSON.parse(readFileSync(join(dir, ".heartbeat.json"), "utf8"));
    const age = Date.now() - Date.parse(hb?.lastSeenAt);
    return Number.isInteger(hb?.pid) && age <= STALE_MS && age >= -5_000 ? hb.pid : null;
  } catch { return null; }
}

const num = (value, fallback) => {
  const n = Number(value);
  return value !== "" && value != null && Number.isFinite(n) ? n : fallback;
};

function resolveConfig(dataDir, env = process.env) {
  const real = resolve(dataDir).toLowerCase() === REAL_DATA_DIR.toLowerCase();
  const dir = env.TELEGRAM_BOT_DIR || DEFAULT_BOT_DIR;
  const cfg = {
    real, dir, log: join(dataDir, "telegram-bot.log"), active: real, why: null,
    autostart: env.TELEGRAM_AUTOSTART !== "0",
    cmd: WIN ? join(dir, ".venv", "Scripts", "python.exe") : join(dir, ".venv", "bin", "python"), args: ["main.py"],
    backoff: BACKOFF_MS, graceMs: STOP_GRACE_MS, pollMs: POLL_MS, verifyMs: VERIFY_MS, stableMs: STABLE_MS,
    startDelayMs: START_DELAY_MS,
  };
  if (!real) {
    if (env.TELEGRAM_BOT_CMD) {
      try {
        const parsed = JSON.parse(env.TELEGRAM_BOT_CMD);
        if (!Array.isArray(parsed) || parsed.length < 2 || parsed.some((x) => typeof x !== "string" || !x)) {
          throw new Error("format");
        }
        [cfg.cmd, ...cfg.args] = parsed;
        cfg.active = true;
      } catch { cfg.why = "TELEGRAM_BOT_CMD invalide (tableau JSON de 2 textes au moins attendu)."; }
      if (cfg.active) {
        if (env.TELEGRAM_BACKOFF_MS) {
          const list = env.TELEGRAM_BACKOFF_MS.split(",").map(Number).filter((n) => n >= 0);
          if (list.length) cfg.backoff = list;
        }
        cfg.graceMs = num(env.TELEGRAM_STOP_GRACE_MS, cfg.graceMs);
        cfg.pollMs = num(env.TELEGRAM_POLL_MS, cfg.pollMs);
        cfg.verifyMs = num(env.TELEGRAM_VERIFY_MS, cfg.verifyMs);
        cfg.stableMs = num(env.TELEGRAM_STABLE_MS, cfg.stableMs);
        cfg.startDelayMs = num(env.TELEGRAM_START_DELAY_MS, cfg.startDelayMs);
      }
    } else cfg.why = "Supervision désactivée : instance de test (dossier de données différent de dashboard/data).";
  }
  cfg.script = basename(cfg.args[cfg.args.length - 1]);
  return cfg;
}

export function register(ctx) {
  const { onMessage, send, broadcast, sendError } = ctx;
  const cfg = resolveConfig(ctx.dataDir);
  const log = (...a) => ctx.log("telegramctl", ...a);
  const iso = (t = Date.now()) => new Date(t).toISOString();
  const saved = (() => { try { return ctx.store.read("telegram-bot", null); } catch { return null; } })();

  const st = {
    pid: null, since: null, adopted: false, restarts: 0, lastExit: saved?.lastStop ?? null, lastError: cfg.why,
    busy: null, retryAt: null, gaveUp: false, failures: 0,
  };
  let wanted = cfg.active && cfg.autostart;
  let hadRun = false;
  let lastVerify = Date.now();
  const stopping = new Set();

  const publicState = () => ({
    available: cfg.active, running: st.pid !== null, pid: st.pid, since: st.since, adopted: st.adopted,
    restarts: st.restarts,
    lastExit: st.lastExit, lastError: st.lastError ? mask(st.lastError) : null, autostart: cfg.active && cfg.autostart,
    busy: st.busy, gaveUp: st.gaveUp, nextRetryAt: st.retryAt && st.pid === null && wanted ? iso(st.retryAt) : null,
  });
  let lastSig = "";
  const persist = () => {
    try {
      ctx.store.write("telegram-bot", {
        pid: st.pid, startedAt: st.since, adopted: st.adopted, launchedBy: st.adopted ? "externe" : "dashboard",
        lastStop: st.lastExit, updatedAt: iso(),
      });
    } catch { /* disque en lecture seule : l'état reste en mémoire */ }
  };
  const emit = () => {
    const state = publicState();
    const sig = JSON.stringify(state);
    if (sig === lastSig) return;
    lastSig = sig;
    broadcast({ type: "telegramctl.state", ...state, ref: null });
  };

  // Opérations (lancement, arrêt, relance) l'une après l'autre : jamais deux en même temps.
  let chain = Promise.resolve();
  let pending = 0;
  const enqueue = (fn) => {
    pending++;
    const result = chain.then(fn);
    chain = result.catch(() => {}).finally(() => { pending--; emit(); });
    return result;
  };

  async function scan() {
    const procs = await listProcesses();
    if (!procs) return null;
    const hbPid = readHeartbeatPid(cfg.dir);
    return { ...findBot(procs, { dir: cfg.dir, script: cfg.script, hbPid }), hbPid };
  }

  // Racine préférée : celle du pid déjà enregistré par une exécution précédente, puis celle du battement,
  // puis la plus ancienne.
  function adopt(found) {
    const beats = (r) => r.pid === found.hbPid || found.matched.get(found.hbPid)?.ppid === r.pid;
    const rank = (r) => (r.pid === saved?.pid ? 2 : 0) + (beats(r) ? 1 : 0);
    const byAge = (a, b) => String(a.start).localeCompare(String(b.start));
    const ordered = [...found.roots].sort((a, b) => rank(b) - rank(a) || byAge(a, b));
    const keep = ordered[0];
    st.pid = keep.pid;
    st.since = keep.start || iso();
    st.adopted = true;
    st.retryAt = null;
    st.gaveUp = false;
    st.lastError = ordered.length > 1
      ? duplicatesWarning(ordered)
      : null;
    hadRun = true;
    persist();
    log(`bot déjà en marche (pid ${keep.pid}) : adopté, aucun second lancement`);
  }

  // Dossier ou Python du bot introuvable : message clair dans l'état, jamais d'erreur ni de boucle de relance.
  const configProblem = () => {
    if (!existsSync(cfg.dir)) return `Dossier du bot introuvable : ${cfg.dir}`;
    if (/[\\/]/.test(cfg.cmd) && !existsSync(cfg.cmd)) return `Python du bot introuvable : ${cfg.cmd}`;
    return null;
  };

  const duplicatesWarning = (roots) => `Plusieurs instances du bot détectées (pids ${roots.map((r) => r.pid).join(", ")}) `
    + ": « Relancer Telegram » n'en garde qu'une.";

  function launch() {
    const problem = configProblem();
    if (problem) { st.lastError = problem; st.retryAt = null; return false; }
    if (hadRun) st.restarts++;
    hadRun = true;
    const relayArgs = [HERE, "--relay", cfg.log, cfg.dir, JSON.stringify([cfg.cmd, ...cfg.args])];
    let child;
    try {
      child = spawn(process.execPath, relayArgs, {
        cwd: cfg.dir, detached: true, windowsHide: true, stdio: "ignore", env: botEnv(),
      });
    } catch (e) { st.lastError = `Lancement impossible : ${ctx.safeError(e)}`; st.retryAt = null; return false; }
    child.unref();
    if (!child.pid) { st.lastError = "Lancement impossible : processus non créé."; st.retryAt = null; return false; }
    const pid = child.pid;
    st.pid = pid;
    st.since = iso();
    st.adopted = false;
    st.retryAt = null;
    st.lastError = null;
    appendLog(cfg.log, `[telegramctl] lancement du bot par le tableau de bord (relais pid ${pid})\n`);
    child.once("error", (e) => onGone(pid, null, `lancement impossible (${e.code || e.message})`));
    child.once("exit", (code) => onGone(pid, code));
    persist();
    log(`bot lancé (relais pid ${pid})`);
    return true;
  }

  const onGone = (...args) => { gone(...args); emit(); };
  function gone(pid, code, why = null) {
    if (st.pid !== pid) return;
    const uptime = Date.now() - Date.parse(st.since);
    const intended = stopping.has(pid);
    st.pid = null;
    st.lastExit = { at: iso(), code, reason: intended ? "arrêt demandé" : (why || "le bot s'est arrêté seul") };
    persist();
    if (intended || !wanted) return;
    if (uptime >= cfg.stableMs) st.failures = 0;
    st.failures++;
    const codeText = code == null ? "" : ` (code ${code})`;
    if (st.failures >= MAX_FAILURES) {
      st.gaveUp = true;
      st.retryAt = null;
      st.lastError = uptime < 60_000
        ? `Le bot s'arrête dès le lancement${codeText} : voir le journal. ${MAX_FAILURES} échecs de suite, abandon.`
        : `Le bot s'est arrêté ${MAX_FAILURES} fois de suite${codeText} : voir le journal. Abandon.`;
      log(st.lastError);
      return;
    }
    const delay = cfg.backoff[Math.min(st.failures - 1, cfg.backoff.length - 1)];
    st.retryAt = Date.now() + delay;
    const wait = Math.max(1, Math.round(delay / 1000));
    st.lastError = `Le bot s'est arrêté${codeText} ; nouvelle tentative dans ${wait} s `
      + `(échec ${st.failures}/${MAX_FAILURES}).`;
    log(st.lastError);
  }

  // Adopte un bot vivant, sinon en lance un. Appelé au démarrage, après chaque délai de reprise et par « Démarrer ».
  async function ensureRunning() {
    if (st.pid !== null && alive(st.pid)) return;
    const found = await scan();
    if (!found) {
      st.lastError = "Liste des processus illisible : lancement différé pour ne pas créer un second bot.";
      st.retryAt = Date.now() + 15_000;
      return;
    }
    if (found.roots.length) { adopt(found); return; }
    launch();
  }

  async function stopAll(found) {
    const results = { stopped: [], refused: [] };
    if (st.pid !== null && !found.matched.has(st.pid) && alive(st.pid)) {
      results.refused.push(st.pid);
      log(`pid ${st.pid} ne correspond pas au bot (sans ${cfg.script} ni dossier du bot dans sa ligne de commande) : `
        + "non arrêté");
      st.lastError = `Le pid ${st.pid} n'est pas celui du bot : laissé en place.`;
      st.pid = null;
    }
    for (const root of found.roots) {
      const target = killTarget(root, found.byPid, cfg.dir);
      stopping.add(root.pid);
      let dead = await terminate(target, cfg.graceMs);
      if (dead && target !== root.pid && alive(root.pid)) dead = await terminate(root.pid, cfg.graceMs);
      if (!dead) {
        stopping.delete(root.pid);
        throw new Error(`le bot (pid ${root.pid}) ne s'arrête pas`);
      }
      results.stopped.push(root.pid);
      if (st.pid === root.pid) onGone(root.pid, null);
      stopping.delete(root.pid);
    }
    if (st.pid !== null && !alive(st.pid)) onGone(st.pid, null);
    return results;
  }

  async function restartBot() {
    wanted = true;
    st.failures = 0;
    st.gaveUp = false;
    st.retryAt = null;
    st.busy = "restarting";
    emit();
    try {
      const found = await scan();
      if (!found) {
        throw new Error("liste des processus illisible : relance annulée (aucun bot arrêté, aucun second bot créé)");
      }
      await stopAll(found);
      st.lastError = null;
      launch();
    } catch (e) {
      st.lastError = `Relance impossible : ${mask(ctx.safeError(e))}`;
      throw e;
    } finally { st.busy = null; }
  }

  async function startBot() {
    wanted = true;
    st.failures = 0;
    st.gaveUp = false;
    st.lastError = null;
    await ensureRunning();
  }

  async function stopBot() {
    wanted = false;
    st.retryAt = null;
    st.busy = "stopping";
    emit();
    try {
      const found = await scan();
      if (!found) throw new Error("liste des processus illisible : arrêt annulé");
      await stopAll(found);
    } finally { st.busy = null; }
  }

  // Surveillance : le pid suivi est-il vivant, le bot est-il toujours « le bot », faut-il relancer ?
  let ticking = false;
  async function tick() {
    if (ticking || !cfg.active || pending > 0) return;
    ticking = true;
    try {
      const now = Date.now();
      if (st.pid !== null) {
        if (!alive(st.pid)) onGone(st.pid, null);
        else {
          if (st.failures && now - Date.parse(st.since) >= cfg.stableMs) st.failures = 0;
          if (now - lastVerify >= cfg.verifyMs) {
            lastVerify = now;
            const found = await scan();
            if (found && st.pid !== null) {
              if (!found.matched.has(st.pid)) onGone(st.pid, null, "le pid suivi n'est plus le bot");
              else if (found.roots.length > 1) {
                st.lastError = duplicatesWarning(found.roots);
              }
            }
          }
        }
      } else if (wanted && !st.gaveUp && st.retryAt && now >= st.retryAt) {
        await enqueue(ensureRunning);
      }
    } catch (e) { log(`surveillance : ${mask(ctx.safeError(e))}`); } finally { ticking = false; emit(); }
  }

  const refuseInvoke = (ws) => {
    if (!String(ws?._uiId ?? "").startsWith("invoke:")) return false;
    sendError(ws, "Message réservé à l'interface.");
    return true;
  };
  const reply = (ws, m) => send(ws, { type: "telegramctl.state", ...publicState(), ref: m.ref ?? null });
  let acting = false;
  const action = (type, fn) => onMessage(type, async (ws, m) => {
    if (refuseInvoke(ws)) return;
    if (!cfg.active) return sendError(ws, cfg.why || "Supervision du bot indisponible.");
    if (!st.busy && !acting) {
      acting = true; // un double clic ne relance pas deux fois
      try { await enqueue(fn); } catch (e) { sendError(ws, mask(ctx.safeError(e))); } finally { acting = false; }
    }
    reply(ws, m);
  });
  onMessage("telegramctl.get", (ws, m) => reply(ws, m));
  action("telegramctl.restart", restartBot);
  action("telegramctl.start", startBot);
  action("telegramctl.stop", stopBot);
  onMessage("telegramctl.logs", (ws, m) => {
    if (refuseInvoke(ws)) return;
    send(ws, { type: "telegramctl.logs", lines: tailLines(cfg.log, m.lines), ref: m.ref ?? null });
  });

  // Démarrage : adopter un bot déjà vivant tout de suite ; sinon lancer après le délai
  // (le bot du raccourci Démarrage passe d'abord).
  let timer = null;
  if (cfg.active) {
    log(`supervision du bot : ${cfg.dir} (${cfg.real ? "réel" : "test"}), `
      + `lancement automatique ${cfg.autostart ? "activé" : "désactivé"}`);
    enqueue(async () => {
      const found = await scan();
      if (!found) {
        st.lastError = "Liste des processus illisible : adoption impossible.";
        if (wanted) st.retryAt = Date.now() + 15_000;
        return;
      }
      if (found.roots.length) return adopt(found);
      if (saved?.pid && alive(saved.pid)) {
        log(`pid ${saved.pid} (état précédent) est vivant mais n'est pas le bot : ignoré`);
      }
      const problem = wanted ? configProblem() : null;
      if (problem) st.lastError = problem;
      else if (wanted) st.retryAt = Date.now() + cfg.startDelayMs;
    }).catch(() => {}).finally(emit);
    timer = setInterval(tick, cfg.pollMs);
    timer.unref?.();
  }
  return () => clearInterval(timer); // le bot, lui, continue de tourner
}
