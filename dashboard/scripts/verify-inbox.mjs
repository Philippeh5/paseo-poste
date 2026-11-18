// Vérifie handlers/inbox.mjs.
// Usage : node dashboard/scripts/verify-inbox.mjs   (le serveur du dashboard doit tourner sur :7070)
// Partie A (module isolé, dossier temporaire, faux hôte) : idempotence, plafond de 500, extension ctx.inbox,
//   détection permission / fin / erreur / machine, aucune recréation au redémarrage.
// Partie B (serveur réel) : agent claude-openrouter/sonnet en mode « Always Ask », vraie permission d'écriture,
//   délai d'apparition, doublons, inbox.mark / markAll / clear, approbation puis élément « fin ».
//   Supprime hello.txt et l'agent de test à la fin.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");
const daemonUrl = process.env.PASEO_LOCAL_URL || "ws://127.0.0.1:6767/ws";
const here = fileURLToPath(new URL(".", import.meta.url));
const SANDBOX = process.env.VERIFY_SANDBOX || "D:/Projets/AI-OS/paseo-poste/sandbox-repo";
const HELLO = join(SANDBOX, "hello.txt");

const fail = (message) => { throw new Error(message); };
const expect = (condition, label, detail = "") => {
  if (!condition) fail(`${label} ${detail}`);
  console.log(`OK ${label}`);
};
async function waitFor(label, fn, timeout = 20000, step = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(step);
  }
  return fail(`Délai dépassé : ${label}`);
}

// ---------- Partie A : module isolé ----------
const { register } = await import(pathToFileURL(join(here, "..", "handlers", "inbox.mjs")).href);
const { createStore } = await import(pathToFileURL(join(here, "..", "lib", "store.mjs")).href);

function bootModule(dir, fake) {
  const sent = [];
  const broadcasts = [];
  const handlers = {};
  let stateHook = null;
  const ctx = {
    onMessage: (type, fn) => { handlers[type] = fn; },
    send: (_ws, m) => sent.push(m), broadcast: (m) => broadcasts.push(m), sendError: (_ws,
      m) => sent.push({ error: m }),
    store: createStore(dir), log() {}, safeError: String, onStateChange: (fn) => { stateHook = fn; },
    hosts: {
      labels: () => ["fake"],
      get: () => ({ connected: () => true, api: { agents: {
        list: async () => ({ entries: fake.agents.map((a) => ({ agent: a })) }),
        ref: () => ({ timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message",
          text: fake.reply } }] }) } }),
      } } }),
    },
  };
  const stop = register(ctx);
  return {
    ctx, sent, broadcasts, stop, state: (s) => stateHook(s),
    call: (type, m = {}) => { handlers[type]({}, m); return sent.at(-1); },
    items: () => ctx.inbox.list(),
  };
}
const fakeAgent = (over = {}) => ({
  id: "ag1", status: "running", title: "Agent test", cwd: "/x/projet-test", pendingPermissions: [], ...over,
});
const pending = (id) => ({ id, name: "Write", detail: { type: "write", filePath: "/x/projet-test/a.txt",
  content: "SECRET" } });

