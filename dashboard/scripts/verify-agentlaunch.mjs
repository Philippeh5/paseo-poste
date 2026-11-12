// dashboard/scripts/verify-agentlaunch.mjs
// Vérification du ticket T31 : le Mode Agent démarre vraiment l'agent + vue « Agent » en direct.
// Serveur isolé (port 7095 ou VERIFY_PORT, dossier de données temporaire) : ne touche ni au :7070 ni à dashboard/data.
// - G1 : consigne d'orchestrateur (chemin réel de postectl), refus clairs, activation avec lancement = UNE tâche
//        « Jarvis — <projet> » démarrée (origine « agent »), origine « agent » des tâches créées par l'API
//        sous mandat (et pas d'usurpation par WebSocket), un seul mandat actif, « Reprendre la main » arrête
//        l'orchestrateur sans toucher aux tâches filles (sauf stopTasks).
//        Appels réels au moteur : l'orchestrateur (arrêté aussitôt) et une tâche fille « PONG » (arrêtée aussitôt).
// - G2/G3 : vue Agent dans un vrai navigateur (Playwright, fenêtré sauf VERIFY_HEADLESS=1) puis mobile 390 px.
// Captures : .foreman/scratch/t31-*.png

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildBrief, freshState } from "../handlers/agentmode.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const shotsDir = join(rootDir, ".foreman", "scratch");
const scratchDir = join(shotsDir, `t31-launch-${process.pid}`);
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });

