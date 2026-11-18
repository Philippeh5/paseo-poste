// Vérification du transfert vers Oracle (T10) : sécurité, machine d'états, persistance, reprise, vrai dépôt git jetable.
// Usage : node dashboard/scripts/verify-transfer.mjs   (autonome : lance sa propre instance du serveur sur le port 7079
// avec une COPIE des données ; le serveur 7070 n'est ni utilisé ni modifié).
// Garanties de ce script : aucune extinction (les ordres vont à un faux daemon), aucun push GitHub (le « GitHub » du
// dépôt jetable est redirigé par insteadOf vers un dépôt nu local, contrôlé avant tout push), aucun commit dans les
// dépôts de Philippe (instantané HEAD/branche de tous les projets suivis avant et après).
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { createStore } from "../lib/store.mjs";
import {
  TransferManager, buildPlan, createRealExecutors, createSimulationExecutors, SHUTDOWN_COMMAND,
} from "../handlers/transfer.mjs";
import {
  buildResumePrompt, isMainOrMaster, isTransferBranch, makeBranchName, redact, sensitivePaths, translateProjectPath,
} from "../lib/transfer-steps.mjs";

const here = fileURLToPath(import.meta.url);
const dashboardDir = join(dirname(here), "..");
const scratch = join(dashboardDir, "..", ".foreman", "scratch");
const work = join(scratch, `t10-transfer-${process.pid}`);
const SECRET_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SECRET_PASS = "hunter2-ultra-secret";

const openManagers = [];
function mk(ctx, options) {
  const m = new TransferManager(ctx, options);
  openManagers.push(m);
  return m;
}

// ---------- Mode enfant : processus qui « plante » au milieu d'un transfert ----------
if (process.argv[2] === "--crash-child") {
  const [, , , dbPath, dataDir] = process.argv;
  const ctx = { dataDir, store: createStore(dataDir), hosts: { get: () => null }, broadcast() {}, send() {}, log() {}, safeError: String };
  const ok = async () => ({ ok: true });
  const mgr = mk(ctx, {
    dbPath,
    executors: {
      check: async () => fakePlan(), stopAgents: ok, commit: ok, push: ok, reassign: ok, shutdown: ok, abortShutdown: ok,
      waitOffline: async () => true,
      clone: async () => { console.log("AT_CLONING"); await new Promise(() => {}); }, // ne rend jamais la main
    },
  });
  mgr.run({ confirm: true, dryRun: false }).catch(() => {});
  setInterval(() => {}, 1000); // garde le processus vivant jusqu'à ce que le parent le tue
  await new Promise(() => {});
}

// ---------- Utilitaires de test ----------
let passed = 0;
let failed = 0;
let skipped = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const skip = (label) => { skipped++; console.log(`SKIP ${label}`); };
const section = (t) => console.log(`\n=== ${t} ===`);
const throws = async (fn, re, label) => {
  try { await fn(); fail(label, "aucune erreur levée"); } catch (e) { expect(re.test(e.message), label, e.message); }
};
const g = (cwd, ...args) => execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const gd = (gitDir, ...args) => execFileSync("git", ["--git-dir", gitDir, ...args], { windowsHide: true, encoding: "utf8" }).trim();
const sleep = delay;

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const dataDir = join(work, "data");
mkdirSync(dataDir, { recursive: true });
process.env.BRAIN_DB = join(work, "brain.sqlite");

