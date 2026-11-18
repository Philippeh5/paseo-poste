// dashboard/scripts/verify-telegramctl.mjs
// Vérification du ticket T48 : le tableau de bord lance, surveille et relance le bot Telegram (handlers/telegramctl.mjs).
// Tout est ISOLÉ : instance de test sur le port 7081 (jamais :7070), dossier de données temporaire, FAUX bot (un petit script
// Node, dossier « FakeTelegramAssistant » temporaire) désigné par TELEGRAM_BOT_CMD. Aucun jeton réel, aucun envoi Telegram,
// aucun appel LLM, rien dans dashboard/data ni dans D:\Projets\TelegramAssistant ; le vrai « python main.py » n'est jamais
// lancé ni arrêté (le superviseur ne reconnaît que les processus portant le dossier du faux bot).
// Parties (VERIFY_PART=a|b|c|d|e, toutes par défaut) :
//   a : reconnaissance du bot (fonction pure) + dossier / Python introuvables + refus d'un client interne (ctx.invoke)
//   b : lancement automatique, environnement filtré, état, restart (jamais deux vivants), survie au tableau de bord, arrêt/démarrage
//   c : adoption d'un bot déjà vivant (lancé par un .bat, ligne de commande relative), doublons, processus étrangers épargnés
//   d : arrêt forcé d'un bot qui ignore l'arrêt poli, abandon après 5 échecs avec attente croissante, compteur remis à zéro,
//       TELEGRAM_AUTOSTART=0
//   e : journal masqué / plafonné à 1 Mo, puis navigateur (Playwright) : bouton, confirmation, journal, deux thèmes, 390 px.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { findBot, mask, register } from "../handlers/telegramctl.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const shotDir = join(dashboardDir, "screenshots");
const work = join(rootDir, ".foreman", "scratch", `t48-verify-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7081);
const BASE = `http://127.0.0.1:${PORT}`;
const PARTS = (process.env.VERIFY_PART || "a,b,c,d,e").split(",");
const part = (p) => PARTS.includes(p);

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);
const json = (v) => JSON.stringify(v);

// ---------- Faux bot : écrit .heartbeat.json, note son lancement, se comporte selon mode.json ----------
const FAKE_BOT = String.raw`
const fs = require("fs"), path = require("path");
const dir = __dirname;
let mode = {};
try { mode = JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8")); } catch (e) {}
fs.appendFileSync(path.join(dir, "spawned.log"), JSON.stringify({ pid: process.pid, at: Date.now(), mode: mode.mode || "normal" }) + "\n");
fs.writeFileSync(path.join(dir, "env.json"), JSON.stringify({ keys: Object.keys(process.env), cwd: process.cwd(),
  token: process.env.TELEGRAM_BOT_TOKEN || null, apiKey: process.env.MY_SERVICE_API_KEY || null, pw: process.env.SOME_PASSWORD || null }));
const startedAt = new Date().toISOString();
const beat = () => fs.writeFileSync(path.join(dir, ".heartbeat.json"), JSON.stringify({ pid: process.pid, startedAt,
  lastSeenAt: new Date().toISOString(), version: "fake" }));
beat();
setInterval(beat, 200);
console.log("fake bot démarré pid " + process.pid);
if (mode.mode === "crash") {
  console.error("boom : le faux bot plante au démarrage");
  setTimeout(() => process.exit(mode.code === undefined ? 3 : mode.code), mode.afterMs === undefined ? 50 : mode.afterMs);
}
if (mode.mode === "stubborn") for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) { try { process.on(sig, () => {}); } catch (e) {} }
if (mode.mode === "chatty") {
  console.log("TELEGRAM_BOT_TOKEN=123456789:AAFakeTokenValue_abcdefghijklmnopqrstuv");
  console.log("Authorization: Bearer abcdefghijklmnop12345");
  console.log("password=hunter2hunter2 et jeton 987654321:AAOtherFakeToken_abcdefghijklmnopqrstu nu");
  console.error("GET https://api.telegram.org/bot123456789:AAFakeTokenValue_abcdefghijklmnopqrstuv/getUpdates");
  console.log("clé sk-abcdefghijklmnop1234567890 et api_key=EARLYSECRET99");
  const filler = "filler ".repeat(40);
  for (let i = 0; i < 12000; i++) {
    console.log("ligne de remplissage " + i + " " + filler);
    if (i % 3000 === 2999) console.log("rappel password=hunter2hunter2 et Bearer abcdefghijklmnop12345");
  }
  console.log("FINAL api_key=ZZZlatesecretZZZ");
}
`;

const procAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// Tue un processus et ses descendants (lecture des enfants via /proc).
const killTree = (pid) => {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* déjà mort */ }
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const cpid = Number(entry.name);
      try {
        const stat = readFileSync(`/proc/${cpid}/stat`, "utf8");
        const m = stat.match(/^\(\d+\)\s+\w\s+(\d+)/);
        if (m && Number(m[1]) === pid) killTree(cpid);
      } catch { /* */ }
    }
  } catch { /* /proc indisponible */ }
};
const tracked = new Set();   // pids à nous (décoys, bots lancés « à la main ») à supprimer à la fin

