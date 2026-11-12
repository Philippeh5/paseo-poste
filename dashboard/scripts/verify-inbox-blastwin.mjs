// dashboard/scripts/verify-inbox-blastwin.mjs — régression T48 : le sondage du daemon ne doit JAMAIS marquer « traité »
// une demande BlastWin (blastwin-confirm / blastwin-merge), qui n'existe pas côté daemon. Hors ligne, sans daemon réel.
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const here = fileURLToPath(new URL(".", import.meta.url));
const { register } = await import(pathToFileURL(join(here, "..", "handlers", "inbox.mjs")).href);

let fails = 0;
const expect = (c, l) => { console.log(`${c ? "OK  " : "FAIL"} ${l}`); if (!c) fails++; };

const ctx = {
  onMessage() {}, send() {}, broadcast() {}, log() {},
  sendError() {}, onStateChange() {}, invoke: async () => ({}),
  store: { read: () => ({}), write() {} },
  // Daemon factice : connecté, aucune permission en attente.
  hosts: { labels: () => ["oracle"], get: () => ({ connected: () => true, api: { agents: { list: async () => ({ entries: [] }) } } }) },
};
register(ctx);

const mk = (kind) => ctx.inbox.add({
  kind: "permission", host: "oracle", title: `BlastWin ${kind}`, body: "x", status: "nouveau", source: "t48-test",
  action: { type: "permission", requestId: `req-${kind}`, kind, actions: [] },
});
const confirm = mk("blastwin-confirm");
const merge = mk("blastwin-merge");
// Témoin : une vraie demande de permission (côté daemon) disparue doit, elle, passer à « traité » (comportement conservé).
const orphan = ctx.inbox.add({
  kind: "permission", host: "oracle", title: "Permission daemon disparue", body: "x", status: "nouveau", source: "test",
  action: { type: "permission", requestId: "req-daemon", kind: "tool", actions: [] },
});

await sleep(2500); // plusieurs cycles de sondage (500 ms)
const st = (it) => ctx.inbox.list({}).find((i) => i.id === it.id)?.status;
expect(st(confirm) === "nouveau", "blastwin-confirm reste « nouveau » après plusieurs sondages");
expect(st(merge) === "nouveau", "blastwin-merge reste « nouveau » après plusieurs sondages");
expect(st(orphan) === "traité", "témoin : une permission daemon disparue passe bien à « traité »");

console.log(fails ? `\n${fails} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(fails ? 1 : 0);
