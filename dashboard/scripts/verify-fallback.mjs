// Vérifie le repli automatique de moteur (T44) : handlers/tasks.mjs branché sur ctx.quota (handlers/quota.mjs).
// Usage : node dashboard/scripts/verify-fallback.mjs
//   A. (toujours) vrais handlers quota/tasks dans un faux hôte Paseo, base SQLite et dossier de données jetables :
//      402 -> moteur au repos -> démarrage avec le moteur de repli et raison écrite (moteur voulu inchangé) ; aucun moteur
//      disponible -> « À faire » + retryAt, reprise seule si autostart ; une seule relance automatique, jamais de boucle ;
//      refus d'un moteur OpenRouter payant ; sans ctx.quota, comportement d'avant ; auto:false inchangé. Aucun appel LLM.
//   B. (VERIFY_REAL=0 pour sauter) instance isolée (VERIFY_PORT, défaut 7089) avec QUOTA_TEST_HOOK : un seul petit appel
//      réel (« PONG ») avec le moteur de repli, puis « tous les moteurs au repos ». Tâche et agent supprimés ensuite.
// Ne parle jamais au serveur :7070 et n'écrit pas dans dashboard/data/ : tout est dans .foreman/scratch/t44-fallback-*.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createStore } from "../lib/store.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratch = join(rootDir, ".foreman", "scratch", `t44-fallback-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7089);
if (PORT === 7070) throw new Error("VERIFY_PORT ne doit jamais être 7070 (serveur réel)");
const SANDBOX = join(rootDir, "sandbox-repo");
const P = "D:/Projets/AI-OS/paseo-lab/fake-proj";
const X = "claude-openrouter/sonnet";
const NVIDIA = "claude-nvidia/sonnet";
const PI = "pi/nvidia-proxy/nvidia/nemotron-3-ultra-550b-a55b";
const PONG = "Reply with the single word PONG and do nothing else.";

let passed = 0;
let failed = 0;
const say = (prefix) => ({
  ok: (label) => { passed += 1; console.log(`OK   ${prefix}${label}`); },
  bad: (label, detail = "") => { failed += 1; console.error(`FAIL ${prefix}${label}${detail ? ` -> ${detail}` : ""}`); },
  expect(cond, label, detail = "") { return cond ? this.ok(label) : this.bad(label, String(detail)); },
});
const main = say("");
const section = (name) => console.log(`\n=== ${name} ===`);
const dump = (v) => JSON.stringify(v);

async function until(t, fn, label, timeout = 9000, step = 60) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  t.bad(`Délai dépassé : ${label}`);
  return null;
}