const TASKS_SCHEMA = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT 'local', engine TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT '',
  isolation TEXT NOT NULL DEFAULT 'local', branch TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done','blocked')),
  deps TEXT NOT NULL DEFAULT '[]', agent_id TEXT, summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  permission INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`;
function brain(fn) {
  const db = new DatabaseSync(process.env.BRAIN_DB);
  try { return fn(db); } finally { db.close(); }
}
brain((db) => db.exec(TASKS_SCHEMA));
const putTask = (t) => brain((db) => db.prepare(
  "INSERT OR REPLACE INTO tasks (id,title,description,project,host,status,agent_id,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
).run(t.id, t.title, t.description ?? "", t.project ?? "", t.host ?? "local", t.status ?? "todo", t.agent_id ?? null, t.error ?? "", "2026-10-14T00:00:00Z", "2026-10-14T00:00:00Z"));
const delTask = (id) => brain((db) => db.prepare("DELETE FROM tasks WHERE id = ?").run(id));
const getTask = (id) => brain((db) => ({ ...db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) }));

function fakePlan() {
  return {
    projects: [{ name: "p1", dir: "D:\\fake\\p1", concerned: true, oracleDir: "/home/USERNAME/projets/p1", dirty: [], githubRepo: { owner: "o", repo: "p1" } }],
    tasks: [{ id: "t1", title: "Tâche 1", project: "D:\\fake\\p1", status: "doing" }],
    agents: [{ id: "a1", task: "Tâche 1", status: "running" }],
    oracleDiskFree: 1e11, ghConnected: { local: true, oracle: true }, errors: [], blockers: [], warnings: [], forceRequired: false, ok: true,
  };
}
// Exécuteurs 100 % factices qui comptent leurs appels.
function fakeExec(counts, overrides = {}) {
  const wrap = (name, fn) => async (...args) => { counts[name] = (counts[name] || 0) + 1; return fn ? fn(...args) : { ok: true, name }; };
  const base = {
    check: async () => fakePlan(), stopAgents: null, commit: null, push: null, clone: null, reassign: null,
    shutdown: async () => ({ ordered: true }), abortShutdown: null, waitOffline: async () => true,
  };
  const out = {};
  for (const [name, fn] of Object.entries(base)) out[name] = wrap(name, overrides[name] ?? fn);
  return out;
}

// Faux monde : daemons du mini-PC et d'Oracle qui enregistrent ce qu'on leur demande.
function fakeWorld() {
  const w = {
    localOnline: true, oracleOnline: true, oracleGh: true, diskFree: 50e9, autoOffline: false, agents: [],
    oracleDirs: new Set(), oracleBranch: {}, calls: { cancel: [], localTerm: [], oracle: [] },
  };
  const local = {
    label: "local", url: "ws://fake-local:6767", connected: () => w.localOnline,
    daemon: {
      async cancelAgent(id) { w.calls.cancel.push(id); },
      async createTerminal(cwd, name, rid, opts) {
        w.calls.localTerm.push({ command: opts?.command, args: opts?.args });
        if (opts?.command === "shutdown" && opts.args[0] === "/s" && w.autoOffline) setTimeout(() => { w.localOnline = false; }, 150);
        return { terminal: { id: "t-local" }, error: null };
      },
    },
    api: {
      agents: { list: async () => ({ entries: w.agents.map((agent) => ({ agent })) }) },
      workspaces: { list: async () => ({ entries: [{ id: "wks_local", workspaceDirectory: "D:\\fake\\ws" }] }) },
    },
  };
  const oracle = {
    label: "oracle", url: "ws://100.1.1.1:6767", connected: () => w.oracleOnline,
    daemon: {
      async listDirectory(dir) { if (!w.oracleDirs.has(dir)) throw new Error("absent"); return {}; },
      async cloneGithubProject(i) {
        w.calls.oracle.push({ op: "clone", ...i });
        const checkoutPath = `${i.targetDirectory}/${i.repo.split("/")[1]}`;
        w.oracleDirs.add(checkoutPath);
        return { checkoutPath, error: null };
      },
      async checkoutPull(d) { w.calls.oracle.push({ op: "pull", dir: d }); return { error: null }; },
      async checkoutSwitchBranch(d, b) { w.calls.oracle.push({ op: "switch", dir: d, branch: b }); w.oracleBranch[d] = b; return { success: true, error: null }; },
      async getCheckoutStatus(d) { return { currentBranch: w.oracleBranch[d] }; },
      async createTerminal(cwd, name, rid, opts) { w.calls.oracle.push({ op: "terminal", cwd, command: opts?.command, args: opts?.args }); return { terminal: { id: "t-oracle" }, error: null }; },
    },
    api: { workspaces: { list: async () => ({ entries: [{ id: "wks_oracle", workspaceDirectory: "/home/USERNAME/projets/essai" }] }) } },
  };
  const map = { local, oracle };
  w.hosts = { get: (l) => map[l], has: (l) => l in map, labels: () => Object.keys(map) };
  w.deps = {
    ghState: async (h) => ({ connected: h.label === "oracle" ? w.oracleGh : true }),
    probeOracleDisk: async () => ({ freeBytes: w.diskFree, source: "test" }),
  };
  return w;
}
const makeCtx = (w, bus) => ({
  dataDir, store: createStore(dataDir), hosts: w.hosts, broadcast: (m) => bus.push(m), send() {}, log() {}, safeError: (e) => e.message,
});
const spy = (exec, counts) => Object.fromEntries(Object.entries(exec).map(([k, f]) => [k, async (...a) => { counts[k] = (counts[k] || 0) + 1; return f(...a); }]));
const dbDump = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  try {
    return JSON.stringify({ t: db.prepare("SELECT * FROM transfers").all(), e: db.prepare("SELECT * FROM transfer_events").all() });
  } finally { db.close(); }
};

// ---------- Dépôt git jetable (« GitHub » redirigé vers un dépôt nu local) ----------
const sandbox = join(work, "sandbox-repo");
const bare = join(work, "sandbox-bare.git");
const FAKE_GITHUB = "https://github.com/t10test/sandbox-repo.git";
mkdirSync(sandbox, { recursive: true });
execFileSync("git", ["init", "--bare", "-b", "main", bare], { windowsHide: true });
execFileSync("git", ["init", "-b", "main", sandbox], { windowsHide: true });
g(sandbox, "config", "user.email", "t10@test.local");
g(sandbox, "config", "user.name", "T10 Test");
g(sandbox, "config", "core.autocrlf", "false");
writeFileSync(join(sandbox, "a.txt"), "initial\n");
g(sandbox, "add", "-A");
g(sandbox, "commit", "-m", "Commit initial");
g(sandbox, "remote", "add", "origin", FAKE_GITHUB);
g(sandbox, "config", `url.${bare.replace(/\\/g, "/")}.insteadOf`, FAKE_GITHUB);
const expanded = g(sandbox, "ls-remote", "--get-url", "origin").replace(/\\/g, "/");
if (expanded !== bare.replace(/\\/g, "/")) {
  console.error(`ABANDON : l'URL effective du remote n'est pas le dépôt nu local (${expanded}) : aucun push ne sera tenté.`);
  process.exit(2);
}
g(sandbox, "push", "origin", "main");
ok("dépôt jetable prêt ; le remote « GitHub » est redirigé vers un dépôt nu local (vérifié avant tout push)");

// Instantané des dépôts réels de Philippe (HEAD + branche) pour prouver qu'on n'y a pas touché.
const livePaths = (() => {
  try { return JSON.parse(readFileSync(join(dashboardDir, "data", "projects.json"), "utf8")).projects.map((p) => p.dir); } catch { return []; }
})();
const snapshotLive = () => livePaths.map((d) => {
  try { return `${d}|${g(d, "rev-parse", "HEAD")}|${g(d, "rev-parse", "--abbrev-ref", "HEAD")}`; } catch { return `${d}|-`; }
}).join("\n");
const liveBefore = snapshotLive();

const snap = () => ({
  head: g(sandbox, "rev-parse", "HEAD"), branch: g(sandbox, "rev-parse", "--abbrev-ref", "HEAD"),
  status: g(sandbox, "status", "--porcelain"), main: g(sandbox, "rev-parse", "main"),
  bare: gd(bare, "for-each-ref", "--format=%(refname) %(objectname)"),
});

// =====================================================================================================================
section("Fonctions pures : branches, chemins, secrets, invite de reprise");
expect(isMainOrMaster("main") && isMainOrMaster("master") && isMainOrMaster("refs/heads/main") && isMainOrMaster("x/main"), "main/master reconnus sous toutes leurs formes");
expect(isTransferBranch("transfert/20261014-0130") && isTransferBranch("reprise/20261014-0130"), "branches transfert/ et reprise/ valides");
expect(!isTransferBranch("main") && !isTransferBranch("feature/x") && !isTransferBranch("transfert/../main") && !isTransferBranch("transfert/20261014-0130/main"), "toute autre branche refusée");
expect(/^transfert\/\d{8}-\d{4}$/.test(makeBranchName("transfert")), "makeBranchName suit AAAAMMJJ-HHMM");
expect((() => { try { makeBranchName("main"); return false; } catch { return true; } })(), "makeBranchName refuse un préfixe arbitraire");
expect(translateProjectPath("D:\\Projets\\X") === "/home/USERNAME/projets/X" && translateProjectPath("") === "", "D:\\Projets\\X -> /home/USERNAME/projets/X");
const sneaky = JSON.stringify(redact({ msg: `https://user:${SECRET_PASS}@github.com/x ${SECRET_TOKEN} password=${SECRET_PASS}`, password: "p", nested: { Authorization: "Bearer abcdefghijkl" } }));
expect(!sneaky.includes(SECRET_TOKEN) && !sneaky.includes(SECRET_PASS) && !sneaky.includes("abcdefghijkl"), "redact masque jeton, mot de passe, URL à identifiants, Bearer");
expect(sensitivePaths([" M a.txt", "?? .env", "?? deploy/id_rsa", "A  src/key.pem"]).length === 3, "sensitivePaths détecte .env, id_rsa, .pem (et pas a.txt)");
const prompt = buildResumePrompt({
  task: { id: "t", title: "Titre", project: "D:\\Projets\\X", description: "Faire Z" }, branch: "transfert/20261014-0130",
  lastCommit: "abc123 sujet", modifiedFiles: [" M f.js"], errors: "TypeError boom",
});
expect(["Linux", "/home/USERNAME/projets/X", "transfert/20261014-0130", "abc123 sujet", "f.js", "TypeError boom", "Faire Z"].every((s) => prompt.includes(s)),
  "invite de reprise : système, dossier traduit, branche, dernier commit, fichiers, erreurs, objectif");