const tmp = mkdtempSync(join(tmpdir(), "inbox-verify-"));
try {
  const fake = { agents: [fakeAgent({ pendingPermissions: [pending("p0")] })], reply: "Travail terminé : 3 fichiers." };
  const dir = join(tmp, "a");
  let m = bootModule(dir, fake);
  await waitFor("permission détectée au démarrage", () => m.items().length >= 1, 4000);
  expect(m.items().length === 1 && m.items()[0].kind === "permission",
    "permission en attente détectée par l'interrogation");
  const first = m.items()[0];
  expect(first.title === "Permission requise : Write" && first.body === "/x/projet-test/a.txt",
    "titre et cible (chemin) de la permission");
  expect(!JSON.stringify(first).includes("SECRET"), "le contenu du fichier n'est jamais copié dans l'élément");
  expect(first.project === "projet-test" && first.source === "agent" && first.status === "nouveau",
    "projet, source, statut");
  await delay(1400);
  expect(m.items().length === 1, "pas de doublon après plusieurs interrogations");

  // La demande disparaît (traitée ailleurs) → « traité » ; l'agent finit → « fin » avec le dernier message
  fake.agents[0] = fakeAgent({ status: "running" });
  await waitFor("permission traitée", () => m.items().find((i) => i.kind === "permission").status === "traité", 4000);
  expect(true, "demande disparue → élément « traité »");
  fake.agents[0] = fakeAgent({ status: "idle" });
  await waitFor("élément fin", () => m.items().some((i) => i.kind === "fin"), 4000);
  const fin = m.items().find((i) => i.kind === "fin");
  expect(fin.body === "Travail terminé : 3 fichiers." && fin.action.type === "session",
    "élément « fin » avec résumé et action");
  fake.agents[0] = fakeAgent({ status: "running" });
  await delay(1100);
  fake.agents[0] = fakeAgent({ status: "error" });
  await waitFor("élément erreur", () => m.items().some((i) => i.kind === "erreur"), 4000);
  expect(m.items().filter((i) => i.kind === "erreur").length === 1, "élément « erreur » unique");

  // Le module ignore les changements d'état de machine pendant 90 s après son démarrage (SETTLE_MS) : on avance l'horloge.
  const realNow = Date.now;
  Date.now = () => realNow() + 91_000;
  // Machine : le même nouvel état deux fois de suite avant d'alerter
  m.state({ hosts: [{ label: "fake", status: "connected" }] });
  m.state({ hosts: [{ label: "fake", status: "error", reason: "coupée" }] });
  expect(!m.items().some((i) => i.kind === "machine"), "un seul relevé « injoignable » : pas encore d'alerte");
  m.state({ hosts: [{ label: "fake", status: "error", reason: "coupée" }] });
  expect(m.items().some((i) => i.kind === "machine" && i.title.includes("injoignable")), "machine injoignable");
  m.state({ hosts: [{ label: "fake", status: "connected" }] });
  m.state({ hosts: [{ label: "fake", status: "connected" }] });
  expect(m.items().some((i) => i.title.includes("reconnectée")), "machine reconnectée");

  // Redémarrage : aucun élément recréé pour des événements déjà vus
  fake.agents[0] = fakeAgent({ status: "error", pendingPermissions: [pending("p0")] });
  const countBefore = m.items().length;
  m.stop();
  m = bootModule(dir, fake);
  await delay(1300);
  expect(m.items().length === countBefore, "redémarrage : pas de doublon d'événements déjà vus",
    `${countBefore} → ${m.items().length}`);

  // Extension ctx.inbox.add (Telegram, scripts…) : clé d'idempotence, champ source, validation
  const a1 = m.ctx.inbox.add({ kind: "système", title: "Message Telegram", body: "salut", source: "telegram",
    key: "tg:1" });
  expect(a1.source === "telegram" && a1.kind === "système", "ctx.inbox.add : source « telegram »");
  expect(m.ctx.inbox.add({ kind: "système", title: "bis", key: "tg:1" }) === null,
    "ctx.inbox.add : clé déjà vue → ignoré");
  expect(m.ctx.inbox.add({ kind: "inconnu", title: "x" }).kind === "système",
    "ctx.inbox.add : kind inconnu → « système »");
  expect(m.ctx.inbox.add("n'importe quoi") === null, "ctx.inbox.add : entrée invalide ignorée");
  m.stop();
  m = bootModule(dir, fake);
  expect(m.ctx.inbox.add({ title: "bis", key: "tg:1" }) === null, "clés d'idempotence conservées après redémarrage");

  // Plafond de 500, éléments traités sacrifiés en premier
  fake.agents.length = 0;
  for (let i = 0; i < 520; i++) m.ctx.inbox.add({ kind: "système", title: `n${i}`, key: `bulk:${i}` });
  const all = m.items();
  expect(all.length === 500 && all[0].title === "n519", "plafond de 500 éléments, le plus récent en tête",
    String(all.length));
  const store = JSON.parse(readFileSync(join(dir, "inbox.json"), "utf8"));
  expect(store.items.length === 500 && store.seenKeys.length > 500, "fichier écrit, plafond respecté, clés conservées");
  const ids = all.slice(0, 5).map((i) => i.id);
  m.ctx.inbox.mark(ids, "traité");
  for (let i = 0; i < 5; i++) m.ctx.inbox.add({ kind: "système", title: `extra${i}`, key: `extra:${i}` });
  expect(m.items().length === 500 && !m.items().some((i) => ids.includes(i.id)),
    "au-delà de 500, les éléments traités sont supprimés avant les autres");
  m.stop();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- Partie B : serveur réel ----------
const ws = new WebSocket(url, { origin });
const inbox = [];
ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
ws.on("error", (e) => console.error("[ws]", e.message));
const request = async (message, type, timeout = 10000) => {
  const from = inbox.length;
  ws.send(JSON.stringify(message));
  return waitFor(type, () => inbox.slice(from).find((x) => x.type === type), timeout);
};
let agentId = null;
let daemon = null;
const mine = new Set();

try {
  await waitFor("connexion", () => ws.readyState === WebSocket.OPEN, 5000, 50);
  expect(true, "connexion au dashboard");
  daemon = new DaemonClient({ url: daemonUrl, clientId: `verify-inbox-${Date.now()}`, clientType: "cli" });
  await daemon.connect();
  const api = createPaseoApi(daemon);

  const options = await request({ type: "launch.options", host: "local" }, "launch.options", 30000);
  const provider = options.providers.find((p) => p.id === "claude-openrouter");
  if (!provider) throw Object.assign(new Error("partie B (agent LLM réel claude-openrouter) non exécutée : fournisseur absent de ce poste"), { skip: true });
  const askMode = provider.modes.find((x) => x.label === "Always Ask");
  expect(Boolean(askMode), "mode « Always Ask » disponible", askMode?.id);

  const baseline = (await request({ type: "inbox.list" }, "inbox.list")).items.map((i) => i.id);
  const started = Date.now();
  const from = inbox.length;
  ws.send(JSON.stringify({
    type: "launch.start", host: "local", cwd: SANDBOX, kind: "agent", provider: "claude-openrouter", model: "sonnet",
    mode: askMode.id, title: "verify-inbox-permission", ref: "verify-inbox",
    prompt: `Create a file hello.txt containing hi in ${SANDBOX}`,
  }));
  const launched = await waitFor("launch.started", () => inbox.slice(from).find((x) => x.type === "launch.started"),
    30000);
  agentId = launched.agentId;
  expect(Boolean(agentId), "agent de test lancé en mode Always Ask", agentId);

  // Vérité terrain : instant où le daemon expose la demande (interrogation directe toutes les 100 ms).
  const truth = await waitFor("permission côté daemon", async () => {
    const row = (await api.agents.list({})).entries.map((e) => e.agent || e).find((a) => a.id === agentId);
    return row?.pendingPermissions?.length ? { t: Date.now(), p: row.pendingPermissions[0] } : null;
  }, 240000, 100);
  console.log(`  permission visible côté daemon après ${((truth.t - started) / 1000).toFixed(1)} s : ${truth.p.name}`);
  const item = await waitFor("élément permission dans l'inbox", () => inbox.findLast((x) =>
    x.type === "inbox.changed" && x.items.some((i) => i.agentId === agentId && i.kind === "permission"))?.items
    .find((i) => i.agentId === agentId && i.kind === "permission"), 15000, 20);
  const delayMs = Date.now() - truth.t;
  console.log(`  DÉLAI d'apparition dans la boîte de réception : ${delayMs} ms après le daemon`);
  expect(delayMs < 1000, "élément permission apparu en moins d'une seconde", `${delayMs} ms`);
  mine.add(item.id);
  expect(item.host === "local" && item.status === "nouveau" && item.source === "agent",
    "élément : machine, statut, source");
  expect(item.title.includes("Write") && item.body.includes("hello.txt"), "élément : outil et fichier demandés",
    item.body);
  expect(item.action.requestId === truth.p.id && item.project === "sandbox-repo", "élément : requestId et projet");
  expect(!JSON.stringify(item).includes('"content"'), "aucun contenu de fichier dans l'élément");
  const changed = inbox.findLast((x) => x.type === "inbox.changed");
  expect(changed.unreadCount >= 1 && changed.unreadCount === changed.items.filter((i) => i.status === "nouveau").length,
    "compteur unreadCount cohérent", String(changed.unreadCount));

  // Pas de doublon, marquages
  await delay(2500);
  let list = (await request({ type: "inbox.list" }, "inbox.list")).items;
  expect(list.filter((i) => i.action?.requestId === truth.p.id).length === 1, "un seul élément pour cette demande");
  const marked = await request({ type: "inbox.mark", ids: [item.id], status: "lu" }, "inbox.marked");
  list = (await request({ type: "inbox.list" }, "inbox.list")).items;
  expect(marked.count === 1 && list.find((i) => i.id === item.id).status === "lu", "inbox.mark → lu");
  const bad = await request({ type: "inbox.mark", ids: [item.id], status: "n'importe" }, "error");
  expect(/statut/.test(bad.message), "inbox.mark refuse un statut inconnu", bad.message);
  const filtered = await request({ type: "inbox.list", filter: { kind: "permission", status: "lu" } }, "inbox.list");
  expect(filtered.items.some((i) => i.id === item.id) && filtered.items.every((i) => i.kind === "permission"),
    "inbox.list filtre par type et statut");

  // Approbation par perm.respond (message utilisé par la vue)
  ws.send(JSON.stringify({
    type: "perm.respond", host: "local", agentId, requestId: item.action.requestId, behavior: "allow",
  }));
  const done = await waitFor("élément traité", () => inbox.findLast((x) => x.type === "inbox.changed")?.items
    .find((i) => i.id === item.id && i.status === "traité"), 15000, 50);
  expect(Boolean(done), "après approbation : élément « traité »");
  const fin = await waitFor("élément fin", () => inbox.findLast((x) => x.type === "inbox.changed")?.items
    .find((i) => i.agentId === agentId && i.kind === "fin"), 120000, 250);
  mine.add(fin.id);
  expect(fin.status === "nouveau" && fin.body.length > 0 && fin.action.type === "session",
    "élément « fin » avec résumé", fin.body);
  expect(existsSync(HELLO) && readFileSync(HELLO, "utf8").trim() === "hi",
    "hello.txt créé par l'agent après approbation");
  await delay(2000);
  list = (await request({ type: "inbox.list" }, "inbox.list")).items;
  expect(list.filter((i) => i.agentId === agentId && i.kind === "fin").length === 1, "un seul élément « fin »");
  expect(list.filter((i) => i.agentId === agentId && i.kind === "permission").length === 1,
    "toujours une seule permission");

  // markAll puis clear
  const markAll = await request({ type: "inbox.markAll", status: "lu" }, "inbox.markedAll");
  list = (await request({ type: "inbox.list" }, "inbox.list")).items;
  expect(markAll.count >= 1 && list.every((i) => i.status !== "nouveau"), "inbox.markAll : plus aucun « nouveau »");
  await request({ type: "inbox.mark", ids: [...mine], status: "traité" }, "inbox.marked");
  const keep = await request({ type: "inbox.clear", olderThan: 3_600_000 }, "inbox.cleared");
  list = (await request({ type: "inbox.list" }, "inbox.list")).items;
  expect([...mine].every((id) => list.some((i) => i.id === id)),
    "inbox.clear {olderThan: 1 h} garde les éléments récents",
    `supprimés : ${keep.removed}`);
  const invalid = await request({ type: "inbox.clear", olderThan: "pas une date" }, "inbox.cleared");
  expect(invalid.removed === 0, "inbox.clear refuse une date invalide");
  const cleared = await request({ type: "inbox.clear", olderThan: 1 }, "inbox.cleared");
  list = (await request({ type: "inbox.list" }, "inbox.list")).items;
  expect(cleared.removed >= 2 && ![...mine].some((id) => list.some((i) => i.id === id)),
    "inbox.clear supprime les traités",
    `supprimés : ${cleared.removed}`);
  console.log(`  éléments déjà présents avant le test : ${baseline.length}`);
  console.log("\nVERIFY_INBOX_PASS");
} catch (error) {
  if (error.skip) console.log(`\n[IGNORÉ] ${error.message}\nVERIFY_INBOX_PASS (partie A seule)`);
  else { console.error("\nVERIFY_INBOX_FAIL", error.message);
  process.exitCode = 1; }
} finally {
  rmSync(HELLO, { force: true });
  console.log(`hello.txt supprimé : ${!existsSync(HELLO)}`);
  if (agentId && daemon) {
    try {
      await daemon.cancelAgent(agentId).catch(() => {});
      await daemon.deleteAgent(agentId);
      console.log(`agent de test supprimé : ${agentId.slice(0, 8)}`);
    } catch (e) {
      console.error(`NETTOYAGE À FAIRE : agent ${agentId} (${e.message})`);
      process.exitCode = 1;
    }
  }
  if (mine.size && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "inbox.mark", ids: [...mine], status: "traité" }));
    await delay(300);
    ws.send(JSON.stringify({ type: "inbox.clear", olderThan: 1 }));
    await delay(300);
  }
  await daemon?.close().catch(() => {});
  ws.close();
}