// ---------------------------------------------------------------- faux hôte Paseo + vrais handlers
async function harness({ name, modules, scale = 1, openrouter = "vendor/free-model:free" }) {
  const dataDir = join(scratch, name);
  mkdirSync(dataDir, { recursive: true });
  const settings = join(dataDir, "or-settings.json");
  const env = Object.fromEntries(["SONNET", "OPUS", "HAIKU", "FABLE"].map((a) => [`ANTHROPIC_DEFAULT_${a}_MODEL`, openrouter]));
  writeFileSync(settings, JSON.stringify({ env }));
  process.env.BRAIN_DB = join(dataDir, "brain.sqlite");
  process.env.QUOTA_OPENROUTER_SETTINGS = settings;
  process.env.QUOTA_COOLDOWN_SCALE = String(scale);
  process.env.QUOTA_BROADCAST_MIN_MS = "100000000";
  const agents = new Map();
  const sim = { up: true };
  const entry = {
    connected: () => sim.up,
    api: {
      workspaces: { open: async () => ({ id: "ws-sim" }) },
      agents: {
        create: async (options) => {
          const agent = { id: randomUUID(), status: "running", pendingPermissions: [], options };
          agents.set(agent.id, agent);
          return agent;
        },
        list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })) }),
        ref: (id) => ({
          refresh: async () => {
            if (!agents.has(id)) throw new Error("agent introuvable");
            return { agent: agents.get(id) };
          },
          timeline: { refetch: async () => ({ entries: [] }) },
        }),
      },
    },
    daemon: {
      waitForFinish: async (id) => ({ lastMessage: `compte-rendu simulé ${id.slice(0, 4)}` }),
      cancelAgent: async (id) => { if (agents.has(id)) agents.get(id).status = "closed"; },
    },
  };
  const routes = new Map();
  const broadcasts = [];
  const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const ctx = {
    dataDir, store: createStore(dataDir), log: () => {}, safeError: (e) => String(e?.message ?? e),
    hosts: { get: (l) => (l === "local" ? entry : undefined), has: (l) => l === "local" },
    onMessage: (type, fn) => { if (!routes.has(type)) routes.set(type, []); routes.get(type).push(fn); },
    send, broadcast: (m) => broadcasts.push(m), onStateChange: () => {},
    sendError: (ws, m) => send(ws, { type: "error", message: `Erreur : ${m}` }),
  };
  const call = async (kind, type, payload = {}) => {
    if (!routes.has(type)) throw new Error(`message inconnu : ${type}`);
    const replies = [];
    const client = { _uiId: kind === "invoke" ? `invoke:${randomUUID()}` : `ui:${randomUUID()}`, readyState: 1,
      send: (raw) => replies.push(JSON.parse(raw)) };
    let error = null;
    try {
      for (const handler of routes.get(type)) await handler(client, { ...payload, type });
    } catch (e) {
      error = String(e?.message ?? e);
    }
    const refused = replies.find((r) => r.type === "error");
    return { replies, error: error ?? (refused ? refused.message : null) };
  };
  ctx.invoke = (type, payload) => call("invoke", type, payload);
  for (const file of modules) await (await import(`../handlers/${file}.mjs`)).register(ctx);
  const h = {
    ctx, call, agents, sim, broadcasts, dataDir,
    tasks: async () => (await call("ui", "task.list")).replies.find((r) => r.type === "tasks").tasks,
    task: async (id) => (await h.tasks()).find((t) => t.id === id),
    db: (id) => {
      const raw = new DatabaseSync(join(dataDir, "brain.sqlite"), { readOnly: true });
      const row = raw.prepare("SELECT run_engine, fb_tries, retry_at FROM tasks WHERE id = ?").get(id);
      raw.close();
      return row;
    },
    async create(extra = {}, kind = "ui") {
      const r = await call(kind, "task.create", { title: `Tâche ${randomUUID().slice(0, 4)}`, host: "local", project: P, engine: X, ...extra });
      return r.replies.find((m) => m.type === "task.created").id;
    },
    agentOf: async (id) => agents.get((await h.task(id)).agentId),
  };
  return h;
}

const fail402 = "Error 402: Payment Required - insufficient credits on this key";
const fail429 = "Error 429: rate limit exceeded, retry later";