// =====================================================================================================================
section("Plan réel sur dépôt git jetable (buildPlan) : lecture seule");
const world = fakeWorld();
const bus = [];
const ctx = makeCtx(world, bus);
const counts = {};
const realExec = createRealExecutors(world.deps);
const sandboxFwd = sandbox.replace(/\\/g, "/");
writeFileSync(join(sandbox, "a.txt"), "initial\nmodifié\n");
writeFileSync(join(sandbox, "work.txt"), "nouveau\n");
putTask({ id: "T1", title: "Corriger le bug X", description: "Corriger le bug X dans a.txt", project: sandboxFwd, status: "doing", agent_id: "agent-1", error: "TypeError: boom" });
putTask({ id: "T2", title: "Tâche à faire", project: sandbox, status: "todo" });
putTask({ id: "T3", title: "Tâche terminée", project: "D:\\autre", status: "done" });
world.agents = [{ id: "agent-1", status: "running" }, { id: "other-agent", status: "running" }];
const S0 = snap();
const plan0 = await buildPlan(ctx, {}, world.deps);
const p0 = plan0.projects.find((p) => p.concerned);
expect(plan0.projects.length === 1 && p0?.name === "sandbox-repo", "un seul projet concerné, déduit des tâches todo/doing (la tâche done est ignorée)", JSON.stringify(plan0.projects.map((p) => p.name)));
expect(p0?.isGit && p0.branch === "main" && p0.dirtyCount === 2, "dépôt git, branche main, 2 fichiers modifiés détectés", JSON.stringify(p0));
expect(p0?.remoteUrl === FAKE_GITHUB && p0.githubRepo?.owner === "t10test", "URL du dépôt distant lue (config brute, sans insteadOf)");
expect(p0?.oracleDir === "/home/USERNAME/projets/sandbox-repo" && p0.oracleExists === false && p0.diskNeeded > 0, "dossier Oracle traduit, absent côté Oracle, taille estimée");
expect(plan0.ghConnected.oracle === true && plan0.oracleDiskFree === 50e9 && plan0.blockers.length === 0 && plan0.ok, "gh connecté sur Oracle : aucun blocage, espace disque rapporté");
expect(plan0.agents.length === 1 && plan0.agents[0].id === "agent-1" && plan0.tasks.length === 2, "agents/tâches concernés = ceux des tâches (pas tous les agents)");
expect(plan0.warnings.some((w) => w.code === "other_agents" && w.forceRequired) && plan0.forceRequired, "l'autre agent actif est un avertissement qui exige force");
expect(JSON.stringify(snap()) === JSON.stringify(S0), "le plan n'a modifié ni le dépôt ni le remote");

