// Vue Téléphone : règles de rangement (handlers/mobile.mjs), point d'historique d'usage et utilitaires purs de views/mobile.js.
import assert from "node:assert/strict";
import { tidyCandidates, pointOf, cleanHours } from "../handlers/mobile.mjs";

const H = 3_600_000;
const now = Date.now();
const at = (h) => new Date(now - h * H).toISOString();
const agents = [
  { host: "a", agentId: "old-idle", status: "idle", updatedAt: at(30) },
  { host: "a", agentId: "old-running", status: "running", updatedAt: at(30) },
  { host: "a", agentId: "recent-idle", status: "idle", updatedAt: at(2) },
  { host: "a", agentId: "old-error", status: "error", updatedAt: at(48) },
  { host: "a", agentId: "waiting", status: "waiting-permission", updatedAt: at(99) },
  { host: "a", agentId: "parent", status: "idle", updatedAt: at(90) },
  { host: "a", agentId: "child", status: "running", parentAgentId: "parent", updatedAt: at(1) },
  { host: "a", agentId: "no-date", status: "idle", updatedAt: null },
  { host: "a", agentId: "closed", status: "closed", updatedAt: at(500) },
];
assert.deepEqual(tidyCandidates(agents, 24, now).map((a) => a.agentId), ["old-idle", "old-error"]);
assert.deepEqual(tidyCandidates(agents, 1, now).map((a) => a.agentId), ["old-idle", "recent-idle", "old-error"]);
assert.deepEqual(tidyCandidates(null, 24, now), []);
assert.equal(cleanHours("abc"), 24);
assert.equal(cleanHours(0), 1);
assert.equal(cleanHours(99999), 720);

const point = pointOf({ providers: [{ id: "claude", name: "Claude", windows: [{ id: "five_hour", label: "Session", shortLabel: "5h", usedPct: 7 }, { id: "x", usedPct: null }] }] }, 5);
assert.deepEqual(point, { t: 5, v: { "claude/five_hour": 7 } });

globalThis.document = {}; // mobile.js n'importe que des modules purs côté navigateur ; seules les fonctions pures sont testées
console.log("verify-mobile : OK");
