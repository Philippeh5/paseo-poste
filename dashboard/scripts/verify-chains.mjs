// Vérifie les chaînes d'agents (T40) : handlers/chains.mjs, règle de workflow de handlers/tasks.mjs, agent « verifier ».
// Usage : node dashboard/scripts/verify-chains.mjs
//   A. (toujours) vrais handlers profiles/tasks/chains dans un faux hôte Paseo, base SQLite et dossier de données jetables :
//      tâches liées, démarrage automatique de la suivante, passage « Terminé » automatique, arrêt de la chaîne sur erreur,
//      blocage ou échec de démarrage, reprise, machine absente, suppression d'un maillon, champs refusés au navigateur,
//      migration d'une ancienne base et d'anciens agents de base. Aucun appel LLM.
//   B. (VERIFY_REAL=0 pour sauter) instance isolée (VERIFY_PORT, défaut 7099) : chaîne de 2 agents « PONG » avec le moteur
//      claude-openrouter/sonnet (2 petits appels réels), tâches et agents supprimés ensuite.
//   C. (SKIP_TASKS=1 pour sauter) verify-tasks.mjs contre cette même instance isolée (SKIP_PERM=1).
// Ne parle jamais au serveur :7070 et n'écrit pas dans dashboard/data/ : tout est dans .foreman/scratch/t40-*.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createStore } from "../lib/store.mjs";
import { DEFAULT_PROFILES } from "../handlers/profiles.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratch = join(rootDir, ".foreman", "scratch", `t40-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// Fichier des machines : variable d'environnement, sinon dashboard/ ; dans un worktree git (fichier non versionné absent),
// celui du dépôt principal.
function locateHostsFile() {
  const candidates = [process.env.DASHBOARD_HOSTS_FILE, join(dashboardDir, "hosts.json")];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: rootDir, encoding: "utf8" }).trim();
    candidates.push(join(dirname(common), "dashboard", "hosts.json"));
  } catch { /* pas un dépôt git */ }
  return candidates.find((f) => f && existsSync(f)) || null;
}

const PORT = Number(process.env.VERIFY_PORT || 7099);
if (PORT === 7070) throw new Error("VERIFY_PORT ne doit jamais être 7070 (serveur réel)");
const SANDBOX = join(rootDir, "sandbox-repo");
const P = "D:/Projets/AI-OS/paseo-poste/fake-proj";
const ENGINE = "claude-openrouter/sonnet";
const PONG = "Reply with the single word PONG and do nothing else.";

let passed = 0;
let failed = 0;
const ok = (label) => { passed += 1; console.log(`OK   ${label}`); };
const bad = (label, detail = "") => { failed += 1; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : bad(label, String(detail)));
const section = (name) => console.log(`\n=== ${name} ===`);
const dump = (v) => JSON.stringify(v);

async function until(fn, label, timeout = 8000, step = 60) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  bad(`Délai dépassé : ${label}`);
  return null;
}