section("Blocages détectés dynamiquement (aucun contournable par force)");
const blockedBy = async (label, code) => {
  const plan = await buildPlan(ctx, {}, world.deps);
  expect(plan.blockers.some((b) => b.code === code) && !plan.ok, `blocage ${code} : ${label}`, JSON.stringify(plan.blockers.map((b) => b.code)));
  return plan;
};
world.oracleGh = false;
await blockedBy("gh déconnecté sur Oracle", "github_oracle_disconnected");
{
  const m = mk(ctx, { dbPath: join(work, "blk.sqlite"), executors: spy(realExec, counts) });
  const c2 = {};
  const m2 = mk(ctx, { dbPath: join(work, "blk2.sqlite"), executors: spy(createRealExecutors(world.deps), c2) });
  await throws(() => m2.run({ confirm: true, dryRun: true, force: true }), /GitHub n’est pas connecté sur la machine Oracle/, "force:true ne contourne pas « gh non connecté sur Oracle »");
  expect(m2.status().state === "failed(checking)" && !c2.stopAgents, "état failed(checking), aucun exécuteur d'étape suivante appelé");
  m.close(); m2.close();
}
world.oracleGh = true;
const none = await buildPlan(ctx, {}, world.deps);
expect(!none.blockers.some((b) => b.code === "github_oracle_disconnected"), "gh de nouveau connecté : le blocage disparaît (détection dynamique)");
world.diskFree = 1.2e9;
await blockedBy("espace Oracle < 2 Go après clone", "disk_low");
world.diskFree = 50e9;
world.oracleOnline = false;
await blockedBy("Oracle non connecté", "oracle_unreachable");
world.oracleOnline = true;
writeFileSync(join(sandbox, ".env"), "SECRET=1\n");
await blockedBy("fichier .env non ignoré", "sensitive_file");
rmSync(join(sandbox, ".env"));
const nested = join(sandbox, "sous-dossier");
mkdirSync(nested, { recursive: true });
putTask({ id: "T-nested", title: "sous-dossier", project: nested, status: "todo" });
await blockedBy("projet = sous-dossier d'un dépôt (commit du parent interdit)", "not_git");
delTask("T-nested");
const noRemote = join(work, "sans-remote");
mkdirSync(noRemote, { recursive: true });
g(noRemote, "init", "-b", "main");
g(noRemote, "config", "user.email", "t@t"); g(noRemote, "config", "user.name", "t");
writeFileSync(join(noRemote, "x"), "x"); g(noRemote, "add", "-A"); g(noRemote, "commit", "-m", "x");
putTask({ id: "T-noremote", title: "sans remote", project: noRemote, status: "todo" });
await blockedBy("dépôt sans remote", "no_remote");
{
  const c3 = {};
  const m3 = mk(ctx, { dbPath: join(work, "blk3.sqlite"), executors: spy(createRealExecutors(world.deps), c3) });
  await throws(() => m3.run({ confirm: true, dryRun: true, force: true }), /dépôt distant/, "force:true ne contourne pas « pas de dépôt distant »");
  m3.close();
}
delTask("T-noremote");
expect((await buildPlan(ctx, {}, world.deps)).ok, "après retrait des cas bloquants, le plan est de nouveau valide");

// =====================================================================================================================
section("Garde-fous de transfer.run");
const mgrDb = join(work, "main.sqlite");
const mgr = mk(ctx, { dbPath: mgrDb, executors: spy(realExec, counts) });
const rows = () => {
  const db = new DatabaseSync(mgrDb);
  try { return db.prepare("SELECT COUNT(*) AS n FROM transfers").get().n; } finally { db.close(); }
};
await throws(() => mgr.run({ dryRun: true }), /confirm/i, "sans confirm : refusé");
await throws(() => mgr.run({ dryRun: true, confirm: false }), /confirm/i, "confirm:false : refusé, même en dryRun");
await throws(() => mgr.run({ confirm: true }), /dryRun/, "dryRun non précisé : refusé");
await throws(() => mgr.run({ confirm: true, dryRun: "true" }), /dryRun/, "dryRun « true » (chaîne) : refusé, pas interprété comme faux");
expect(rows() === 0 && !counts.check, "refus avant toute écriture en base et tout contrôle");

section("dryRun complet : la simulation n'appelle JAMAIS un exécuteur réel");
{
  const c = {};
  const boom = () => { throw new Error("EXÉCUTEUR RÉEL APPELÉ EN DRYRUN"); };
  const real = fakeExec(c, { stopAgents: boom, commit: boom, push: boom, clone: boom, reassign: boom, shutdown: boom, abortShutdown: boom });
  const b = [];
  const m = mk({ ...ctx, broadcast: (x) => b.push(x) }, { dbPath: join(work, "dry.sqlite"), executors: real });
  const res = await m.run({ confirm: true, dryRun: true, confirmShutdown: true, force: true });
  const steps = b.filter((x) => x.type === "transfer.status").map((x) => x.step);
  expect(res.status === "done" && m.status().state === "done", "dryRun atteint done sans confirmShutdown requis pour la simulation (et sans planter)");
  expect(JSON.stringify(steps) === JSON.stringify(["checking", "stopping_agents", "committing", "cloning", "reassigning", "shutting_down", "done"]), "transitions diffusées dans l'ordre", steps.join(">"));
  expect(c.check === 1 && !c.shutdown && !c.commit && !c.push && !c.clone && !c.reassign && !c.stopAgents, "seul le contrôle (lecture seule) est réel", JSON.stringify(c));
  const row = m.row(res.id);
  const results = JSON.parse(row.results_json);
  expect(results.shutdown.simulated === true && results.shutdown.command === SHUTDOWN_COMMAND && SHUTDOWN_COMMAND === 'shutdown /s /t 60 /c "Transfert vers Oracle"', "extinction simulée : commande annulable décrite, non exécutée", results.shutdown.command);
  expect(results.commit["D:\\fake\\p1"].simulated && /^transfert\/\d{8}-\d{4}$/.test(results.commit["D:\\fake\\p1"].branch), "commit simulé visant transfert/<date>");
  const ev = m.events(res.id);
  expect(["checking", "stopping_agents", "committing", "cloning", "reassigning", "shutting_down", "done"].every((s) => ev.some((e) => e.step === s)), `journal : ${ev.length} événements couvrant les 7 étapes`);
  expect(b.some((x) => x.type === "transfer.done" && x.summary?.shutdown === "simulée"), "transfer.done diffusé avec résumé");
  console.log(`JOURNAL_DRYRUN ${JSON.stringify(ev.map((e) => `${e.step}:${e.message}`).slice(0, 6))} ...`);
  m.close();
}

