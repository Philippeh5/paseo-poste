// dashboard/scripts/verify-decide.mjs
// Vérification de TASK B du ticket T29 : outil « décider » (POST /api/v1/decide -> Laya), postectl decide, MCP post_decide.
// Serveurs isolés (ports 7092 / 18765..18768, dossier de données temporaire) : ne touche ni au :7070 ni au Laya de Philippe.
// - faux Laya (petit serveur HTTP de test) : succès, entrée invalide 400, Laya injoignable 503, panne 503, plafonds
// - démarrage paresseux (faux exécutable = node + module d'amorçage) : variables LAYA_HOST/PORT/MODELS, jamais 0.0.0.0,
//   arrêt de Laya à la sortie du processus et après un arrêt brutal du tableau de bord (sentinelle)
// - appels journalisés dans l'historique d'activité (sans le texte de l'état) ; postectl decide ; MCP post_decide
// - test RÉEL avec le vrai Laya si LAYA_BIN (ou le chemin par défaut) existe : résultat marqué [RÉEL] ; sinon [IGNORÉ]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratchDir = join(rootDir, ".foreman", "scratch", `t29-decide-${process.pid}`);
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7092);
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_PORT = 18765;
const CLOSED_PORT = 18769;
const REAL_BIN = process.env.LAYA_BIN || "D:\\Projets\\AI-OS\\paseo-poste\\.foreman\\laya-test\\.venv\\Scripts\\laya-serve.exe";

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);

// ---------- Faux Laya ----------
const seen = [];
let fakeMode = "ok";
const fake = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* ignoré */ }
    seen.push({ method: req.method, url: req.url, body });
    const reply = (status, payload, raw) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(raw ?? JSON.stringify(payload));
    };
    if (fakeMode === "500") return reply(500, { detail: "boom" });
    if (fakeMode === "422") return reply(422, { detail: [{ msg: "champ invalide" }] });
    if (fakeMode === "html") return reply(200, null, "<html>pas du json</html>");
    if (fakeMode === "slow") { await sleep(11_000); return reply(200, { answers: {} }); }
    const answers = {};
    for (const [name, q] of Object.entries(body?.questions || {})) {
      answers[name] = q.type === "choice" ? { choice: Object.keys(q.criteria)[0], confidence: 0.9 }
        : q.type === "noul" ? { noul: 0.12 } : { score: 1.5 };
    }
    reply(200, { answers });
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", r));