const PORT = Number(process.env.VERIFY_PORT || 7095);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ui`;
const SANDBOX = join(rootDir, "sandbox-repo");
const POSTECTL = join(rootDir, "tools", "postectl.mjs");
const ENGINE = "claude-openrouter/sonnet";
const PONG = "Reply with the single word PONG and do nothing else.";
const HEADLESS = process.env.VERIFY_HEADLESS === "1";

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
async function connectWs(srv) {
  for (let i = 0; i < 300 && !srv.log.includes("Paseo dashboard :"); i++) await sleep(100);
  const ws = new WebSocket(WS_URL, { origin: BASE });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const take = async (pred, label, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await sleep(25);
    }
    fail(`Délai dépassé : ${label}`);
    return null;
  };
  const rpc = (msg, pred, label, timeout) => { inbox.length = 0; ws.send(JSON.stringify(msg)); return take(pred, label, timeout); };
  return { ws, inbox, take, rpc, send: (m) => ws.send(JSON.stringify(m)) };
}
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { "X-Agent-Name": "verify-agentlaunch", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};
async function until(fn, label, timeout = 15000, step = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(step);
  }
  fail(`Délai dépassé : ${label}`);
  return null;
}
const postectl = (...args) => spawnSync(process.execPath, [POSTECTL, "--url", BASE, ...args], { encoding: "utf8" });

const srv = startServer();
const client = await connectWs(srv);
const hosts = JSON.parse(readFileSync((process.env.DASHBOARD_HOSTS_FILE || join(dashboardDir, "hosts.json")), "utf8")).hosts;
const localHost = hosts.find((h) => h.label === "local");
const daemon = new DaemonClient({ url: localHost.url, clientId: `verify-agentlaunch-${Date.now()}`, clientType: "cli", password: localHost.password || undefined });
await daemon.connect();
const agentsToDelete = new Set();
const terminalsToKill = new Set();
let browser = null;

const tasksNow = async () => (await api("GET", "/tasks")).json.data.tasks;
const stateOf = async () => {
  await sleep(150);
  client.inbox.length = 0;
  client.send({ type: "agentmode.get" });
  return client.take((m) => m.type === "agentmode.state", "agentmode.get");
};

try {
  // ---------------------------------------------------------------- unitaire : consigne d'orchestrateur
  section("Consigne d'orchestrateur (fonction pure)");
  const brief = buildBrief({ project: "MonProjet", dir: "D:\\Projets\\MonProjet", brief: "Range les notes.", forbidden: ["supprimer", "pousser sur GitHub"], engine: ENGINE });
  expect(brief.includes("tools/postectl.mjs") && !/\\/.test(brief), "consigne : chemin de postectl réel avec des / (aucun antislash)");
  const pathInBrief = brief.match(/node (\S+postectl\.mjs)/)?.[1];
  expect(Boolean(pathInBrief) && existsSync(pathInBrief), "consigne : le chemin de postectl existe sur le disque", pathInBrief);
  expect(brief.includes("D:/Projets/MonProjet") && brief.includes("mandate") && brief.includes("task add") && brief.includes("task start") && brief.includes("task move"), "consigne : dossier réel, lecture du mandat, création/démarrage/clôture des tâches");
  expect(brief.includes("--engine claude-openrouter/sonnet") && brief.includes("supprimer, pousser sur GitHub") && brief.includes("Range les notes."), "consigne : moteur, interdictions du mandat et consigne de Philippe");
  expect(freshState({ enabled: false, runId: "x", launch: { status: "started" } }).runId === null, "freshState : champs de lancement vidés quand le mode est inactif");

  // ---------------------------------------------------------------- G1 : lancement
  section("G1 : activation avec lancement, origine « agent », reprise de la main");
  const s0 = await stateOf();
  expect(s0?.enabled === false, "mode inactif au départ");

  const followed = await client.rpc({ type: "project.follow", host: "local", dir: SANDBOX }, (m) => m.type === "project.followed", "project.follow sandbox-repo");
  expect(followed?.ok === true, "dossier sandbox-repo suivi dans l'instance de test");

  const e1 = await client.rpc({ type: "agentmode.enable", project: "Inconnu-xyz", brief: "x", launch: true }, (m) => m.type === "error", "projet non suivi");
  expect(/projets suivis/i.test(e1?.message || ""), "projet non suivi : refus clair", e1?.message);
  const e2 = await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", launch: true, engine: "sansbarre" }, (m) => m.type === "error", "moteur invalide");
  expect(/fournisseur\/modèle/i.test(e2?.message || ""), "moteur invalide refusé", e2?.message);
  const e3 = await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", launch: "oui" }, (m) => m.type === "error", "launch non booléen");
  expect(/oui ou non/i.test(e3?.message || ""), "launch non booléen refusé", e3?.message);
  const e4 = await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", launch: true, engine: `a/${"b".repeat(250)}` }, (m) => m.type === "error", "moteur trop long");
  expect(/moteur/i.test(e4?.message || ""), "moteur trop long refusé (plafond)", e4?.message);
  expect((await stateOf())?.enabled === false && (await tasksNow()).length === 0, "aucun mandat ni tâche créés par les refus");

  const t0 = Date.now();
  client.inbox.length = 0;
  client.send({ type: "agentmode.enable", project: "sandbox-repo", brief: `Test technique T31. ${PONG} Ne crée AUCUNE tâche.`, forbidden: ["supprimer", "pousser sur GitHub", "éteindre une machine"], launch: true, engine: ENGINE, ref: "t31" });
  const starting = await client.take((m) => m.type === "agentmode.state" && m.ref === "t31", "état après activation");
  expect(starting?.enabled === true && typeof starting.runId === "string" && starting.engine === ENGINE, "activation : mandat actif avec runId et moteur", JSON.stringify(starting && { e: starting.enabled, r: starting.runId, g: starting.engine }));
  const started = await client.take((m) => m.type === "agentmode.state" && m.launch?.status === "started", "orchestrateur démarré", 60000);
  console.log(`  lancement en ${Date.now() - t0} ms`);
  expect(started?.launch?.status === "started" && Boolean(started.orchestratorTaskId), "état « started » avec l'identifiant de la tâche orchestrateur");
  const runId = started?.runId;
  const orchId = started?.orchestratorTaskId;

  const all1 = await tasksNow();
  const orch = all1.find((t) => t.id === orchId);
  expect(all1.length === 1, "UNE seule tâche créée par l'activation", String(all1.length));
  expect(orch?.title === "Jarvis — sandbox-repo", "titre « Jarvis — sandbox-repo »", orch?.title);
  expect(orch?.status === "doing" && Boolean(orch.agentId), "tâche orchestrateur démarrée (doing) avec une session", `${orch?.status}`);
  if (orch?.agentId) agentsToDelete.add(orch.agentId);
  expect(orch?.origin === "agent" && orch?.agentRun === runId, "orchestrateur : origine « agent » et agentRun = mandat");
  expect(orch?.engine === ENGINE && orch?.project.toLowerCase().replace(/\\/g, "/").endsWith("/sandbox-repo"), "orchestrateur : moteur et dossier du projet suivi", `${orch?.engine} ${orch?.project}`);
  expect(orch?.description.includes(pathInBrief) && orch.description.includes(`--url ${BASE}`) && orch.description.includes("sandbox-repo"), "description : chemin réel de postectl, adresse de ce poste et dossier");
  const sessions = (await api("GET", "/sessions")).json.data.sessions;
  await until(async () => (await api("GET", "/sessions")).json.data.sessions.some((s) => s.id === orch?.agentId), "session visible dans l'API", 15000);
  const sess = (await api("GET", "/sessions")).json.data.sessions.find((s) => s.id === orch?.agentId);
  expect(sess?.origin === "agent" && sess?.taskId === orchId, "API : la session de l'orchestrateur porte origin « agent »", JSON.stringify(sess && { o: sess.origin, t: sess.taskId }));
  void sessions;

  const dup = await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", launch: true }, (m) => m.type === "error", "deuxième mandat");
  expect(/déjà actif/i.test(dup?.message || ""), "un seul mandat actif à la fois", dup?.message);
  expect((await tasksNow()).length === 1, "le refus n'a pas créé de seconde tâche orchestrateur");

  // Origine des tâches créées par l'API sous mandat
  const child = (await api("POST", "/tasks", { title: "T31 fille todo", project: SANDBOX, engine: ENGINE, description: PONG })).json.data.task;
  expect(child?.origin === "agent" && child?.agentRun === runId, "tâche créée par l'API sous mandat : origin « agent » + agentRun", JSON.stringify({ o: child?.origin, r: child?.agentRun }));
  const viaCli = postectl("--json", "task", "add", "T31 fille cli", "--project", SANDBOX);
  const cliTask = (await tasksNow()).find((t) => t.title === "T31 fille cli");
  expect(viaCli.status === 0 && cliTask?.origin === "agent" && cliTask.agentRun === runId, "tâche créée par postectl sous mandat : origine « agent »", viaCli.stderr);
  client.send({ type: "task.create", title: "T31 usurpation", origin: "agent", agentRun: runId });
  const spoof = await until(async () => (await tasksNow()).find((t) => t.title === "T31 usurpation"), "tâche créée par le navigateur");
  expect(spoof?.origin === "" || spoof?.origin == null, "une tâche créée depuis l'interface ne peut pas se déclarer « agent »", String(spoof?.origin));

  // Reprise de la main : l'orchestrateur est arrêté, les tâches filles ne sont ni supprimées ni arrêtées
  const off = await client.rpc({ type: "agentmode.disable", ref: "off" }, (m) => m.type === "agentmode.state" && m.ref === "off", "reprise de la main");
  expect(off?.enabled === false && off.orchestratorTaskId === null && off.runId === null, "disable : mandat inactif, lancement effacé");
  const stopped = await until(async () => (await tasksNow()).find((t) => t.id === orchId && t.status === "blocked"), "orchestrateur arrêté (blocked)", 30000);
  expect(stopped?.reason === "Arrêtée manuellement", "disable : la tâche orchestrateur est arrêtée (task.stop)", stopped?.reason);
  const live = await daemon.fetchAgents({});
  const agentRow = (live.entries || []).map((e) => e.agent || e).find((a) => a.id === orch?.agentId);
  expect(!agentRow || !["running", "initializing"].includes(agentRow.status), "la session de l'orchestrateur n'est plus active sur le daemon", agentRow?.status);
  const after = await tasksNow();
  expect(after.filter((t) => ["T31 fille todo", "T31 fille cli"].includes(t.title)).length === 2 && after.every((t) => t.id === orchId || t.status === "todo"), "disable : les tâches filles sont intactes (ni supprimées ni arrêtées)");
  const afterApi = (await api("POST", "/tasks", { title: "T31 hors mandat" })).json.data.task;
  expect(afterApi?.origin === "" || afterApi?.origin == null, "hors mandat, l'API ne marque plus l'origine", String(afterApi?.origin));

  // Nouvelle exécution : mandat sans lancement, tâche fille réellement démarrée puis stopTasks
  const run2 = await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", brief: "Mandat sans lancement", launch: false, ref: "r2" }, (m) => m.type === "agentmode.state" && m.ref === "r2", "second mandat sans lancement");
  expect(run2?.enabled === true && run2.runId && run2.runId !== runId && run2.launch === null && run2.orchestratorTaskId === null, "réactiver = nouvelle exécution (autre runId, rien lancé)");
  expect((await tasksNow()).length === after.length + 1, "mandat sans lancement : aucune tâche orchestrateur");
  const kid = (await api("POST", "/tasks", { title: "T31 fille pong", project: SANDBOX, engine: ENGINE, description: PONG })).json.data.task;
  const kidStart = await api("POST", `/tasks/${kid.id}/start`);
  expect(kidStart.status === 200 && kidStart.json.data.task.status === "doing", "tâche fille réelle (PONG) démarrée sous le second mandat", JSON.stringify(kidStart.json).slice(0, 200));
  if (kidStart.json.data?.task?.agentId) agentsToDelete.add(kidStart.json.data.task.agentId);
  client.send({ type: "agentmode.disable", stopTasks: true });
  const kidStopped = await until(async () => (await tasksNow()).find((t) => t.id === kid.id && t.status !== "doing"), "tâche fille arrêtée par stopTasks", 30000);
  expect(kidStopped?.status === "blocked" && kidStopped.reason === "Arrêtée manuellement", "disable {stopTasks:true} : la tâche fille de l'agent est arrêtée aussi", `${kidStopped?.status} ${kidStopped?.reason}`);
  expect((await tasksNow()).some((t) => t.id === kid.id), "…mais jamais supprimée");

  // Aucun secret dans les journaux
  const leaked = /sk-[A-Za-z0-9_-]{8,}|password\s*[:=]/i.test(srv.log);
  expect(!leaked, "journal du serveur : aucun secret");
  expect(!srv.log.includes("Ne crée AUCUNE tâche"), "journal du serveur : le texte de la consigne n'est pas journalisé");

  // ---------------------------------------------------------------- G2 / G3 : navigateur
  section("G2/G3 : vue Agent en navigateur");
  async function getPlaywright() {
    for (const p of ["playwright-core", "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs"]) {
      try { const mod = await import(p); return mod.default || mod; } catch { /* suivant */ }
    }
    throw new Error("playwright-core introuvable");
  }
  const playwright = await getPlaywright();
  browser = await playwright.chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.goto(`${BASE}/#agent`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#agv-entrust", { timeout: 10000 });
  expect(/Jarvis n.a pas de mission en cours/.test(await page.locator(".agv-head").innerText()), "sans mandat : message clair");
  expect(await page.locator("#tab-agent").count() === 1, "onglet « Agent » présent dans la barre des vues");
  await page.screenshot({ path: join(shotsDir, "t31-agent-empty.png") });
  await page.click("#agv-entrust");
  await page.waitForSelector("#agentmode-dialog", { timeout: 4000 });
  expect(await page.locator("#agentmode-launch").isChecked(), "dialogue : « Lancer l'agent maintenant » cochée par défaut");
  expect((await page.inputValue("#agentmode-engine")) === ENGINE, "dialogue : moteur par défaut claude-openrouter/sonnet");
  expect((await page.locator("#agentmode-engines option").count()) >= 1, "dialogue : liste des moteurs proposés");
  await page.screenshot({ path: join(shotsDir, "t31-dialog.png") });
  await page.click("#agentmode-dialog .dialog-foot .btn:not(.btn-primary)"); // Annuler
  expect((await stateOf())?.enabled === false, "annuler n'active rien");

  // Mandat posé par l'API pendant que la page est ouverte (sans lancement : aucun jeton dépensé)
  const run3 = await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", brief: "Ranger les notes du projet de test.", forbidden: ["supprimer"], launch: false, ref: "r3" }, (m) => m.type === "agentmode.state" && m.ref === "r3", "mandat pour la vue");
  await page.waitForFunction(() => /Mode Agent actif/.test(document.querySelector("#agv-mode-state")?.textContent || ""), null, { timeout: 4000 });
  ok("la page passe en « Mode Agent actif » sans recharger");
  const headText = await page.locator(".agv-head").innerText();
  expect(headText.includes("sandbox-repo") && headText.includes("Ranger les notes") && headText.includes("supprimer"), "en-tête : projet, consigne et interdictions");
  expect(/pas lancé automatiquement/i.test(await page.locator("#agv-orch").innerText()), "en-tête : « pas lancé automatiquement » quand rien n'est lancé");

  const beforeCards = await page.locator("#agv-tasks .agv-task").count();
  const tAdd = Date.now();
  const add = postectl("task", "add", "T31 carte en direct", "--project", SANDBOX, "--description", "carte de test");
  const cmdMs = Date.now() - tAdd;
  expect(add.status === 0, "postectl task add pendant que la page est ouverte", add.stderr);
  await page.waitForFunction(() => [...document.querySelectorAll("#agv-tasks .agv-task")].some((c) => c.textContent.includes("T31 carte en direct")), null, { timeout: 6000 });
  const appearMs = Date.now() - tAdd;
  console.log(`  postectl terminé en ${cmdMs} ms ; carte visible ${appearMs - cmdMs} ms après la fin de la commande`);
  expect(appearMs - cmdMs < 3000, `la carte apparaît dans « Tâches créées par l'agent » en ${appearMs - cmdMs} ms après l'ajout (total avec le démarrage de postectl : ${appearMs} ms ; sans rechargement)`);
  expect(await page.locator("#agv-tasks .agv-task").count() === beforeCards + 1, "une seule carte de plus");
  const cardText = await page.locator("#agv-tasks .agv-task", { hasText: "T31 carte en direct" }).innerText();
  expect(/À faire/.test(cardText) && /activité/.test(cardText), "carte : statut et dernière activité", cardText.replace(/\n/g, " | "));
  await page.waitForFunction(() => document.querySelector("#agv-activity")?.textContent.includes("Tâche créée"), null, { timeout: 4000 });
  ok("« Activité de l'agent » affiche l'action de l'agent (Tâche créée)");
  const pendingText = await page.locator("#agv-perms").innerText();
  expect(/Aucune permission en attente/.test(pendingText), "permissions en attente : état vide lisible");

  // Terminal ouvert sur le dossier du projet
  client.send({ type: "launch.start", host: "local", cwd: SANDBOX, kind: "terminal", ref: "t31-term" });
  const launched = await client.take((m) => m.type === "launch.started" && m.ref === "t31-term", "terminal de test", 20000);
  const termId = launched?.terminalId;
  if (termId) terminalsToKill.add(termId);
  expect(Boolean(termId), "terminal de test créé dans le dossier du projet");
  await page.waitForSelector(`#agv-sessions .agv-row[data-id="${termId}"]`, { timeout: 12000 });
  ok("le terminal apparaît dans « Sessions et terminaux »");
  client.send({ type: "windows.send", host: "local", terminalId: termId, text: "echo T31-BONJOUR-AGENT", enter: true, confirm: true });
  await page.click(`#agv-sessions .agv-row[data-id="${termId}"] .agv-row-main`);
  await page.waitForFunction(() => document.querySelector("#agv-preview")?.textContent.includes("T31-BONJOUR-AGENT"), null, { timeout: 9000 });
  const previewLines = (await page.locator("#agv-preview").innerText()).split("\n").length;
  expect(previewLines <= 9, `aperçu du terminal : sortie visible, ${previewLines} ligne(s) (≤ 8 utiles)`);
  await page.screenshot({ path: join(shotsDir, "t31-agent-live.png"), fullPage: true });

  // Voir sur le Bureau
  await page.click("#agv-desk");
  await page.waitForFunction(() => location.hash === "#bureau", null, { timeout: 4000 });
  const deskTerminals = await page.evaluate((id) => window.__getWindows().filter((w) => w.terminalId === id).length, termId);
  expect(deskTerminals === 1, "« Voir sur le Bureau » : la fenêtre du terminal est posée sur le Bureau");
  await page.goto(`${BASE}/#agent`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#agv-takeover", { timeout: 8000 });

  // G3 : mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => {
    const view = document.getElementById("view");
    const w = window.innerWidth;
    const wide = [...document.querySelectorAll("body *")].filter((e) => getComputedStyle(e).position !== "fixed" && e.getBoundingClientRect().right > w + 1).slice(0, 5).map((e) => `${e.tagName}.${String(e.className).slice(0, 30)}#${e.id}:${Math.round(e.getBoundingClientRect().right)}`);
    return { doc: document.documentElement.scrollWidth - w, body: document.body.scrollWidth - w, view: view.scrollWidth - view.clientWidth, wide };
  });
  expect(overflow.doc <= 0 && overflow.body <= 0 && overflow.view <= 0, "mobile 390 px : aucun débordement horizontal", JSON.stringify(overflow));
  await page.screenshot({ path: join(shotsDir, "t31-agent-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1360, height: 900 });

  // Reprendre la main depuis la vue
  await page.click("#agv-takeover");
  await page.waitForSelector("#agv-entrust", { timeout: 6000 });
  ok("« Reprendre la main » dans la vue : retour à l'écran « Confier le poste »");
  expect((await stateOf())?.enabled === false, "le serveur a bien désactivé le mandat");

  // Orchestrateur réel (un seul appel, arrêté par « Reprendre la main ») observé dans la vue
  const run4 = await client.rpc({ type: "agentmode.enable", project: "sandbox-repo", brief: `Test technique T31. ${PONG} Ne crée AUCUNE tâche.`, forbidden: ["supprimer"], launch: true, engine: ENGINE, ref: "r4" }, (m) => m.type === "agentmode.state" && m.ref === "r4", "mandat avec lancement pour la vue");
  await page.waitForFunction(() => /Agent\s*:\s*en train de (travailler|démarrer)/i.test(document.querySelector("#agv-orch")?.textContent || ""), null, { timeout: 30000 });
  ok("vue : l'orchestrateur apparaît « en train de démarrer / travailler »");
  const orch4 = await until(async () => (await tasksNow()).find((t) => t.title === "Jarvis — sandbox-repo" && t.status === "doing" && t.agentRun === run4?.runId), "tâche orchestrateur du second lancement", 30000);
  const sessRow = await page.waitForSelector(`#agv-sessions .agv-row[data-id="${orch4?.agentId}"]`, { timeout: 15000 }).catch(() => null);
  expect(Boolean(sessRow), "vue : la session de l'orchestrateur est listée dans « Sessions et terminaux »");
  if (sessRow) expect(/agent/.test(await sessRow.innerText()), "vue : la session est marquée « agent »");
  await page.waitForFunction(() => document.querySelector("#agv-phrase")?.textContent.length > 5, null, { timeout: 90000 }).catch(() => {});
  const phrase = await page.locator("#agv-phrase").innerText().catch(() => "");
  expect(phrase.length > 5, "vue : la dernière phrase écrite par l'orchestrateur s'affiche", phrase);
  console.log(`  dernière phrase : ${phrase.slice(0, 140)}`);
  const orchText = await page.locator("#agv-orch").innerText();
  console.log(`  statut : ${orchText.split("\n")[0]}`);
  await page.screenshot({ path: join(shotsDir, "t31-agent-orchestrator.png"), fullPage: true });
  const stillDoing = (await tasksNow()).find((t) => t.id === orch4?.id)?.status === "doing";
  await page.click("#agv-takeover");
  await page.waitForSelector("#agv-entrust", { timeout: 6000 });
  if (stillDoing) {
    const orchStopped = await until(async () => (await tasksNow()).find((t) => t.id === orch4?.id && t.status === "blocked"), "second orchestrateur arrêté", 30000);
    expect(orchStopped?.reason === "Arrêtée manuellement", "« Reprendre la main » (vue) arrête l'orchestrateur réel");
  } else {
    console.log("  (l'orchestrateur avait déjà fini son tour : arrêt non vérifié sur ce passage)");
  }
  expect(consoleErrors.length === 0, "aucune erreur JavaScript dans la page", consoleErrors.join(" | "));
  void run3;
} catch (e) {
  fail("exception pendant la vérification", e.stack || e.message);
} finally {
  section("Nettoyage");
  try { await browser?.close(); } catch { /* ignoré */ }
  // Seuls les agents et terminaux créés par ce test sont supprimés.
  try {
    for (const t of await tasksNow().catch(() => [])) if (t.agentId) agentsToDelete.add(t.agentId);
    for (const id of agentsToDelete) await daemon.deleteAgent(id).catch(() => {});
    for (const id of terminalsToKill) await daemon.killTerminal(id).catch(() => {});
  } catch { /* ignoré */ }
  await daemon.close().catch(() => {});
  try { client.ws.close(); } catch { /* ignoré */ }
  srv.proc.kill();
  await sleep(400);
  try { rmSync(scratchDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* ignoré */ }
  console.log(`agents supprimés : ${agentsToDelete.size}, terminaux fermés : ${terminalsToKill.size}`);
  console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
  if (failed > 0) {
    process.exitCode = 1;
  } else {
    console.log("VERIFY_AGENTLAUNCH_PASS");
  }
}
