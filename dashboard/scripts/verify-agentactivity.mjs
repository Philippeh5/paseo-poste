// dashboard/scripts/verify-agentactivity.mjs
// Vérification de TASK A du ticket T29 : historique d'activité de l'agent (journal des appels mutants de /api/v1).
// Serveur isolé (port 7091, dossier de données temporaire) : ne touche ni au serveur :7070 ni aux données de Philippe.
// - appel mutant -> entrée dans agentactivity.list ET diffusion agentactivity.added ; GET non journalisés
// - refus du mandat (403) journalisé en ok:false ; échec 400 journalisé
// - aucun secret (titre, route, fichier) ; machines nommées « Mini PC » (jamais « local ») dans les résumés
// - plafond de 500 entrées, persistance après redémarrage, écriture atomique (pas de fichier .tmp)
// - navigateur (Playwright headless) : une tâche créée par l'API apparaît sans rechargement dans la liste des tâches
//   et dans « Activité de l'agent » en moins de 3 s ; les entrées refusées sont en rouge.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratchDir = join(rootDir, ".foreman", "scratch", `t29-activity-${process.pid}`);
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7091);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ui`;
const CAP = 500;

let passed = 0;
let failed = 0;
const ok = (label) => { passed++; console.log(`OK   ${label}`); };
const fail = (label, detail = "") => { failed++; console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`); };
const expect = (cond, label, detail = "") => (cond ? ok(label) : fail(label, detail));
const section = (name) => console.log(`\n=== ${name} ===`);

function startServer() {
  const env = { ...process.env, DASHBOARD_PORT: String(PORT), DASHBOARD_DATA_DIR: scratchDir, DASHBOARD_HOST: "127.0.0.1" };
  delete env.DASHBOARD_PASSWORD;
  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const srv = { proc, log: "" };
  proc.stdout.on("data", (d) => { srv.log += d; });
  proc.stderr.on("data", (d) => { srv.log += d; });
  return srv;
}
async function stopServer(srv) {
  if (srv.proc.exitCode !== null) return;
  const gone = new Promise((r) => srv.proc.once("exit", r));
  srv.proc.kill();
  await gone;
}
async function connectWs(srv) {
  for (let i = 0; i < 300 && !srv.log.includes("Paseo dashboard :"); i++) await sleep(100);
  const ws = new WebSocket(WS_URL, { origin: BASE });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const take = async (pred, label, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await sleep(20);
    }
    fail(`Délai dépassé : ${label}`);
    return null;
  };
  const rpc = (msg, pred, label, timeout) => { ws.send(JSON.stringify(msg)); return take(pred, label, timeout); };
  return { ws, inbox, take, rpc };
}
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "X-Agent-Name": "verify-agentactivity", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};
const list = async (client, limit = 500) => (await client.rpc({ type: "agentactivity.list", limit }, (m) => m.type === "agentactivity.list", "agentactivity.list"));

let srv = startServer();
let client = await connectWs(srv);

