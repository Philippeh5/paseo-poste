// Vérifie le « cerveau » (handlers/tasks.mjs) en client WebSocket, avec une vraie session claude-openrouter/sonnet.
// Usage : node dashboard/scripts/verify-tasks.mjs   (le serveur du dashboard doit tourner avec le handler chargé)
// Variables : DASHBOARD_VERIFY_URL (défaut ws://127.0.0.1:7070/ui), PROJECT (défaut sandbox-repo), SKIP_PERM=1.
// Tout ce que le test crée porte le préfixe « VERIF-T08 » et est supprimé à la fin (tâches, agents, fichiers).
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readJson } from "../lib/store.mjs";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");
const dashboardDir = fileURLToPath(new URL("../", import.meta.url));
const dbFile = process.env.BRAIN_DB || `${dashboardDir}data/brain.sqlite`;
const project = process.env.PROJECT || String.raw`D:\Projets\AI-OS\paseo-poste\sandbox-repo`;
const PREFIX = "VERIF-T08";
const ENGINE = "claude-openrouter/sonnet";
const PONG = "Reply with the single word PONG and do nothing else.";

const socket = new WebSocket(url, { origin });
let opened = false;
let tasks = [];
let state = { agents: [] };
const changes = [];
const errors = [];
const agentsToDelete = [];
socket.on("open", () => { opened = true; });
socket.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "tasks") tasks = m.tasks;
  else if (m.type === "task.changed") changes.push(m);
  else if (m.type === "state") state = m.payload;
  else if (m.type === "error") errors.push(m.message);
});

const send = (message) => socket.send(JSON.stringify(message));
const expect = (condition, label, detail = "") => {
  if (!condition) throw new Error(`${label} ${detail}`);
  console.log(`OK ${label}`);
};
async function until(predicate, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await delay(60);
  }
  throw new Error(`Délai dépassé : ${label}`);
}
const byId = (id) => tasks.find((t) => t.id === id);
// Envoie un message qui doit être refusé ; renvoie le texte de l'erreur.
async function refused(message, label) {
  errors.length = 0;
  send(message);
  return until(() => errors[0], `refus attendu : ${label}`, 5000);
}
async function create(fields) {
  const title = `${PREFIX} ${fields.title}`;
  send({ type: "task.create", host: "local", project, ...fields, title });
  const change = await until(() => changes.find((c) => c.task?.title === title), `création de « ${title} »`);
  return change.task;
}
const column = (status) => tasks.filter((t) => t.status === status).map((t) => t.title.replace(`${PREFIX} `, ""));

let db;
const createdIds = [];
const probeFile = `${project}\\t08-perm-probe.txt`;
let daemon;
async function cleanup() {
  for (const id of createdIds) if (byId(id)) send({ type: "task.delete", id });
  await delay(400);
  if (daemon) {
    for (const id of agentsToDelete) await daemon.deleteAgent(id).catch(() => {});
    await daemon.close().catch(() => {});
  }
  rmSync(probeFile, { force: true });
}