function makeScenario(name) {
  const base = join(work, name);
  const botDir = join(base, "FakeTelegramAssistant");
  const dataDir = join(base, "data");
  mkdirSync(botDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(botDir, "main.js"), FAKE_BOT);
  writeFileSync(join(botDir, "start_telegram_assistant.sh"), '#!/bin/sh\ncd "$(dirname "$0")"\nexec node main.js\n');
  try { fs.chmodSync(join(botDir, "start_telegram_assistant.sh"), 0o755); } catch { /* chmod non critique */ }
  writeFileSync(join(base, "hosts.json"), json({ hosts: [{ label: "local", url: "ws://127.0.0.1:1/ws" }] }));
  const spawnedFile = join(botDir, "spawned.log");
  const sc = {
    name, base, botDir, dataDir, hosts: join(base, "hosts.json"),
    mode: (m) => writeFileSync(join(botDir, "mode.json"), json(m)),
    spawned: () => (existsSync(spawnedFile) ? readFileSync(spawnedFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    fakes: () => sc.spawned().filter((e) => procAlive(e.pid)),
    stateFile: () => { try { return JSON.parse(readFileSync(join(dataDir, "telegram-bot.json"), "utf8")); } catch { return null; } },
    logFile: join(dataDir, "telegram-bot.log"),
    readLog: () => (existsSync(join(dataDir, "telegram-bot.log")) ? readFileSync(join(dataDir, "telegram-bot.log"), "utf8") : ""),
    waitSpawned: async (n, timeout = 15_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end && sc.spawned().length < n) await sleep(50);
      return sc.spawned().length >= n;
    },
    cleanup: () => {
      for (const e of sc.spawned()) killTree(e.pid);
      const st = sc.stateFile();
      if (st?.pid) killTree(st.pid);
    },
  };
  return sc;
}

function startDash(sc, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(DASHBOARD_|TELEGRAM_)/.test(key)) delete env[key];
  Object.assign(env, {
    DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: sc.dataDir, DASHBOARD_HOST: "127.0.0.1", DASHBOARD_HOSTS_FILE: sc.hosts,
    DASHBOARD_WSL: "0", DASHBOARD_COORD_WAKE: "0",
    TELEGRAM_BOT_DIR: sc.botDir, TELEGRAM_BOT_CMD: json(["node", "main.js"]),
    TELEGRAM_START_DELAY_MS: "0", TELEGRAM_POLL_MS: "150", TELEGRAM_STOP_GRACE_MS: "2000", TELEGRAM_VERIFY_MS: "1500",
    // secrets bidon du tableau de bord : le bot ne doit RIEN en recevoir
    TELEGRAM_BOT_TOKEN: "123456789:POISONtokenValueThatMustNeverReachTheBot", MY_SERVICE_API_KEY: "POISONapikey", SOME_PASSWORD: "POISONpw",
    ...extra,
  });
  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const srv = { proc, log: "" };
  proc.stdout.on("data", (d) => { srv.log += d; });
  proc.stderr.on("data", (d) => { srv.log += d; });
  return srv;
}
async function stopDash(srv, hard = true) {
  if (srv.proc.exitCode !== null) return;
  const gone = new Promise((r) => srv.proc.once("exit", r));
  srv.proc.kill(hard ? "SIGKILL" : undefined);
  await gone;
}
async function connect(srv) {
  for (let i = 0; i < 300 && !srv.log.includes("Paseo dashboard :"); i++) await sleep(100);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: BASE });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  let n = 0;
  const request = async (type, extra = {}, timeout = 15_000) => {
    const ref = `r${++n}`;
    ws.send(json({ type, ref, ...extra }));
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = inbox.findIndex((m) => m.ref === ref && (m.type === "telegramctl.state" || m.type === "telegramctl.logs" || m.type === "error"));
      if (i >= 0) return inbox.splice(i, 1)[0];
      await sleep(20);
    }
    fail(`Délai dépassé : ${type}`);
    return null;
  };
  const get = () => request("telegramctl.get");
  const until = async (pred, timeout, label) => {
    const end = Date.now() + timeout;
    let last = null;
    while (Date.now() < end) {
      last = await get();
      if (last && pred(last)) return last;
      await sleep(150);
    }
    fail(`Délai dépassé : ${label}`, json(last));
    return last;
  };
  return { ws, inbox, request, get, until, close: () => ws.close() };
}

const STATE_KEYS = ["running", "pid", "since", "adopted", "restarts", "lastExit", "lastError", "autostart"];

