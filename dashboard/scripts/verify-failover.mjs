// Vérification de la surveillance et de la reprise automatique (T10) : machine d'états pure, gestionnaire avec un
// faux hôte dont on coupe la réponse, puis vrai serveur isolé (port 7078, données jetables) avec redémarrage.
// Usage : node dashboard/scripts/verify-failover.mjs   (autonome ; le serveur 7070 n'est ni utilisé ni modifié)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { createStore } from "../lib/store.mjs";
import { FailoverManager, nextState } from "../handlers/failover.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(dashboardDir, "..", ".foreman", "scratch", `t10-failover-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (t) => console.log(`\n=== ${t} ===`);
const throws = (fn, re, label) => {
  try { fn(); fail(label, "aucune erreur levée"); } catch (e) { expect(re.test(e.message), label, e.message); }
};
async function until(pred, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  fail(`délai dépassé : ${label}`);
  return false;
}

// =====================================================================================================================
section("nextState : fonction pure (nextState(state, event, config, now))");
const T0 = 1_000_000;
const CFG = { thresholdMinutes: 1, minPings: 3 }; // 60 000 ms
const fresh = (over = {}) => ({ status: "monitoring", consecutiveFailures: 0, firstFailureAt: null, lastSuccessAt: null, lastPingAt: null, resumedTasks: [], ...over });
const feed = (events, { cfg = CFG, state = fresh(), start = T0, step = 1000 } = {}) =>
  events.reduce((s, e, i) => nextState(s, typeof e === "string" ? { type: e } : e, cfg, start + i * step), state);
const F = "ping_failure";
const S = "ping_success";

