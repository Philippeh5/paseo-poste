// dashboard/scripts/verify-jarvis-thread.mjs
// Vérification du ticket T43 : fil unique Jarvis (panneau + Telegram) et « dis à Jarvis de… ».
//   A : fonctions pures de handlers/jarvis.mjs (entrée du fil, plafond de 100, 6 derniers messages, mandat, faux LLM gardé).
//   B : instance JETABLE (port 7096, données jetables, aucun hôte joignable, faux LLM) : routes REST du pont Telegram, fil WS,
//       diffusion jarvis.msg, contexte de 6 messages tous canaux, plafond/persistance, refus sans mandat.
//   C : laboratoire RÉEL jetable (daemon Paseo jetable + faux moteur ACP, aucun modèle) : « dis à Jarvis de… » arrive bien dans la
//       session de l'orchestrateur du mandat actif (relu dans l'historique de la session), jamais sans mandat.
// Ne touche NI le serveur :7070 de Philippe, NI dashboard/data, NI hosts.json, NI son daemon, NI le vrai bot Telegram, NI aucun LLM.
// Usage : node dashboard/scripts/verify-jarvis-thread.mjs   (VERIFY_PART=a|b|c ; VERIFY_PORT, VERIFY_DAEMON_PORT ; VERIFY_KEEP=1)
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  CONTEXT_MESSAGES, THREAD_MAX, buildContext, fakeReplyFor, findOrchestrator, makeEntry, parseReply, planAction, threadHistory,
  trimThread,
} from "../handlers/jarvis.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const work = join(rootDir, ".foreman", "scratch", `t43-thread-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const PART = (process.env.VERIFY_PART || "").toLowerCase();
const run = (part) => PART === "" || PART === part;
const PORT = Number(process.env.VERIFY_PORT || 7096);
const DAEMON_PORT = Number(process.env.VERIFY_DAEMON_PORT || 6797);
if (PORT === 7070) throw new Error("le port 7070 est celui du serveur de Philippe : refusé");
const REAL_THREAD = join(dashboardDir, "data", "jarvis-thread.json");
const realBefore = existsSync(REAL_THREAD) ? statSync(REAL_THREAD).mtimeMs : null;

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);
async function until(fn, label, timeout = 10000, step = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  fail(`Délai dépassé : ${label}`);
  return null;
}
const slash = (p) => p.replace(/\\/g, "/");

const killers = [];
const killProc = (proc) => {
  if (!proc?.pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else proc.kill("SIGKILL");
  } catch { /* déjà arrêté */ }
};
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  for (const k of killers) { try { k(); } catch { /* déjà arrêté */ } }
  const realAfter = existsSync(REAL_THREAD) ? statSync(REAL_THREAD).mtimeMs : null;
  if (realAfter !== realBefore) fail("dashboard/data/jarvis-thread.json a été modifié (ne devait pas l'être)");
  else ok("dashboard/data/jarvis-thread.json intact (les données réelles ne sont pas touchées)");
  console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
  if (failed === 0 && passed > 0) console.log("VERIFY_JARVIS_THREAD_PASS");
  if (!(failed > 0 && process.env.VERIFY_KEEP === "1")) {
    try { rmSync(work, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* verrouillé */ }
  }
  process.exitCode = failed > 0 || passed === 0 ? 1 : 0;
}
process.on("uncaughtException", (e) => { fail("exception non interceptée", e?.stack || String(e)); finish(); });
process.on("unhandledRejection", (e) => { fail("rejet non géré", e?.stack || String(e)); finish(); });