section("dryRun sur le vrai dépôt jetable : rien ne bouge");
{
  const c = {};
  const m = mk(ctx, { dbPath: join(work, "dry2.sqlite"), executors: spy(createRealExecutors(world.deps), c) });
  const res = await m.run({ confirm: true, dryRun: true, force: true });
  const S1 = snap();
  expect(res.status === "done", "dryRun réel (contrôle réel + simulation) terminé");
  expect(JSON.stringify(S1) === JSON.stringify(S0), "dépôt jetable identique avant/après (HEAD, branche, statut, remote nu)");
  expect(!world.calls.cancel.length && !world.calls.localTerm.length && !world.calls.oracle.length, "aucun appel de daemon (arrêt d'agent, terminal, clone)");
  expect(getTask("T1").host === "local" && getTask("T1").status === "doing", "tâches inchangées en base");
  m.close();
}

// =====================================================================================================================
section("Transfert réel sur le dépôt jetable (force:true, sans extinction)");
let realBranch;
{
  const c = {};
  const m = mk(ctx, { dbPath: join(work, "real.sqlite"), executors: spy(createRealExecutors(world.deps), c) });
  await throws(() => m.run({ confirm: true, dryRun: false }), /autre\(s\) agent\(s\) actif\(s\)/, "sans force : l'avertissement « autres agents actifs » bloque");
  expect(m.status().state === "failed(checking)" && !c.stopAgents, "état failed(checking), rien d'autre exécuté");
  const res = await m.run({ confirm: true, dryRun: false, force: true });
  realBranch = JSON.parse(m.row(res.id).results_json).meta.branch;
  expect(res.status === "done" && m.status().state === "done", "force:true passe l'avertissement : relance depuis l'étape échouée, transfert terminé");
  expect(JSON.stringify(world.calls.cancel) === '["agent-1"]', "seul l'agent de la tâche est arrêté (pas « other-agent »)", JSON.stringify(world.calls.cancel));
  expect(g(sandbox, "rev-parse", "--abbrev-ref", "HEAD") === realBranch && /^transfert\/\d{8}-\d{4}$/.test(realBranch), `HEAD sur la branche ${realBranch}`);
  expect(g(sandbox, "log", "-1", "--format=%s").startsWith("Transfert vers Oracle"), "message du commit « Transfert vers Oracle … »");
  expect(g(sandbox, "status", "--porcelain") === "", "arbre de travail propre (a.txt et work.txt committés)");
  expect(g(sandbox, "rev-parse", "main") === S0.main, "la branche main du dépôt est intacte");
  const refs = gd(bare, "for-each-ref", "--format=%(refname)");
  expect(refs.includes(`refs/heads/${realBranch}`) && gd(bare, "rev-parse", "main") === S0.main && refs.split("\n").length === 2, "le dépôt nu a reçu la branche de transfert ; main n'a pas bougé", refs);
  expect(gd(bare, "rev-parse", realBranch) === g(sandbox, "rev-parse", "HEAD"), "SHA distant = SHA local");
  const clone = world.calls.oracle.find((x) => x.op === "clone");
  expect(clone?.repo === "t10test/sandbox-repo" && clone.targetDirectory === "/home/USERNAME/projets", "clone Oracle demandé pour t10test/sandbox-repo dans /home/USERNAME/projets", JSON.stringify(clone));
  expect(world.calls.oracle.some((x) => x.op === "switch" && x.branch === realBranch), "Oracle basculé sur la branche de transfert");
  expect(world.calls.oracle.some((x) => x.op === "terminal" && x.command === "git" && x.args.join(" ") === "-C /home/USERNAME/projets/sandbox-repo config core.autocrlf input"), "core.autocrlf=input demandé sur le clone Oracle");
  const t1 = getTask("T1");
  expect(t1.host === "oracle" && t1.status === "todo" && t1.agent_id === null && t1.branch === realBranch, "tâche réaffectée à Oracle (hôte, statut todo, agent retiré, branche)");
  const sha = g(sandbox, "log", "-1", "--format=%h %s");
  expect([realBranch, "Linux", "/home/USERNAME/projets/sandbox-repo", "TypeError: boom", "work.txt", "a.txt", sha, "Corriger le bug X dans a.txt"].every((s) => t1.description.includes(s)), "invite de reprise complète (branche, Linux, dossier, erreurs, fichiers, dernier commit, objectif)");
  expect(getTask("T2").host === "oracle", "toutes les tâches du mini-PC réaffectées");
  expect(!world.calls.localTerm.some((x) => x.command === "shutdown"), "pas de confirmShutdown : AUCUNE commande d'extinction envoyée");
  expect(JSON.parse(m.row(res.id).results_json).shutdown.skipped === true, "extinction explicitement « non demandée » dans le résultat");
  m.close();
}

section("Le commit réel refuse main/master/toute branche hors transfert/ reprise");
{
  const before = snap();
  const proj = { name: "sandbox-repo", dir: sandbox };
  for (const b of ["main", "master", "feature/x", "refs/heads/main", "transfert/20261014-0130/../main"]) {
    await throws(() => realExec.commit(ctx, proj, { branch: b }), /Branche refusée/, `commit réel refusé sur « ${b} »`);
    await throws(() => realExec.push(ctx, proj, { branch: b }), /Branche refusée/, `push réel refusé sur « ${b} »`);
  }
  expect(JSON.stringify(snap()) === JSON.stringify(before), "dépôt jetable inchangé après ces refus");
}