expect(feed([S]).status === "monitoring" && feed([S]).consecutiveFailures === 0, "1. succès en monitoring : reste monitoring, compteur à 0");
expect(feed([F]).status === "monitoring" && feed([F]).consecutiveFailures === 1, "2. un échec : reste monitoring (faux positif évité)");
expect(feed([F, F]).status === "monitoring", "3. deux échecs : toujours monitoring (minimum 3 échecs)");
expect(feed([F, F, F]).status === "suspect", "4. trois échecs consécutifs : suspect");
expect(feed([F, F, S]).status === "monitoring" && feed([F, F, S]).consecutiveFailures === 0, "5. deux échecs puis succès : compteur remis à zéro, jamais suspect");
expect(feed([F, F, S, F, F]).status === "monitoring", "6. le compteur est bien consécutif (F F S F F ne fait pas suspect)");
expect(feed([F, F, F, S]).status === "monitoring", "7. suspect puis retour de vie : revient à monitoring");
expect(feed([F, F, F, F]).status === "suspect", "8. suspect avant le seuil (4 s sur 60 s) : reste suspect même avec plus d'échecs");
{
  const s = feed([F, F, F, F], { step: 30000 }); // 3e échec à 60 s, 4e à 90 s après le premier
  expect(s.status === "unreachable", "9. seuil de 1 min dépassé depuis le premier échec : unreachable");
  expect(feed([F, F, F], { step: 30000 }).status === "suspect", "10. au seuil exact mais en monitoring : passe d'abord par suspect (jamais de saut)");
  expect(feed([F], { state: s }).status === "unreachable" && feed([F], { state: s }).consecutiveFailures === s.consecutiveFailures + 1, "11. double événement : un échec de plus en unreachable ne change pas l'état");
  expect(feed([S], { state: s }).status === "monitoring", "12. retour de vie en unreachable (sans reprise) : monitoring");
  expect(feed(["resume_start"], { state: s }).status === "resuming", "13. resume_start depuis unreachable : resuming");
  const r = feed(["resume_start", "resume_start"], { state: s });
  expect(r.status === "resuming", "14. resume_start déjà en resuming : ignoré (un seul plan à la fois)");
  const done = feed(["resume_start", { type: "resume_done", tasks: [{ id: "t1", title: "T", branch: "reprise/20261014-0100" }] }], { state: s });
  expect(done.status === "resumed" && done.resumedTasks.length === 1, "15. resume_done avec tâches : resumed");
  expect(feed([{ type: "resume_done", tasks: [{ id: "t1" }] }], { state: s }).status === "unreachable", "16. resume_done hors resuming : ignoré");
  expect(feed(["resume_start", { type: "resume_done", tasks: [] }], { state: s }).status === "unreachable", "17. rien à reprendre : retour à unreachable (pas de faux « resumed »)");
  expect(feed(["resume_start", { type: "resume_failed", error: "boom" }], { state: s }).status === "resume_failed", "18. échec de reprise : resume_failed");
  const again = feed(["resume_start", { type: "resume_done", tasks: [{ id: "t1" }] }, "resume_start"], { state: s });
  expect(again.status === "resumed", "19. resume_start en resumed : ignoré");
  const dedupe = feed([{ type: "resume_done", tasks: [{ id: "t1" }, { id: "t2" }] }], { state: { ...again, status: "resuming" } });
  expect(dedupe.resumedTasks.length === 2, "20. une tâche déjà reprise n'est pas dupliquée");
  expect(feed([S], { state: done }).status === "reclaim_available", "21. resumed + machine de retour : reclaim_available (pas de retour automatique)");
  const rec = feed([S], { state: done });
  expect(feed([S, S], { state: done }).status === "reclaim_available", "22. reclaim_available + succès : reste reclaim_available");
  expect(feed(["reclaim_start"], { state: rec }).status === "reclaiming", "23. reclaim_start depuis reclaim_available : reclaiming");
  expect(feed(["reclaim_start"], { state: done }).status === "resumed", "24. reclaim_start hors reclaim_available : ignoré");
  const back = feed(["reclaim_start", "reclaim_done"], { state: rec });
  expect(back.status === "monitoring" && back.resumedTasks.length === 0, "25. reclaim_done : monitoring, tâches reprises effacées");
  expect(feed([F, F, F], { state: rec }).status === "resumed", "26. la machine retombe pendant reclaim_available : retour à resumed");
  expect(feed([S], { state: fresh({ status: "resume_failed", resumedTasks: [] }) }).status === "monitoring", "27. resume_failed + machine de retour : monitoring (rien à rapatrier)");
}
{
  const input = fresh();
  const frozen = JSON.stringify(input);
  nextState(input, { type: F }, CFG, T0);
  expect(JSON.stringify(input) === frozen, "28. la fonction est pure : l'état d'entrée n'est jamais modifié");
  expect(feed([F, F, F], { state: fresh({ status: "idle" }) }).status === "idle", "29. état idle (désarmé) : aucun échec ne déclenche quoi que ce soit");
  expect(nextState(fresh(), { type: "inconnu" }, CFG, T0).status === "monitoring", "30. événement inconnu ignoré");
  expect(feed([F, F]).status === "monitoring" && feed([F, F], { cfg: { thresholdMinutes: 1, minPings: 2 } }).status === "suspect", "31. minPings configurable (2 échecs suffisent avec minPings=2)");
}