// =====================================================================================================================
if (run("a")) {
  section("A : fonctions pures de handlers/jarvis.mjs");
  const e = makeEntry({ channel: "telegram", role: "user", text: "  Bonjour  " }, new Date("2026-10-21T10:00:00Z"));
  expect(e && e.channel === "telegram" && e.role === "user" && e.text === "Bonjour" && e.at === "2026-10-21T10:00:00.000Z"
    && typeof e.id === "string" && e.id.length >= 8 && !("summary" in e), "makeEntry : forme {id, at, channel, role, text}", JSON.stringify(e));
  expect(makeEntry({ channel: "telegram", role: "system", text: "x" }) === null, "makeEntry : rôle inconnu refusé");
  expect(makeEntry({ channel: "sms", role: "user", text: "x" }) === null, "makeEntry : canal inconnu refusé");
  expect(makeEntry({ channel: "panneau", role: "user", text: "   " }) === null, "makeEntry : texte vide refusé");
  expect(makeEntry({ channel: "panneau", role: "assistant", text: "mot ".repeat(1500) }).text.length === 2000, "makeEntry : 2000 caractères au plus");
  const secret = makeEntry({ channel: "telegram", role: "user", text: "ma clé token=abcdef1234567890SECRETVALUE ok", summary: "password: hunter2hunter2" });
  expect(!secret.text.includes("SECRETVALUE") && !secret.summary.includes("hunter2"), "makeEntry : secrets masqués (texte et résumé)", JSON.stringify(secret));
  const many = Array.from({ length: 130 }, (_, i) => ({ id: `m${i}` }));
  expect(trimThread(many).length === THREAD_MAX && trimThread(many)[0].id === "m30" && THREAD_MAX === 100, "trimThread : 100 derniers messages");
  expect(trimThread(null).length === 0, "trimThread : entrée invalide -> fil vide");

  const thread = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, at: new Date(Date.UTC(2026, 9, 21, 10, 0, i)).toISOString(), channel: i % 2 ? "telegram" : "panneau",
    role: i % 2 ? "assistant" : "user", text: `T${i}`, ...(i === 9 ? { summary: "Créer la tâche X" } : {}),
  }));
  const h = threadHistory(thread);
  expect(CONTEXT_MESSAGES === 6 && h.length === 6 && h[0].content === "T4" && h[0].role === "user", "threadHistory : 6 derniers messages", JSON.stringify(h));
  expect(new Set(thread.slice(-6).map((x) => x.channel)).size === 2, "threadHistory : les deux canaux sont mélangés dans ces 6 messages");
  expect(h[5].content.startsWith("T9") && h[5].content.includes("Créer la tâche X"), "threadHistory : une proposition garde son résumé");
  expect(threadHistory(thread, 6, thread[7].at).map((x) => x.content.slice(0, 2)).join() === "T8,T9", "threadHistory : `since` écarte les anciens");
  expect(threadHistory(undefined).length === 0, "threadHistory : entrée invalide -> vide");

  const mandate = { enabled: true, orchestratorTaskId: "t-orch" };
  expect(findOrchestrator({ enabled: false }, []).error?.includes("aucun mandat actif"), "findOrchestrator : sans mandat -> erreur claire");
  expect(findOrchestrator(undefined, []).error?.includes("aucun mandat actif"), "findOrchestrator : état absent -> erreur claire");
  expect(findOrchestrator({ enabled: true }, [{ id: "t-orch", agentId: "a1" }]).error?.includes("introuvable"), "findOrchestrator : mandat sans tâche d'orchestrateur -> erreur");
  expect(findOrchestrator(mandate, [{ id: "autre", agentId: "a2" }]).error?.includes("introuvable"), "findOrchestrator : tâche absente -> erreur");
  expect(findOrchestrator(mandate, [{ id: "t-orch", host: "oracle" }]).error?.includes("pas encore démarrée"), "findOrchestrator : session pas démarrée -> erreur");
  const target = findOrchestrator(mandate, [{ id: "autre", agentId: "a2" }, { id: "t-orch", host: "oracle", agentId: "a1" }]);
  expect(target.host === "oracle" && target.agentId === "a1" && !target.error, "findOrchestrator : hôte et session de l'orchestrateur", JSON.stringify(target));
  expect(findOrchestrator(mandate, [{ id: "t-orch", agentId: "a1" }]).host === "local", "findOrchestrator : hôte « local » par défaut");

  const tell = parseReply('{"mode":"poste","say":"Je transmets","poste":{"action":"tell_jarvis","args":{"text":"Pense aux tests"}}}');
  expect(tell?.mode === "poste" && tell.action === "tell_jarvis" && tell.args.text === "Pense aux tests", "parseReply : action tell_jarvis acceptée", JSON.stringify(tell));
  const plan = planAction(tell, { mandate });
  expect(!plan.error && plan.exec.length === 1 && plan.exec[0].type === "jarvis.tell" && plan.exec[0].text === "Pense aux tests"
    && plan.summary.includes("Dire à Jarvis"), "planAction : tell_jarvis -> résumé + exec jarvis.tell {text}", JSON.stringify(plan));
  expect(planAction(tell, { mandate: { enabled: false } }).error?.includes("aucun mandat actif"), "planAction : tell_jarvis sans mandat -> erreur, aucun exec");
  expect(planAction({ action: "tell_jarvis", args: { text: "  " } }, { mandate }).error?.includes("Que dois-je dire"), "planAction : tell_jarvis sans texte -> question");
  expect(planAction(tell, {}).exec?.length === 1, "planAction : sans info de mandat, la confirmation reste possible (le serveur refusera)");
  expect(buildContext({ state: {}, mandate }).includes("MANDAT DE JARVIS (orchestrateur) : actif"), "buildContext : mandat actif signalé au LLM");
  expect(buildContext({ state: {}, mandate: { enabled: false } }).includes("aucun mandat actif"), "buildContext : absence de mandat signalée au LLM");

  const env = { JARVIS_FAKE_REPLY: "{}", DASHBOARD_DATA_DIR: join(work, "x"), DASHBOARD_PORT: "7096" };
  expect(fakeReplyFor(env, join(work, "x")) === "{}", "faux LLM : actif dans une instance isolée");
  expect(fakeReplyFor({ ...env, DASHBOARD_DATA_DIR: join(dashboardDir, "data") }, join(dashboardDir, "data")) === null, "faux LLM : ignoré sur le dossier de données réel");
  expect(fakeReplyFor({ ...env, DASHBOARD_PORT: "7070" }, join(work, "x")) === null && fakeReplyFor({ ...env, DASHBOARD_PORT: undefined }, join(work, "x")) === null,
    "faux LLM : ignoré sur le port 7070 (ou port par défaut)");
  expect(fakeReplyFor({ JARVIS_FAKE_REPLY: "{}", DASHBOARD_PORT: "7096" }, join(work, "x")) === null, "faux LLM : ignoré sans DASHBOARD_DATA_DIR");
  expect(fakeReplyFor({ DASHBOARD_DATA_DIR: join(work, "x"), DASHBOARD_PORT: "7096" }, join(work, "x")) === null, "faux LLM : absent sans variable");
}