// ================================================================ A. faux hôte
async function scenarioRepli(h) {
  const t = say("[repli] ");
  h.ctx.quota.noteFailure(X, fail402);
  const id = await h.create();
  let r = await h.call("ui", "task.start", { id });
  const task = await h.task(id);
  const agent = h.agents.get(task.agentId);
  t.expect(!r.error && task.status === "doing", "task.start : la tâche démarre malgré le moteur au repos", r.error);
  t.expect(agent?.options.config.provider === NVIDIA, "session créée avec le moteur de repli (claude-nvidia/sonnet)",
    agent?.options.config.provider);
  t.expect(task.engine === X, "moteur voulu de la tâche inchangé", task.engine);
  t.expect(task.reason === `Moteur remplacé : ${X} au repos (crédits épuisés, encore 30 min), utilisé : ${NVIDIA}`,
    "raison lisible « Moteur remplacé : … au repos (…), utilisé : … »", task.reason);
  t.expect(task.runEngine === NVIDIA && h.db(id).run_engine === NVIDIA, "moteur réellement utilisé conservé (runEngine)",
    dump(h.db(id)));
  const calm = await h.create({ engine: PI });
  await h.call("ui", "task.start", { id: calm });
  const c = await h.task(calm);
  t.expect(c.status === "doing" && c.reason === "" && h.agents.get(c.agentId).options.config.provider === PI,
    "moteur disponible : démarrage normal, raison vide", dump([c.reason, h.agents.get(c.agentId)?.options.config.provider]));

  // auto:false inchangé : « En cours » seulement par « Démarrer »
  const todo = await h.create();
  const before = h.agents.size;
  r = await h.call("ui", "task.move", { id: todo, status: "doing", auto: false });
  t.expect(/ne passe « En cours » que par « Démarrer »/.test(r.error || "") && h.agents.size === before,
    "task.move auto:false vers « En cours » : refus d'avant, aucune session", r.error);

  // Erreur d'une autre nature : ni repos ni relance
  const other = await h.create({ engine: NVIDIA });
  await h.call("ui", "task.start", { id: other });
  const sessions = h.agents.size;
  const restBefore = dump(h.ctx.quota.snapshot().cooldowns.map((c2) => c2.engine).sort());
  const agentOther = await h.agentOf(other);
  agentOther.status = "error";
  agentOther.lastError = "boom: erreur interne inattendue du faux hôte";
  await until(t, async () => (await h.task(other)).error, "erreur ordinaire détectée");
  await sleep(5600);
  t.expect(h.agents.size === sessions && (await h.task(other)).status === "doing" &&
    dump(h.ctx.quota.snapshot().cooldowns.map((c2) => c2.engine).sort()) === restBefore,
  "erreur ordinaire : pas de relance, aucun moteur mis au repos", `${h.agents.size}/${sessions}`);

  // Une seule relance après 429, journalisée, puis plus rien
  const hit = await h.create({ engine: NVIDIA });
  await h.call("ui", "task.start", { id: hit });
  const first = await h.agentOf(hit);
  t.expect(first.options.config.provider === NVIDIA, "tâche 429 : démarrée avec claude-nvidia/sonnet");
  const count = h.agents.size;
  first.status = "error";
  first.lastError = fail429;
  await until(t, async () => h.agents.size === count + 1 && (await h.task(hit)).agentId !== first.id, "relance automatique", 9000);
  const relaunched = await h.task(hit);
  const second = h.agents.get(relaunched.agentId);
  t.expect(second?.options.config.provider === PI && relaunched.status === "doing" && relaunched.error === "",
    "relance avec le moteur de repli disponible (openrouter au repos, nvidia au repos)", second?.options.config.provider);
  t.expect(/^Relance automatique après une erreur de quota \(402\/429\)\. Moteur remplacé : claude-nvidia\/sonnet au repos \(limite de débit/
    .test(relaunched.reason), "relance journalisée dans la raison", relaunched.reason);
  t.expect(relaunched.engine === NVIDIA && h.db(hit).fb_tries === 1, "moteur voulu inchangé, fb_tries = 1", dump(h.db(hit)));
  t.expect(h.ctx.quota.snapshot().cooldowns.some((c2) => c2.engine === NVIDIA && c2.kind === "rate"),
    "la panne a été notée sur le moteur utilisé (claude-nvidia/sonnet, limite de débit)");
  second.status = "error";
  second.lastError = fail402;
  await until(t, async () => (await h.task(hit)).error, "2e erreur (402) détectée", 9000);
  await sleep(5600);
  const final = await h.task(hit);
  t.expect(h.agents.size === count + 1 && final.status === "doing" && /402/.test(final.error),
    "2e chute 402 : pas de 2e relance (jamais de boucle), l'erreur reste visible", dump([h.agents.size - count, final.status]));
  t.expect(h.ctx.quota.snapshot().cooldowns.some((c2) => c2.engine === `pi/nvidia-proxy/*` && c2.kind === "credit"),
    "la 2e panne est notée sur le moteur de la relance (pi/nvidia-proxy, crédits)");
}

async function scenarioAucun(h) {
  const t = say("[repos] ");
  const prime = () => { for (const e of [X, NVIDIA, PI]) h.ctx.quota.noteFailure(e, fail402); };
  prime();
  const auto = await h.create({ title: "Autostart au repos", autostart: true }, "invoke");
  await until(t, async () => (await h.task(auto)).reason, "raison « Tous les moteurs… » posée", 6000);
  let task = await h.task(auto);
  t.expect(task.status === "todo" && /^Tous les moteurs sont au repos, reprise vers \d\d:\d\d$/.test(task.reason),
    "autostart : reste « À faire » avec « Tous les moteurs sont au repos, reprise vers HH:MM »", dump([task.status, task.reason]));
  const hhmm = new Date(task.retryAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  t.expect(task.retryAt && task.reason.endsWith(hhmm) && Date.parse(task.retryAt) > Date.now(),
    "retryAt (ISO, futur) cohérent avec l'heure affichée", dump([task.retryAt, hhmm]));
  t.expect(h.agents.size === 0, "aucune session créée pendant le repos");
  await until(t, async () => (await h.task(auto)).status === "doing", "reprise seule à l'échéance (autostart)", 12000);
  task = await h.task(auto);
  t.expect(task.reason === "" && task.retryAt === null && h.agents.get(task.agentId).options.config.provider === X,
    "reprise : moteur voulu de nouveau disponible, raison et retryAt effacés",
    dump([task.reason, task.retryAt, h.agents.get(task.agentId)?.options.config.provider]));

  prime();
  const manual = await h.create({ title: "Manuelle au repos" });
  const sessions = h.agents.size;
  const r = await h.call("ui", "task.start", { id: manual });
  task = await h.task(manual);
  t.expect(/Tous les moteurs sont au repos, reprise vers \d\d:\d\d$/.test(r.error || "") && task.status === "todo" &&
    task.retryAt && h.agents.size === sessions, "task.start sans moteur : erreur claire, « À faire », retryAt, aucune session",
  dump([r.error, task.status]));
  await sleep(7500);
  task = await h.task(manual);
  t.expect(task.status === "todo" && task.reason === "" && task.retryAt === null && h.agents.size === sessions,
    "sans autostart : ne redémarre pas seule ; la raison périmée est retirée à l'échéance", dump([task.status, task.reason]));
}

async function scenarioPayant(h) {
  const t = say("[payant] ");
  const id = await h.create({ engine: X });
  await h.call("ui", "task.start", { id });
  const task = await h.task(id);
  const provider = h.agents.get(task.agentId)?.options.config.provider;
  t.expect(provider === NVIDIA, "alias OpenRouter résolu en modèle payant : refusé, session en claude-nvidia/sonnet", provider);
  t.expect(task.reason === `Moteur remplacé : OpenRouter payant refusé (vendor/paid-model), utilisé : ${NVIDIA}`,
    "raison : « OpenRouter payant refusé (…) »", task.reason);
  const direct = await h.create({ engine: "claude-openrouter/vendor/other-paid" });
  await h.call("ui", "task.start", { id: direct });
  const dprov = h.agents.get((await h.task(direct)).agentId)?.options.config.provider;
  t.expect(dprov === NVIDIA, "modèle OpenRouter explicite sans :free : refusé aussi", dprov);
  let threw = "";
  try { h.ctx.quota.setFallback(["claude-openrouter/vendor/other-paid"]); } catch (e) { threw = e.message; }
  t.expect(/OpenRouter payant refusé/.test(threw), "liste de repli : un moteur OpenRouter payant est refusé", threw);
  for (const e of [NVIDIA, PI]) h.ctx.quota.noteFailure(e, fail402);
  const last = await h.create({ engine: X });
  const sessions = h.agents.size;
  const r = await h.call("ui", "task.start", { id: last });
  t.expect(/Tous les moteurs sont au repos, reprise vers \d\d:\d\d$/.test(r.error || "") && h.agents.size === sessions &&
    ![...h.agents.values()].some((a) => /vendor\/(paid|other)/.test(a.options.config.provider)),
  "tous les autres au repos : aucune session OpenRouter payant n'est jamais créée", r.error);
}

async function scenarioSansQuota(h) {
  const t = say("[sans quota] ");
  t.expect(h.ctx.quota === undefined, "ctx.quota absent dans ce harnais");
  const id = await h.create();
  const r = await h.call("ui", "task.start", { id });
  const task = await h.task(id);
  t.expect(!r.error && task.status === "doing" && h.agents.get(task.agentId).options.config.provider === X &&
    task.reason === "", "démarrage inchangé avec le moteur voulu", dump([r.error, task.reason]));
  const agent = await h.agentOf(id);
  agent.status = "error";
  agent.lastError = fail402;
  await until(t, async () => (await h.task(id)).error, "erreur 402 détectée");
  await sleep(5600);
  t.expect(h.agents.size === 1 && (await h.task(id)).status === "doing" && /402/.test((await h.task(id)).error),
    "erreur 402 : ni repos, ni relance (comportement d'avant)", String(h.agents.size));
}

try {
  section("A. faux hôte Paseo, vrais handlers quota + tasks (chaque scénario a son harnais)");
  const h1 = await harness({ name: "repli", modules: ["quota", "tasks"] });
  const h2 = await harness({ name: "repos", modules: ["quota", "tasks"], scale: 0.002 });
  const h3 = await harness({ name: "payant", modules: ["quota", "tasks"], openrouter: "vendor/paid-model" });
  const h4 = await harness({ name: "sans-quota", modules: ["tasks"] });
  await Promise.all([scenarioRepli(h1), scenarioAucun(h2), scenarioPayant(h3), scenarioSansQuota(h4)]);
} catch (error) {
  main.bad("exception pendant la partie A", error?.stack || error);
}

// ================================================================ B. instance isolée
let server = null;
let daemon = null;
const agentsToDelete = new Set();
async function realParts() {
  const t = say("[réel] ");
  const dataDir = join(scratch, "real-data");
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_HOST: "127.0.0.1",
    BRAIN_DB: join(dataDir, "brain.sqlite"), QUOTA_TEST_HOOK: "1" };
  delete env.DASHBOARD_PASSWORD;
  delete env.QUOTA_OPENROUTER_SETTINGS;
  delete env.QUOTA_COOLDOWN_SCALE;
  const taken = await new Promise((resolve) => {
    const probe = connect(PORT, "127.0.0.1");
    probe.on("connect", () => { probe.destroy(); resolve(true); });
    probe.on("error", () => resolve(false));
  });
  if (taken) throw new Error(`le port ${PORT} est déjà utilisé par un autre processus : choisissez VERIFY_PORT`);
  server = { log: "", proc: spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true }) };
  server.proc.stdout.on("data", (d) => { server.log += d; });
  server.proc.stderr.on("data", (d) => { server.log += d; });
  for (let i = 0; i < 300 && !server.log.includes("Paseo dashboard :"); i++) await sleep(100);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: `http://127.0.0.1:${PORT}` });
  const inbox = [];
  let tasks = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "tasks") tasks = m.tasks;
    else inbox.push(m);
  });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (m) => ws.send(JSON.stringify(m));
  const take = (pred, label, timeout = 10000) =>
    until(t, () => { const i = inbox.findIndex(pred); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, label, timeout);
  const byId = (id) => tasks.find((x) => x.id === id);
  const local = JSON.parse(readFileSync((process.env.DASHBOARD_HOSTS_FILE || join(dashboardDir, "hosts.json")), "utf8")).hosts.find((x) => x.label === "local");
  daemon = new DaemonClient({ url: local.url, clientId: `verify-fallback-${Date.now()}`, clientType: "cli",
    password: local.password || undefined });
  await daemon.connect();

  send({ type: "quota.test.fail", engine: NVIDIA, reason: fail402, ref: "r1" });
  const noted = await take((m) => m.type === "quota.test.failed", "quota.test.fail");
  t.expect(noted?.result?.kind === "credit", "402 sur claude-nvidia/sonnet : moteur au repos (crédits)", dump(noted?.result));
  send({ type: "task.create", title: "T44 repli réel", description: PONG, project: SANDBOX, host: "local", engine: NVIDIA });
  const created = await take((m) => m.type === "task.created", "task.create");
  const id = created?.id;
  send({ type: "task.start", id });
  await until(t, () => byId(id)?.status === "doing" || byId(id)?.status === "review", "tâche démarrée", 40000);
  if (byId(id)?.agentId) agentsToDelete.add(byId(id).agentId);
  const task = byId(id);
  t.expect(task?.engine === NVIDIA && task.runEngine && task.runEngine !== NVIDIA,
    "moteur voulu inchangé, moteur réellement utilisé différent", dump([task?.engine, task?.runEngine]));
  t.expect(new RegExp(`^Moteur remplacé : ${NVIDIA} au repos \\(crédits épuisés, encore \\d+ min\\), utilisé : ${task?.runEngine}$`)
    .test(task?.reason || ""), "raison lisible écrite dans la tâche", task?.reason);
  console.log(`INFO moteur de repli réellement utilisé : ${task?.runEngine}`);
  await until(t, () => byId(id)?.status === "review", "réel : tâche à valider (la session a répondu)", 240000, 300);
  t.expect(/PONG/i.test(byId(id)?.summary || ""), "réel : compte-rendu PONG reçu avec le moteur de repli", byId(id)?.summary);

  for (const e of [X, PI]) send({ type: "quota.test.fail", engine: e, reason: fail402 });
  await sleep(400);
  send({ type: "task.create", title: "T44 tous au repos", project: SANDBOX, host: "local", engine: NVIDIA });
  const created2 = await take((m) => m.type === "task.created", "task.create (2)");
  send({ type: "task.start", id: created2?.id });
  const err = await take((m) => m.type === "error", "refus : tous les moteurs au repos");
  const rest = byId(created2?.id);
  t.expect(/Tous les moteurs sont au repos, reprise vers \d\d:\d\d/.test(err?.message || "") && rest?.status === "todo" &&
    rest.retryAt && !rest.agentId, "serveur réel : « Tous les moteurs sont au repos », « À faire », retryAt, aucune session",
  dump([err?.message, rest?.status, rest?.retryAt]));
  for (const x of [id, created2?.id]) if (x) send({ type: "task.delete", id: x });
  await sleep(500);
  ws.close();
}

try {
  if (process.env.VERIFY_REAL !== "0") {
    section("B. instance isolée (un seul appel réel « PONG » avec le moteur de repli)");
    await realParts();
  }
} catch (error) {
  main.bad("exception pendant la partie B", error?.stack || error);
} finally {
  if (daemon) {
    for (const id of agentsToDelete) await daemon.deleteAgent(id).catch(() => {});
    await daemon.close().catch(() => {});
    if (agentsToDelete.size) console.log(`nettoyage : ${agentsToDelete.size} agent(s) de test supprimé(s)`);
  }
  if (server) {
    server.proc.kill();
    await sleep(300);
    console.log("instance isolée arrêtée (PID propre uniquement)");
  }
}
console.log(`\n${failed ? "VERIFY_FALLBACK_FAIL" : "VERIFY_FALLBACK_PASS"} : ${passed} vérification(s) réussie(s), ${failed} échec(s)`);
console.log(`journaux : ${scratch}`);
process.exit(failed ? 1 : 0);