// ===================================================================================================================
if (part("a")) {
  section("a.1 : reconnaissance du bot (fonction pure, mêmes formes que le vrai poste)");
  const real = [
    { pid: 3832, ppid: 1, name: "sh", cmd: "/bin/sh" },
    { pid: 2204, ppid: 3832, name: "sh", cmd: "sh /home/USERNAME/Projets/TelegramAssistant/start_telegram_assistant.sh" },
    { pid: 2848, ppid: 2204, name: "node", cmd: "node main.js" },
    { pid: 11572, ppid: 2848, name: "node", cmd: "node main.js" },
    { pid: 9001, ppid: 1, name: "node", cmd: "node /home/USERNAME/autre/projet/main.js" },
    { pid: 9002, ppid: 1, name: "cat", cmd: "cat /home/USERNAME/Projets/TelegramAssistant/main.js" },
    { pid: 9003, ppid: 1, name: "node", cmd: "node /home/USERNAME/Projets/TelegramAssistant2/.venv/bin/node main.js" },
    { pid: 9004, ppid: 1, name: "node", cmd: "node -e x /home/USERNAME/Projets/TelegramAssistant/notmain.js" },
    { pid: 9005, ppid: 1, name: "node", cmd: "node main.js" },
    { pid: 9007, ppid: 1, name: "node", cmd: "node autre.js" },
  ];
  const opts = { dir: "/home/USERNAME/Projets/TelegramAssistant", script: "main.js", hbPid: 11572, selfPid: 1 };
  const f = findBot(real, opts);
  expect(json([...f.matched.keys()].sort((a, b) => a - b)) === "[2848,11572]", "forme réelle (ligne de commande relative, parent .sh) : 2848 et 11572 reconnus",
    json([...f.matched.keys()]));
  expect(json(f.roots.map((p) => p.pid)) === "[2848]", "une seule racine (2848) : on n'arrête que l'arbre du lanceur", json(f.roots.map((p) => p.pid)));
  for (const [pid, why] of [[9001, "autre dossier"], [9002, "processus non-RUNTIME (cat)"], [9003, "TelegramAssistant2"], [9004, "notmain.js"], [9005, "sans dossier"], [9007, "autre script"]]) {
    expect(!f.matched.has(pid), `processus étranger ${pid} (${why}) jamais reconnu comme le bot`);
  }
  expect(findBot(real, { ...opts, hbPid: 9007 }).matched.has(9007) === false, "un .heartbeat.json qui désigne un pid sans main.js ne suffit pas");
  expect(json([...findBot(real, { ...opts, hbPid: 9005 }).matched.keys()]).includes("9005"), "main.js + pid du battement = reconnu (même sans dossier dans sa ligne)");

  section("a.2 : masquage des secrets du journal");
  const masked = mask("TELEGRAM_BOT_TOKEN=123456789:AAFakeTokenValue_abcdefghijklmnopqrstuv puis bot987654321:AAOtherFakeToken_abcdefghijklmnopqrstu/getUpdates");
  expect(!/AAFake|AAOther|123456789:/.test(masked), "jetons Telegram masqués (clé=valeur et nus)", masked);

  section("a.3 : dossier / Python introuvables et refus d'un client interne (ctx.invoke) — en processus, sans rien lancer");
  const harness = async (sc, env, dataDir = sc.dataDir) => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
    const handlers = new Map();
    const sent = [];
    const errors = [];
    const ctx = {
      dataDir, onMessage: (t, h) => handlers.set(t, h), send: (ws, m) => sent.push(m), broadcast: (m) => sent.push({ ...m, broadcast: true }),
      sendError: (ws, m) => errors.push(m), log: () => {}, safeError: (e) => String(e?.message ?? e),
      store: { read: () => null, write: () => {} },   // jamais d'écriture dans dashboard/data
    };
    const dispose = register(ctx);
    const call = async (type, who = "ui", m = {}) => { await handlers.get(type)({ _uiId: `${who}:t` }, m); };
    return { sent, errors, call, handlers, done: () => { dispose(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
  };
  const realData = join(dashboardDir, "data");
  const absent = makeScenario("absent");
  let h = await harness(absent, { TELEGRAM_BOT_DIR: join(work, "n-existe-pas"), TELEGRAM_BOT_CMD: null, TELEGRAM_AUTOSTART: null }, realData);
  await sleep(2500);
  await h.call("telegramctl.get");
  let st = h.sent.filter((m) => m.type === "telegramctl.state").at(-1);
  expect(st && st.running === false && /^Dossier du bot introuvable/.test(st.lastError || ""), "dossier du bot introuvable : message clair dans l'état, aucune erreur", json(st));
  expect(st.available === true && st.autostart === true && st.nextRetryAt === null, "pas de boucle de relance quand le dossier manque", json(st));
  h.done();
  h = await harness(absent, { TELEGRAM_BOT_DIR: absent.botDir, TELEGRAM_BOT_CMD: null, TELEGRAM_AUTOSTART: null }, realData);
  await sleep(2500);
  await h.call("telegramctl.get");
  st = h.sent.filter((m) => m.type === "telegramctl.state").at(-1);
  expect(st && st.running === false && /^Python du bot introuvable/.test(st.lastError || ""), "Python du bot introuvable : message clair dans l'état", json(st));
  expect(!existsSync(join(absent.botDir, "spawned.log")), "rien n'a été lancé");
  h.done();

  const inv = makeScenario("invoke");
  h = await harness(inv, { TELEGRAM_BOT_DIR: inv.botDir, TELEGRAM_BOT_CMD: json(["node", "main.js"]), TELEGRAM_AUTOSTART: "0" });
  await sleep(1500);
  for (const type of ["telegramctl.restart", "telegramctl.start", "telegramctl.stop", "telegramctl.logs"]) {
    h.errors.length = 0;
    const before = h.sent.length;
    await h.call(type, "invoke");
    expect(h.errors.length === 1 && h.errors[0] === "Message réservé à l'interface." && h.sent.length === before,
      `${type} refusé à un appel interne (ctx.invoke), rien envoyé`, json(h.errors));
  }
  await h.call("telegramctl.get", "invoke");
  expect(h.sent.at(-1)?.type === "telegramctl.state", "telegramctl.get (lecture seule) reste permis à un appel interne");
  await h.call("telegramctl.logs", "ui");
  expect(h.sent.at(-1)?.type === "telegramctl.logs" && Array.isArray(h.sent.at(-1).lines), "telegramctl.logs permis à un client d'interface");
  expect(inv.spawned().length === 0, "aucun bot lancé pendant ces refus");
  h.done();
}

// ===================================================================================================================
if (part("b")) {
  section("b : lancement automatique, restart, survie au tableau de bord, arrêt/démarrage");
  const sc = makeScenario("b");
  let srv = startDash(sc);
  let c = await connect(srv);
  try {
    let s = await c.until((x) => x.running, 20_000, "bot lancé automatiquement");
    expect(STATE_KEYS.every((k) => k in s), `état complet (${STATE_KEYS.join(", ")})`, json(Object.keys(s)));
    expect(s.running && s.adopted === false && s.restarts === 0 && s.lastError === null && s.autostart === true,
      "lancement automatique : en marche, non adopté, 0 redémarrage, aucune erreur", json(s));
    expect(await sc.waitSpawned(1), "le faux bot a démarré");
    await sleep(800);
    expect(sc.spawned().length === 1 && sc.fakes().length === 1, "exactement UN faux bot vivant", json(sc.spawned()));
    const env1 = JSON.parse(readFileSync(join(sc.botDir, "env.json"), "utf8"));
    expect(env1.token === null && env1.apiKey === null && env1.pw === null, "secrets du tableau de bord absents de l'environnement du bot",
      json({ ...env1, keys: undefined }));
    expect(!env1.keys.some((k) => /^(DASHBOARD_|TELEGRAM_)/.test(k)), "aucune variable DASHBOARD_* / TELEGRAM_* transmise", json(env1.keys.filter((k) => /^(DASHBOARD_|TELEGRAM_)/.test(k))));
    expect(env1.keys.includes("PYTHONUNBUFFERED") && env1.keys.some((k) => /^path$/i.test(k)), "PATH conservé, PYTHONUNBUFFERED posé");
    expect(env1.cwd.toLowerCase() === sc.botDir.toLowerCase(), "répertoire de travail = dossier du bot", env1.cwd);
    const file = sc.stateFile();
    expect(file && file.pid === s.pid && typeof file.startedAt === "string" && "lastStop" in file, "data/telegram-bot.json : pid, date de lancement, dernière raison d'arrêt", json(file));
    expect(!/POISON/.test(json(file)) && !/POISON/.test(json(s)), "aucun secret dans l'état ni dans le fichier d'état");
    expect(sc.readLog().includes("lancement du bot par le tableau de bord"), "journal data/telegram-bot.log créé");
    const fake1 = sc.spawned()[0].pid;
    const relay1 = s.pid;
    expect(fake1 !== relay1 && procAlive(relay1) && procAlive(fake1), "relais (pid suivi) et bot vivants", json({ relay1, fake1 }));

    // --- restart : ancien mort, nouveau vivant, jamais deux en même temps
    c.inbox.length = 0;
    let maxAlive = 0;
    const sampler = setInterval(() => { maxAlive = Math.max(maxAlive, sc.fakes().length); }, 25);
    const t0 = Date.now();
    const r = await c.request("telegramctl.restart", {}, 60_000);
    const took = Date.now() - t0;
    await sc.waitSpawned(2);
    await sleep(500);
    clearInterval(sampler);
    expect(r?.type === "telegramctl.state" && r.running && r.pid !== relay1 && r.restarts === 1, "restart : nouvel état en marche, nouveau pid, restarts = 1", json(r));
    expect(!procAlive(relay1) && !procAlive(fake1), "restart : ancien relais ET ancien bot morts", json({ relay1: procAlive(relay1), fake1: procAlive(fake1) }));
    const fake2 = sc.spawned()[1]?.pid;
    expect(sc.spawned().length === 2 && fake2 && procAlive(fake2) && sc.fakes().length === 1, "restart : un seul nouveau bot vivant", json(sc.spawned()));
    expect(maxAlive <= 1, `jamais deux bots vivants en même temps (maximum observé : ${maxAlive}, échantillon toutes les 25 ms)`);
    expect(c.inbox.some((m) => m.type === "telegramctl.state" && m.busy === "restarting"), "diffusion telegramctl.state avec busy « restarting » pendant la relance");
    console.log(`     (restart en ${took} ms)`);

    // --- double clic : un seul restart
    const [x, y] = await Promise.all([c.request("telegramctl.restart", {}, 60_000), c.request("telegramctl.restart", {}, 60_000)]);
    await sleep(800);
    expect(sc.spawned().length === 3 && sc.fakes().length === 1 && x && y, "deux restart simultanés : un seul bot relancé (3 lancements au total, 1 vivant)", json(sc.spawned()));

    // --- le bot survit à l'arrêt brutal du tableau de bord et il est réadopté (pas de second lancement)
    const live = await c.get();
    const relay3 = live.pid;
    const fake3 = sc.spawned()[2].pid;
    c.close();
    await stopDash(srv, true);
    await sleep(1500);
    expect(procAlive(relay3) && procAlive(fake3), "tableau de bord tué : le relais et le bot survivent", json({ relay3: procAlive(relay3), fake3: procAlive(fake3) }));
    srv = startDash(sc);
    c = await connect(srv);
    s = await c.until((x2) => x2.running, 20_000, "bot réadopté");
    await sleep(1500);
    expect(s.pid === relay3 && s.adopted === true, "après relance du tableau de bord : même bot adopté", json(s));
    expect(sc.spawned().length === 3 && sc.fakes().length === 1, "aucun second bot lancé au retour du tableau de bord", json(sc.spawned()));

    // --- arrêt puis démarrage
    s = await c.request("telegramctl.stop", {}, 30_000);
    expect(s?.running === false && s.lastExit?.reason === "arrêt demandé", "stop : arrêté, raison « arrêt demandé »", json(s));
    expect(!procAlive(relay3) && !procAlive(fake3), "stop : relais et bot morts");
    await sleep(1500);
    expect(sc.spawned().length === 3 && (await c.get()).running === false, "stop : pas de relance automatique après un arrêt demandé");
    s = await c.request("telegramctl.start", {}, 30_000);
    await sc.waitSpawned(4);
    expect(s?.running === true && sc.spawned().length === 4 && sc.fakes().length === 1, "start : relancé, un seul vivant", json(s));
    const logsReply = await c.request("telegramctl.logs", { lines: 5 });
    expect(logsReply?.type === "telegramctl.logs" && logsReply.lines.length <= 5 && logsReply.lines.length > 0, "telegramctl.logs {lines:5}", json(logsReply));
  } finally {
    c.close();
    await stopDash(srv);
    sc.cleanup();
  }
}

// ===================================================================================================================
if (part("c")) {
  section("c.1 : adoption d'un bot déjà vivant lancé par un .sh (ligne de commande relative, comme le vrai poste)");
  let sc = makeScenario("c1");
  let srv = null;
  let c = null;
  try {
    const sh = spawn("sh", [join(sc.botDir, "start_telegram_assistant.sh")], { cwd: sc.botDir, detached: true, windowsHide: true, stdio: "ignore" });
    sh.unref();
    tracked.add(sh.pid);
    expect(await sc.waitSpawned(1), "faux bot lancé à la main par le .sh");
    const fakePid = sc.spawned()[0].pid;
    srv = startDash(sc);
    c = await connect(srv);
    let s = await c.until((x) => x.running, 20_000, "bot adopté");
    await sleep(2500);
    expect(s.pid === fakePid && s.adopted === true && s.lastError === null, "bot existant ADOPTÉ (même pid, adopted = true)", json({ s, fakePid }));
    expect(sc.spawned().length === 1 && sc.fakes().length === 1, "aucun second processus lancé", json(sc.spawned()));
    let maxAlive = 0;
    const sampler = setInterval(() => { maxAlive = Math.max(maxAlive, sc.fakes().length); }, 25);
    s = await c.request("telegramctl.restart", {}, 60_000);
    await sc.waitSpawned(2);
    await sleep(500);
    clearInterval(sampler);
    expect(!procAlive(fakePid) && !procAlive(sh.pid), "restart d'un bot adopté : ancien bot ET son lanceur .sh fermés", json({ bot: procAlive(fakePid), sh: procAlive(sh.pid) }));
    expect(s.running && s.adopted === false && sc.fakes().length === 1 && maxAlive <= 1, "nouveau bot lancé par le tableau de bord, jamais deux vivants", json({ s, maxAlive }));
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }

  section("c.2 : deux bots déjà vivants (doublon) -> avertissement, puis « Relancer » n'en garde qu'un");
  sc = makeScenario("c2");
  srv = null;
  c = null;
  try {
    for (let i = 0; i < 2; i++) {
      const ext = spawn("node", [join(sc.botDir, "main.js")], { cwd: sc.botDir, detached: true, windowsHide: true, stdio: "ignore" });
      ext.unref();
      tracked.add(ext.pid);
    }
    expect(await sc.waitSpawned(2), "deux faux bots lancés à la main");
    srv = startDash(sc);
    c = await connect(srv);
    let s = await c.until((x) => x.running, 20_000, "un des deux adopté");
    await sleep(1500);
    expect(s.adopted === true && /Plusieurs instances/.test(s.lastError || ""), "adopte l'un, avertit des « Plusieurs instances »", json(s));
    expect(sc.spawned().length === 2, "aucun troisième bot lancé", json(sc.spawned()));
    s = await c.request("telegramctl.restart", {}, 60_000);
    await sc.waitSpawned(3);
    await sleep(500);
    expect(sc.fakes().length === 1 && s.running && !/Plusieurs/.test(s.lastError || ""), "après « Relancer » : un seul bot vivant (les deux anciens arrêtés)", json({ s, alive: sc.fakes().length }));
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }

  section("c.3 : refus de tuer un processus qui n'est pas le bot (pid enregistré / pid du battement / main.js d'un autre dossier)");
  sc = makeScenario("c3");
  srv = null;
  c = null;
  try {
    const decoy1 = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, windowsHide: true, stdio: "ignore" });
    const decoy2 = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "main.js"], { detached: true, windowsHide: true, stdio: "ignore" });
    for (const d of [decoy1, decoy2]) { d.unref(); tracked.add(d.pid); }
    await sleep(500);
    // pid enregistré = décoy 1 ; battement du « bot » = décoy 2 (dont la ligne de commande cite main.js mais pas le dossier du bot)
    writeFileSync(join(sc.dataDir, "telegram-bot.json"), json({ pid: decoy1.pid, startedAt: new Date().toISOString(), adopted: false, launchedBy: "dashboard", lastStop: null }));
    writeFileSync(join(sc.botDir, ".heartbeat.json"), json({ pid: decoy2.pid, startedAt: new Date(Date.now() - 6e5).toISOString(),
      lastSeenAt: new Date(Date.now() - 6e5).toISOString(), version: "x" }));   // vieux battement : pid peut-être réutilisé
    srv = startDash(sc);
    c = await connect(srv);
    let s = await c.until((x) => x.running, 20_000, "vrai faux-bot lancé malgré les décoys");
    await sc.waitSpawned(1);
    expect(s.pid !== decoy1.pid && s.pid !== decoy2.pid && s.adopted === false, "les décoys ne sont PAS adoptés : un vrai bot est lancé", json({ s, d1: decoy1.pid, d2: decoy2.pid }));
    s = await c.request("telegramctl.restart", {}, 60_000);
    s = await c.request("telegramctl.stop", {}, 60_000);
    expect(procAlive(decoy1.pid) && procAlive(decoy2.pid), "restart puis stop : les deux décoys sont toujours vivants (rien d'étranger n'a été tué)", json({ d1: procAlive(decoy1.pid), d2: procAlive(decoy2.pid) }));
    expect(s.running === false && sc.fakes().length === 0, "et le vrai faux-bot, lui, est bien arrêté", json(s));
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }
}