// =====================================================================================================================
// Outils des parties B et C : instance du tableau de bord jetable + client WebSocket « navigateur » + client REST.
const portFree = (port) => new Promise((resolve) => {
  const s = createConnection(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});
const waitPort = async (port, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!(await portFree(port))) return true; await sleep(250); }
  return false;
};
const cleanEnv = () => Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !/^(PASEO_|DASHBOARD_|POSTECTL_|COORD_|JARVIS_)/.test(k)));

async function startDash({ name, hostsFile, fake, data }) {
  if (!(await portFree(PORT))) throw new Error(`le port ${PORT} est déjà utilisé : définir VERIFY_PORT (rien n'est arrêté)`);
  const dir = data || join(work, `data-${name}`);
  mkdirSync(dir, { recursive: true });
  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], {
    env: {
      ...cleanEnv(), DASHBOARD_PORT: String(PORT), DASHBOARD_WSL: "0", DASHBOARD_DATA_DIR: dir, DASHBOARD_HOST: "127.0.0.1",
      DASHBOARD_HOSTS_FILE: hostsFile, DASHBOARD_COORD_WAKE: "0", JARVIS_FAKE_REPLY: fake,
    },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => { log += d; });
  proc.stderr.on("data", (d) => { log += d; });
  const handle = { proc, dir, log: () => log, stopped: false, stop() { if (!handle.stopped) { handle.stopped = true; killProc(proc); } } };
  killers.push(() => handle.stop());
  await until(() => log.includes("Paseo dashboard :"), `instance « ${name} » démarrée`, 40000, 100);
  expect(log.includes("chargé : jarvis.mjs") && !log.includes("échec de jarvis.mjs"), `instance « ${name} » : jarvis.mjs chargé sans erreur`, log.slice(-300));
  await until(async () => !(await portFree(PORT)), "port ouvert", 5000);
  return handle;
}
async function stopDash(h) {
  h.stop();
  await until(() => portFree(PORT), "port libéré", 15000, 200);
}