section("Extinction réelle : confirmShutdown, dryRun, échec, force, annulation");
{
  // garde du code réel, appelé directement
  const w2 = fakeWorld();
  const c2 = makeCtx(w2, []);
  const real2 = createRealExecutors(w2.deps);
  await throws(() => real2.shutdown(c2, { dryRun: true, confirmShutdown: true }), /refusée/, "exécuteur réel : refuse sous dryRun même avec confirmShutdown");
  await throws(() => real2.shutdown(c2, { dryRun: false, confirmShutdown: false }), /refusée/, "exécuteur réel : refuse sans confirmShutdown");
  await throws(() => real2.shutdown(c2, { dryRun: false }), /refusée/, "exécuteur réel : refuse si confirmShutdown absent");
  expect(w2.calls.localTerm.length === 0, "aucune commande envoyée au daemon dans ces trois refus");
}
const newMgr = (name, w, extra = {}) => mk(makeCtx(w, []), { dbPath: join(work, `${name}.sqlite`), executors: createRealExecutors(w.deps), ...extra });
{
  // A. extinction confirmée : le mini-PC disparaît -> done
  const w = fakeWorld(); w.autoOffline = true;
  const m = newMgr("sdA", w);
  const res = await m.run({ confirm: true, dryRun: false, confirmShutdown: true, shutdownWaitMs: 4000 });
  expect(res.status === "done", "A. extinction confirmée + mini-PC hors ligne -> done");
  expect(w.calls.localTerm.length === 1 && JSON.stringify(w.calls.localTerm[0]) === JSON.stringify({ command: "shutdown", args: ["/s", "/t", "60", "/c", "Transfert vers Oracle"] }),
    "A. commande exacte : shutdown /s /t 60 /c \"Transfert vers Oracle\" (annulable)", JSON.stringify(w.calls.localTerm));
  expect(JSON.parse(m.row(res.id).results_json).shutdown.offline === true, "A. disparition du mini-PC vérifiée");
  m.close();
}
{
  // B. le mini-PC répond encore -> partial(shutdown), puis reprise de cette seule étape
  const w = fakeWorld();
  const m = newMgr("sdB", w);
  await throws(() => m.run({ confirm: true, dryRun: false, confirmShutdown: true, shutdownWaitMs: 400 }), /répond encore/, "B. le mini-PC répond encore -> erreur");
  expect(m.status().state === "partial(shutdown)", "B. état partial(shutdown)", m.status().state);
  w.autoOffline = true;
  const c = {};
  const m2 = mk(makeCtx(w, []), { dbPath: join(work, "sdB.sqlite"), executors: spy(createRealExecutors(w.deps), c) });
  const res = await m2.run({ confirm: true, dryRun: false, confirmShutdown: true, shutdownWaitMs: 4000 });
  expect(res.status === "done" && !c.stopAgents && !c.commit && c.shutdown === 1, "B. reprise : seule l'étape d'extinction est rejouée", JSON.stringify(c));
  m.close(); m2.close();
}
{
  // C. annulation pendant le délai : shutdown /a
  const w = fakeWorld();
  const m = newMgr("sdC", w);
  const running = m.run({ confirm: true, dryRun: false, confirmShutdown: true, shutdownWaitMs: 15000 });
  for (let i = 0; i < 100 && !w.calls.localTerm.some((x) => x.args?.[0] === "/s"); i++) await sleep(50);
  const cancel = await m.cancel();
  const res = await running;
  expect(cancel.shutdownAborted?.command === "shutdown /a" && w.calls.localTerm.some((x) => x.command === "shutdown" && x.args.join() === "/a"), "C. transfer.cancel pendant le délai envoie « shutdown /a »", JSON.stringify(w.calls.localTerm));
  expect(res.status === "cancelled" && m.status().state === "partial(shutdown)", "C. transfert annulé, état partial(shutdown)", m.status().state);
  m.close();
}
{
  // D. dryRun + confirmShutdown, force seul, étape échouée : jamais d'extinction réelle
  const c = {};
  const w = fakeWorld();
  const m = mk(makeCtx(w, []), { dbPath: join(work, "sdD.sqlite"), executors: spy(createRealExecutors(w.deps), c) });
  await m.run({ confirm: true, dryRun: true, confirmShutdown: true, force: true });
  await m.run({ confirm: true, dryRun: false, force: true });
  expect(!w.calls.localTerm.length && !c.shutdown, "D. dryRun+confirmShutdown, puis force seul : aucune extinction", JSON.stringify(c));
  m.close();
  const c2 = {};
  const m2 = mk(ctx, {
    dbPath: join(work, "sdE.sqlite"),
    executors: fakeExec(c2, { commit: async () => { throw new Error("échec de commit simulé"); } }),
  });
  await throws(() => m2.run({ confirm: true, dryRun: false, confirmShutdown: true }), /échec de commit simulé/, "E. un échec de commit remonte");
  expect(m2.status().state === "failed(committing)" && !c2.shutdown && !c2.clone && !c2.reassign, "E. failed(committing) : ni clone, ni réaffectation, ni extinction", JSON.stringify(c2));
  expect(!m2.events(m2.status().id).some((e) => e.step === "shutting_down"), "E. l'étape shutting_down n'a même pas démarré");
  m2.close();
}

// =====================================================================================================================
section("Verrou : un seul transfert actif (y compris entre deux instances)");
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = {};
  const dbp = join(work, "lock.sqlite");
  const a = mk(ctx, { dbPath: dbp, executors: fakeExec(c, { stopAgents: () => gate }) });
  const b = mk(ctx, { dbPath: dbp, executors: fakeExec({}) });
  const first = a.run({ confirm: true, dryRun: false });
  await sleep(150);
  await throws(() => a.run({ confirm: true, dryRun: false }), /déjà en cours/, "second run sur la même instance refusé");
  await throws(() => b.run({ confirm: true, dryRun: false }), /déjà en cours/, "second run depuis une autre instance (même base) refusé par le verrou SQLite");
  await throws(() => b.run({ confirm: true, dryRun: true }), /déjà en cours/, "même un dryRun est refusé pendant un transfert actif");
  release();
  expect((await first).status === "done", "le premier transfert se termine normalement");
  a.close(); b.close();
}

section("Annulation entre deux éléments");
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = {};
  const m = mk(ctx, { dbPath: join(work, "cancel.sqlite"), executors: fakeExec(c, { stopAgents: () => gate }) });
  const running = m.run({ confirm: true, dryRun: false, confirmShutdown: true });
  await sleep(150);
  const cancel = await m.cancel();
  release();
  const res = await running;
  expect(cancel.stoppedAt === "stopping_agents" && res.status === "cancelled" && m.status().state === "failed(stopping_agents)" && m.status().error === "annulé", "annulé pendant stopping_agents -> failed(stopping_agents), raison « annulé »");
  expect(!c.commit && !c.shutdown, "ni commit ni extinction après l'annulation");
  await throws(() => m.cancel(), /Aucun transfert/, "annuler sans transfert actif : erreur");
  m.close();
}