// ===================================================================================================================
if (part("d")) {
  section("d.1 : bot qui ignore l'arrêt poli -> arrêt forcé");
  let sc = makeScenario("d1");
  let srv = null;
  let c = null;
  try {
    sc.mode({ mode: "stubborn" });
    srv = startDash(sc);
    c = await connect(srv);
    let s = await c.until((x) => x.running, 20_000, "bot têtu lancé");
    await sc.waitSpawned(1);
    const fake = sc.spawned()[0].pid;
    const polite = spawn(process.execPath, ["-e", `process.kill(${fake}, "SIGTERM")`], { stdio: "ignore" });
    await sleep(500);
    expect(procAlive(fake), `témoin : l'arrêt poli (SIGTERM) n'arrête PAS le faux bot têtu`);
    const t0 = Date.now();
    s = await c.request("telegramctl.restart", {}, 60_000);
    const took = Date.now() - t0;
    await sc.waitSpawned(2);
    expect(!procAlive(fake) && s.running && s.pid !== undefined && sc.fakes().length === 1, "restart : le bot têtu est arrêté de force, un nouveau est lancé", json({ s, took }));
    expect(took < 2000 + 15_000, `durée raisonnable (${took} ms, arrêt poli 2 s au plus configuré en test, 10 s en production)`);
    s = await c.request("telegramctl.stop", {}, 60_000);
    expect(!s.running && sc.fakes().length === 0, "stop d'un bot têtu : arrêté de force");
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }

  section("d.2 : bot qui plante au lancement -> attente croissante puis abandon au 5e échec, puis reprise manuelle");
  sc = makeScenario("d2");
  srv = null;
  c = null;
  try {
    const BACKOFF = [250, 500, 1000, 2000, 4000];
    sc.mode({ mode: "crash", code: 3, afterMs: 50 });
    srv = startDash(sc, { TELEGRAM_BACKOFF_MS: BACKOFF.join(",") });
    c = await connect(srv);
    let s = await c.until((x) => x.gaveUp === true, 60_000, "abandon après 5 échecs");
    const runs = sc.spawned();
    expect(runs.length === 5, "exactement 5 lancements puis abandon", json(runs.map((e) => e.at)));
    const gaps = runs.slice(1).map((e, i) => e.at - runs[i].at);
    expect(gaps.every((g, i) => g >= BACKOFF[i] - 30), `attente croissante respectée (écarts ${gaps.join(", ")} ms, minimum ${BACKOFF.slice(0, 4).join(", ")})`);
    expect(gaps.every((g, i) => i === 0 || g > gaps[i - 1] - 300), "écarts croissants");
    expect(s.running === false && /dès le lancement/.test(s.lastError) && /voir le journal/.test(s.lastError), "raison lisible : « le bot s'arrête dès le lancement : voir le journal »", s.lastError);
    expect(s.lastExit?.code === 3, "dernier code de sortie relayé (3)", json(s.lastExit));
    expect(sc.readLog().includes("boom"), "la sortie du bot qui plante est dans le journal");
    await sleep(3000);
    expect(sc.spawned().length === 5 && (await c.get()).running === false, "plus aucun lancement après l'abandon");
    sc.mode({ mode: "normal" });
    s = await c.request("telegramctl.start", {}, 30_000);
    await sc.waitSpawned(6);
    expect(s.running && s.gaveUp === false && s.lastError === null, "« start » après abandon : repart, compteur d'échecs remis à zéro", json(s));
    await c.request("telegramctl.stop", {}, 30_000);
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }

  section("d.3 : compteur d'échecs remis à zéro après une marche stable (réglage de test : 0,8 s au lieu de 10 min)");
  sc = makeScenario("d3");
  srv = null;
  c = null;
  try {
    sc.mode({ mode: "crash", code: 1, afterMs: 1300 });
    srv = startDash(sc, { TELEGRAM_BACKOFF_MS: "100,100,100,100,100", TELEGRAM_STABLE_MS: "800" });
    c = await connect(srv);
    await sc.waitSpawned(7, 60_000);
    const s = await c.get();
    expect(sc.spawned().length >= 7 && s.gaveUp === false && !/Abandon|abandon/.test(s.lastError || ""), `7 plantages espacés de plus de 0,8 s : jamais d'abandon (${sc.spawned().length} lancements)`, json(s));
    expect(s.restarts >= 6, "compteur de redémarrages affiché", String(s.restarts));
    await c.request("telegramctl.stop", {}, 30_000);
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }

  section("d.4 : TELEGRAM_AUTOSTART=0");
  sc = makeScenario("d4");
  srv = null;
  c = null;
  try {
    srv = startDash(sc, { TELEGRAM_AUTOSTART: "0" });
    c = await connect(srv);
    await sleep(3500);
    let s = await c.get();
    expect(s.running === false && s.autostart === false && s.lastError === null && s.nextRetryAt === null && sc.spawned().length === 0,
      "rien n'est lancé tout seul, autostart = false", json(s));
    s = await c.request("telegramctl.start", {}, 30_000);
    await sc.waitSpawned(1);
    expect(s.running === true && sc.fakes().length === 1, "« start » manuel lance quand même le bot", json(s));
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }
}

