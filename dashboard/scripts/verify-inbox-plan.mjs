// Vérifie le flux « plan généré » de la boîte de réception (serveur) : création, réordonnancement,
// validation (tâches réellement créées dans l'ordre), refus (aucune tâche). Nettoie tout.
import { WebSocket } from "ws";
import { setTimeout as delay } from "node:timers/promises";
const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const ws = new WebSocket(url, { origin: new URL(url).origin.replace("ws:", "http:") });
const inbox = [];
ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type !== "state") inbox.push(m); });
let fails = 0;
const ok = (c, msg, extra = "") => { console.log(c ? "OK" : "FAIL", msg, extra); if (!c) fails++; };
const send = (m) => ws.send(JSON.stringify(m));
async function next(pred, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; await delay(50); }
  throw new Error("délai: " + label);
}
await new Promise((r) => ws.on("open", r));
const tag = `VFPLAN-${Date.now().toString(36)}`;
const tasks = [
  { id: "a", title: `${tag} A` , project: "sandbox-repo", harness: "" },
  { id: "b", title: `${tag} B`, project: "sandbox-repo", harness: "", dependsOn: ["a"] },
  { id: "c", title: `${tag} C`, project: "sandbox-repo", harness: "" },
];
const cleanup = [];
try {
  send({ type: "task.list" });
  const before = (await next((m) => m.type === "tasks" || m.type === "task.list", "liste initiale")).tasks?.length ?? 0;

  send({ type: "inbox.plan.create", title: `Plan ${tag}`, tasks, host: "local", project: "sandbox-repo" });
  const created = await next((m) => m.type === "inbox.plan.created", "plan créé");
  ok(created.item.kind === "plan" && created.item.tasks.length === 3, "plan créé avec 3 tâches");
  const id = created.item.id;

  send({ type: "inbox.plan.update", id, tasks: [tasks[2], tasks[0], tasks[1]] });
  const upd = await next((m) => m.type === "inbox.plan.updated", "plan réordonné");
  ok(upd.item.tasks.map((t) => t.title.slice(-1)).join("") === "CAB", "réordonnancement conservé (C,A,B)");

  send({ type: "task.list" });
  const mid = (await next((m) => m.type === "tasks" || m.type === "task.list", "liste avant validation")).tasks.length;
  ok(mid === before, "aucune tâche créée avant validation", `${mid} vs ${before}`);

  send({ type: "inbox.plan.apply", id });
  const applied = await next((m) => m.type === "inbox.plan.applied", "plan validé");
  ok(applied.createdTasks.length === 3, "validation crée exactement 3 tâches", JSON.stringify(applied.createdTasks));
  cleanup.push(...applied.createdTasks);
  await delay(800); inbox.length = 0;
  send({ type: "task.list" });
  const all = (await next((m) => m.type === "tasks" || m.type === "task.list", "liste après")).tasks;
  const mine = all.filter((t) => t.title.includes(tag));
  ok(mine.length === 3, "3 tâches présentes dans la base");
  const b = mine.find((t) => t.title.endsWith(" B")), a = mine.find((t) => t.title.endsWith(" A"));
  ok(b && a && JSON.stringify(b.deps || b.dependsOn || []).includes(a.id), "dépendance B→A résolue");
  send({ type: "inbox.plan.apply", id });
  const again = await next((m) => m.type === "error", "second apply refusé").catch(() => null);
  ok(again, "revalider un plan traité est refusé");

  send({ type: "inbox.plan.create", title: `Plan refus ${tag}`, tasks: [{ title: `${tag} R` }] });
  const c2 = await next((m) => m.type === "inbox.plan.created", "plan 2");
  send({ type: "inbox.plan.refuse", id: c2.item.id });
  await next((m) => m.type === "inbox.plan.refused", "plan refusé");
  await delay(800); inbox.length = 0;
  send({ type: "task.list" });
  const after = (await next((m) => m.type === "tasks" || m.type === "task.list", "liste refus")).tasks;
  ok(!after.some((t) => t.title.endsWith(`${tag} R`)), "plan refusé: aucune tâche créée");
  send({ type: "inbox.plan.create", title: "vide", tasks: [] });
  await next((m) => m.type === "error", "plan vide refusé");
  ok(true, "plan vide refusé");
} catch (e) { console.log("FAIL exception", e.message); fails++; }
finally {
  for (const t of cleanup) send({ type: "task.delete", id: t });
  await delay(500);
  ws.close();
}
console.log(fails ? `ÉCHECS: ${fails}` : "VERIFY_INBOX_PLAN_PASS");
process.exit(fails ? 1 : 0);
