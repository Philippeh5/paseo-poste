// Pilotage de FreqTrade depuis le poste de commande : un assistant lance le bot
// avec un choix en cascade (type de lancement → config → stratégie → options) puis
// exécute la commande CLI directement (spawn, jamais de shell, arguments séparés).
//
// Messages WS : freqtrade.list | freqtrade.launch {mode, config, strategy, ...}
//             | freqtrade.logs {id, lines?} | freqtrade.stop {id}
// Réponses : freqtrade.list {configs, strategies, pairs} | freqtrade.logs {id, lines}
//            freqtrade.state {id, running, pid, code, error, cmd}
import { spawn, execFile } from "node:child_process";
import {
  closeSync, existsSync, openSync, readSync, readdirSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";

const FREQTRADE_DIR = "/home/USERNAME/Projets/freqtrade";
const USERDIR = join(FREQTRADE_DIR, "user_data");
const STRATEGY_DIR = join(USERDIR, "strategies");
const LOG_DIR = join("/home/USERNAME/paseo-dash-data", "services-logs");
// Fichiers de donnees : <PAIR>-<TF>-<type>.feather dans user_data/data/<exchange>/<trading_mode>/.
const DATA_ROOT = join(USERDIR, "data");
const TF_MS = { "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000, "8h": 28800000, "12h": 43200000, "1d": 86400000, "1w": 604800000 };
const FREQTRADE_BIN = join(FREQTRADE_DIR, ".venv", "bin", "freqtrade");

// Paires affichées par défaut (whitelist du config principal).
const DEFAULT_PAIRS = [
  "BTC/USDT:USDT", "ETH/USDT:USDT", "JASMY/USDT:USDT", "RUNE/USDT:USDT",
  "TAO/USDT:USDT", "SOL/USDT:USDT", "JUP/USDT:USDT", "VET/USDT:USDT",
  "BNB/USDT:USDT", "LINK/USDT:USDT", "XRP/USDT:USDT", "CHZ/USDT:USDT",
  "RENDER/USDT:USDT", "COTI/USDT:USDT", "OCEAN/USDT:USDT", "ANKR/USDT:USDT",
  "TRX/USDT:USDT", "NEAR/USDT:USDT", "LTC/USDT:USDT", "AAVE/USDT:USDT",
  "GRT/USDT:USDT", "THETA/USDT:USDT",
];

const modes = [
  { id: "trade", label: "Normal (trade / dry_run selon config)" },
  { id: "backtest", label: "Backtest" },
  { id: "hyperopt", label: "Hyper optimisation (HyperOpt)" },
  { id: "download", label: "Télécharger les données (avant un backtest)" },
  { id: "freqai", label: "FreqIA (config_freqai.json)" },
];

const children = new Map(); // id -> { child, pid, startedAt, logfd, mode, config, strategy }

function nowIso() { return new Date(Date.now()).toISOString(); }
function clip(s, n = 300) { const t = String(s ?? ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }

function logPath(id) { return join(LOG_DIR, `freqtrade-${id}.log`); }
// Nom d'un fichier .feather -> paire lisible (BTC_USDT_USDT-5m-futures -> BTC/USDT:USDT).
function fileToPair(stem) {
  const parts = stem.split("_");
  if (parts.length < 3) return stem;
  return `${parts[0]}/${parts.slice(1, -1).join("_")}:${parts.at(-1)}`;
}

// Donnees deja presentes sur le disque (noms de fichiers) : instantane.
function listData() {
  const out = [];
  if (!existsSync(DATA_ROOT)) return out;
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const m = /^(.+)-([0-9]+[mhdw])-(futures|mark|funding_rate)\.feather$/.exec(entry.name);
      if (!m) continue;
      let size = 0;
      try { size = statSync(full).size; } catch { /* ignore */ }
      out.push({ pair: fileToPair(m[1]), timeframe: m[2], type: m[3], size });
    }
  };
  walk(DATA_ROOT);
  return out.sort((a, b) => a.pair.localeCompare(b.pair) || a.timeframe.localeCompare(b.timeframe));
}

// Plages reelles et nombre de bougies : `freqtrade list-data --show-timerange` (2 a 3 s), mis en cache 30 s.
let dataCache = { at: 0, rows: [] };
async function listDataRanges() {
  if (Date.now() - dataCache.at < 30000) return dataCache.rows;
  const res = await new Promise((done) => {
    execFile(FREQTRADE_BIN, ["list-data", "--userdir", USERDIR, "--exchange", "binanceusdm",
      "--trading-mode", "futures", "--show-timerange"],
      { cwd: FREQTRADE_DIR, timeout: 30000, windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONUNBUFFERED: "1" } },
      (error, stdout) => done({ ok: !error, stdout: stdout || "" }));
  });
  if (!res.ok) return dataCache.rows;
  const rows = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.includes("\u2502")) continue;
    // │ BTC/USDT:USDT │ 5m │ futures │ 2026-11-09 00:00:00 │ 2026-11-10 00:55:00 │ 300 │
    const cells = line.split("\u2502").map((c) => c.trim()).filter((c) => c && !/^[\u2500\u2502\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u253c\u2534\u2550-\u256c]+$/.test(c));
    if (cells.length < 5) continue;
    const pair = cells[0], timeframe = cells[1], type = cells[2];
    if (!/^[0-9]{4}-/.test(cells[3])) continue;
    rows.push({ pair, timeframe, type, from: cells[3].slice(0, 16), to: cells[4].slice(0, 16), candles: Number(cells[5]) || 0 });
  }
  dataCache = { at: Date.now(), rows };
  return rows;
}

