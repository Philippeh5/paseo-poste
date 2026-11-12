// Classement des moteurs par rôle de tâche (handlers/quota.mjs) : un rôle personnalisé choisit son propre moteur de repli,
// un rôle sans liste suit le classement par défaut, une liste vide avec un rôle revient au défaut, un rôle inconnu est refusé.
import assert from "node:assert/strict";
import { createQuota } from "../handlers/quota.mjs";

const files = new Map();
const store = { read: (n, d) => files.get(n) ?? d, write: (n, v) => files.set(n, JSON.parse(JSON.stringify(v))) };
const q = createQuota({ store, settingsFile: "/nonexistent" });

const base = q.getFallback();
q.noteFailure(base[0], "429 rate limit"); // le 1er moteur par défaut est au repos
assert.equal(q.pickEngine(undefined, "reader").engine, base[1], "sans liste de rôle : classement par défaut");

q.setFallback(["claude-nvidia/haiku", "claude-nvidia/opus"], "reader");
assert.equal(q.pickEngine(undefined, "reader").engine, "claude-nvidia/haiku", "le rôle lecture suit sa propre liste");
assert.equal(q.pickEngine(undefined, "writer").engine, base[1], "les autres rôles ne changent pas");
assert.deepEqual(q.snapshot().roles.reader.map((e) => e.engine), ["claude-nvidia/haiku", "claude-nvidia/opus"]);
assert.deepEqual(q.getFallback(), base, "la liste par défaut est intacte");

assert.throws(() => q.setFallback(["claude-nvidia/haiku"], "boss"), /rôle inconnu/);
assert.throws(() => q.setFallback(["pas-un-moteur"], "reader"), /forme attendue/);

q.setFallback([], "reader");
assert.equal(q.snapshot().roles.reader, undefined, "liste vide + rôle : retour au défaut");
assert.equal(q.pickEngine(undefined, "reader").engine, base[1]);
assert.throws(() => q.setFallback([]), /vide/, "la liste par défaut ne peut pas être vide");
q.stop();
console.log("verify-quota-roles : OK");