try {
  for (let i = 0; i < 100 && !opened; i++) await delay(50);
  expect(opened, "connexion au dashboard");
  const local = readJson((process.env.DASHBOARD_HOSTS_FILE || `${dashboardDir}hosts.json`), { hosts: [] }).hosts.find((h) => h.label === "local");
  daemon = new DaemonClient({ url: local.url, clientId: `verify-tasks-${Date.now()}`, clientType: "cli", password: local.password || undefined });
  await daemon.connect();

  send({ type: "task.list" });
  await until(() => Array.isArray(tasks), "task.list répond");
  const baseline = tasks.length;
  console.log(`BASELINE ${baseline} tâche(s) existante(s), non touchées`);

  // 1. Création et validation
  const e1 = await refused({ type: "task.create", title: "   ", host: "local" }, "titre vide");
  expect(/titre/i.test(e1), "task.create avec titre vide refusé", e1);
  const e2 = await refused({ type: "task.create", title: `${PREFIX} x`, host: "inconnue" }, "hôte inconnu");
  expect(/machine inconnue/i.test(e2), "task.create avec hôte inconnu refusé", e2);
  const e3 = await refused({ type: "task.create", title: `${PREFIX} x`, host: "local", deps: ["nope"] }, "dépendance inconnue");
  expect(/dépendance inconnue/i.test(e3), "task.create avec dépendance inexistante refusé", e3);
  const e4 = await refused({ type: "task.create", title: `${PREFIX} x`, host: "local", engine: "sansbarre" }, "moteur invalide");
  expect(/moteur/i.test(e4), "task.create avec moteur invalide refusé", e4);
  expect(!tasks.some((t) => t.title === `${PREFIX} x`), "aucune tâche créée par les refus");

  const A = await create({ title: "A (prérequis)", description: "Étape A", engine: ENGINE });
  createdIds.push(A.id);
  expect(A.status === "todo" && A.id.length === 36, "task.create : A créée en « todo » avec un uuid", A.id);
  const B = await create({ title: "B (dépend de A)", description: PONG, engine: ENGINE, mode: "", deps: [A.id] });
  createdIds.push(B.id);
  expect(JSON.stringify(B.deps) === JSON.stringify([A.id]) && B.blockedBy[0]?.id === A.id, "B créée avec dépendance A et blockedBy");

  // 2. Cycles
  const c1 = await refused({ type: "task.update", id: A.id, deps: [B.id] }, "cycle A→B→A");
  expect(/cycle/i.test(c1), "task.update A dépend de B (B dépend de A) : cycle refusé", c1);
  const c2 = await refused({ type: "task.update", id: A.id, deps: [A.id] }, "auto-dépendance");
  expect(/cycle|elle-même/i.test(c2), "task.update auto-dépendance refusée", c2);

  // 3. Dépendance : démarrage de B refusé tant que A n'est pas terminé
  const s1 = await refused({ type: "task.start", id: B.id }, "B bloquée par A");
  expect(/Bloquée par: .*A \(prérequis\).*À faire/.test(s1), "task.start B refusé : « Bloquée par: … »", s1);
  expect(byId(B.id).status === "todo", "B reste « todo » après le refus");

  // 4. Déplacements : « doing » sans session refusé ; ordre et colonnes
  const D = await create({ title: "D" });
  const d1 = await refused({ type: "task.move", id: D.id, status: "doing" }, "doing sans projet");
  expect(/dossier|moteur/.test(d1) && byId(D.id).status === "todo", "task.move vers « doing » sans session ni projet refusé (la carte reste « todo »)", d1);
  const E = await create({ title: "E" });
  createdIds.push(D.id, E.id);
  console.log("COLONNE todo avant :", JSON.stringify(column("todo")));
  send({ type: "task.move", id: E.id, status: "todo", index: 0 });
  await until(() => column("todo")[0] === "E", "E remonte en tête de « todo »");
  console.log("COLONNE todo après :", JSON.stringify(column("todo")));
  send({ type: "task.move", id: D.id, status: "review", index: 0 });
  await until(() => byId(D.id).status === "review", "D passe « review »");
  console.log("COLONNES todo / review :", JSON.stringify(column("todo")), JSON.stringify(column("review")));
  send({ type: "task.update", id: D.id, title: `${PREFIX} D renommée`, description: "x" });
  await until(() => byId(D.id).title === `${PREFIX} D renommée`, "task.update renomme D");

  // 5. A terminé -> B démarrable ; session réelle
  send({ type: "task.move", id: A.id, status: "done" });
  await until(() => byId(A.id).status === "done", "A déplacée vers « done » à la main");
  await until(() => byId(B.id).blockedBy.length === 0, "B n'est plus bloquée");
  errors.length = 0;
  const startedAt = Date.now();
  send({ type: "task.start", id: B.id });
  await until(() => byId(B.id).status === "doing", "task.start B accepté : B passe « doing »", 20000);
  const doing = byId(B.id);
  agentsToDelete.push(doing.agentId);
  expect(Boolean(doing.agentId), "B a un agentId", doing.agentId);
  expect(errors.length === 0, "aucune erreur au démarrage", errors.join(" | "));
  console.log(`DOING après ${Date.now() - startedAt} ms, agent ${doing.agentId}`);
  try {
    await until(() => byId(B.id).status === "review", "B passe « review » à la fin du tour", 240000);
  } catch (error) {
    const rows = (await daemon.fetchAgents({})).entries.map((e) => e.agent || e);
    const agent = rows.find((a) => a.id === doing.agentId);
    console.log("DIAGNOSTIC agent :", JSON.stringify({ status: agent?.status, lastError: agent?.lastError, pending: agent?.pendingPermissions?.length, task: byId(B.id)?.status }));
    throw error;
  }
  const reviewed = byId(B.id);
  console.log(`REVIEW après ${Date.now() - startedAt} ms, résumé : ${JSON.stringify(reviewed.summary)}`);
  expect(/PONG/.test(reviewed.summary), "le résumé contient PONG", reviewed.summary);
  const sessionsBefore = state.agents.filter((a) => a.agentId === doing.agentId).length;
  expect(sessionsBefore <= 1, "une seule session créée pour B");

  // 5b. Workflow : une tâche terminée remise dans « À faire » est relancée automatiquement (nouvelle session)
  send({ type: "task.move", id: B.id, status: "done" });
  await until(() => byId(B.id).status === "done", "B déplacée vers « done »");
  errors.length = 0;
  send({ type: "task.move", id: B.id, status: "todo" });
  await until(() => byId(B.id).status === "doing" && byId(B.id).agentId && byId(B.id).agentId !== doing.agentId,
    "done → todo relance B automatiquement (nouvelle session)", 30000);
  agentsToDelete.push(byId(B.id).agentId);
  await until(() => byId(B.id).status === "review", "B repasse « review » après la relance", 240000);

  // 6. Persistance : relecture directe de SQLite et nouvelle connexion
  db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 4000");
  const stored = db.prepare("SELECT id, title, status, agent_id, summary, deps FROM tasks WHERE title LIKE ?").all(`${PREFIX}%`);
  const storedB = stored.find((r) => r.id === B.id);
  console.log("SQLITE B :", JSON.stringify(storedB));
  expect(stored.length === createdIds.length, "SQLite contient les tâches de test", `${stored.length}/${createdIds.length}`);
  expect(storedB.status === "review" && storedB.agent_id === byId(B.id).agentId && /PONG/.test(storedB.summary), "SQLite : B en review avec agent_id et résumé");
  const second = new WebSocket(url, { origin });
  const relist = await new Promise((resolve, reject) => {
    second.on("open", () => second.send(JSON.stringify({ type: "task.list" })));
    second.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "tasks") resolve(m.tasks);
    });
    setTimeout(() => reject(new Error("task.list (2e connexion) sans réponse")), 5000);
  });
  second.close();
  expect(relist.filter((t) => t.title.startsWith(PREFIX)).length === createdIds.length, "2e connexion : task.list retrouve les mêmes tâches");

  // 7. Rapprochement : une tâche « doing » dont l'agent n'existe pas devient « blocked / session perdue »
  const ghost = await create({ title: "Fantôme (agent inexistant)" });
  createdIds.push(ghost.id);
  const rw = new DatabaseSync(dbFile);
  rw.exec("PRAGMA busy_timeout = 4000");
  rw.prepare("UPDATE tasks SET status = 'doing', agent_id = ? WHERE id = ?").run("00000000-0000-4000-8000-000000000000", ghost.id);
  rw.close();
  send({ type: "task.list" });
  await until(() => byId(ghost.id)?.status === "blocked", "tâche fantôme : « doing » -> « blocked »", 45000);
  expect(byId(ghost.id).reason === "session perdue", "raison « session perdue »", byId(ghost.id).reason);

  // 8. Demande de permission : pastille sans changement de colonne, puis arrêt
  if (!process.env.SKIP_PERM) {
    const P = await create({
      title: "Permission", engine: ENGINE, mode: "default",
      description: "Create a file named t08-perm-probe.txt in the current directory containing the word hi, using the Write tool.",
    });
    createdIds.push(P.id);
    send({ type: "task.start", id: P.id });
    await until(() => byId(P.id).status === "doing", "tâche Permission démarrée", 20000);
    agentsToDelete.push(byId(P.id).agentId);
    await until(() => byId(P.id).permission || byId(P.id).status !== "doing", "drapeau « permission requise »", 240000);
    expect(byId(P.id).permission === true && byId(P.id).status === "doing", "permission requise : pastille posée, colonne inchangée (doing)");
    send({ type: "task.stop", id: P.id });
    await until(() => byId(P.id).status === "blocked", "task.stop : la tâche passe « blocked »", 20000);
    expect(byId(P.id).reason === "Arrêtée manuellement" && byId(P.id).permission === false, "raison « Arrêtée manuellement », pastille retirée");
    expect(!existsSync(probeFile), "le fichier de test n'a pas été créé (permission refusée par l'arrêt)");
  }

  // 9. Suppression : le lien de dépendance disparaît avec la tâche supprimée
  send({ type: "task.delete", id: A.id });
  await until(() => !byId(A.id), "task.delete A");
  expect(byId(B.id).deps.length === 0, "B ne dépend plus de A après suppression de A");
  const gone = await refused({ type: "task.delete", id: A.id }, "suppression d'une tâche inconnue");
  expect(/introuvable/i.test(gone), "task.delete d'une tâche supprimée refusé", gone);

  console.log("VERIFY_TASKS_PASS");
} catch (error) {
  console.error("VERIFY_TASKS_FAIL", error.message);
  process.exitCode = 1;
} finally {
  db?.close();
  await cleanup();
  send({ type: "task.list" });
  await delay(500);
  const left = tasks.filter((t) => t.title.startsWith(PREFIX));
  console.log(`NETTOYAGE : ${left.length} tâche(s) de test restante(s), ${tasks.length} au total (base initiale ${tasks.length - left.length})`);
  if (left.length) process.exitCode = 1;
  socket.close();
}