const BASE = `http://127.0.0.1:${PORT}`;
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: BASE });
  const all = [];
  let seq = 0;
  ws.on("message", (raw) => { try { all.push({ n: ++seq, m: JSON.parse(raw.toString()) }); } catch { /* ignoré */ } });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  killers.push(() => { try { ws.terminate(); } catch { /* fermé */ } });
  const c = {
    all, ws, mark: () => seq,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, label, timeout = 10000, from = 0) => until(() => all.find((x) => x.n > from && pred(x.m))?.m, label, timeout, 30),
    close: () => { try { ws.close(); } catch { /* fermé */ } },
  };
  // Demande puis attend la réponse typée (ou une erreur).
  c.ask = (msg, pred, label, timeout) => { const from = c.mark(); c.send(msg); return c.wait((m) => m.type === "error" || pred(m), label, timeout, from); };
  return c;
}
async function api(method, path, body, headers = {}) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: { "X-Agent-Name": "verify-t43", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const say = async (c, text, extra = {}) => {
  const id = `s${Math.random().toString(36).slice(2, 8)}`;
  const from = c.mark();
  c.send({ type: "jarvis.say", id, text, ...extra });
  const reply = await c.wait((m) => m.type === "jarvis.reply" && m.id === id, `réponse à « ${text.slice(0, 30)} »`, 20000, from);
  return { reply, from };
};

// =====================================================================================================================
if (run("b")) {
  section("B : instance jetable (faux LLM « écho » : répond avec l'historique que le LLM aurait reçu)");
  const hostsFile = join(work, "hosts-b.json");
  writeFileSync(hostsFile, JSON.stringify({ hosts: [{ label: "local", url: "ws://127.0.0.1:1/ws" }] }));
  const dataB = join(work, "data-b");
  let dash = await startDash({ name: "b-écho", hostsFile, fake: "__ECHO_HISTORY__", data: dataB });
  const c = await connect();

  // --- Pont Telegram : routes REST ---------------------------------------------------------------------------------
  const empty = await api("GET", "/jarvis/thread");
  expect(empty.status === 200 && empty.json?.ok && Array.isArray(empty.json.data?.messages) && empty.json.data.messages.length === 0,
    "GET /api/v1/jarvis/thread : fil vide au départ", JSON.stringify(empty));

  const postLog = (role, text, extra = {}, headers = {}) => api("POST", "/jarvis/log", { channel: "telegram", role, text, ...extra }, headers);
  let from = c.mark();
  const first = await postLog("user", "MSG-1 depuis Telegram");
  expect(first.status === 200 && first.json.ok && typeof first.json.data.id === "string", "POST /jarvis/log : message accepté", JSON.stringify(first));
  const live = await c.wait((m) => m.type === "jarvis.msg" && m.message?.text === "MSG-1 depuis Telegram", "diffusion jarvis.msg du message Telegram", 5000, from);
  expect(live?.message.channel === "telegram" && live.message.role === "user" && live.message.id === first.json.data.id && live.message.at,
    "jarvis.msg : {id, at, channel:telegram, role, text} diffusé au panneau", JSON.stringify(live));
  await postLog("assistant", "MSG-2 réponse du bot");

  const bad = [
    ["rôle inconnu", await postLog("system", "x")],
    ["canal panneau forcé", await postLog("user", "x", { channel: "panneau" })],
    ["texte vide", await postLog("user", "   ")],
    ["texte absent", await api("POST", "/jarvis/log", { channel: "telegram", role: "user" })],
    ["texte non textuel", await postLog("user", { a: 1 })],
    ["texte > 2000", await postLog("user", "mot ".repeat(501))],
    ["JSON invalide", await fetch(`${BASE}/api/v1/jarvis/log`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{pas json" })
      .then(async (r) => ({ status: r.status, json: await r.json() }))],
  ];
  for (const [label, r] of bad) expect(r.status === 400 && r.json?.ok === false, `POST /jarvis/log refuse : ${label}`, JSON.stringify(r));
  const exact = await postLog("user", "yyyyy ".repeat(400).slice(0, 2000));
  expect(exact.status === 200, "POST /jarvis/log : 2000 caractères exactement acceptés");
  const noChannel = await api("POST", "/jarvis/log", { role: "assistant", text: "MSG-3 sans canal" });
  expect(noChannel.status === 200, "POST /jarvis/log : canal omis accepté (imposé telegram)");
  const afterBad = (await api("GET", "/jarvis/thread")).json.data.messages;
  expect(afterBad.map((m) => m.text.slice(0, 5)).join() === "MSG-1,MSG-2,yyyyy,MSG-3" && afterBad.every((m) => m.channel === "telegram"),
    "les requêtes refusées n'ont rien ajouté ; tous les messages du pont ont le canal telegram", afterBad.map((m) => m.text.slice(0, 5)).join());
  const extra = await postLog("user", "MSG-4 avec champs en trop", { summary: "ignoré", exec: [{ type: "task.delete" }], id: "forgé", at: "1999-01-01" });
  const msg4 = (await api("GET", "/jarvis/thread")).json.data.messages.at(-1);
  expect(extra.status === 200 && !("summary" in msg4) && !("exec" in msg4) && msg4.id !== "forgé" && msg4.at !== "1999-01-01",
    "POST /jarvis/log : texte seulement (summary/exec/id/at fournis par le client ignorés)", JSON.stringify(msg4));

  const foreign = await api("POST", "/jarvis/log", { role: "user", text: "intrus" }, { Origin: "http://evil.example" });
  expect(foreign.status === 403, "POST /jarvis/log : Origin étrangère refusée (mêmes gardes que /api/v1)", JSON.stringify(foreign));
  const foreignHost = await new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: PORT, path: "/api/v1/jarvis/thread", headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve("erreur"));
    req.end();
  });
  expect(foreignHost === 403, "GET /jarvis/thread : nom d'hôte étranger refusé (DNS rebinding)", String(foreignHost));
  expect((await api("DELETE", "/jarvis/log")).status === 405, "DELETE /jarvis/log : méthode refusée (405)");

  const secretPost = await postLog("user", "voici ma clé token=abcdef1234567890SECRETVALUE et sk-abcdef1234567890ABCDEF");
  const fileText = readFileSync(join(dataB, "jarvis-thread.json"), "utf8");
  const apiText = JSON.stringify((await api("GET", "/jarvis/thread")).json);
  expect(secretPost.status === 200 && !fileText.includes("SECRETVALUE") && !apiText.includes("SECRETVALUE") && !apiText.includes("sk-abcdef1234567890ABCDEF"),
    "aucun secret dans le fil (ni dans l'API ni dans data/jarvis-thread.json)");

  const lim = async (q) => (await api("GET", `/jarvis/thread${q}`)).json.data.messages.length;
  const total = await lim("");
  expect([await lim("?limit=2"), await lim("?limit=0"), await lim("?limit=abc"), await lim("?limit=9999")].join() === `2,${total},${total},${total}`,
    "GET /jarvis/thread?limit= : bornée, valeur invalide -> tout", `${total}`);

  // --- Fil WebSocket + question du panneau : le LLM reçoit les messages Telegram ---------------------------------------
  const t0 = await c.ask({ type: "jarvis.thread" }, (m) => m.type === "jarvis.thread", "jarvis.thread");
  expect(t0.messages.length === total && t0.messages[0].text === "MSG-1 depuis Telegram", "WS jarvis.thread {messages} : le fil complet", `${t0.messages?.length}`);
  const t6 = await c.ask({ type: "jarvis.thread", limit: 6 }, (m) => m.type === "jarvis.thread", "jarvis.thread limit");
  expect(t6.messages.length === 6, "WS jarvis.thread {limit:6} : 6 derniers messages");

  from = c.mark();
  const { reply: r1 } = await say(c, "Bonjour Jarvis depuis le panneau");
  expect(r1.ok && r1.mode === "answer", "jarvis.say : réponse du faux LLM", JSON.stringify(r1));
  expect(/user:MSG-1 depuis Telegram|user:MSG-4/.test(r1.text) && r1.text.includes("assistant:MSG-3 sans canal"),
    "le contexte envoyé au LLM contient des messages venus de Telegram", r1.text.slice(0, 200));
  const tail = (await api("GET", "/jarvis/thread")).json.data.messages;
  const [qMsg, aMsg] = tail.slice(-2);
  expect(qMsg.channel === "panneau" && qMsg.role === "user" && qMsg.text === "Bonjour Jarvis depuis le panneau", "la question du panneau est ajoutée au fil (canal panneau)", JSON.stringify(qMsg));
  expect(aMsg.channel === "panneau" && aMsg.role === "assistant" && aMsg.text === r1.text && r1.messageId === aMsg.id,
    "la réponse est ajoutée au fil ; jarvis.reply porte son messageId", JSON.stringify({ aMsg: aMsg.id, id: r1.messageId }));
  const liveQ = await c.wait((m) => m.type === "jarvis.msg" && m.message?.id === qMsg.id, "diffusion jarvis.msg de la question", 3000, from);
  const liveA = await c.wait((m) => m.type === "jarvis.msg" && m.message?.id === aMsg.id, "diffusion jarvis.msg de la réponse", 3000, from);
  expect(liveQ && liveA && !("exec" in liveA.message), "jarvis.msg diffusé pour la question et la réponse (sans exec)");

  // 6 derniers messages seulement, tous canaux confondus.
  for (let i = 1; i <= 10; i++) await postLog(i % 2 ? "user" : "assistant", `SIX-${i}`);
  const { reply: r6 } = await say(c, "combien de messages ?");
  const seen = [...r6.text.matchAll(/SIX-(\d+)/g)].map((m) => Number(m[1]));
  expect(seen.join() === "5,6,7,8,9,10" && r6.text.split(" | ").length === 6, "le contexte = exactement les 6 derniers messages du fil", r6.text);
  await postLog("user", "MIX-telegram");
  const { reply: rMix } = await say(c, "mélange");
  expect(rMix.text.includes("user:MIX-telegram") && rMix.text.includes("user:combien de messages ?"),
    "canaux mélangés : message Telegram + question précédente du panneau dans les 6", rMix.text);
  const { reply: rSince } = await say(c, "nouvelle discussion", { since: new Date().toISOString() });
  expect(rSince.text === "(historique vide)", "jarvis.say {since} : « Nouvelle discussion » écarte les anciens messages du contexte", rSince.text);

  // --- Plafond de 100, persistance ---------------------------------------------------------------------------------------
  for (let i = 1; i <= 105; i++) await postLog("user", `CAP-${i}`);
  const capped = (await api("GET", "/jarvis/thread")).json.data.messages;
  expect(capped.length === 100 && capped[0].text === "CAP-6" && capped.at(-1).text === "CAP-105", "plafond : 100 derniers messages gardés", `${capped.length} ${capped[0].text}`);
  const onDisk = JSON.parse(readFileSync(join(dataB, "jarvis-thread.json"), "utf8"));
  expect(Array.isArray(onDisk) && onDisk.length === 100 && onDisk.at(-1).text === "CAP-105", "data/jarvis-thread.json : 100 messages, écrit par ctx.store");
  const leftovers = readdirSync(dataB).filter((f) => f.endsWith(".tmp"));
  expect(leftovers.length === 0, "écriture atomique : aucun fichier .tmp résiduel", leftovers.join());

  // --- Sans mandat : « dis à Jarvis » refusé, rien d'envoyé -------------------------------------------------------------
  const noMandate = await c.ask({ type: "jarvis.tell", text: "Pense aux tests" }, (m) => m.type === "jarvis.told", "jarvis.tell sans mandat");
  expect(noMandate.type === "error" && /aucun mandat actif/.test(noMandate.message) && /rien n'a été envoyé/.test(noMandate.message),
    "jarvis.tell sans mandat actif : erreur claire, rien n'est envoyé", noMandate.message);
  await sleep(500);
  expect(!c.all.some((x) => x.m.type === "jarvis.told"), "aucun jarvis.told reçu sans mandat");
  const emptyTell = await c.ask({ type: "jarvis.tell", text: "   " }, (m) => m.type === "jarvis.told", "jarvis.tell vide");
  expect(emptyTell.type === "error" && /vide/.test(emptyTell.message), "jarvis.tell avec texte vide : refusé", emptyTell.message);

  c.close();
  await stopDash(dash);

  // --- Redémarrage : le fil persiste ; action tell_jarvis proposée par le LLM (sans mandat -> pas de bouton) ---------------
  const actionFake = JSON.stringify({ mode: "poste", say: "Je lui transmets.", poste: { action: "tell_jarvis", args: { text: "Pense aux tests" } } });
  dash = await startDash({ name: "b-action", hostsFile, fake: actionFake, data: dataB });
  const afterRestart = (await api("GET", "/jarvis/thread")).json.data.messages;
  expect(afterRestart.length === 100 && afterRestart.at(-1).text === "CAP-105", "après redémarrage du serveur : le fil est conservé (100 messages)");
  const c2 = await connect();
  const { reply: rNo } = await say(c2, "dis à Jarvis de penser aux tests");
  expect(rNo.ok && rNo.mode === "answer" && !rNo.exec && /aucun mandat actif/.test(rNo.text),
    "jarvis.say « dis à Jarvis… » sans mandat : message d'erreur clair, aucune action à confirmer", JSON.stringify(rNo));
  c2.close();
  await stopDash(dash);
}

