// Vérifie les mises en page nommées du Bureau (handlers/layouts.mjs) en client WebSocket.
// Usage : node dashboard/scripts/verify-v3.mjs   (le serveur du dashboard doit tourner)
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");
const dataDir = process.env.VERIFY_FIXTURE_DIR ? `${process.env.VERIFY_FIXTURE_DIR}/data/` : fileURLToPath(new URL("../data/", import.meta.url));
const socket = new WebSocket(url, { origin });
const inbox = [];
let opened = false;
socket.on("open", () => { opened = true; });
socket.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));

const fail = (message) => { throw new Error(message); };
// Les enregistrements/suppressions sont aussi diffusés (layout.list) : on vide la boîte avant chaque requête.
const send = (message) => {
  inbox.length = 0;
  socket.send(JSON.stringify(message));
};
async function receive(type, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const index = inbox.findIndex((m) => m.type === type);
    if (index >= 0) return inbox.splice(index, 1)[0];
    await delay(50);
  }
  return fail(`Délai dépassé : ${label}`);
}
const expect = (condition, label, detail = "") => {
  if (!condition) fail(`${label} ${detail}`);
  console.log(`OK ${label}`);
};

const name = `verif-v3-${Date.now().toString(36)}`;
const windows = [
  {
    type: "terminal", host: "local", terminalId: "t-1", cwd: "D:\\x\\sandbox-repo",
    x: 24, y: 40, w: 560, h: 344, minimized: false, z: 2,
  },
  { type: "agent", host: "oracle", agentId: "a-1", x: 616, y: 40, w: 520, h: 432, minimized: true, z: 3 },
];
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  send({ type: "layout.delete", name });
  await delay(300);
};

try {
  for (let i = 0; i < 100 && !opened; i++) await delay(50);
  expect(opened, "connexion au dashboard");

  send({ type: "layout.save", name, windows });
  const saved = await receive("layout.saved", "layout.saved après layout.save");
  expect(saved.name === name && saved.windows.length === 2, "layout.save renvoie le nom et 2 fenêtres");

  await delay(200);
  send({ type: "layout.list" });
  const list = await receive("layout.list", "layout.list");
  const entry = list.layouts.find((l) => l.name === name);
  expect(entry?.count === 2, "layout.list contient la mise en page avec count=2", JSON.stringify(entry));

  send({ type: "layout.load", name });
  const loaded = await receive("layout.loaded", "layout.loaded");
  const [term, agent] = loaded.windows;
  expect(loaded.windows.length === 2, "layout.load renvoie 2 fenêtres");
  expect(term.type === "terminal" && term.host === "local" && term.terminalId === "t-1", "fenêtre terminal intacte");
  const geometry = [term.x, term.y, term.w, term.h, term.z].join(",");
  expect(geometry === "24,40,560,344,2", "géométrie terminal intacte", geometry);
  expect(agent.type === "agent" && agent.agentId === "a-1" && agent.minimized, "fenêtre agent intacte (réduite)");
  console.log("LAYOUT_LOADED", JSON.stringify(loaded.windows));

  send({ type: "layout.save", name: "", windows });
  const emptyName = await receive("error", "refus du nom vide");
  expect(/nom/i.test(emptyName.message), "layout.save avec nom vide refusé", emptyName.message);
  send({ type: "layout.save", name: "   ", windows });
  const blankName = await receive("error", "refus du nom blanc");
  expect(/nom/i.test(blankName.message), "layout.save avec nom d'espaces refusé", blankName.message);
  send({ type: "layout.save", name: "invalide", windows: "pas une liste" });
  const badWindows = await receive("error", "refus d'une liste invalide");
  expect(/fenêtres/i.test(badWindows.message), "layout.save avec fenêtres invalides refusé", badWindows.message);

  send({ type: "layout.delete", name });
  const deleted = await receive("layout.deleted", "layout.deleted");
  expect(deleted.name === name, "layout.delete confirme la suppression");
  cleaned = true;
  await delay(200);
  send({ type: "layout.list" });
  const after = await receive("layout.list", "layout.list après suppression");
  expect(!after.layouts.some((l) => l.name === name), "layout.list ne contient plus la mise en page");
  send({ type: "layout.load", name });
  const missing = await receive("error", "chargement d'une mise en page supprimée");
  expect(/introuvable/i.test(missing.message), "layout.load après suppression refusé", missing.message);

  const leftovers = readdirSync(dataDir).filter((f) => f.endsWith(".tmp"));
  expect(leftovers.length === 0, "écriture atomique : aucun fichier .tmp résiduel", leftovers.join(","));
  console.log("VERIFY_V3_PASS");
} catch (error) {
  console.error("VERIFY_V3_FAIL", error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  socket.close();
}