section("Crash réel du processus au milieu, redémarrage, reprise depuis l'étape échouée");
{
  const dbp = join(work, "crash.sqlite");
  const child = spawn(process.execPath, [here, "--crash-child", dbp, dataDir], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const exited = new Promise((r) => child.on("exit", r));
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  for (let i = 0; i < 200 && !out.includes("AT_CLONING"); i++) await sleep(50);
  expect(out.includes("AT_CLONING"), "le processus enfant est arrivé à l'étape cloning");
  child.kill(); // arrêt brutal de CE processus enfant uniquement (PID connu)
  await exited;
  const raw = new DatabaseSync(dbp);
  const crashed = raw.prepare("SELECT state, step FROM transfers").get();
  raw.close();
  expect(crashed.state === "cloning", "base : état intermédiaire « cloning » laissé par le crash", crashed.state);
  const c = {};
  const m = mk(ctx, { dbPath: dbp, executors: fakeExec(c) }); // « redémarrage » : nouvelle instance
  const st = m.status();
  expect(st.state === "failed(cloning)" && st.error === "interrompu", "au démarrage : failed(cloning), raison « interrompu »", JSON.stringify(st));
  const res = await m.run({ confirm: true, dryRun: false });
  expect(res.id === st.id && res.status === "done", "run reprend le même transfert");
  expect(!c.stopAgents && !c.commit && !c.push && c.clone === 1 && c.reassign === 1, "reprise idempotente : commit/push/arrêts non rejoués, clone rejoué", JSON.stringify(c));
  m.close();
}

section("Reprise après échec d'une étape : les éléments déjà faits ne sont pas rejoués");
{
  const c = {};
  let first = true;
  const dbp = join(work, "resume.sqlite");
  const m = mk(ctx, { dbPath: dbp, executors: fakeExec(c, { clone: async () => { if (first) { first = false; throw new Error("réseau coupé"); } return { ok: true }; } }) });
  await throws(() => m.run({ confirm: true, dryRun: false }), /réseau coupé/, "clone en échec -> erreur");
  expect(m.status().state === "failed(cloning)", "état failed(cloning)");
  const res = await m.run({ confirm: true, dryRun: false });
  expect(res.status === "done" && c.commit === 1 && c.push === 1 && c.clone === 2 && c.check === 1, "reprise : commit/push une seule fois, clone deux fois, pas de nouveau contrôle", JSON.stringify(c));
  const dry = await m.run({ confirm: true, dryRun: true });
  expect(dry.id !== res.id, "un dryRun ne reprend jamais un transfert réel (mode différent)");
  m.close();
}

section("Aucun secret dans le journal, le plan, les résultats ni les messages");
{
  const b = [];
  const leaky = async () => { throw new Error(`fatal: https://octocat:${SECRET_PASS}@github.com/o/r.git token=${SECRET_TOKEN} password=${SECRET_PASS}`); };
  const dbp = join(work, "secret.sqlite");
  const m = mk({ ...ctx, broadcast: (x) => b.push(x) }, {
    dbPath: dbp,
    executors: fakeExec({}, { commit: leaky, check: async () => ({ ...fakePlan(), token: SECRET_TOKEN, nested: { password: SECRET_PASS } }) }),
  });
  await throws(() => m.run({ confirm: true, dryRun: false }), /fatal/, "échec contenant des secrets");
  const dump = dbDump(dbp) + JSON.stringify(b);
  expect(!dump.includes(SECRET_TOKEN) && !dump.includes(SECRET_PASS), "ni jeton ni mot de passe dans transfers, transfer_events ni diffusions");
  expect(dump.includes("fatal"), "le message d'erreur utile est conservé (rédigé)");
  m.close();
}
const liveAfter = snapshotLive();
expect(liveBefore === liveAfter, `dépôts de Philippe : HEAD/branche identiques avant/après (${livePaths.length} projets suivis contrôlés)`);

// =====================================================================================================================
section("Serveur réel (instance isolée sur 7079, copie des données) : messages WebSocket et plan réel");
const PORT = 7079;
const srvData = join(work, "srv-data");
mkdirSync(srvData, { recursive: true });
for (const f of ["projects.json", "brain.sqlite"]) {
  const src = join(dashboardDir, "data", f);
  if (existsSync(src)) copyFileSync(src, join(srvData, f));
}
// La copie de la base reçoit une tâche vers le dépôt jetable pour avoir un projet « concerné » déterministe.
const srvBrain = new DatabaseSync(join(srvData, "brain.sqlite"));
srvBrain.exec("DELETE FROM tasks WHERE status IN ('todo', 'doing')");
srvBrain.prepare("INSERT OR REPLACE INTO tasks (id,title,project,host,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
  .run("T10-WS", "Tâche du test WebSocket", sandbox, "local", "todo", "2026-10-14T00:00:00Z", "2026-10-14T00:00:00Z");
srvBrain.close();
const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: srvData };
delete env.BRAIN_DB;
delete env.DASHBOARD_PASSWORD;
const server = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
let wsFailed = false;
try {
  for (let i = 0; i < 200 && !serverLog.includes("Paseo dashboard :"); i++) await sleep(100);
  expect(serverLog.includes("Paseo dashboard :") && /chargé : transfer\.mjs/.test(serverLog), "serveur de test démarré, transfer.mjs chargé");
  const origin = `http://127.0.0.1:${PORT}`;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const take = async (pred, label, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await sleep(40);
    }
    fail(`délai dépassé : ${label}`);
    wsFailed = true;
    return null;
  };
  const rpc = (msg, pred, label, timeout) => { inbox.length = 0; ws.send(JSON.stringify(msg)); return take(pred, label, timeout); };

  // Laisse au serveur le temps de connecter ses machines (état diffusé : oracle « connected »).
  const ready = Date.now() + 30000;
  while (Date.now() < ready) {
    const hit = inbox.find((m) => m.type === "state" && m.payload?.hosts?.some((h) => h.label === "oracle" && h.status === "connected"));
    if (hit) break;
    await sleep(100);
  }
  const st0 = await rpc({ type: "transfer.status" }, (m) => m.type === "transfer.status", "transfer.status");
  expect(st0?.state === "idle", "transfer.status initial : idle (base isolée vide)", st0?.state);
  const e1 = await rpc({ type: "transfer.run", dryRun: true }, (m) => m.type === "error" && m.source === "transfer.run", "run sans confirm");
  expect(/confirm/i.test(e1?.message || ""), "WS : transfer.run sans confirm refusé, même en dryRun");
  const e2 = await rpc({ type: "transfer.cancel" }, (m) => m.type === "error" && m.source === "transfer.cancel", "cancel à vide");
  expect(!!e2, "WS : transfer.cancel sans transfert actif -> erreur");

  const t0 = Date.now();
  const plan = await rpc({ type: "transfer.plan" }, (m) => m.type === "transfer.plan", "transfer.plan réel", 90000);
  if (plan) {
    const followed = JSON.parse(readFileSync(join(srvData, "projects.json"), "utf8")).projects.filter((p) => p.host === "local");
    const concerned = plan.projects.filter((p) => p.concerned);
    console.log(`TRANSFER_PLAN_REEL (${Date.now() - t0} ms) ${JSON.stringify({
      projetsSuivis: followed.length, projetsDansLePlan: plan.projects.length, noms: plan.projects.slice(0, 8).map((p) => `${p.name}${p.concerned ? "*" : ""}:${p.isGit ? (p.remoteUrl ? "git+remote" : "git sans remote") : "non-git"}`),
      concernes: concerned.map((p) => ({ name: p.name, dirty: p.dirtyCount, remoteUrl: p.remoteUrl, oracleDir: p.oracleDir, oracleExists: p.oracleExists, diskNeeded: p.diskNeeded })),
      ghConnected: plan.ghConnected, oracleDiskFree: plan.oracleDiskFree, oracleDiskGo: Math.round(plan.oracleDiskFree / 1024 ** 3), oracleDiskSource: plan.oracleDiskSource,
      agents: plan.agents.length, tasks: plan.tasks.length, errors: plan.errors, warnings: plan.warnings.map((w) => w.code), ok: plan.ok,
    })}`);
    expect(followed.length > 0 && followed.every((f) => plan.projects.some((p) => p.dir.toLowerCase() === f.dir.toLowerCase())), `le plan cite les ${followed.length} projets suivis de l'état actuel`);
    expect(Array.isArray(plan.errors) && Array.isArray(plan.agents) && typeof plan.ghConnected.local === "boolean", "contrat du plan : projects, agents, ghConnected, errors");
    if (plan.ghConnected.oracle) {
      expect(!plan.errors.some((e) => /GitHub n’est pas connecté sur la machine Oracle/.test(e)), "gh connecté sur Oracle : ce n'est PLUS un blocage");
      expect(Number.isFinite(plan.oracleDiskFree) && plan.oracleDiskFree > 2 * 1024 ** 3, `espace disque d'Oracle rapporté : ${Math.round(plan.oracleDiskFree / 1024 ** 3)} Go (${plan.oracleDiskSource})`);
      expect(plan.oracleDiskSource.startsWith("mesuré"), "l'espace disque d'Oracle est mesuré (df), pas supposé", plan.oracleDiskSource);
      expect(concerned.length === 1 && concerned[0].name === "sandbox-repo" && plan.ok, "projet concerné = le dépôt jetable ; plan valide", JSON.stringify(plan.errors));
    } else skip("Oracle injoignable ou gh déconnecté sur Oracle dans cet environnement : assertions Oracle du plan non évaluées");

    if (plan.ok) {
      const before = snap();
      const events = [];
      const res = await rpc({ type: "transfer.run", confirm: true, dryRun: true, force: true }, (m) => m.type === "transfer.result" || (m.type === "error" && m.source === "transfer.run"), "run dryRun", 90000);
      events.push(...inbox);
      const steps = inbox.filter((m) => m.type === "transfer.status").map((m) => m.step);
      expect(res?.type === "transfer.result" && res.status === "done", "WS : transfer.run dryRun -> transfer.result done", JSON.stringify(res));
      expect(steps.includes("committing") && steps.includes("shutting_down"), "WS : diffusion transfer.status pour chaque étape", steps.join(">"));
      expect(JSON.stringify(snap()) === JSON.stringify(before), "WS : le dépôt jetable n'a pas bougé pendant le dryRun");
      const ev = await rpc({ type: "transfer.events" }, (m) => m.type === "transfer.events", "transfer.events");
      expect(ev?.events?.some((e) => e.step === "shutting_down" && /Début/.test(e.message)), `WS : journal lisible (${ev?.events?.length} événements)`);
      const st = await rpc({ type: "transfer.status" }, (m) => m.type === "transfer.status", "status final");
      expect(st?.state === "done" && st.dryRun === true, "WS : transfer.status final = done (dryRun)");
    }
  }
  ws.close();
} catch (e) {
  fail("exception dans la section serveur", e.stack || e.message);
} finally {
  server.kill(); // uniquement le processus lancé par ce script
  await sleep(300);
}
if (wsFailed) console.error(serverLog.slice(-1500));

// ---------- Fin ----------
const liveFinal = snapshotLive();
expect(liveBefore === liveFinal, "dépôts de Philippe toujours intacts à la fin");
for (const m of openManagers) m.close();
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
} catch (e) {
  console.warn(`nettoyage partiel de ${work} : ${e.code}`);
}
console.log(`\n=== Résumé : ${passed} OK, ${failed} FAIL, ${skipped} SKIP ===`);
if (failed > 0) process.exit(1);
console.log("VERIFY_TRANSFER_PASS");
process.exit(0);