// ---------------------------------------------------------------- faux hôte Paseo + vrais handlers
async function harness({ name, modules = ["profiles", "tasks", "chains"], preseed = null }) {
  const dataDir = join(scratch, name);
  mkdirSync(dataDir, { recursive: true });
  preseed?.(dataDir);
  process.env.BRAIN_DB = join(dataDir, "brain.sqlite");
  const agents = new Map();
  const sim = { up: true, failOpen: false, opens: 0 };
  const entry = {
    connected: () => sim.up,
    api: {
      workspaces: {
        open: async () => {
          sim.opens += 1;
          if (sim.failOpen) throw new Error("dossier refusé par le faux hôte");
          return { id: "ws-sim" };
        },
      },
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
    send, broadcast: (m) => broadcasts.push(m),
    sendError: (ws, m) => send(ws, { type: "error", message: `Erreur : ${m}` }),
  };
  // `ui` : un navigateur ; `invoke` : un appel interne (ctx.invoke du vrai serveur)
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
  if (modules.includes("tasks")) {
    ctx.onMessage("project.list", (ws) => send(ws, { type: "project.list",
      projects: [{ name: "Proj", dir: P, host: "local" }] }));
  }
  const h = {
    ctx, call, agents, sim, entry, broadcasts, dataDir,
    tasks: async () => (await call("ui", "task.list")).replies.find((r) => r.type === "tasks").tasks,
    task: async (id) => (await h.tasks()).find((t) => t.id === id),
    // statuts successifs d'une tâche d'après les diffusions task.changed
    history: (id) => broadcasts.filter((b) => b.type === "task.changed" && b.task?.id === id)
      .map((b) => b.task.status).filter((s, i, all) => s !== all[i - 1]),
    agentOf: async (id) => agents.get((await h.task(id)).agentId),
    // Termine chaque tâche à tour de rôle : attend qu'elle démarre, rend sa session au repos, attend « Terminé ».
    async drive(ids) {
      for (const id of ids) {
        await until(async () => (await h.task(id))?.status === "doing", `tâche ${id.slice(0, 6)} démarre`, 12000);
        const agent = await h.agentOf(id);
        if (agent) agent.status = "idle";
        await until(async () => (await h.task(id))?.status === "done", `tâche ${id.slice(0, 6)} terminée`, 12000);
      }
    },
  };
  return h;
}

const started = (r) => r.replies.find((m) => m.type === "chain.started");

// ================================================================ A. faux hôte
try {
  section("A0. Agent de base « verifier » et migration des agents de base existants");
  const legacy = DEFAULT_PROFILES.filter((p) => p.id !== "verifier").map((p) => ({ ...p }));
  const pf = await harness({ name: "profiles-old", modules: ["profiles"],
    preseed: (dir) => writeFileSync(join(dir, "agent-profiles.json"), JSON.stringify({ profiles: legacy })) });
  const list = (await pf.call("ui", "profile.list")).replies[0].profiles;
  const verifier = list.find((p) => p.id === "verifier");
  expect(verifier?.role === "reader" && list.length === legacy.length + 1, "ancien fichier d'agents : verifier ajouté (reader)",
    dump(list.map((p) => p.id)));
  expect(/AVEUGLE/.test(verifier.instructions) && /PASS_WITH_NOTES/.test(verifier.instructions) &&
    /PREMIÈRE LIGNE/.test(verifier.instructions) && /JAMAIS confiance/.test(verifier.instructions) &&
    /lecture seule/.test(verifier.instructions), "verifier : aveugle, ne fait pas confiance, lecture seule, verdict en 1re ligne");
  const persisted = JSON.parse(readFileSync(join(pf.dataDir, "agent-profiles.json"), "utf8"));
  expect(persisted.seen?.includes("verifier") && persisted.profiles.some((p) => p.id === "verifier"),
    "fichier réécrit avec la clé seen contenant verifier");
  await pf.call("ui", "profile.delete", { id: "verifier" });
  const again = await harness({ name: "profiles-old", modules: ["profiles"] });
  const list2 = (await again.call("ui", "profile.list")).replies[0].profiles;
  expect(!list2.some((p) => p.id === "verifier") && list2.length === legacy.length,
    "verifier supprimé par l'utilisateur : non ressuscité au redémarrage");
  const fresh = await harness({ name: "profiles-new", modules: ["profiles"] });
  expect((await fresh.call("ui", "profile.list")).replies[0].profiles.some((p) => p.id === "verifier"),
    "dossier de données neuf : verifier fait partie des agents de base");

  section("A1. Migration d'une ancienne base SQLite (sans chain / autostart)");
  const oldDb = join(scratch, "old-brain", "brain.sqlite");
  mkdirSync(dirname(oldDb), { recursive: true });
  const raw = new DatabaseSync(oldDb);
  raw.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT 'local', engine TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT '', isolation TEXT NOT NULL DEFAULT 'local', branch TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo', deps TEXT NOT NULL DEFAULT '[]', agent_id TEXT, summary TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '', permission INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT '', agent_run TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'writer')`);
  raw.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('old-1', 'Ancienne tâche', 'a', 'a')").run();
  raw.close();
  const mig = await harness({ name: "old-brain", modules: ["profiles", "tasks"] });
  const cols = new DatabaseSync(oldDb, { readOnly: true }).prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  const oldTask = (await mig.tasks()).find((t) => t.id === "old-1");
  expect(cols.includes("chain") && cols.includes("autostart"), "colonnes chain et autostart ajoutées", dump(cols.slice(-4)));
  expect(oldTask?.chain === "" && oldTask?.autostart === false && oldTask?.title === "Ancienne tâche",
    "ancienne tâche conservée, chain '' et autostart false dans le snapshot", dump(oldTask));

  const h = await harness({ name: "main" });

  section("A2. chain.list, chain.save, chain.delete, chain.reset");
  const listed = (await h.call("ui", "chain.list")).replies.find((m) => m.type === "chain.list");
  const steps = Object.fromEntries(listed.chains.map((c) => [c.id, c.steps.join(",")]));
  expect(steps.feature === "plan,plan-review,dev,review,test" && steps.bugfix === "dev,test,review" &&
    steps.audit === "review" && steps.verified === "dev,verifier" && listed.chains.length === 4,
    "chaînes par défaut : feature, bugfix, audit, verified", dump(steps));
  let r = await h.call("ui", "chain.save", { chain: { id: "Vide", name: "Vide", steps: [] } });
  expect(/au moins une étape/.test(r.error || ""), "chain.save : chaîne sans étape refusée", r.error);
  r = await h.call("ui", "chain.save", { chain: { id: "x y", name: "X", steps: ["dev"] } });
  expect(/identifiant/.test(r.error || ""), "chain.save : identifiant invalide refusé", r.error);
  r = await h.call("ui", "chain.save", { chain: { id: "pair", name: "Deux développeurs", steps: ["dev", "dev"] } });
  expect(!r.error && h.broadcasts.some((b) => b.type === "chain.list" && b.chains.some((c) => c.id === "pair")),
    "chain.save : chaîne « pair » enregistrée et diffusée");
  const file = JSON.parse(readFileSync(join(h.dataDir, "agent-chains.json"), "utf8"));
  expect(file.chains.some((c) => c.id === "pair") && file.chains.length === 5, "data/agent-chains.json écrit (ctx.store)");
  r = await h.call("ui", "chain.save", { chain: { id: "ghost", name: "Fantôme", steps: ["dev", "nope"] } });
  r = await h.call("ui", "chain.run", { chain: "ghost", project: "Proj", mission: "x" });
  expect(/agent de base inconnu.*nope/.test(r.error || "") && (await h.tasks()).length === 0,
    "chain.run : agent de base inconnu refusé, aucune tâche créée", r.error);
  r = await h.call("ui", "chain.delete", { id: "ghost" });
  expect(!r.error && !(await h.call("ui", "chain.list")).replies[0].chains.some((c) => c.id === "ghost"),
    "chain.delete : chaîne supprimée");
  r = await h.call("ui", "chain.delete", { id: "ghost" });
  expect(/introuvable/.test(r.error || ""), "chain.delete : chaîne inconnue refusée", r.error);
  await h.call("ui", "chain.delete", { id: "audit" });
  await h.call("ui", "chain.reset");
  const reset = (await h.call("ui", "chain.list")).replies[0].chains.map((c) => c.id);
  expect(dump(reset) === dump(["feature", "bugfix", "audit", "verified", "pair"]),
    "chain.reset : chaînes par défaut restaurées, chaîne personnalisée conservée", dump(reset));

  section("A3. chain.run : refus clairs");
  const refusals = [
    [{ chain: "nope", project: "Proj", mission: "x" }, /chaîne inconnue/],
    [{ chain: "bugfix", project: "Proj", mission: "  " }, /mission est obligatoire/],
    [{ chain: "bugfix", project: "", mission: "x" }, /choisissez le projet/],
    [{ chain: "bugfix", project: "Inconnu", mission: "x" }, /projets suivis/],
    [{ chain: "bugfix", project: "Proj", host: "oracle", mission: "x" }, /projets suivis/],
    [{ chain: "bugfix", project: "Proj", mission: "x".repeat(2001) }, /2000/],
  ];
  for (const [payload, pattern] of refusals) {
    r = await h.call("ui", "chain.run", payload);
    expect(pattern.test(r.error || "") && !started(r), `chain.run refusé : ${pattern}`, r.error);
  }
  expect((await h.tasks()).length === 0, "aucun refus n'a créé de tâche");

  section("A4. chaîne « bugfix » : tâches liées, 1re démarrée seule, suivantes en attente");
  const mission = "Ajoute une fonction sum(a, b) dans src/sum.js.\nPuis teste-la.";
  r = await h.call("ui", "chain.run", { chain: "bugfix", project: "Proj", mission });
  const s1 = started(r);
  expect(s1?.taskIds?.length === 3 && typeof s1.runId === "string", "chain.started {runId, taskIds[3]}", dump(s1));
  const [a1, a2, a3] = await Promise.all(s1.taskIds.map((id) => h.task(id)));
  expect([a1, a2, a3].every((t) => t.chain === s1.runId && t.autostart === true), "3 tâches : chain = runId, autostart");
  expect(dump(a1.deps) === "[]" && dump(a2.deps) === dump([a1.id]) && dump(a3.deps) === dump([a2.id]),
    "dépendances : 1re libre, 2e sur la 1re, 3e sur la 2e", dump([a1.deps, a2.deps, a3.deps]));
  expect(dump([a1.role, a2.role, a3.role]) === dump(["writer", "writer", "reader"]),
    "rôles repris des agents de base (dev, test, review)", dump([a1.role, a2.role, a3.role]));
  expect(a1.title.startsWith("Développeur — Ajoute une fonction sum") && !a1.title.includes("\n"),
    "titre = agent de base + 1re ligne de la mission", a1.title);
  expect(a1.description.includes("Tu es le DÉVELOPPEUR") && a1.description.includes(mission) &&
    a3.description.includes("Tu es le RELECTEUR DE CODE") && a3.description.includes(mission),
    "description = consigne de l'agent de base + mission d'origine telle quelle");
  expect(a1.project === P && a1.host === "local" && a1.engine === ENGINE, "projet suivi résolu par nom, moteur gratuit par défaut",
    dump([a1.project, a1.engine]));
  await until(async () => (await h.task(a1.id)).status === "doing", "1re tâche démarrée sans action");
  expect(h.agents.size === 1 && (await h.task(a2.id)).status === "todo" && (await h.task(a3.id)).status === "todo",
    "seule la 1re session existe, les autres restent « À faire »");
  expect((await h.task(a2.id)).blockedBy[0]?.id === a1.id, "la 2e est « bloquée par » la 1re");
  const byPath = await h.call("ui", "chain.run", { chain: "audit", project: `${P}/`, host: "local", mission: "Audit" });
  expect(started(byPath)?.taskIds.length === 1, "projet désigné par son chemin complet (et host) accepté");
  await h.drive(started(byPath).taskIds);

  section("A5. fin de tâche -> suivante : À valider -> Terminé automatique, permission, reprise");
  const agent1 = h.agents.get((await h.task(a1.id)).agentId);
  agent1.status = "idle";
  await until(async () => (await h.task(a1.id)).status === "done", "1re tâche passée « Terminé » seule", 12000);
  expect(dump(h.history(a1.id)) === dump(["todo", "doing", "review", "done"]),
    "historique de la 1re : todo > doing > review > done", dump(h.history(a1.id)));
  await until(async () => (await h.task(a2.id)).status === "doing", "2e tâche démarrée seule", 8000);
  expect((await h.task(a2.id)).summary === "" && h.agents.size === 3, "2e session créée (3 au total avec l'audit)");
  expect((await h.task(a3.id)).status === "todo", "la 3e attend toujours");
  const agent2 = h.agents.get((await h.task(a2.id)).agentId);
  agent2.status = "idle";
  agent2.pendingPermissions = [{ id: "p1" }];
  await until(async () => (await h.task(a2.id)).permission, "permission en attente signalée", 8000);
  await sleep(3200);
  const waiting = await h.task(a2.id);
  expect(waiting.status === "doing" && (await h.task(a3.id)).status === "todo",
    "permission en attente : la tâche reste « En cours », la chaîne n'avance pas", dump([waiting.status, waiting.permission]));
  agent2.pendingPermissions = [];
  await until(async () => (await h.task(a2.id)).status === "done", "permission réglée : 2e terminée", 12000);
  await until(async () => (await h.task(a3.id)).status === "doing", "3e tâche démarrée seule", 8000);
  await h.drive([a3.id]);
  expect(dump(h.history(a3.id)) === dump(["todo", "doing", "review", "done"]), "3e : todo > doing > review > done");

  section("A6. erreur d'une étape : la chaîne s'arrête, raison lisible, reprise possible");
  const r2 = started(await h.call("ui", "chain.run", { chain: "bugfix", project: "Proj", mission: "Autre mission" }));
  const [b1, b2, b3] = r2.taskIds;
  await until(async () => (await h.task(b1)).status === "doing", "chaîne 2 : 1re démarrée");
  const sessionsBefore = h.agents.size;
  const agentB1 = await h.agentOf(b1);
  agentB1.status = "error";
  agentB1.lastError = "boom du faux hôte";
  const title1 = (await h.task(b1)).title;
  await until(async () => (await h.task(b1)).error, "erreur de la 1re détectée", 8000);
  await until(async () => (await h.task(b2)).reason, "raison posée sur la 2e", 5000);
  const stopped = await h.task(b2);
  expect(stopped.status === "todo" && stopped.reason === `Chaîne arrêtée : ${title1} a échoué`,
    "2e reste « À faire » avec « Chaîne arrêtée : <titre> a échoué »", dump([stopped.status, stopped.reason]));
  expect((await h.task(b3)).reason === `Chaîne arrêtée : ${title1} a échoué`, "idem pour la 3e");
  await sleep(5600);
  expect(h.agents.size === sessionsBefore && (await h.task(b2)).status === "todo",
    "aucune session lancée pendant l'arrêt (2 cycles de synchronisation)", `${h.agents.size}/${sessionsBefore}`);
  agentB1.status = "running";
  agentB1.lastError = undefined;
  await until(async () => (await h.task(b2)).reason === "", "l'erreur disparaît : la raison est retirée", 8000);
  expect((await h.task(b2)).status === "todo", "la 2e reste « À faire » tant que la 1re n'est pas terminée");
  await h.drive(r2.taskIds);
  expect(dump(h.history(b3)) === dump(["todo", "doing", "review", "done"]), "chaîne 2 reprise puis terminée jusqu'au bout");

  section("A7. étape bloquée (session fermée) + agent « verifier » + terminée à la main");
  const vMission = "Ajoute le bouton Exporter.";
  const r3 = started(await h.call("ui", "chain.run", { chain: "verified", project: "Proj", mission: vMission }));
  const [c1, c2] = r3.taskIds;
  const t2 = await h.task(c2);
  expect(t2.role === "reader" && t2.title.startsWith("Vérificateur —") && t2.description.includes("VÉRIFICATEUR AVEUGLE") &&
    t2.description.includes(vMission), "verifier : lecteur, reçoit la mission d'origine telle quelle", t2.title);
  await until(async () => (await h.task(c1)).status === "doing", "chaîne 3 : dev démarré");
  (await h.agentOf(c1)).status = "closed";
  await until(async () => (await h.task(c1)).status === "blocked", "dev bloqué (session fermée)", 8000);
  await until(async () => (await h.task(c2)).reason, "raison posée sur le vérificateur", 5000);
  const blocked = await h.task(c1);
  expect((await h.task(c2)).reason === `Chaîne arrêtée : ${blocked.title} a échoué` && blocked.reason === "session fermée",
    "étape bloquée : le vérificateur attend avec la raison", dump([blocked.reason, (await h.task(c2)).reason]));
  await h.call("ui", "task.move", { id: c1, status: "done" });
  await until(async () => (await h.task(c2)).status === "doing", "dev terminé à la main : le vérificateur démarre seul", 8000);
  expect((await h.task(c2)).reason === "", "raison retirée au démarrage");
  await h.drive([c2]);

  section("A8. échec du démarrage automatique : tâche bloquée, pas de boucle, relance manuelle");
  h.sim.failOpen = true;
  h.sim.opens = 0;
  const r4 = started(await h.call("ui", "chain.run", { chain: "pair", project: "Proj", mission: "Mission pair" }));
  const [d1, d2] = r4.taskIds;
  await until(async () => (await h.task(d1)).status === "blocked", "1re bloquée (démarrage impossible)", 8000);
  const failedStart = await h.task(d1);
  expect(/^Démarrage automatique impossible : .*dossier refusé/.test(failedStart.reason), "raison « Démarrage automatique impossible »",
    failedStart.reason);
  await until(async () => (await h.task(d2)).reason, "raison sur la 2e", 5000);
  expect((await h.task(d2)).reason.startsWith("Chaîne arrêtée : "), "la 2e : « Chaîne arrêtée : … »");
  await sleep(5600);
  expect(h.sim.opens === 1, "un seul essai de démarrage (pas de boucle de relance)", String(h.sim.opens));
  h.sim.failOpen = false;
  await h.call("ui", "task.move", { id: d1, status: "todo" });
  await h.drive(r4.taskIds);
  ok("relance manuelle de la 1re (glisser vers « À faire ») : la chaîne repart et se termine");

  section("A9. machine absente, maillon supprimé (les suivants héritent des dépendances)");
  h.sim.up = false;
  const sessionsA9 = h.agents.size;
  const r5 = started(await h.call("ui", "chain.run", { chain: "bugfix", project: "Proj", mission: "Hors ligne" }));
  const [e1, e2, e3] = r5.taskIds;
  await until(async () => (await h.task(e1)).reason, "raison d'attente de la machine", 5000);
  expect((await h.task(e1)).reason === "En attente de la machine local" && (await h.task(e1)).status === "todo",
    "machine injoignable : « En attente de la machine local », rien n'est bloqué");
  await h.call("ui", "task.delete", { id: e2 });
  expect(dump((await h.task(e3)).deps) === dump([e1]), "maillon supprimé : la 3e dépend maintenant de la 1re",
    dump((await h.task(e3)).deps));
  h.sim.up = true;
  await until(async () => (await h.task(e1)).status === "doing", "machine revenue : la 1re démarre (filet de sécurité)", 9000);
  expect((await h.task(e3)).status === "todo" && h.agents.size === sessionsA9 + 1,
    "la 3e n'a pas démarré avant la fin de la 1re");
  await h.drive([e1, e3]);

  section("A10. champs refusés au navigateur ; autostart seul ; tâches ordinaires inchangées");
  r = await h.call("ui", "task.create", { title: "Forgée", host: "local", project: P, engine: ENGINE,
    chain: "forged", autostart: true });
  const forged = await h.task(r.replies.find((m) => m.type === "task.created").id);
  expect(forged.chain === "" && forged.autostart === false && forged.status === "todo",
    "navigateur : chain et autostart ignorés (rien ne démarre)", dump([forged.chain, forged.autostart, forged.status]));
  await sleep(3200);
  expect((await h.task(forged.id)).status === "todo", "la tâche forgée reste « À faire » après 1 cycle");
  const plain1 = (await h.call("ui", "task.create", { title: "Prérequis", host: "local", project: P, engine: ENGINE }))
    .replies.find((m) => m.type === "task.created").id;
  await h.call("ui", "task.move", { id: plain1, status: "done" });
  const plain2 = (await h.call("ui", "task.create", { title: "Ordinaire", host: "local", project: P, engine: ENGINE,
    deps: [plain1] })).replies.find((m) => m.type === "task.created").id;
  const solo = (await h.call("invoke", "task.create", { title: "Autostart seul", host: "local", project: P,
    engine: ENGINE, autostart: true })).replies.find((m) => m.type === "task.created").id;
  await until(async () => (await h.task(solo)).status === "doing", "appel interne autostart (sans chaîne) : démarre seul", 8000);
  expect((await h.task(solo)).chain === "" && (await h.task(solo)).autostart === true, "snapshot : chain '' et autostart true");
  (await h.agentOf(solo)).status = "idle";
  await until(async () => (await h.task(solo)).status === "review", "autostart seul : arrive « À valider »", 8000);
  await sleep(3200);
  expect((await h.task(solo)).status === "review" && (await h.task(plain2)).status === "todo",
    "hors chaîne : pas de passage « Terminé » automatique, et une tâche ordinaire (dépendance faite) ne démarre pas seule");
  const withChain = await h.call("invoke", "task.create", { title: "Interne", host: "local", project: P, engine: ENGINE,
    chain: "run-x" });
  const internal = await h.task(withChain.replies.find((m) => m.type === "task.created").id);
  expect(internal.chain === "run-x" && internal.autostart === false && internal.status === "todo",
    "appel interne : chain acceptée", dump([internal.chain, internal.autostart]));
} catch (error) {
  bad("exception pendant la partie A", error?.stack || error);
}

// ================================================================ B et C. instance isolée
let server = null;
const agentsToDelete = new Set();
let daemon = null;
async function realParts() {
  const dataDir = join(scratch, "real-data");
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: dataDir, DASHBOARD_HOST: "127.0.0.1",
    BRAIN_DB: join(dataDir, "brain.sqlite") };
  delete env.DASHBOARD_PASSWORD;
  // Un autre processus (autre agent, serveur réel) écoute déjà : on ne s'y connecte jamais.
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
  const base = `http://127.0.0.1:${PORT}`;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ui`, { origin: base });
  const inbox = [];
  let tasks = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "tasks") tasks = m.tasks;
    else inbox.push(m);
  });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (m) => ws.send(JSON.stringify(m));
  const take = async (pred, label, timeout = 10000) => {
    const m = await until(() => { const i = inbox.findIndex(pred); return i >= 0 ? inbox.splice(i, 1)[0] : null; }, label, timeout);
    return m;
  };
  const hostsFile = locateHostsFile();
  if (!hostsFile) { console.log("SKIP parties B/C : fichier des machines introuvable (DASHBOARD_HOSTS_FILE, dashboard/ ou dépôt principal)"); return; }
  const local = JSON.parse(readFileSync(hostsFile, "utf8")).hosts.find((x) => x.label === "local");
  daemon = new DaemonClient({ url: local.url, clientId: `verify-chains-${Date.now()}`, clientType: "cli",
    password: local.password || undefined });
  await daemon.connect();

  if (process.env.VERIFY_REAL !== "0") {
    section("B. instance isolée, chaîne réelle de 2 agents PONG (claude-openrouter/sonnet)");
    send({ type: "project.follow", host: "local", dir: SANDBOX });
    await take((m) => m.type === "project.followed", "project.follow sandbox-repo");
    for (const id of ["pong-a", "pong-b"]) {
      send({ type: "profile.save", profile: { id, name: `Test ${id}`, role: "writer", instructions: PONG, engine: ENGINE } });
    }
    send({ type: "chain.save", chain: { id: "pong2", name: "Deux PONG", steps: ["pong-a", "pong-b"] } });
    await sleep(300);
    inbox.length = 0;
    send({ type: "chain.run", chain: "pong2", project: "sandbox-repo", mission: PONG });
    const real = await take((m) => m.type === "chain.started" || m.type === "error", "chain.run réel", 20000);
    expect(real?.type === "chain.started" && real.taskIds.length === 2, "chain.started avec 2 tâches", dump(real));
    const [p1, p2] = real?.taskIds || [];
    const seen = new Map();
    const track = setInterval(() => { for (const t of tasks) if (!seen.has(t.id + t.status)) seen.set(t.id + t.status, Date.now()); }, 50);
    const byId = (id) => tasks.find((t) => t.id === id);
    await until(() => byId(p1)?.status === "doing", "réel : 1re tâche démarrée sans action", 30000);
    if (byId(p1)?.agentId) agentsToDelete.add(byId(p1).agentId);
    expect(byId(p2)?.status === "todo", "réel : la 2e attend pendant que la 1re travaille");
    await until(() => byId(p2)?.status === "doing" || byId(p2)?.status === "done", "réel : 2e tâche démarrée seule", 300000, 200);
    if (byId(p2)?.agentId) agentsToDelete.add(byId(p2).agentId);
    expect(byId(p1)?.status === "done" && /PONG/.test(byId(p1)?.summary || ""),
      "réel : la 1re est passée « Terminé » seule avec le résumé PONG", dump([byId(p1)?.status, byId(p1)?.summary]));
    await until(() => byId(p2)?.status === "done", "réel : 2e tâche terminée seule", 300000, 200);
    clearInterval(track);
    expect(/PONG/.test(byId(p2)?.summary || "") && seen.get(p1 + "done") <= seen.get(p2 + "doing"),
      "réel : la 2e n'a démarré qu'après la fin de la 1re", dump([byId(p2)?.summary, seen.get(p1 + "done"), seen.get(p2 + "doing")]));
    for (const id of [p1, p2]) send({ type: "task.delete", id });
    await sleep(500);
  }

  if (process.env.SKIP_TASKS !== "1") {
    section("C. verify-tasks.mjs contre l'instance isolée");
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dashboardDir, "scripts", "verify-tasks.mjs")], {
        env: { ...env, DASHBOARD_VERIFY_URL: `ws://127.0.0.1:${PORT}/ui`, SKIP_PERM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      child.stdout.on("data", (d) => { text += d; });
      child.stderr.on("data", (d) => { text += d; });
      child.on("exit", (code) => resolve({ code, text }));
    });
    writeFileSync(join(scratch, "verify-tasks.log"), out.text);
    console.log(out.text.split("\n").filter((l) => /^(OK|VERIFY|NETTOYAGE|BASELINE)/.test(l)).slice(-12).join("\n"));
    expect(out.code === 0 && out.text.includes("VERIFY_TASKS_PASS"), "verify-tasks.mjs passe (variante isolée)", `code ${out.code}`);
  }
  ws.close();
}

try {
  if (process.env.VERIFY_REAL !== "0" || process.env.SKIP_TASKS !== "1") await realParts();
} catch (error) {
  bad("exception pendant les parties B/C", error?.stack || error);
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
console.log(`\n${failed ? "VERIFY_CHAINS_FAIL" : "VERIFY_CHAINS_PASS"} : ${passed} vérification(s) réussie(s), ${failed} échec(s)`);
console.log(`journaux : ${existsSync(scratch) ? scratch : "(aucun)"}`);
process.exit(failed ? 1 : 0);