// ---------- Serveur du tableau de bord ----------
function startServer(extraEnv = {}, port = PORT, dataDir = join(scratchDir, "data")) {
  // T47 : Von jamais lancé ici (port fermé, exécutable absent) ; son test est dans verify-decide-von.mjs.
  const noVon = { VON_URL: `http://127.0.0.1:${CLOSED_PORT}/v1/systemone`, VON_BIN: join(scratchDir, "inexistant-von.exe") };
  const env = { ...process.env, DASHBOARD_PORT: String(port), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_HOST: "127.0.0.1", ...noVon, ...extraEnv };
  delete env.DASHBOARD_PASSWORD;
  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const srv = { proc, log: "", base: `http://127.0.0.1:${port}` };
  proc.stdout.on("data", (d) => { srv.log += d; });
  proc.stderr.on("data", (d) => { srv.log += d; });
  return srv;
}
async function ready(srv) {
  for (let i = 0; i < 300 && !srv.log.includes("Paseo dashboard :"); i++) await sleep(100);
  return srv;
}
async function stopServer(srv) {
  if (srv.proc.exitCode !== null) return;
  const gone = new Promise((r) => srv.proc.once("exit", r));
  srv.proc.kill();
  await gone;
}
const post = async (srv, path, body, raw) => {
  const res = await fetch(`${srv.base}/api/v1${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Name": "verify-decide" },
    body: raw ?? JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};
const get = async (srv, path) => (await (await fetch(`${srv.base}/api/v1${path}`)).json());

const q1 = { harness: { type: "choice", instructions: "Quel agent ?", criteria: { claude_code: "code", hermes: "admin", pi: "recherche" } },
  destructive: { type: "noul", instructions: "Est-ce destructeur ?" }, urgence: { type: "score", instructions: "Urgence ?" } };
const valid = { state: "Corriger le bug d'affichage des sessions", questions: q1 };
const portOpen = (port) => new Promise((resolve) => {
  import("node:net").then(({ connect }) => {
    const s = connect({ host: "127.0.0.1", port });
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
async function waitUntil(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(150); }
  return false;
}

// Faux exécutable Laya : node + module d'amorçage (actif seulement dans un processus lancé par decide.mjs).
const bootFile = join(scratchDir, "fake-laya-boot.mjs");
writeFileSync(bootFile, `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
if (process.env.LAYA_MODELS && process.env.FAKE_LAYA_REPORT) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ answers: { lazy: { noul: 0.5 } } })); });
  });
  server.listen(Number(process.env.LAYA_PORT), process.env.LAYA_HOST, () => {
    writeFileSync(process.env.FAKE_LAYA_REPORT, JSON.stringify({ pid: process.pid, host: process.env.LAYA_HOST, port: process.env.LAYA_PORT, models: process.env.LAYA_MODELS }));
  });
}
`);
const bootOptions = `--import ${pathToFileURL(bootFile).href}`;

let srv = null;
try {
  // =====================================================================================
  section("G2.a : unités — validation stricte et plafonds");
  const { validateDecide, LIMITS } = await import(pathToFileURL(join(dashboardDir, "handlers", "decide.mjs")).href);
  const bad = (body) => { try { validateDecide(body); return null; } catch (e) { return e; } };
  expect(bad(valid) === null, "entrée valide acceptée");
  expect(bad(null)?.status === 400 && bad([])?.status === 400, "corps non objet refusé (400)");
  expect(bad({ questions: q1 })?.status === 400, "state manquant refusé");
  expect(bad({ ...valid, state: "   " })?.status === 400, "state vide refusé");
  expect(bad({ ...valid, state: 42 })?.status === 400, "state non texte refusé");
  expect(bad({ ...valid, state: "x".repeat(LIMITS.state) }) === null, "state de 2000 caractères accepté");
  expect(bad({ ...valid, state: "x".repeat(LIMITS.state + 1) })?.status === 400, "state de 2001 caractères refusé");
  const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: "noul", instructions: "oui ?" }]));
  expect(bad({ ...valid, questions: many(8) }) === null, "8 questions acceptées");
  expect(bad({ ...valid, questions: many(9) })?.status === 400, "9 questions refusées");
  expect(bad({ ...valid, questions: {} })?.status === 400, "aucune question refusée");
  expect(bad({ ...valid, questions: [] })?.status === 400, "questions en tableau refusées");
  expect(bad({ ...valid, questions: { "mauvais nom": { type: "noul", instructions: "x" } } })?.status === 400, "nom de question invalide refusé");
  expect(bad({ ...valid, questions: { q: { type: "autre", instructions: "x" } } })?.status === 400, "type inconnu refusé");
  expect(bad({ ...valid, questions: { q: { type: "noul" } } })?.status === 400, "instructions manquantes refusées");
  expect(bad({ ...valid, questions: { q: { type: "noul", instructions: "x".repeat(LIMITS.instructions + 1) } } })?.status === 400, "instructions trop longues refusées");
  expect(bad({ ...valid, questions: { q: { type: "noul", instructions: "x", extra: 1 } } })?.status === 400, "champ inconnu dans une question refusé");
  expect(bad({ ...valid, questions: { q: { type: "choice", instructions: "x", criteria: { a: "un seul" } } } })?.status === 400, "choice à 1 option refusé");
  expect(bad({ ...valid, questions: { q: { type: "choice", instructions: "x" } } })?.status === 400, "choice sans criteria refusé");
  expect(bad({ ...valid, questions: { q: { type: "noul", instructions: "x", criteria: "texte" } } })?.status === 400, "criteria non objet refusé");
  const opts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, "d"]));
  expect(bad({ ...valid, questions: { q: { type: "choice", instructions: "x", criteria: opts(26) } } }) === null, "26 options acceptées");
  expect(bad({ ...valid, questions: { q: { type: "choice", instructions: "x", criteria: opts(27) } } })?.status === 400, "27 options refusées");
  expect(bad({ ...valid, questions: { q: { type: "choice", instructions: "x", criteria: { a: 1, b: "x" } } } })?.status === 400, "description d'option non texte refusée");
  const proto = JSON.parse('{"state":"s","questions":{"__proto__":{"type":"noul","instructions":"x"}}}');
  expect(bad(proto) === null && !({}).type, "clé __proto__ traitée comme un simple nom (pas de pollution)");

  // =====================================================================================
  section("G2.b : route POST /api/v1/decide avec un faux Laya");
  srv = await ready(startServer({ LAYA_URL: `http://127.0.0.1:${FAKE_PORT}/v1/systemone`, LAYA_BIN: join(scratchDir, "inexistant.exe") }));
  const good = await post(srv, "/decide", valid);
  expect(good.status === 200 && good.json.ok === true, "succès : HTTP 200 ok", JSON.stringify(good.json).slice(0, 200));
  expect(good.json.data?.answers?.harness?.choice === "claude_code" && good.json.data.answers.destructive?.noul === 0.12, "réponse : answers relayées");
  expect(Number.isInteger(good.json.data?.latencyMs) && good.json.data.latencyMs >= 0, "réponse : latencyMs entier", String(good.json.data?.latencyMs));
  const relayed = seen.at(-1);
  expect(relayed?.method === "POST" && relayed.url === "/v1/systemone", "relayé vers /v1/systemone");
  expect(relayed?.body?.model === "multilingual" && relayed.body.state === valid.state && Object.keys(relayed.body.questions).length === 3,
    "corps relayé : model multilingual + state + questions");
  expect(good.json.data?.engine === "laya", "T47 : réponse sans engine -> moteur « laya » (défaut inchangé)", String(good.json.data?.engine));
  const viaLaya = await post(srv, "/decide", { ...valid, engine: "laya" });
  expect(viaLaya.status === 200 && viaLaya.json.data?.engine === "laya" && seen.at(-1)?.body?.model === "multilingual",
    "T47 : engine « laya » explicite accepté, modèle multilingual", JSON.stringify(viaLaya.json).slice(0, 200));
  const seenBeforeEngine = seen.length;
  for (const wrong of ["gpt", "LAYA", "", 42, ["von"], {}, "__proto__"]) {
    const r = await post(srv, "/decide", { ...valid, engine: wrong });
    expect(r.status === 400 && r.json.error?.code === "bad_request", `T47 : engine ${JSON.stringify(wrong)} refusé (HTTP 400)`, `${r.status} ${JSON.stringify(r.json.error)}`);
  }
  expect(seen.length === seenBeforeEngine, "T47 : un engine inconnu n'atteint aucun serveur");
  const viaVon = await post(srv, "/decide", { ...valid, engine: "von" });
  expect(viaVon.status === 503 && viaVon.json.error?.code === "von_unavailable" && /Von est (absent|injoignable)/.test(viaVon.json.error.message),
    "T47 : engine « von » indisponible : HTTP 503 von_unavailable (sans repli silencieux sur Laya)", JSON.stringify(viaVon.json.error));
  expect(seen.length === seenBeforeEngine, "T47 : la requête Von n'a pas été envoyée à Laya");
  const callsBefore = seen.length;
  const rejections = [
    ["state manquant", { questions: q1 }], ["state 2001", { ...valid, state: "x".repeat(2001) }],
    ["9 questions", { ...valid, questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, { type: "noul", instructions: "x" }])) }],
    ["type inconnu", { ...valid, questions: { q: { type: "zzz", instructions: "x" } } }],
  ];
  for (const [label, body] of rejections) {
    const r = await post(srv, "/decide", body);
    expect(r.status === 400 && r.json.ok === false && r.json.error.code === "bad_request", `entrée invalide (${label}) : HTTP 400`, `${r.status} ${JSON.stringify(r.json.error)}`);
  }
  const notJson = await post(srv, "/decide", null, "pas du json");
  expect(notJson.status === 400, "corps non JSON : HTTP 400");
  expect(seen.length === callsBefore, "aucune requête invalide n'atteint Laya");
  const wrongMethod = await fetch(`${srv.base}/api/v1/decide`);
  expect(wrongMethod.status === 405, "GET /decide : HTTP 405");

  fakeMode = "422";
  const r422 = await post(srv, "/decide", valid);
  expect(r422.status === 400 && /refusé la requête/.test(r422.json.error?.message || ""), "Laya répond 422 : HTTP 400 expliqué", r422.json.error?.message);
  fakeMode = "500";
  const r500 = await post(srv, "/decide", valid);
  expect(r500.status === 503 && /Laya est en panne/.test(r500.json.error?.message || ""), "Laya en panne (500) : HTTP 503 en français", r500.json.error?.message);
  fakeMode = "html";
  const rHtml = await post(srv, "/decide", valid);
  expect(rHtml.status === 502, "réponse non JSON de Laya : HTTP 502", String(rHtml.status));
  fakeMode = "slow";
  const t0 = Date.now();
  const rSlow = await post(srv, "/decide", valid);
  const slowMs = Date.now() - t0;
  expect(rSlow.status === 503 && /10 s/.test(rSlow.json.error?.message || ""), "Laya trop lent : HTTP 503 après ~10 s", `${rSlow.status} ${slowMs} ms`);
  expect(slowMs >= 9500 && slowMs < 11_500, "délai d'attente de 10 s respecté", `${slowMs} ms`);
  fakeMode = "ok";

  section("G2.c : journal d'activité des appels decide (sans texte de l'état)");
  const secretState = { state: "Contexte confidentiel password=zzzSecret12345 à ne jamais journaliser", questions: { urgent: { type: "noul", instructions: "Urgent ?" } } };
  await post(srv, "/decide", secretState);
  await post(srv, "/decide", { ...valid, state: "" });
  const activityFile = readFileSync(join(scratchDir, "data", "agent-activity.json"), "utf8");
  const activity = JSON.parse(activityFile);
  const okEntry = activity.find((e) => /^Décision demandée : 3 question/.test(e.summary));
  expect(okEntry && okEntry.ok === true && okEntry.method === "POST" && okEntry.route === "/decide", "appel decide réussi journalisé", okEntry?.summary);
  expect(activity.some((e) => e.ok === false && e.status === 400 && /^Décision impossible/.test(e.summary)), "appel decide refusé (400) journalisé");
  expect(activity.some((e) => e.ok === false && e.status === 503 && /^Décision impossible/.test(e.summary)), "appel decide en échec (503) journalisé");
  expect(!activityFile.includes("zzzSecret12345") && !activityFile.includes("Contexte confidentiel"), "le texte de l'état n'est jamais journalisé");

  // =====================================================================================
  section("G2.d : postectl decide et MCP post_decide");
  // Asynchrone : le faux Laya tourne dans ce processus, un spawnSync le figerait.
  const ctl = (...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(rootDir, "tools", "postectl.mjs"), "--url", srv.base, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const text = await ctl("decide", "Corriger le bug", "d'affichage", "--choice", "harness=claude_code,hermes,pi", "--yesno", "Est-ce destructeur ?");
  expect(text.status === 0 && /harness : claude_code/.test(text.stdout) && /yesno : non/.test(text.stdout) && /\(\d+ ms\)/.test(text.stdout),
    "postectl decide : sortie lisible", text.stdout + text.stderr);
  expect(/Corriger le bug d'affichage/.test(JSON.stringify(seen.at(-1).body.state)), "postectl decide : l'état est reconstitué");
  expect(seen.at(-1).body.questions.harness.criteria.hermes === "hermes", "postectl decide : --choice devient des criteria");
  const asJson = await ctl("--json", "decide", "x", "--yesno", "a ?", "--yesno", "b ?");
  expect(asJson.status === 0 && Object.keys(JSON.parse(asJson.stdout).answers).join() === "yesno,yesno2", "postectl --json decide : deux --yesno", asJson.stdout + asJson.stderr);
  const noQuestion = await ctl("decide", "sans question");
  expect(noQuestion.status === 1 && /questions/.test(noQuestion.stderr), "postectl decide sans question : erreur de l'API (code 1)", noQuestion.stderr);
  const badChoice = await ctl("decide", "x", "--choice", "seul=a");
  expect(badChoice.status === 2, "postectl decide --choice à 1 option : usage (code 2)", badChoice.stderr);

  const mcp = spawn(process.execPath, [join(rootDir, "tools", "postectl-mcp.mjs")], { env: { ...process.env, POSTECTL_URL: srv.base }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  let buf = "";
  const frames = [];
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) frames.push(JSON.parse(line)); }
  });
  const rpc = async (id, method, params) => {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (let i = 0; i < 100; i++) { const f = frames.find((x) => x.id === id); if (f) return f; await sleep(100); }
    return null;
  };
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const tools = await rpc(2, "tools/list", {});
  const tool = tools?.result?.tools?.find((t) => t.name === "post_decide");
  expect(Boolean(tool) && /JAMAIS comme seul garde-fou/.test(tool.description), "MCP : outil post_decide listé avec son avertissement");
  const called = await rpc(3, "tools/call", { name: "post_decide", arguments: valid });
  const calledData = called?.result?.isError ? null : JSON.parse(called?.result?.content?.[0]?.text || "null");
  expect(calledData?.answers?.harness?.choice === "claude_code" && typeof calledData.latencyMs === "number", "MCP post_decide : réponse relayée", JSON.stringify(called?.result).slice(0, 200));
  const invalidCall = await rpc(4, "tools/call", { name: "post_decide", arguments: { state: "x", questions: {} } });
  expect(invalidCall?.result?.isError === true, "MCP post_decide : entrée invalide refusée");
  const unknownArg = await rpc(5, "tools/call", { name: "post_decide", arguments: { state: "x", questions: valid.questions, autre: 1 } });
  expect(unknownArg?.result?.isError === true, "MCP post_decide : paramètre inconnu refusé");
  mcp.kill();
  await stopServer(srv);
  srv = null;

  // =====================================================================================
  section("G2.e : Laya injoignable -> 503 en français, le tableau de bord continue de fonctionner");
  srv = await ready(startServer({ LAYA_URL: `http://127.0.0.1:${CLOSED_PORT}/v1/systemone`, LAYA_BIN: join(scratchDir, "inexistant.exe") }));
  const down = await post(srv, "/decide", valid);
  expect(down.status === 503 && down.json.error.code === "laya_unavailable", "Laya absent : HTTP 503", `${down.status} ${JSON.stringify(down.json.error)}`);
  expect(/Laya est absent/.test(down.json.error.message) && /continue de fonctionner/.test(down.json.error.message), "message clair en français", down.json.error.message);
  const still = await get(srv, "/summary");
  expect(still.ok === true, "le tableau de bord répond toujours (GET /summary)");
  const tasks = await post(srv, "/tasks", { title: "Après panne de Laya" });
  expect(tasks.json.ok === true, "les autres routes fonctionnent (POST /tasks)");
  const remote = await post(srv, "/decide", valid);
  expect(remote.status === 503, "relance : toujours 503 sans blocage");
  await stopServer(srv);
  srv = await ready(startServer({ LAYA_URL: "http://192.0.2.1:8765/v1/systemone", LAYA_BIN: process.execPath }));
  const nonLocal = await post(srv, "/decide", valid);
  expect(nonLocal.status === 503 && /seulement sur cette machine|ne se lance automatiquement/.test(nonLocal.json.error.message), "URL non locale : jamais de lancement automatique", nonLocal.json.error.message);
  await stopServer(srv);
  srv = null;

  // =====================================================================================
  section("G2.f : démarrage paresseux (faux exécutable) — environnement, port, arrêt");
  const LAZY_PORT = 18766;
  const report = join(scratchDir, "lazy-report.json");
  const lazyEnv = { LAYA_URL: `http://127.0.0.1:${LAZY_PORT}/v1/systemone`, LAYA_BIN: process.execPath, NODE_OPTIONS: bootOptions,
    FAKE_LAYA_REPORT: report, LAYA_HOST: "0.0.0.0", LAYA_PORT: "9999", LAYA_START_TIMEOUT_MS: "20000" };
  srv = await ready(startServer(lazyEnv));
  expect(!(await portOpen(LAZY_PORT)), "avant le premier appel : Laya n'est pas lancé (paresseux)");
  const lazy = await post(srv, "/decide", { state: "x", questions: { lazy: { type: "noul", instructions: "ok ?" } } });
  expect(lazy.status === 200 && lazy.json.data?.answers?.lazy?.noul === 0.5, "premier appel : Laya lancé puis interrogé", JSON.stringify(lazy.json).slice(0, 200));
  const info = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
  expect(info?.host === "127.0.0.1" && info.port === String(LAZY_PORT) && info.models === "multilingual",
    "Laya reçoit LAYA_HOST=127.0.0.1, LAYA_PORT, LAYA_MODELS=multilingual (surcharge 0.0.0.0 / 9999)", JSON.stringify(info));
  expect((await portOpen(LAZY_PORT)) && info != null, "Laya écoute sur le port prévu");
  const second = await post(srv, "/decide", { state: "x", questions: { lazy: { type: "noul", instructions: "ok ?" } } });
  expect(second.status === 200, "deuxième appel : réutilise le Laya déjà lancé");
  const pid = info?.pid;
  await stopServer(srv); // arrêt brutal (TerminateProcess) : aucun gestionnaire de sortie ne s'exécute
  srv = null;
  const goneAfterKill = await waitUntil(async () => !alive(pid) && !(await portOpen(LAZY_PORT)), 10_000);
  expect(goneAfterKill, "arrêt brutal du tableau de bord : la sentinelle arrête Laya", `pid ${pid}`);

  // Sortie normale du processus (gestionnaire process.on("exit")) : script d'appui qui charge decide.mjs seul.
  const harness = join(scratchDir, "harness-exit.mjs");
  const report2 = join(scratchDir, "exit-report.json");
  writeFileSync(harness, `
    import { register } from ${JSON.stringify(pathToFileURL(join(dashboardDir, "handlers", "decide.mjs")).href)};
    const ctx = { log() {}, safeError: (e) => String(e?.message) };
    register(ctx);
    const r = await ctx.decide.run({ state: "x", questions: { lazy: { type: "noul", instructions: "ok ?" } } });
    console.log(JSON.stringify(r));
    process.exit(0);
  `);
  const exited = await new Promise((resolve) => {
    const p = spawn(process.execPath, [harness], { windowsHide: true, env: {
    ...process.env, LAYA_URL: `http://127.0.0.1:${LAZY_PORT + 1}/v1/systemone`, LAYA_BIN: process.execPath, NODE_OPTIONS: bootOptions,
    FAKE_LAYA_REPORT: report2, LAYA_START_TIMEOUT_MS: "20000" } });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  expect(exited.status === 0 && /"lazy"/.test(exited.stdout), "script d'appui : Laya lancé puis interrogé", exited.stdout + exited.stderr);
  const exitedPid = existsSync(report2) ? JSON.parse(readFileSync(report2, "utf8")).pid : null;
  expect(await waitUntil(async () => !alive(exitedPid) && !(await portOpen(LAZY_PORT + 1)), 8000), "sortie normale du processus : Laya est arrêté", `pid ${exitedPid}`);

  // =====================================================================================
  section("G2.g : test RÉEL avec le vrai Laya (si présent)");
  if (!existsSync(REAL_BIN)) {
    console.log(`[IGNORÉ] ${REAL_BIN} introuvable : test réel non exécuté`);
  } else {
    const REAL_PORT = 18767;
    srv = await ready(startServer({ LAYA_URL: `http://127.0.0.1:${REAL_PORT}/v1/systemone`, LAYA_BIN: REAL_BIN, LAYA_START_TIMEOUT_MS: "90000" }));
    const started = Date.now();
    const real = await post(srv, "/decide", {
      state: "Supprimer toutes les sessions et tous les fichiers du dossier de test",
      questions: {
        harness: { type: "choice", instructions: "Quel agent doit traiter cette tâche ?",
          criteria: { claude_code: "écrire, corriger ou tester du code", hermes: "administrer un serveur ou une machine", pi: "rechercher des informations et faire une synthèse" } },
        destructive: { type: "noul", instructions: "Cette tâche est-elle destructrice ou irréversible (supprimer, forcer, éteindre) ?" },
      },
    });
    console.log(`[RÉEL] démarrage + 1er appel : ${Date.now() - started} ms ; réponse : ${JSON.stringify(real.json).slice(0, 400)}`);
    expect(real.status === 200 && real.json.ok === true, "[RÉEL] vrai Laya lancé paresseusement et interrogé", JSON.stringify(real.json).slice(0, 300));
    const a = real.json.data?.answers;
    expect(typeof a?.harness?.choice === "string" && typeof (a?.destructive?.noul ?? a?.destructive?.probability) === "number",
      "[RÉEL] forme de la réponse : harness.choice (texte) et destructive.noul (nombre)", JSON.stringify(a).slice(0, 300));
    expect(a?.destructive?.noul > 0.5, "[RÉEL] tâche destructrice détectée (P > 0,5)", String(a?.destructive?.noul));
    const second = await post(srv, "/decide", { state: "Chercher des modèles gratuits de transcription audio", questions: { destructive: { type: "noul", instructions: "Cette tâche est-elle destructrice ?" } } });
    console.log(`[RÉEL] 2e appel : latence ${second.json.data?.latencyMs} ms`);
    expect(second.status === 200 && second.json.data.latencyMs < 5000, "[RÉEL] appel à chaud rapide (< 5 s)", String(second.json.data?.latencyMs));
    const withActivity = JSON.parse(readFileSync(join(scratchDir, "data", "agent-activity.json"), "utf8"));
    expect(withActivity.some((e) => /^Décision demandée/.test(e.summary)), "[RÉEL] appel journalisé dans l'activité");
    await stopServer(srv); // arrêt brutal : la sentinelle doit tuer l'arbre laya-serve
    srv = null;
    expect(await waitUntil(async () => !(await portOpen(REAL_PORT)), 15_000), "[RÉEL] Laya arrêté après l'arrêt du tableau de bord", `port ${REAL_PORT}`);
  }
} catch (e) {
  fail("exception inattendue", e.stack || e.message);
} finally {
  if (srv) await stopServer(srv);
  fake.close();
  fake.closeAllConnections?.();
  await sleep(300);
  try { rmSync(scratchDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* ignoré */ }
}

console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
if (failed > 0) process.exit(1);
console.log("VERIFY_DECIDE_PASS");
process.exit(0);
