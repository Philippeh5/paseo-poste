// Vérifie handlers/timeline.mjs.
// Usage : node dashboard/scripts/verify-timeline.mjs   (le serveur du dashboard doit tourner sur :7070)
// Partie A (module isolé, dossier temporaire, jamais data/timeline.json) : épisodes, marqueurs, relecture du
// fichier après « redémarrage », fermeture des orphelins, plafond de 2000, machine injoignable, timeline.list.
// Partie B (serveur réel) : un vrai agent claude-openrouter/sonnet, puis timeline.list et data/timeline.json.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");
const daemonUrl = process.env.PASEO_LOCAL_URL || "ws://127.0.0.1:6767/ws";
const here = fileURLToPath(new URL(".", import.meta.url));
const dataDir = process.env.DASHBOARD_DATA_DIR || join(here, "..", "data");
const SANDBOX = process.env.VERIFY_SANDBOX || "D:/Projets/AI-OS/paseo-lab/sandbox-repo";

const fail = (message) => { throw new Error(message); };
const expect = (condition, label, detail = "") => {
  if (!condition) fail(`${label} ${detail}`);
  console.log(`OK ${label}`);
};

// ---------- Partie A : module isolé ----------
const { register } = await import(pathToFileURL(join(here, "..", "handlers", "timeline.mjs")).href);
const { createStore } = await import(pathToFileURL(join(here, "..", "lib", "store.mjs")).href);

function boot(dir) {
  const sent = [];
  const broadcasts = [];
  const handlers = {};
  let hook = null;
  const ctx = {
    onMessage: (type, fn) => { handlers[type] = fn; },
    send: (_ws, message) => sent.push(message),
    broadcast: (message) => broadcasts.push(message),
    store: createStore(dir), log() {}, safeError: String, onStateChange: (fn) => { hook = fn; },
  };
  register(ctx);
  return { sent, broadcasts, hook: (state) => hook(state), list: (m = {}) => { handlers["timeline.list"]({},
    m); return sent.at(-1).episodes; } };
}
const agent = (over = {}) => ({
  host: "local", agentId: "a1", title: "Test", provider: "claude-openrouter", model: "sonnet",
  cwd: "D:\\Projets\\AI-OS\\paseo-lab\\sandbox-repo", status: "running", ...over,
});
const state = (agents, hostStatus = "connected") => ({ hosts: [{ label: "local", status: hostStatus }], agents });
const readEpisodes = (dir) => JSON.parse(readFileSync(join(dir, "timeline.json"), "utf8")).episodes;

const tmp = mkdtempSync(join(tmpdir(), "timeline-verify-"));
try {
  // Cycle complet : actif → permission → reprise → inactif
  const dirA = join(tmp, "a");
  let t = boot(dirA);
  t.hook(state([agent()]));
  let eps = t.list();
  expect(eps.length === 1 && eps[0].end === null && eps[0].status === "running",
    "épisode ouvert quand l'agent travaille");
  expect(eps[0].project === "sandbox-repo" && eps[0].provider === "claude-openrouter",
    "projet et fournisseur renseignés");
  expect(t.broadcasts.some((m) => m.type === "timeline.changed"), "diffusion timeline.changed");
  t.hook(state([agent({ status: "waiting-permission" })]));
  t.hook(state([agent({ status: "running" })]));
  t.hook(state([agent({ status: "idle" })]));
  eps = t.list();
  expect(eps.length === 1 && eps[0].end && eps[0].status === "closed", "épisode fermé quand l'agent redevient inactif");
  expect(eps[0].markers.map((m) => m.type).join() === "permission,reprise,fin", "marqueurs permission, reprise, fin",
    eps[0].markers.map((m) => m.type).join());
  t.hook(state([agent({ status: "idle" })]));
  expect(t.list().length === 1, "pas de doublon quand l'agent reste inactif");

  // Erreur
  t.hook(state([agent({ agentId: "a2", status: "running" })]));
  t.hook(state([agent({ agentId: "a2", status: "error" })]));
  const failed = t.list().find((e) => e.agentId === "a2");
  expect(failed.status === "error" && failed.markers.at(-1).type === "erreur", "fin en erreur : statut et marqueur");

  // Redémarrage simulé : relecture du fichier
  const reboot = boot(dirA);
  expect(reboot.list().length === 2 && reboot.list()[0].end, "relecture du fichier conserve les épisodes");

  // Épisode ouvert au moment de l'arrêt : fermé « interrompu » au redémarrage, fin = dernier instant connu
  t.hook(state([agent({ agentId: "a3", status: "running" })]));
  const persisted = readEpisodes(dirA).find((e) => e.agentId === "a3");
  expect(persisted.end === null && persisted.lastSeen, "épisode ouvert persisté avec lastSeen");
  await delay(30);
  const after = boot(dirA);
  const orphan = after.list().find((e) => e.agentId === "a3");
  expect(orphan.status === "interrupted" && orphan.end === persisted.lastSeen,
    "orphelin fermé à lastSeen, pas à « maintenant »");
  expect(orphan.markers.at(-1).label.includes("Interrompu"), "marqueur « interrompu »");

  // Machine injoignable : l'épisode reste ouvert ; agent supprimé machine jointe : fermé
  const dirB = join(tmp, "b");
  t = boot(dirB);
  t.hook(state([agent()]));
  t.hook(state([], "error"));
  expect(t.list()[0].end === null, "machine injoignable : épisode laissé ouvert");
  t.hook(state([]));
  expect(t.list()[0].status === "interrupted" && t.list()[0].markers.at(-1).label === "Agent disparu",
    "agent disparu machine connectée : épisode interrompu");

  // timeline.list since/until
  const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
  expect(t.list({ since: new Date(Date.now() + 60_000).toISOString() }).length === 0,
    "timeline.list since futur → vide");
  expect(t.list({ since: old }).length === 1 && t.list({ until: old }).length === 0, "timeline.list since / until");

  // Plafond de 2000 épisodes (fermés supprimés en premier, les plus anciens d'abord)
  const dirC = join(tmp, "c");
  const big = Array.from({ length: 2100 }, (_, i) => ({
    id: `ep-${i}`, host: "local", agentId: `x${i}`, title: null, provider: "test", model: null, project: "p",
    start: new Date(Date.now() - (2100 - i) * 60000).toISOString(),
    end: new Date(Date.now() - (2100 - i) * 60000 + 30000).toISOString(), status: "closed", markers: [],
  }));
  createStore(dirC).write("timeline", { episodes: big });
  boot(dirC);
  const capped = readEpisodes(dirC);
  expect(capped.length === 2000 && capped[0].id === "ep-100",
    "plafond de 2000 appliqué au démarrage (100 plus anciens supprimés)",
    `${capped.length} ${capped[0]?.id}`);
  const capped2 = boot(dirC);
  capped2.hook(state([agent({ agentId: "n1" })]));
  const after2 = readEpisodes(dirC);
  expect(after2.length === 2000 && after2.at(-1).agentId === "n1" && after2[0].id === "ep-101",
    "plafond respecté à chaque écriture, épisode ouvert conservé");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---------- Partie B : serveur réel ----------
const ws = new WebSocket(url, { origin });
const inbox = [];
ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
ws.on("error", (e) => console.error("[ws]", e.message));
let created = null;
let daemon = null;

async function waitFor(label, fn, timeout = 60000, step = 500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(step);
  }
  return fail(`Délai dépassé : ${label}`);
}
const lastState = () => inbox.findLast((m) => m.type === "state")?.payload;
const request = async (message, type) => {
  const from = inbox.length;
  ws.send(JSON.stringify(message));
  return waitFor(type, () => inbox.slice(from).find((m) => m.type === type), 10000, 100);
};