function tail(file, lines = 120) {
  try {
    const size = statSync(file).size;
    if (!size) return [];
    // Lecture par la fin du fichier : on ne charge jamais tout un journal de plusieurs Mo.
    const fd = openSync(file, "r");
    try {
      const start = Math.max(0, size - 262144);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
    } finally { closeSync(fd); }
  } catch { return []; }
}
function openLog(id, header) {
  try { if (statSync(logPath(id)).size > 1_000_000) { try { renameSync(logPath(id), `${logPath(id)}.1`); } catch {} } } catch {}
  const fd = openSync(logPath(id), "a");
  writeFileSync(fd, `\n===== ${nowIso()} — ${header} =====\n`);
  return fd;
}

// Liste des configs (fichiers .json à la racine et dans user_data / user_data/strategies).
function listConfigs() {
  const seen = new Set();
  const out = [];
  const add = (file) => {
    const name = basename(file);
    if (name.endsWith(".json") && !seen.has(name)) {
      seen.add(name);
      out.push({ id: name, label: name, path: file });
    }
  };
  const dirs = [FREQTRADE_DIR, USERDIR, STRATEGY_DIR];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) add(join(d, f));
  }
  return out;
}

// Liste des stratégies (fichiers .py dans user_data/strategies).
function listStrategies() {
  if (!existsSync(STRATEGY_DIR)) return [];
  return readdirSync(STRATEGY_DIR)
    .filter((f) => f.endsWith(".py") && !f.startsWith("__") && !f.startsWith("sample_"))
    .sort()
    .map((f) => ({ id: f.slice(0, -3), label: f.slice(0, -3), path: join(STRATEGY_DIR, f) }));
}