// ===================================================================================================================
if (part("e")) {
  section("e.1 : journal masqué et plafonné à 1 Mo");
  const sc = makeScenario("e1");
  let srv = null;
  let c = null;
  try {
    sc.mode({ mode: "chatty" });
    srv = startDash(sc);
    c = await connect(srv);
    await c.until((x) => x.running, 20_000, "bot bavard lancé");
    const end = Date.now() + 40_000;
    while (Date.now() < end && !(sc.readLog().includes("FINAL api_key=") || /FINAL api_key=\[masqué\]/.test(sc.readLog()))) await sleep(200);
    await sleep(500);
    const rotated = `${sc.logFile}.1`;
    const text = sc.readLog() + (existsSync(rotated) ? readFileSync(rotated, "utf8") : "");
    expect(!/hunter2|AAFake|AAOther|abcdefghijklmnop12345|EARLYSECRET|ZZZlatesecret|sk-abcdefghijklmnop/.test(text), "aucun secret du bot dans le journal ni dans le journal tourné");
    expect((text.match(/\[masqué\]/g) || []).length >= 2 && /rappel password \[masqué\]/.test(text),
      "les secrets encore présents dans les fichiers sont remplacés par [masqué]");
    const size = statSync(sc.logFile).size;
    expect(size <= 1_000_000, `journal ≤ 1 Mo (${size} octets)`);
    expect(existsSync(rotated), "rotation simple : ancien journal conservé en .log.1");
    const reply = await c.request("telegramctl.logs", { lines: 100000 });
    expect(reply.lines.length <= 200 && reply.lines.length > 50, `telegramctl.logs plafonné à 200 lignes (${reply.lines.length})`);
    expect(!/hunter2|AAFake|ZZZlatesecret/.test(json(reply)) && reply.lines.some((l) => l.includes("[masqué]")), "lignes renvoyées masquées");
    const small = await c.request("telegramctl.logs", { lines: 3 });
    expect(small.lines.length === 3, "telegramctl.logs {lines:3} -> 3 lignes");
    const s = await c.get();
    expect(!/POISON|hunter2|AAFake/.test(json(s)), "état sans secret");
  } finally {
    c?.close();
    if (srv) await stopDash(srv);
    sc.cleanup();
  }

  section("e.2 : navigateur (Playwright) — bouton, confirmation, journal, erreur, deux thèmes, 390 px");
  const ui = makeScenario("ui");
  let srv2 = null;
  let browser = null;
  try {
    let playwright = null;
    const candidates = ["playwright-core",
      "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs"];
    for (const p of candidates) {
      try { const mod = await import(p); playwright = mod.default || mod; break; } catch { /* suivant */ }
    }
    if (!playwright) throw new Error("playwright-core introuvable");
    srv2 = startDash(ui, { TELEGRAM_BACKOFF_MS: "200,300,400,500,600" });
    browser = await playwright.chromium.launch({ headless: process.env.T48_HEADED !== "1" });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console ${m.text()}`); });
    for (let i = 0; i < 300 && !srv2.log.includes("Paseo dashboard :"); i++) await sleep(100);
    await page.goto(`${BASE}/#agents`, { waitUntil: "domcontentloaded" });
    const button = page.locator("#topbar-telegram");
    await button.waitFor({ state: "visible", timeout: 10_000 });
    await ui.waitSpawned(1, 20_000);
    await button.click();
    const panel = page.locator("#telegram-panel");
    await panel.waitFor({ state: "visible", timeout: 3000 });
    const label = () => page.evaluate(() => document.querySelector("#telegram-ctl-label")?.textContent || "");
    await page.waitForFunction(() => /^En marche depuis/.test(document.querySelector("#telegram-ctl-label")?.textContent || ""),
      null, { timeout: 15_000 });
    expect(/^En marche depuis \d+ (s|min)$/.test((await label()).trim()), "état : « En marche depuis … »", await label());
    const detail = (await page.locator("#telegram-ctl-detail").innerText()).trim();
    expect(detail.includes("lancé par le tableau de bord") && /0 redémarrage$/.test(detail),
      "adopté ou lancé par le tableau de bord + redémarrages", detail);
    expect(await page.locator("#telegram-restart").innerText() === "Relancer Telegram"
      && await page.locator("#telegram-logs").innerText() === "Journal", "boutons « Relancer Telegram » et « Journal »");
    expect(await page.locator("#telegram-ctl-error").isHidden(), "aucun message d'erreur quand tout va bien");
    expect((await panel.innerText()).includes("Lecture seule"), "mention « Lecture seule » conservée (côté Telegram)");
    const clean = async (what) => {
      const sw = await page.evaluate(() => {
        const r = document.querySelector("#telegram-panel").getBoundingClientRect();
        return { doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
          body: [document.body.scrollWidth, document.body.clientWidth], panel: [Math.round(r.left), Math.round(r.right), innerWidth] };
      });
      expect(sw.doc[0] === sw.doc[1] && sw.body[0] <= sw.body[1], `${what} : scrollWidth === clientWidth`, json(sw));
      expect(sw.panel[0] >= 0 && sw.panel[1] <= sw.panel[2], `${what} : panneau entièrement dans la fenêtre`, json(sw.panel));
    };
    const shot = (name) => page.screenshot({ path: join(shotDir, `t48-${name}.png`) });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await clean("1280 px");
    await shot("panel-running-dark-1280");

    // confirmation intégrée : Annuler ne relance rien
    await page.locator("#telegram-restart").click();
    const dlg = page.locator("dialog[open]");
    await dlg.waitFor({ state: "visible", timeout: 3000 });
    const dlgText = await dlg.innerText();
    expect(dlgText.includes("Le bot sera arrêté puis relancé ; les messages envoyés pendant ce temps sont reçus ensuite."),
      "dialogue de confirmation avec le texte demandé", dlgText);
    expect(await panel.isVisible(), "le panneau reste ouvert derrière la confirmation");
    await shot("confirm-dark-1280");
    await dlg.locator("button", { hasText: "Annuler" }).click();
    await dlg.waitFor({ state: "detached", timeout: 3000 });
    await sleep(800);
    expect(ui.spawned().length === 1 && ui.fakes().length === 1, "Annuler : le bot n'est pas relancé");
    // clavier : Entrée sur le bouton, Échap ferme le dialogue sans fermer le panneau
    await page.locator("#telegram-restart").focus();
    await page.keyboard.press("Enter");
    await dlg.waitFor({ state: "visible", timeout: 3000 });
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 3000 });
    expect(await panel.isVisible(), "Échap ferme la confirmation mais pas le panneau");
    expect(await page.evaluate(() => document.activeElement?.id) === "telegram-restart", "le focus revient sur « Relancer Telegram »");

    // confirmation -> relance réelle du faux bot
    const oldFake = ui.spawned()[0].pid;
    await page.locator("#telegram-restart").click();
    await dlg.locator("button", { hasText: "Relancer" }).click();
    await page.waitForFunction(() => /Relance en cours|Relance demandée/.test(document.querySelector("#telegram-ctl-label")?.textContent || ""),
      null, { timeout: 8000 }).catch(() => {});
    const busyLabel = await label();
    expect(/Relance (en cours|demandée)/.test(busyLabel) || ui.spawned().length === 2, "pendant la relance : « Relance en cours… »", busyLabel);
    await page.waitForFunction(() => /^En marche depuis/.test(document.querySelector("#telegram-ctl-label")?.textContent || "")
      && /1 redémarrage$/.test(document.querySelector("#telegram-ctl-detail")?.textContent || ""), null, { timeout: 30_000 });
    await ui.waitSpawned(2, 10_000);
    expect(!procAlive(oldFake) && ui.spawned().length === 2 && ui.fakes().length === 1,
      "relance faite : ancien bot mort, un seul nouveau", json(ui.spawned()));
    expect(await page.locator("#telegram-restart").isEnabled(), "bouton de nouveau actif");

    // journal
    await page.locator("#telegram-logs").click();
    await dlg.waitFor({ state: "visible", timeout: 3000 });
    await page.waitForFunction(() => /lancement du bot/.test(document.querySelector(".telegram-log")?.textContent || ""), null, { timeout: 5000 });
    const logText = await page.locator(".telegram-log").innerText();
    expect(logText.includes("fake bot démarré") && !/POISON/.test(logText),
      "dialogue « Journal » : dernières lignes du bot, sans secret", logText.slice(0, 120));
    await shot("journal-dark-1280");
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 3000 });
    expect(await panel.isVisible(), "Échap ferme le journal, pas le panneau");

    // thème clair
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await shot("panel-running-light-1280");
    await page.locator("#telegram-restart").click();
    await dlg.waitFor({ state: "visible", timeout: 3000 });
    await shot("confirm-light-1280");
    await dlg.locator("button", { hasText: "Annuler" }).click();
    await page.locator("#telegram-logs").click();
    await dlg.waitFor({ state: "visible", timeout: 3000 });
    await shot("journal-light-1280");
    await page.keyboard.press("Escape");

    // 390 px : clair puis sombre
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    await clean("390 px clair");
    await shot("panel-running-light-390");
    await page.locator("#telegram-restart").click();
    await dlg.waitFor({ state: "visible", timeout: 3000 });
    await clean("390 px clair + confirmation");
    await shot("confirm-light-390");
    await dlg.locator("button", { hasText: "Annuler" }).click();
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.locator("#telegram-logs").click();
    await dlg.waitFor({ state: "visible", timeout: 3000 });
    await clean("390 px sombre + journal");
    await shot("journal-dark-390");
    await page.keyboard.press("Escape");
    await clean("390 px sombre");
    await shot("panel-running-dark-390");

    // panne : le faux bot plante en boucle -> abandon, message lisible
    ui.mode({ mode: "crash", code: 3, afterMs: 50 });
    await page.locator("#telegram-restart").click();
    await dlg.locator("button", { hasText: "Relancer" }).click();
    await page.waitForFunction(() => /abandonnée/.test(document.querySelector("#telegram-ctl-label")?.textContent || ""),
      null, { timeout: 60_000 });
    const errText = await page.locator("#telegram-ctl-error").innerText();
    expect(/dès le lancement/.test(errText) && /voir le journal/.test(errText), "panne : message d'erreur lisible dans le panneau", errText);
    const topLine = (await page.locator("#telegram-status").innerText()).trim();
    expect(/^Le bot est arrêté/.test(topLine) && await button.getAttribute("data-state") === "stopped",
      "panne : la ligne d'état et la pastille du haut disent « arrêté » (pas « répond »)", topLine);
    expect(await page.locator("#telegram-ctl[data-tone=danger] .led-danger").count() === 1,
      "panne : voyant en losange (forme) + texte, pas la couleur seule");
    await clean("390 px sombre en panne");
    await shot("panel-error-dark-390");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await shot("panel-error-light-1280");
    expect(problems.length === 0, "console sans erreur ni exception", problems.join(" | "));
  } catch (e) {
    fail("navigateur", e.stack || e.message);
  } finally {
    await browser?.close();
    if (srv2) await stopDash(srv2);
    ui.cleanup();
  }
}

for (const pid of tracked) killTree(pid);
console.log(`\n${passed} OK, ${failed} FAIL`);
process.exit(failed ? 1 : 0);