try {
  await waitFor("connexion", () => ws.readyState === WebSocket.OPEN, 5000, 50);
  expect(true, "connexion au dashboard");
  const before = (await request({ type: "timeline.list" }, "timeline.list")).episodes.length;

  const options = await request({ type: "launch.options", host: "local" }, "launch.options");
  if (!options.providers?.some((p) => p.id === "claude-openrouter")) throw Object.assign(new Error("partie réelle (agent LLM claude-openrouter) non exécutée : fournisseur absent de ce poste"), { skip: true });
  const from = inbox.length;
  ws.send(JSON.stringify({
    type: "launch.start", host: "local", cwd: SANDBOX, kind: "agent", provider: "claude-openrouter", model: "sonnet",
    prompt: "Reply with the single word PONG and do nothing else.", title: "verify-timeline-pong",
      ref: "verify-timeline",
  }));
  const started = await waitFor("launch.started", () => inbox.slice(from).find((m) => m.type === "launch.started"),
    30000);
  created = started.agentId;
  expect(Boolean(created), "agent claude-openrouter/sonnet lancé", created);

  // L'épisode doit s'ouvrir pendant le travail puis se fermer quand l'agent redevient inactif.
  let sawOpen = false;
  const done = await waitFor("fin de l'agent", async () => {
    const list = (await request({ type: "timeline.list" }, "timeline.list")).episodes;
    const ep = list.find((e) => e.agentId === created);
    if (ep && !ep.end) sawOpen = true;
    return ep?.end ? ep : null;
  }, 180000, 1500);
  console.log("  épisode :", JSON.stringify({ ...done, markers: done.markers.map((m) => m.type) }));
  expect(Boolean(done.start) && Boolean(done.end) && Date.parse(done.end) > Date.parse(done.start),
    "début et fin cohérents");
  expect(done.status === "closed", "statut final « closed »", done.status);
  expect(done.provider === "claude-openrouter" && done.model === "sonnet", "fournisseur et modèle corrects");
  expect(done.project === "sandbox-repo", "projet = nom du dossier", done.project);
  expect(done.host === "local" && done.title === "verify-timeline-pong", "machine et titre corrects");
  expect(done.markers.some((m) => m.type === "fin"), "marqueur de fin présent");
  console.log(`  épisode observé ouvert pendant le travail : ${sawOpen}`);
  const total = (await request({ type: "timeline.list" }, "timeline.list")).episodes;
  expect(total.length === before + 1, "un seul nouvel épisode (pas de doublon)", `${before} → ${total.length}`);

  // Persistance : relecture du vrai fichier de données
  const onDisk = JSON.parse(readFileSync(join(dataDir, "timeline.json"),
    "utf8")).episodes.find((e) => e.id === done.id);
  expect(onDisk?.end === done.end && onDisk.status === "closed", "épisode relu dans data/timeline.json");

  console.log("\nVERIFY_TIMELINE_PASS");
} catch (error) {
  if (error.skip) console.log(`\n[IGNORÉ] ${error.message}\nVERIFY_TIMELINE_PASS (partie sans agent réel)`);
  else { console.error("\nVERIFY_TIMELINE_FAIL", error.message);
  process.exitCode = 1; }
} finally {
  if (created) {
    try {
      daemon = new DaemonClient({ url: daemonUrl, clientId: `verify-timeline-${Date.now()}`, clientType: "cli" });
      await daemon.connect();
      await daemon.cancelAgent(created).catch(() => {});
      await daemon.deleteAgent(created);
      console.log(`agent de test supprimé : ${created.slice(0, 8)}`);
    } catch (e) {
      console.error(`NETTOYAGE À FAIRE : agent ${created} (${e.message})`);
      process.exitCode = 1;
    }
    await daemon?.close().catch(() => {});
  }
  ws.close();
}