try {
  section("G1.a : un appel mutant crée une entrée listée ET diffusée ; les GET ne sont pas journalisés");
  const first = await list(client);
  expect(first && Array.isArray(first.entries) && first.entries.length === 0, "journal vide au départ");

  await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", brief: "test T29", forbidden: ["supprimer"] },
    (m) => m.type === "agentmode.state", "agentmode.enable");

  client.inbox.length = 0;
  const secretTitle = "Tâche A password=hunter2hunter2 sk-abcdefghijklmnop0123456789";
  const created = await api("POST", "/tasks", { title: secretTitle });
  expect(created.status === 200 && created.json.ok, "POST /tasks réussit", JSON.stringify(created.json).slice(0, 200));
  const taskId = created.json.data?.task?.id;
  const added = await client.take((m) => m.type === "agentactivity.added", "agentactivity.added après POST /tasks");
  expect(added?.entry?.method === "POST" && added.entry.ok === true && added.entry.status === 200, "diffusion agentactivity.added (POST, ok, 200)");
  expect(/^Tâche créée : /.test(added?.entry?.summary || ""), "résumé français « Tâche créée : … »", added?.entry?.summary);
  expect(added?.entry?.route === "/tasks", "route sans secret ni chaîne de requête", added?.entry?.route);
  expect(added?.entry?.mandateActive === true, "mandateActive = true (Mode Agent actif)");
  for (const key of ["id", "at", "method", "route", "ok", "status", "summary", "mandateActive"]) {
    expect(key in (added?.entry || {}), `entrée : champ ${key} présent`);
  }

  const afterCreate = await list(client);
  expect(afterCreate?.entries?.[0]?.id === added?.entry?.id, "agentactivity.list : la plus récente en premier");
  expect(afterCreate?.entries?.length === 1, "une seule entrée après un appel mutant", String(afterCreate?.entries?.length));

  client.inbox.length = 0;
  for (const path of ["/summary", "/tasks", "/mandate", "/inbox", "/projects", "/sessions"]) {
    const r = await api("GET", path);
    expect(r.json.ok === true, `GET ${path} répond`, JSON.stringify(r.json).slice(0, 120));
  }
  await sleep(300);
  expect(!client.inbox.some((m) => m.type === "agentactivity.added"), "aucune diffusion pour les GET");
  const afterGets = await list(client);
  expect(afterGets?.entries?.length === 1, "les GET ne sont pas journalisés", String(afterGets?.entries?.length));

  section("G1.b : refus du mandat (403) et échecs journalisés");
  client.inbox.length = 0;
  const refused = await api("DELETE", `/tasks/${taskId}?confirm=true`);
  expect(refused.status === 403 && /interdit par le mandat/.test(refused.json.error?.message || ""), "DELETE refusé 403 par le mandat (pas de régression)");
  const refusedAdded = await client.take((m) => m.type === "agentactivity.added", "agentactivity.added après refus");
  expect(refusedAdded?.entry?.ok === false && refusedAdded.entry.status === 403, "refus journalisé ok:false, status 403");
  expect(refusedAdded?.entry?.summary === "Refusé par le mandat : supprimer", "résumé « Refusé par le mandat : supprimer »", refusedAdded?.entry?.summary);
  expect(refusedAdded?.entry?.route === `/tasks/${taskId}`, "route du refus sans ?confirm", refusedAdded?.entry?.route);
  expect(refusedAdded?.entry?.mandateActive === true, "refus : mandateActive = true");

  client.inbox.length = 0;
  const invalid = await api("POST", "/tasks", {});
  expect(invalid.status >= 400 && invalid.json.ok === false, "POST /tasks sans titre est refusé");
  const invalidAdded = await client.take((m) => m.type === "agentactivity.added", "agentactivity.added après échec");
  expect(invalidAdded?.entry?.ok === false && /impossible/.test(invalidAdded.entry.summary), "échec journalisé ok:false", invalidAdded?.entry?.summary);

  const unknown = await api("POST", "/sessions/local/abc12345/close");
  expect(unknown.status === 403, "fermeture de session aussi refusée par le mandat (supprimer)");

  await client.rpc({ type: "agentmode.disable" }, (m) => m.type === "agentmode.state", "agentmode.disable");
  client.inbox.length = 0;
  const closeUnknown = await api("POST", "/sessions/local/abc12345/close");
  expect(closeUnknown.json.ok === false, "fermeture d'une session inconnue échoue");
  const closeAdded = await client.take((m) => m.type === "agentactivity.added", "agentactivity.added après fermeture");
  expect(closeAdded?.entry?.mandateActive === false, "mandateActive = false une fois le Mode Agent désactivé");
  expect(/Mini PC/.test(closeAdded?.entry?.summary || "") && !/\blocal\b/i.test(closeAdded?.entry?.summary || ""),
    "machine nommée « Mini PC » (jamais « local ») dans le résumé", closeAdded?.entry?.summary);

  section("G1.c : aucun secret dans les entrées ni dans le fichier");
  const all = await list(client);
  const blob = JSON.stringify(all.entries);
  const file = readFileSync(join(scratchDir, "agent-activity.json"), "utf8");
  for (const secret of ["hunter2hunter2", "sk-abcdefghijklmnop0123456789"]) {
    expect(!blob.includes(secret) && !file.includes(secret), `secret « ${secret.slice(0, 8)}… » absent des entrées et du fichier`);
  }
  expect(all.entries.every((e) => !/\?/.test(e.route)), "aucune chaîne de requête dans les routes");
  expect(all.entries.every((e) => e.summary.length <= 200 && e.route.length <= 160), "textes plafonnés");
  expect(created.json.ok && all.entries.some((e) => /^Tâche créée : Tâche A/.test(e.summary)), "le titre de tâche reste lisible (hors secrets)");

  section("G1.d : plafond de 500 entrées");
  const firstId = all.entries.at(-1).id;
  const batch = 520;
  for (let i = 0; i < batch; i += 20) {
    await Promise.all(Array.from({ length: 20 }, () => api("POST", "/inbox/mark", { ids: ["nexistepas"] })));
  }
  const capped = await list(client);
  expect(capped.entries.length === CAP, `liste plafonnée à ${CAP}`, String(capped.entries.length));
  expect(capped.total === CAP, "total = 500", String(capped.total));
  expect(!capped.entries.some((e) => e.id === firstId), "les plus anciennes sont écartées");
  const onDisk = JSON.parse(readFileSync(join(scratchDir, "agent-activity.json"), "utf8"));
  expect(Array.isArray(onDisk) && onDisk.length === CAP, "fichier data/agent-activity.json plafonné à 500", String(onDisk.length));
  expect(readdirSync(scratchDir).every((f) => !f.endsWith(".tmp")), "aucun fichier temporaire (écriture atomique)");
  const small = await list(client, 5);
  expect(small.entries.length === 5, "agentactivity.list respecte limit", String(small.entries.length));
  const lastId = capped.entries[0].id;

  section("G1.e : persistance après redémarrage");
  client.ws.close();
  await stopServer(srv);
  srv = startServer();
  client = await connectWs(srv);
  const restored = await list(client);
  expect(restored.entries.length === CAP && restored.entries[0].id === lastId, "journal relu intact au redémarrage");

  section("G1.f : navigateur (Playwright headless) — hot refresh sans rechargement");
  let browser = null;
  try {
    let playwright = null;
    for (const p of ["playwright-core", "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs"]) {
      try { const mod = await import(p); playwright = mod.default || mod; break; } catch { /* suivant */ }
    }
    if (!playwright) throw new Error("playwright-core introuvable");
    await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", brief: "test navigateur", forbidden: ["supprimer"] },
      (m) => m.type === "agentmode.state", "agentmode.enable (navigateur)");
    browser = await playwright.chromium.launch({ headless: true });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    let navigations = 0;
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) navigations++; });
    await page.goto(`${BASE}/#taches`, { waitUntil: "domcontentloaded" });
    const panel = page.locator("#agentactivity-panel");
    await panel.waitFor({ state: "visible", timeout: 8000 });
    expect((await panel.innerText()).includes("Activité de l'agent"), "panneau « Activité de l'agent » visible quand le Mode Agent est actif");
    const navBefore = navigations;
    const title = `Tâche vivante ${Date.now()}`;
    const t0 = Date.now();
    const made = await api("POST", "/tasks", { title });
    expect(made.json.ok === true, "tâche créée par l'API pendant que la page est ouverte");
    await page.locator("main", { hasText: title }).first().waitFor({ state: "visible", timeout: 3000 });
    const tTask = Date.now() - t0;
    expect(tTask < 3000, "la tâche apparaît dans la liste des tâches sans rechargement", `${tTask} ms`);
    await panel.locator(".agentactivity-item", { hasText: `Tâche créée : ${title}` }).first().waitFor({ state: "visible", timeout: 3000 });
    const tAct = Date.now() - t0;
    expect(tAct < 3000, "la tâche apparaît dans « Activité de l'agent » en moins de 3 s", `${tAct} ms`);
    expect(navigations === navBefore, "aucun rechargement de la page", `${navigations - navBefore} navigation(s)`);
    const topText = await panel.locator(".agentactivity-item").first().innerText();
    expect(topText.includes(title), "la plus récente est en haut de la liste", topText);
    expect(/à l'instant|il y a \d+ s/.test(topText), "horodatage relatif en français", topText);

    await api("DELETE", `/tasks/${made.json.data.task.id}?confirm=true`);
    const refusedItem = panel.locator(".agentactivity-item.is-refused", { hasText: "Refusé par le mandat" }).first();
    await refusedItem.waitFor({ state: "visible", timeout: 3000 });
    const color = await refusedItem.evaluate((n) => getComputedStyle(n).color);
    expect(/^rgb\(2[0-9]{2}, \d+, \d+\)$/.test(color) || color !== "rgb(230, 235, 242)", "entrée refusée affichée en rouge", color);
    const injected = await page.evaluate(() => document.querySelector("#agentactivity-panel").innerHTML.includes("<script"));
    expect(!injected, "aucun HTML injecté dans le panneau");
    await browser.close();
    browser = null;
  } catch (e) {
    fail("vérification navigateur", e.stack || e.message);
  } finally {
    if (browser) await browser.close();
  }
} catch (e) {
  fail("exception inattendue", e.stack || e.message);
} finally {
  try { client.ws.close(); } catch { /* ignoré */ }
  await stopServer(srv);
  await sleep(300);
  try { rmSync(scratchDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* ignoré */ }
}

console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
if (failed > 0) process.exit(1);
console.log("VERIFY_AGENTACTIVITY_PASS");