// =====================================================================================================================
section("Gestionnaire avec faux hôte dont on coupe la réponse");
process.env.BRAIN_DB = join(work, "brain.sqlite");
{
  const db = new DatabaseSync(process.env.BRAIN_DB);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'todo', agent_id TEXT, error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0)`);
  const ins = db.prepare("INSERT INTO tasks (id,title,description,project,host,status,agent_id,error) VALUES (?,?,?,?,?,?,?,?)");
  ins.run("A", "Tâche A (cochée)", "Faire A", "D:\\Projets\\ProjA", "mini", "doing", "ag-A", "Erreur récente A");
  ins.run("B", "Tâche B (non cochée)", "Faire B", "D:\\Projets\\ProjB", "mini", "doing", "ag-B", "");
  ins.run("C", "Tâche C (cochée, agent sur Oracle)", "Faire C", "D:\\Projets\\ProjC", "mini", "doing", "ag-C", "");
  ins.run("D", "Tâche D (cochée, mais à faire)", "Faire D", "D:\\Projets\\ProjD", "mini", "todo", null, "");
  ins.run("E", "Tâche E (cochée, déjà sur Oracle)", "Faire E", "/home/ubuntu/projets/ProjE", "oracle", "doing", null, "");
  db.close();
}
function makeWorld() {
  const fh = { connected: true, alive: true, hang: false, failNext: 0, pings: 0, inflight: 0, maxInflight: 0 };
  const oracleAgents = [{ id: "ag-C", status: "running" }];
  const mini = {
    label: "mini", url: "ws://mini:1", connected: () => fh.connected, api: {},
    daemon: {
      async ping() {
        fh.pings++; fh.inflight++; fh.maxInflight = Math.max(fh.maxInflight, fh.inflight);
        try {
          if (fh.hang) return await new Promise(() => {});
          if (fh.failNext > 0) { fh.failNext--; throw new Error("pas de réponse"); }
          if (!fh.alive) throw new Error("pas de réponse");
          return { rttMs: 1 };
        } finally { fh.inflight--; }
      },
    },
  };
  const oracle = { label: "oracle", url: "ws://100.1.1.1:1", connected: () => true, daemon: {}, api: { agents: { list: async () => ({ entries: oracleAgents.map((agent) => ({ agent })) }) } } };
  const map = { mini, oracle };
  const hosts = { get: (l) => map[l], has: (l) => l in map, labels: () => Object.keys(map) };
  return { fh, hosts };
}
function makeCtx(name, world) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const bus = [];
  const inbox = [];
  return {
    bus, inbox, dir, store: createStore(dir),
    ctx: { dataDir: dir, store: createStore(dir), hosts: world.hosts, broadcast: (m) => bus.push(m), send() {}, log() {}, safeError: (e) => e.message, inbox: { add: (i) => { inbox.push(i); return i; } } },
  };
}
const statesOf = (bus) => bus.filter((m) => m.type === "failover.status").map((m) => m.state).filter((s, i, a) => s !== a[i - 1]);
const countingExecutor = (calls, delayMs = 0, failWith = null) => ({
  async resume(c, plan) {
    calls.push(plan);
    if (delayMs) await sleep(delayMs);
    if (failWith) throw new Error(failWith);
    return { ok: true, simulated: true };
  },
  async reclaim() { return { ok: true, simulated: true }; },
});
const FAST = { intervalMs: 50, pingTimeoutMs: 80 };

{
  const world = makeWorld();
  const { ctx, bus, inbox, dir } = makeCtx("flow1", world);
  const calls = [];
  const m = new FailoverManager(ctx, { ...FAST, resumeExecutor: countingExecutor(calls) });
  expect(m.getStatus().armed === false && m.getStatus().state === "idle", "départ : désarmé, état idle");
  await sleep(250);
  expect(world.fh.pings === 0, "désarmé : aucun test de vie");
  throws(() => m.arm({ host: "inconnue" }), /Machine inconnue/, "arm sur une machine inconnue : refusé");
  throws(() => m.arm({ host: "mini", thresholdMinutes: -1 }), /thresholdMinutes/, "arm avec seuil négatif : refusé");
  throws(() => m.arm({ host: "mini", minPings: 0 }), /minPings/, "arm avec minPings = 0 : refusé");
  throws(() => m.arm({ host: "mini", intervalMs: 5 }), /intervalMs/, "arm avec intervalle < 100 ms : refusé");
  expect(m.getStatus().armed === false, "les armements refusés n'ont rien changé");
  throws(() => m.setAutoResume("", true), /taskId/, "setAutoResume sans taskId : refusé");
  throws(() => m.setAutoResume("A", "oui"), /true ou false/, "setAutoResume avec « on » non booléen : refusé");
  for (const id of ["A", "C", "D", "E"]) m.setAutoResume(id, true);
  const armed = m.arm({ host: "mini", thresholdMinutes: 0.01, minPings: 3 });
  expect(armed.armed === true && armed.state === "monitoring" && armed.host === "mini", "arm : armé, monitoring, hôte mini");
  await sleep(400);
  expect(m.getStatus().state === "monitoring" && m.getStatus().missedPings === 0 && world.fh.pings >= 5, `hôte vivant : reste monitoring (${world.fh.pings} tests de vie)`);

  world.fh.alive = false; // on coupe la réponse du faux hôte
  await until(() => m.getStatus().state === "resumed", "monitoring -> suspect -> unreachable -> resuming -> resumed");
  const seq = statesOf(bus);
  console.log(`TRANSITIONS ${JSON.stringify(seq)}`);
  const idx = (s) => seq.indexOf(s);
  expect(idx("monitoring") >= 0 && idx("suspect") > idx("monitoring") && idx("unreachable") > idx("suspect") && idx("resuming") > idx("unreachable") && idx("resumed") > idx("resuming"),
    "ordre observé : monitoring, suspect, unreachable, resuming, resumed");
  expect(calls.length === 1 && calls[0].taskId === "A", "plan de reprise produit pour la seule tâche cochée en cours sur l'hôte principal (A)", JSON.stringify(calls.map((c) => c.taskId)));
  const plan = calls[0];
  expect(/^reprise\/\d{8}-\d{4}$/.test(plan.branch) && plan.targetDir === "/home/ubuntu/projets/ProjA", "plan : branche reprise/<date> et dossier Oracle traduit", `${plan.branch} ${plan.targetDir}`);
  expect(["Linux", "Faire A", "Erreur récente A", plan.branch, "/home/ubuntu/projets/ProjA", "perdu"].every((s) => plan.prompt.includes(s)), "invite de reprise : système, objectif, erreurs, branche, dossier, avertissement travail non commité");
  const st = m.getStatus();
  expect(!calls.some((c) => ["B", "D", "E"].includes(c.taskId)), "aucun plan pour B (non cochée), D (à faire), E (autre hôte)");
  expect(st.skipped.length === 1 && st.skipped[0].id === "C" && /oracle/.test(st.skipped[0].reason), "tâche C ignorée : elle a déjà un propriétaire actif sur Oracle", JSON.stringify(st.skipped));
  expect(st.resumePlans.length === 1 && st.resumePlans[0].status === "resumed" && st.resumedTasks[0].id === "A", "plan enregistré et statut « resumed »");
  await sleep(600);
  expect(calls.length === 1 && m.getStatus().state === "resumed", "600 ms plus tard (machine toujours muette) : pas de double reprise");
  await Promise.all([m.evaluateResume(), m.evaluateResume()]);
  expect(calls.length === 1, "évaluations concurrentes forcées : toujours un seul plan");
  expect(world.fh.maxInflight === 1, "les tests de vie ne se chevauchent jamais", `max ${world.fh.maxInflight}`);
  const kinds = inbox.map((i) => `${i.kind}/${i.source}/${i.title}`);
  expect(inbox.length >= 4 && inbox.every((i) => i.source === "failover" && i.kind === "machine"), `boîte de réception : ${inbox.length} éléments source « failover »`, kinds.join(" | "));
  expect(inbox.some((i) => /suspecte/.test(i.title)) && inbox.some((i) => /injoignable/.test(i.title)) && inbox.some((i) => /Reprise automatique/.test(i.title)), "éléments pour suspect, injoignable et reprise");
  const file = JSON.parse(readFileSync(join(dir, "failover.json"), "utf8"));
  expect(file.armed === true && file.host === "mini" && file.state.status === "resumed" && file.resumePlans.length === 1 && file.autoResumeTaskIds.includes("A"), "data/failover.json : armé, hôte, état, plan, tâches cochées");

  // redémarrage du module : l'état armé est restauré et la reprise n'est pas rejouée
  m.close();
  const calls2 = [];
  const m2 = new FailoverManager({ ...ctx, store: createStore(dir) }, { resumeExecutor: countingExecutor(calls2) });
  const s2 = m2.getStatus();
  expect(s2.armed === true && s2.host === "mini" && s2.state === "resumed" && s2.thresholdMinutes === 0.01 && s2.intervalMs === 50, "redémarrage : armé, hôte, seuil, intervalle et état « resumed » restaurés", JSON.stringify(s2).slice(0, 200));
  expect(s2.autoResumeTaskIds.join() === "A,C,D,E" && s2.resumedTasks.length === 1, "redémarrage : tâches cochées et tâches reprises restaurées");
  await sleep(500);
  expect(calls2.length === 0 && m2.getStatus().state === "resumed", "après redémarrage, machine toujours muette : aucune seconde reprise");

  // retour de vie
  world.fh.alive = true;
  await until(() => m2.getStatus().state === "reclaim_available", "retour de vie -> reclaim_available");
  expect(inbox.some((i) => /de retour/.test(i.title)), "élément « machine de retour » dans la boîte");
  await sleep(300);
  expect(m2.getStatus().state === "reclaim_available" && calls2.length === 0, "pas de retour automatique : reste reclaim_available");
  try { await m2.reclaim({}); fail("reclaim sans confirm"); } catch (e) { expect(/confirm/.test(e.message), "reclaim sans confirm:true : refusé"); }
  const bus2 = [];
  m2.ctx.broadcast = (x) => bus2.push(x);
  const rec = await m2.reclaim({ confirm: true });
  expect(rec.ok && rec.simulated && m2.getStatus().state === "monitoring" && m2.getStatus().resumePlans.length === 0, "reclaim confirmé (simulation) : monitoring, plans effacés");
  expect(bus2.filter((x) => x.type === "failover.reclaim.status").map((x) => x.step).join() === "stopping_oracle_agents,pushing,pulling_local,reassigning,done", "étapes failover.reclaim.status diffusées dans l'ordre");
  try { await m2.reclaim({ confirm: true }); fail("reclaim hors reclaim_available"); } catch (e) { expect(/indisponible/.test(e.message), "reclaim hors reclaim_available : refusé"); }

  // désarmement : plus aucun test de vie
  m2.disarm();
  const pings = world.fh.pings;
  await sleep(300);
  expect(world.fh.pings === pings && m2.getStatus().state === "idle", "désarmé : plus aucun test de vie, état idle");
  expect(JSON.parse(readFileSync(join(dir, "failover.json"), "utf8")).armed === false, "désarmement persisté");
  m2.close();
}

section("Faux positifs, délai de réponse, échec de reprise, reprise lente");
{
  // deux échecs puis succès ; puis suspect puis retour de vie
  const world = makeWorld();
  const { ctx, bus, inbox } = makeCtx("flow2", world);
  const m = new FailoverManager(ctx, { ...FAST, resumeExecutor: countingExecutor([]) });
  m.arm({ host: "mini", thresholdMinutes: 5, minPings: 3 });
  world.fh.failNext = 2;
  await sleep(500);
  expect(!statesOf(bus).includes("suspect") && m.getStatus().missedPings === 0, "2 échecs puis succès : jamais suspect");
  world.fh.failNext = 1000;
  await until(() => m.getStatus().state === "suspect", "suspect après 3 échecs");
  expect(!inbox.some((i) => /injoignable/.test(i.title)), "suspect n'est PAS injoignable : aucune reprise avant le seuil de 5 min");
  world.fh.failNext = 0;
  await until(() => m.getStatus().state === "monitoring", "suspect -> monitoring au retour de vie");
  expect(inbox.some((i) => /de nouveau joignable/.test(i.title)), "fausse alerte signalée dans la boîte");
  m.close();
}
{
  // réponse qui ne vient jamais : le délai du test de vie la compte comme un échec
  const world = makeWorld();
  const { ctx, bus } = makeCtx("flow3", world);
  const m = new FailoverManager(ctx, { ...FAST, resumeExecutor: countingExecutor([]) });
  m.arm({ host: "mini", thresholdMinutes: 5, minPings: 2 });
  world.fh.hang = true;
  await until(() => m.getStatus().state === "suspect", "hôte muet (promesse jamais résolue) -> suspect via le délai de 80 ms");
  world.fh.connected = false;
  world.fh.hang = false;
  await sleep(300);
  expect(m.getStatus().state === "suspect", "client déconnecté = pas de vie, même si le daemon répondrait");
  m.close();
}
{
  // exécuteur qui échoue : resume_failed, aucun nouvel essai automatique ; puis la machine revient
  const world = makeWorld();
  const { ctx, inbox } = makeCtx("flow4", world);
  const calls = [];
  const m = new FailoverManager(ctx, { ...FAST, resumeExecutor: countingExecutor(calls, 0, "clone refusé") });
  m.setAutoResume("A", true);
  m.arm({ host: "mini", thresholdMinutes: 0.01, minPings: 2 });
  world.fh.alive = false;
  await until(() => m.getStatus().state === "resume_failed", "exécuteur en échec -> resume_failed");
  await sleep(400);
  expect(calls.length === 1 && m.getStatus().resumePlans[0].status === "failed", "échec enregistré dans le plan, aucun nouvel essai automatique", String(calls.length));
  expect(inbox.some((i) => /en échec/.test(i.title)), "échec signalé dans la boîte");
  world.fh.alive = true;
  await until(() => m.getStatus().state === "monitoring", "machine de retour après un échec sans rien de repris -> monitoring");
  m.close();
}
{
  // exécuteur lent : un seul plan à la fois, les tests de vie continuent pendant la reprise
  const world = makeWorld();
  const { ctx, bus } = makeCtx("flow5", world);
  const calls = [];
  const m = new FailoverManager(ctx, { ...FAST, resumeExecutor: countingExecutor(calls, 500) });
  for (const id of ["A"]) m.setAutoResume(id, true);
  m.arm({ host: "mini", thresholdMinutes: 0.01, minPings: 2 });
  world.fh.alive = false;
  await until(() => m.getStatus().state === "resuming", "état resuming pendant l'exécution lente");
  const during = world.fh.pings;
  await Promise.all([m.evaluateResume(), m.evaluateResume()]);
  await sleep(200);
  expect(calls.length === 1, "pas de double reprise pendant resuming", String(calls.length));
  await until(() => m.getStatus().state === "resumed", "resumed à la fin de l'exécuteur lent");
  expect(world.fh.pings > during, "les tests de vie continuaient pendant la reprise");
  m.close();
}

// =====================================================================================================================
section("Serveur réel (instance isolée sur 7078, données jetables) : messages et redémarrage");
const PORT = 7078;
const srvData = join(work, "srv-data");
mkdirSync(srvData, { recursive: true });
function startServer() {
  const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: srvData };
  delete env.BRAIN_DB; delete env.DASHBOARD_PASSWORD;
  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const state = { proc, log: "" };
  proc.stdout.on("data", (d) => { state.log += d; });
  proc.stderr.on("data", (d) => { state.log += d; });
  return state;
}
async function connect(srv) {
  for (let i = 0; i < 200 && !srv.log.includes("Paseo dashboard :"); i++) await sleep(100);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: `http://127.0.0.1:${PORT}` });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const take = async (pred, label, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await sleep(30);
    }
    fail(`délai dépassé : ${label}`);
    return null;
  };
  const rpc = (msg, pred, label, timeout) => { inbox.length = 0; ws.send(JSON.stringify(msg)); return take(pred, label, timeout); };
  // attend que la machine locale soit connectée côté serveur
  await take((m) => m.type === "state" && m.payload?.hosts?.some((h) => h.label === "local" && h.status === "connected"), "machine locale connectée", 30000);
  return { ws, inbox, rpc, take };
}
let srv = startServer();
try {
  let c = await connect(srv);
  expect(/chargé : failover\.mjs/.test(srv.log), "serveur de test démarré, failover.mjs chargé");
  const st0 = await c.rpc({ type: "failover.status", ref: "r1" }, (m) => m.type === "failover.status", "status initial");
  expect(st0?.armed === false && st0.state === "idle" && st0.ref === "r1", "failover.status initial : désarmé, idle, ref renvoyée");
  const bad = await c.rpc({ type: "failover.arm", host: "fantome" }, (m) => m.type === "error" && m.source === "failover.arm", "arm hôte inconnu");
  expect(/Machine inconnue/.test(bad?.message || ""), "WS : arm sur une machine inconnue -> erreur");
  const armed = await c.rpc({ type: "failover.arm", host: "local", thresholdMinutes: 5, minPings: 3, intervalMs: 200, ref: "r2" }, (m) => m.type === "failover.armed", "failover.armed");
  expect(armed?.armed === true && armed.ref === "r2" && armed.thresholdMinutes === 5, "WS : failover.arm répond failover.armed (type non écrasé), armé");
  await sleep(1200);
  const st1 = await c.rpc({ type: "failover.status" }, (m) => m.type === "failover.status", "status après ticks");
  console.log(`FAILOVER_REEL ${JSON.stringify({ state: st1?.state, missedPings: st1?.missedPings, lastPing: st1?.lastPing, lastSuccess: st1?.lastSuccess, intervalMs: st1?.intervalMs })}`);
  expect(st1?.state === "monitoring" && st1.missedPings === 0 && !!st1.lastSuccess, "vraie machine locale : vrai ping du daemon réussi, monitoring, 0 échec");
  const auto = await c.rpc({ type: "failover.setAutoResume", taskId: "tache-xyz", on: true }, (m) => m.type === "failover.autoResumeSet", "setAutoResume");
  expect(auto?.taskId === "tache-xyz" && auto.on === true, "WS : setAutoResume");
  const rc1 = await c.rpc({ type: "failover.reclaim" }, (m) => m.type === "error" && m.source === "failover.reclaim", "reclaim sans confirm");
  expect(/confirm/.test(rc1?.message || ""), "WS : reclaim sans confirm refusé");
  const rc2 = await c.rpc({ type: "failover.reclaim", confirm: true }, (m) => m.type === "error" && m.source === "failover.reclaim", "reclaim en monitoring");
  expect(/indisponible/.test(rc2?.message || ""), "WS : reclaim hors reclaim_available refusé");
  const file = JSON.parse(readFileSync(join(srvData, "failover.json"), "utf8"));
  expect(file.armed === true && file.host === "local" && file.autoResumeTaskIds.includes("tache-xyz") && file.intervalMs === 200, "failover.json écrit par le serveur");

  // redémarrage du serveur (PID lancé par ce script uniquement)
  c.ws.close();
  srv.proc.kill();
  await new Promise((r) => srv.proc.on("exit", r));
  srv = startServer();
  c = await connect(srv);
  const st2 = await c.rpc({ type: "failover.status" }, (m) => m.type === "failover.status", "status après redémarrage");
  expect(st2?.armed === true && st2.host === "local" && st2.thresholdMinutes === 5 && st2.autoResumeTaskIds.includes("tache-xyz"), "redémarrage du serveur : état armé, hôte, seuil et tâches cochées restaurés");
  await sleep(800);
  const st3 = await c.rpc({ type: "failover.status" }, (m) => m.type === "failover.status", "status après redémarrage + ticks");
  expect(st3?.state === "monitoring" && !!st3.lastSuccess, "après redémarrage la surveillance reprend toute seule (ping réel réussi)");
  const dis = await c.rpc({ type: "failover.disarm" }, (m) => m.type === "failover.disarmed", "disarm");
  expect(dis?.armed === false && dis.state === "idle", "WS : failover.disarm répond failover.disarmed");
  c.ws.close();
} catch (e) {
  fail("exception dans la section serveur", e.stack || e.message);
  console.error(srv.log.slice(-1500));
} finally {
  srv.proc.kill();
  await sleep(300);
}

try {
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
} catch (e) {
  console.warn(`nettoyage partiel de ${work} : ${e.code}`);
}
console.log(`\n=== Résumé : ${passed} OK, ${failed} FAIL ===`);
if (failed > 0) process.exit(1);
console.log("VERIFY_FAILOVER_PASS");
process.exit(0);
