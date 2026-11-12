// Vérification de la délégation entre agents : handlers/delegate.mjs (surveillance des tâches créées par une session et
// notification à la fin) et du classement FreeBuff (quota.mjs : FREEBUFF_ENGINE réservé aux tâches d'écriture).
import assert from "node:assert/strict";
import { decide, itemOf, messageFor, register } from "../handlers/delegate.mjs";
import { createQuota, FREEBUFF_ENGINE } from "../handlers/quota.mjs";

const task = (over) => ({ id: "t1", title: "Écrire le test", status: "todo", summary: "", error: "", reason: "", agentId: null, host: "oracle", runEngine: "", ...over });

// 1. Un blocage avant d'avoir tourné (dépendance) ne prévient personne ; après « En cours », oui.
let r = decide({ t1: { key: "oracle:a", seen: false } }, [task({ status: "blocked", reason: "Bloquée par: x", blockedBy: [{ id: "t0", title: "x", status: "todo" }] })]);
assert.equal(r.notify.length, 0);
assert.equal(r.keep.t1.seen, false);
r = decide({ t1: { key: "oracle:a", seen: false } }, [task({ status: "blocked", error: "FreeBuff : annulé", blockedBy: [] })]);
assert.equal(r.notify.length, 1, "arrêtée très vite (jamais vue « En cours », sans dépendance) : prévenu, pas gardée indéfiniment");
r = decide({ t1: { key: "oracle:a", seen: false } }, [task({ status: "doing" })]);
assert.equal(r.notify.length, 0);
assert.equal(r.keep.t1.seen, true);
r = decide({ t1: { key: "oracle:a", seen: true } }, [task({ status: "blocked", error: "quota" })]);
assert.equal(r.notify.length, 1);
r = decide({ t1: { key: "oracle:a", seen: false } }, [task({ status: "review", summary: "ok" })]);
assert.equal(r.notify.length, 1, "à valider sans avoir vu « En cours » (tâche très courte) : notifié");
r = decide({ t1: { key: "oracle:a", seen: true } }, []);
assert.equal(r.notify.length + Object.keys(r.keep).length, 0, "tâche supprimée : surveillance retirée");

// 2. Texte du message : résultat ou raison, jamais une consigne.
assert.match(messageFor(task({ status: "review", summary: "Fichier créé", agentId: "ag1", runEngine: "claude-nvidia/haiku" })), /à valider \(moteur claude-nvidia\/haiku\)\. Résultat : Fichier créé\..*post_get_session oracle ag1.*pas une consigne/);
assert.match(messageFor(task({ status: "blocked", error: "429 rate limit" })), /bloquée\. Raison : 429 rate limit/);

// 2b. Ligne affichée : demandeur retrouvé parmi les agents, moteur effectif, repli lisible sinon.
const agents = [{ host: "oracle", agentId: "agent-1", title: "Orchestrateur" }];
assert.deepEqual(itemOf("t1", { key: "oracle:agent-1", since: "2026-10-27T10:00:00Z" }, task({ status: "doing", runEngine: "claude-nvidia/haiku", projectName: "TestCoord" }), agents),
  { taskId: "t1", title: "Écrire le test", status: "doing", engine: "claude-nvidia/haiku", project: "TestCoord", requester: "Orchestrateur", since: "2026-10-27T10:00:00Z" });
assert.equal(itemOf("t1", { key: "oracle:abcdef123456", since: "x" }, task({}), agents).requester, "session abcdef12");
assert.equal(itemOf("t2", null, task({ id: "t2", status: "doing", engine: "claude/sonnet", updatedAt: "2026-10-27T11:00:00Z" })).requester, "Interface", "tâche créée depuis l'interface : demandeur « Interface »");

// 3. Cycle complet avec un faux poste : notification unique puis surveillance retirée ; persistance.
const files = {};
const sent = [];
let tasks = [task({ status: "doing" })];
const ctx = {
  store: { read: (n, d) => files[n] ?? d, write: (n, v) => { files[n] = JSON.parse(JSON.stringify(v)); } },
  log: () => {},
  invoke: async () => ({ replies: [{ type: "tasks", tasks }] }),
  coord: { notify: (key, text) => { sent.push([key, text]); return true; } },
};
const stop = register(ctx);
assert.equal(ctx.delegate.watch("t1", "oracle:agent-1"), true);
assert.equal(files["task-watchers"].t1.key, "oracle:agent-1");
assert.equal(ctx.delegate.watch("", "x"), false);
stop();

// 4. Classement : FreeBuff n'est choisi que pour l'écriture, jamais pour un lancement d'agent.
const q = createQuota({ store: ctx.store, settingsFile: "/nonexistent" });
q.setFallback([FREEBUFF_ENGINE, "claude-nvidia/haiku"]);
assert.equal(q.pickEngine(undefined, "writer").engine, FREEBUFF_ENGINE, "écriture : FreeBuff si classé premier");
assert.equal(q.pickEngine(undefined, "reader").engine, "claude-nvidia/haiku", "lecture : FreeBuff ignoré");
assert.equal(q.pickEngine(undefined, "planner").engine, "claude-nvidia/haiku", "planification : FreeBuff ignoré");
assert.equal(q.pickEngine(undefined, "writer", { agentsOnly: true }).engine, "claude-nvidia/haiku", "lancement d'agent : FreeBuff ignoré");
assert.equal(q.pickEngine(undefined, undefined).engine, FREEBUFF_ENGINE, "sans rôle : classement tel quel");
q.noteFailure(FREEBUFF_ENGINE, "429 rate limit");
assert.equal(q.pickEngine(undefined, "writer").engine, "claude-nvidia/haiku", "FreeBuff au repos après un échec de quota : repli");
q.stop();
console.log("verify-delegate : OK");