// =====================================================================================================================
async function lab() {
  const dir = join(work, "lab");
  const home = join(dir, "daemon-home");
  const probe = join(dir, "probe");
  for (const d of [home, probe]) mkdirSync(d, { recursive: true });
  const fakeCmd = [slash(process.execPath), slash(join(dashboardDir, "scripts", "fake-acp-agent.mjs"))];
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1,
    daemon: { listen: `127.0.0.1:${DAEMON_PORT}`, cors: { allowedOrigins: [] }, relay: { enabled: false } },
    pluginsEnabled: false,
    features: { dictation: { enabled: false }, voiceMode: { enabled: false } },
    agents: { providers: { hermes: { extends: "acp", label: "Faux moteur ACP (tests)", command: fakeCmd, env: { FAKE_ACP_PROBE_DIR: slash(probe) } } } },
  }, null, 2));
  if (!(await portFree(DAEMON_PORT))) throw new Error(`le port ${DAEMON_PORT} est déjà utilisé : définir VERIFY_DAEMON_PORT (rien n'est arrêté)`);
  const cli = join(rootDir, "node_modules", "@getpaseo", "cli", "bin", "paseo");
  const daemon = spawn(process.execPath, [cli, "daemon", "run", "--home", home], {
    env: { ...cleanEnv(), PASEO_HOME: home, PASEO_LISTEN: `127.0.0.1:${DAEMON_PORT}`, PASEO_DICTATION_ENABLED: "false", PASEO_VOICE_MODE_ENABLED: "false" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  killers.push(() => killProc(daemon));
  let daemonLog = "";
  daemon.stdout.on("data", (d) => { daemonLog += d; });
  daemon.stderr.on("data", (d) => { daemonLog += d; });
  if (!(await waitPort(DAEMON_PORT, 90000))) throw new Error(`daemon jetable non démarré : ${daemonLog.slice(-300)}`);
  const hostsFile = join(dir, "hosts.json");
  writeFileSync(hostsFile, JSON.stringify({ hosts: [{ label: "local", url: `ws://127.0.0.1:${DAEMON_PORT}/ws` }] }));
  return { dir, hostsFile };
}

if (run("c")) {
  section("C : laboratoire réel jetable (daemon Paseo jetable + faux moteur ACP) : « dis à Jarvis de… »");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
  let L = null;
  try { L = await lab(); } catch (e) { fail("laboratoire jetable démarré", e.message); }
  if (L) {
    const proj = join(L.dir, "labproj");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "a.txt"), "contenu\n");
    git(proj, "init", "-q");
    git(proj, "config", "user.email", "t43@example.invalid");
    git(proj, "config", "user.name", "t43");
    git(proj, "add", "-A");
    git(proj, "commit", "-q", "-m", "init");
    const P = slash(proj);
    const tellFake = JSON.stringify({ mode: "poste", say: "Je lui transmets.", poste: { action: "tell_jarvis", args: { text: "Pense aux tests" } } });
    const dash = await startDash({ name: "c-lab", hostsFile: L.hostsFile, fake: tellFake });
    const c = await connect();
    const bot = await connect(); // second client : le bot Telegram envoie jarvis.tell de la même façon (WS /ui)
    const stateOf = () => [...c.all].reverse().find((x) => x.m.type === "state")?.m.payload;
    await until(() => stateOf()?.hosts?.find((h) => h.label === "local")?.status === "connected", "daemon jetable connecté au tableau de bord", 60000, 200);

    const followed = await c.ask({ type: "project.follow", host: "local", dir: P }, (m) => m.type === "project.followed", "projet suivi");
    expect(followed.type === "project.followed" && followed.ok !== false, "projet de laboratoire suivi", JSON.stringify(followed));

    // Avant le mandat : refus.
    const before = await c.ask({ type: "jarvis.tell", text: "Avant mandat" }, (m) => m.type === "jarvis.told", "jarvis.tell avant mandat");
    expect(before.type === "error" && /aucun mandat actif/.test(before.message), "avant tout mandat : jarvis.tell refusé", before.message);

    // Mandat actif : l'orchestrateur est une session du faux moteur.
    const ref = `t43-${Date.now()}`;
    c.send({ type: "agentmode.enable", ref, project: P, brief: "Test T43 : ne rien faire", forbidden: [], launch: true, engine: "hermes/default" });
    const enabled = await c.wait((m) => m.type === "agentmode.state" && m.ref === ref && m.enabled, "mandat activé", 20000);
    expect(enabled?.enabled === true, "mandat activé (orchestrateur lancé sur le faux moteur)");
    const mandate = await until(async () => {
      c.send({ type: "agentmode.get" });
      await sleep(400);
      const s = [...c.all].reverse().find((x) => x.m.type === "agentmode.state")?.m;
      return s?.orchestratorTaskId && s.launch?.status === "started" ? s : null;
    }, "orchestrateur démarré (launch.status = started)", 60000, 200);
    let orchestrator = null;
    if (mandate) {
      const tl = await c.ask({ type: "task.list" }, (m) => m.type === "tasks", "liste des tâches");
      const task = tl.tasks?.find((t) => t.id === mandate.orchestratorTaskId);
      orchestrator = task?.agentId ? { host: task.host || "local", agentId: task.agentId, taskId: task.id } : null;
      expect(Boolean(orchestrator), "la tâche de l'orchestrateur porte son agentId", JSON.stringify(task && { id: task.id, host: task.host, agentId: task.agentId }));
    }

    if (orchestrator) {
      // Le fil de la session de l'orchestrateur, relu depuis l'historique de la session (vrai daemon).
      c.send({ type: "agent.watch", host: orchestrator.host, agentId: orchestrator.agentId });
      const watched = () => JSON.stringify(c.all.filter((x) => /^agent\./.test(x.m.type)).map((x) => x.m));
      await until(() => c.all.some((x) => x.m.type === "agent.history"), "historique de la session de l'orchestrateur", 20000, 100);

      // Proposition via « dis à Jarvis de… » : exec seulement pour le panneau qui a posé la question.
      const { reply } = await say(c, "dis à Jarvis de penser aux tests");
      expect(reply.ok && reply.mode === "action" && reply.exec?.length === 1 && reply.exec[0].type === "jarvis.tell"
        && reply.exec[0].text === "Pense aux tests" && /Dire à Jarvis/.test(reply.summary), "jarvis.say : proposition tell_jarvis -> exec jarvis.tell {text}", JSON.stringify(reply));
      const thread = (await api("GET", "/jarvis/thread")).json.data.messages;
      const proposal = thread.find((m) => m.id === reply.messageId);
      expect(proposal?.summary === reply.summary && proposal.channel === "panneau" && !JSON.stringify(thread).includes("jarvis.tell"),
        "le fil garde le résumé de la proposition mais JAMAIS l'exec (pas de bouton Confirmer ailleurs)", JSON.stringify(proposal));
      expect(!watched().includes("Pense aux tests"), "avant le clic Confirmer : rien n'a été envoyé à la session de l'orchestrateur");

      // Confirmation : le panneau envoie l'exec reçu.
      const told = await c.ask(reply.exec[0], (m) => m.type === "jarvis.told", "jarvis.told après confirmation");
      expect(told.type === "jarvis.told" && told.ok === true, "jarvis.tell (panneau) : accusé jarvis.told", JSON.stringify(told));
      const arrived = await until(() => watched().includes("Message de Philippe : Pense aux tests"),
        "le message arrive dans la session de l'orchestrateur", 30000, 200);
      expect(Boolean(arrived), "la session de l'orchestrateur a reçu « Message de Philippe : Pense aux tests »");

      // Le client du bot Telegram fait la même chose.
      const botTold = await bot.ask({ type: "jarvis.tell", text: "Depuis Telegram : relis le plan" }, (m) => m.type === "jarvis.told", "jarvis.told (bot)");
      expect(botTold.type === "jarvis.told", "jarvis.tell (client du bot Telegram) : accusé jarvis.told", JSON.stringify(botTold));
      expect(Boolean(await until(() => watched().includes("Message de Philippe : Depuis Telegram : relis le plan"),
        "message du bot reçu par l'orchestrateur", 30000, 200)), "la session de l'orchestrateur a reçu le message envoyé par le client du bot");
      expect(!watched().includes("Avant mandat"), "le message envoyé avant le mandat n'est jamais arrivé");

      // Reprise de la main : plus de mandat -> refus, rien n'arrive.
      const off = await c.ask({ type: "agentmode.disable", ref: `${ref}-off` }, (m) => m.type === "agentmode.state" && m.ref === `${ref}-off`, "mandat repris");
      expect(off.enabled === false, "mandat repris par Philippe");
      const after = await c.ask({ type: "jarvis.tell", text: "Après reprise" }, (m) => m.type === "jarvis.told", "jarvis.tell après reprise");
      expect(after.type === "error" && /aucun mandat actif/.test(after.message), "après reprise de la main : jarvis.tell refusé", after.message);
      await sleep(1500);
      expect(!watched().includes("Après reprise"), "le message envoyé sans mandat n'est jamais arrivé dans la session");
      // Nettoyage : tâche de l'orchestrateur (le daemon jetable est arrêté à la fin).
      c.send({ type: "task.stop", id: orchestrator.taskId });
      await sleep(500);
      c.send({ type: "task.delete", id: orchestrator.taskId });
    }
    c.close();
    bot.close();
    await stopDash(dash);
  }
}

finish();