export function register(ctx) {
  const { onMessage, send, broadcast, log } = ctx;
  if (typeof broadcast !== "function") throw new Error("ctx.broadcast requis");

  // --- Liste des choix disponibles (configs, stratégies, paires, modes) ---
  onMessage("freqtrade.list", (ws) => {
    try {
      send(ws, {
        type: "freqtrade.list",
        modes,
        configs: listConfigs(),
        strategies: listStrategies(),
        pairs: DEFAULT_PAIRS,
      });
    } catch (e) {
      send(ws, { type: "error", message: `freqtrade.list : ${clip(e.message)}` });
    }
  });

  // --- Lancement : construit la commande CLI et lance FreqTrade ---
  onMessage("freqtrade.launch", async (ws, m) => {
    try {
      const { mode, config, strategy, pairs = [], timerange = "", maxTrials = "50", dryRun = true } = m || {};
      if (!mode) throw new Error("mode de lancement requis");
      if (!config) throw new Error("config requise");
      if (!strategy && mode !== "freqai" && mode !== "download") throw new Error("stratégie requise");

      const configPath = join(FREQTRADE_DIR, config);
      if (!existsSync(configPath)) throw new Error(`config introuvable : ${config}`);

      const id = `ft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const args = [];

      if (mode === "backtest") args.push("backtesting");
      else if (mode === "hyperopt") args.push("hyperopt");
      else if (mode === "download") args.push("download-data");
      else if (mode === "freqai") args.push("trade");
      else args.push("trade");

      args.push("--config", config);
      args.push("--userdir", USERDIR);

      if (strategy) args.push("--strategy", strategy);
      if (mode === "freqai") args.push("--config", "config_freqai.json");
      else if (mode === "backtest" && timerange) args.push("--timerange", timerange);
      else if (mode === "hyperopt") {
        if (timerange) args.push("--timerange", timerange);
        args.push("--max-trials", String(maxTrials));
      }

      if (mode === "download") {
        if (pairs.length) args.push("--pairs", ...pairs);
        args.push("--timeframes", String(m.timeframes || "5m"), "--days", String(m.days || 30));
      } else if (pairs.length && (mode === "backtest" || mode === "hyperopt")) {
        args.push("-p", ...pairs);
      }
      if (mode !== "freqai" && mode !== "download" && dryRun === false) args.push("--disable-dry-run");

      const logfd = openLog(id, `freqtrade ${args.join(" ")}`);
      const child = spawn(FREQTRADE_BIN, args, {
        cwd: FREQTRADE_DIR,
        stdio: ["ignore", logfd, logfd],
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      });

      children.set(id, { child, pid: child.pid, startedAt: Date.now(), logfd, mode, config, strategy, args });

      let ended = false;
      const finish = (code, error) => {
        if (ended) return;
        ended = true;
        try { closeSync(logfd); } catch {}
        children.delete(id);
        const err = code === 0 ? null : (error || `code ${code}`);
        // Le journal n'est pas encore entierement sur le disque a l'instant de « exit » : on laisse 600 ms
        // au processus pour vider ses tampons, sinon on lisait un fichier vide.
        setTimeout(() => {
          let lines = [];
          try { lines = tail(logPath(id), 15); } catch { /* journal illisible : l'etat suffit */ }
          try { broadcast({ type: "freqtrade.state", id, running: false, code, error: err, lines, mode, config, strategy, cmd: args.join(" ") }); } catch { /* navigateurs absents */ }
        }, 600);
        // Et on previent tout de suite, pour que la vue quitte l'etat « en cours » sans attendre.
        try { broadcast({ type: "freqtrade.state", id, running: false, code, error: err, lines: [], mode, config, strategy, cmd: args.join(" ") }); } catch { /* ignore */ }
      };
      child.on("error", (e) => finish(-1, e.message));
      child.on("exit", (code) => finish(code, code === 0 ? null : `code ${code}`));

      send(ws, { type: "freqtrade.state", id, running: true, pid: child.pid, mode, config, strategy, cmd: args.join(" "), startedAt: nowIso() });
      log("freqtrade", `lancement id=${id} mode=${mode} config=${config} strategy=${strategy}`);
    } catch (e) {
      send(ws, { type: "error", message: `freqtrade.launch : ${clip(e.message)}` });
    }
  });

  // --- Donnees telechargees (disque + plages reelles via freqtrade list-data) ---
  onMessage("freqtrade.data", (ws) => {
    try { send(ws, { type: "freqtrade.data", files: listData() }); }
    catch (e) { send(ws, { type: "error", message: `freqtrade.data : ${clip(e.message)}` }); }
  });
  onMessage("freqtrade.ranges", async (ws) => {
    try { send(ws, { type: "freqtrade.ranges", ranges: await listDataRanges() }); }
    catch (e) { send(ws, { type: "error", message: `freqtrade.ranges : ${clip(e.message)}` }); }
  });

  // --- Logs d'un lancement ---
  onMessage("freqtrade.logs", (ws, m) => {
    try {
      const id = String(m?.id || "");
      if (!children.has(id) && !existsSync(logPath(id))) {
        return send(ws, { type: "freqtrade.logs", id, lines: [], error: "lancement inconnu" });
      }
      send(ws, { type: "freqtrade.logs", id, lines: tail(logPath(id), m.lines) });
    } catch (e) {
      send(ws, { type: "error", message: `freqtrade.logs : ${clip(e.message)}` });
    }
  });

  // --- Arrêt d'un lancement en cours ---
  onMessage("freqtrade.stop", async (ws, m) => {
    try {
      const id = String(m?.id || "");
      const rec = children.get(id);
      if (!rec) return send(ws, { type: "freqtrade.state", id, running: false, error: "inconnu" });
      // SIGTERM d'abord (FreqTrade peut ranger ses trades), puis SIGKILL s'il resiste.
      try { rec.child.kill("SIGTERM"); } catch { /* deja mort */ }
      const toKill = setTimeout(() => { try { rec.child.kill("SIGKILL"); } catch { /* deja mort */ } }, 4000);
      if (toKill.unref) toKill.unref();
      children.delete(id);
      broadcast({ type: "freqtrade.state", id, running: false, stopped: true, error: "arrêté par vous" });
      send(ws, { type: "freqtrade.state", id, running: false, stopped: true });
    } catch (e) {
      send(ws, { type: "error", message: `freqtrade.stop : ${clip(e.message)}` });
    }
  });

  return () => {
    for (const rec of children.values()) {
      try { rec.child.kill("SIGTERM"); } catch {}
      try { closeSync(rec.logfd); } catch {}
    }
    children.clear();
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
