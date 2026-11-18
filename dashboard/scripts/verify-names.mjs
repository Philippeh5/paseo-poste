// dashboard/scripts/verify-names.mjs
// Vérification complète du ticket T19 : Noms clairs partout (Mini PC et Projet · Machine · Harnais · tâche).
// (a) Tests unitaires purs de public/js/core/names.js (>= 25 cas)
// (b) Test serveur : l'état WebSocket contient displayName: "Mini PC" pour local ; hosts.json non modifié (SHA-1)
// (c) Test navigateur Playwright : parcourt les 6 vues (#bureau, #agents, #connexions, #reception),
//     vérifie qu'aucun nom de machine visible n'est « local », lance un agent réel claude-openrouter/sonnet avec invite
//     « Reply with the single word PONG and do nothing else. », vérifie le schéma sandbox-repo · Mini PC · Claude (OpenRouter) · …,
//     génère les captures d'écran requises (sombre/clair/mobile 390px) et nettoie l'agent et la tâche.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  hostLabel,
  harnessLabel,
  projectLabel,
  sessionName,
  taskName,
  isIdentifier,
  formatTitle,
  toolFromCommand,
  windowName,
  numberDuplicates,
  isAutoTerminalName,
} from "../public/js/core/names.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const dashboardDir = join(here, "..");
const screenshotsDir = join(dashboardDir, "screenshots");
mkdirSync(screenshotsDir, { recursive: true });

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const httpUrl = url.replace("ws:", "http:").replace("wss:", "https:").replace("/ui", "");
const origin = httpUrl;
const daemonUrl = process.env.PASEO_LOCAL_URL || "ws://127.0.0.1:6767/ws";
const SANDBOX = process.env.VERIFY_SANDBOX || "D:/Projets/AI-OS/paseo-poste/sandbox-repo";

let totalTests = 0;
let passedTests = 0;

function fail(msg) {
  console.error(`\x1b[31mFAIL: ${msg}\x1b[0m`);
  throw new Error(msg);
}

function expect(cond, label, detail = "") {
  totalTests++;
  if (!cond) {
    fail(`${label} : ${detail}`);
  }
  passedTests++;
  console.log(`OK ${label}${detail ? ` (${detail})` : ""}`);
}

async function getPlaywright() {
  const paths = [
    "playwright-core",
    "file:///C:/Users/Philippe/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core/index.mjs",
  ];
  for (const p of paths) {
    try {
      const mod = await import(p);
      return mod.default || mod;
    } catch {}
  }
  throw new Error("playwright-core introuvable");
}

// ==============================================================================
// (a) TESTS UNITAIRES PURS DE names.js (au moins 25 cas)
// ==============================================================================
console.log("\n=== (a) Tests unitaires purs de public/js/core/names.js ===");

// 1. hostLabel: local -> Mini PC
expect(hostLabel("local") === "Mini PC", "hostLabel('local')", hostLabel("local"));
// 2. hostLabel: oracle -> Oracle
expect(hostLabel("oracle") === "Oracle", "hostLabel('oracle')", hostLabel("oracle"));
// 3. hostLabel: hôte inconnu avec majuscule initiale
expect(hostLabel("staging-vm") === "Staging-vm", "hostLabel('staging-vm')", hostLabel("staging-vm"));
// 4. hostLabel: objet hôte avec displayName
expect(hostLabel({ label: "local", displayName: "Mon Super PC" }) === "Mon Super PC", "hostLabel objet avec displayName");
// 5. hostLabel: objet hôte sans displayName
expect(hostLabel({ label: "local" }) === "Mini PC", "hostLabel objet sans displayName");
// 6. hostLabel: null / undefined / vide
expect(hostLabel("") === "" && hostLabel(null) === "", "hostLabel vide");

// 7-18: harnessLabel: tous les harnais requis
expect(harnessLabel("claude") === "Claude", "harnessLabel('claude')", harnessLabel("claude"));
expect(harnessLabel("claude-openrouter") === "Claude (OpenRouter)", "harnessLabel('claude-openrouter')");
expect(harnessLabel("claude-openrouter/anthropic/claude-3.5-sonnet") === "Claude (OpenRouter)", "harnessLabel claude-openrouter avec modèle");
expect(harnessLabel("claude-nvidia") === "Claude (NVIDIA)", "harnessLabel('claude-nvidia')");
expect(harnessLabel("codex") === "Codex", "harnessLabel('codex')");
expect(harnessLabel("pi") === "Pi", "harnessLabel('pi')");
expect(harnessLabel("pi/agent-v1") === "Pi", "harnessLabel('pi/agent-v1')");
expect(harnessLabel("hermes") === "Hermes", "harnessLabel('hermes')");
expect(harnessLabel("antigravity") === "agy", "harnessLabel('antigravity')");
expect(harnessLabel("agy") === "agy", "harnessLabel('agy')");
expect(harnessLabel("opencode") === "OpenCode", "harnessLabel('opencode')");
expect(harnessLabel("copilot") === "Copilot", "harnessLabel('copilot')");
expect(harnessLabel("freebuff") === "FreeBuff", "harnessLabel('freebuff')");
expect(harnessLabel("terminal") === "Terminal", "harnessLabel('terminal')");
expect(harnessLabel("custom-tool") === "Custom-tool", "harnessLabel inconnu avec majuscule initiale");

// 19-22: projectLabel: chemins Windows, Linux, trailing slashes, vides
expect(projectLabel("D:\\Projets\\AI-OS\\paseo-poste\\sandbox-repo") === "sandbox-repo", "projectLabel Windows");
expect(projectLabel("/home/USERNAME/projects/ai-hub") === "ai-hub", "projectLabel Linux");
expect(projectLabel("D:/Projets/AI-OS/paseo-poste/sandbox-repo/") === "sandbox-repo", "projectLabel trailing slash");
expect(projectLabel("") === "" && projectLabel(null) === "", "projectLabel vide");
expect(projectLabel({ directory: "C:\\dev\\mon-projet" }) === "mon-projet", "projectLabel objet");

// 23-27: isIdentifier et formatTitle
expect(isIdentifier("Agent d9f5ac61") === true, "isIdentifier('Agent d9f5ac61')");
expect(isIdentifier("d9f5ac61") === true, "isIdentifier('d9f5ac61')");
expect(isIdentifier("Mon super agent") === false, "isIdentifier nom lisible");
expect(formatTitle("", "d9f5ac61") === "Session sans titre d9f5", "formatTitle titre vide");
expect(formatTitle("Agent d9f5ac61", "d9f5ac61") === "Session sans titre d9f5", "formatTitle titre identifiant");
const veryLongTitle = "Refactorisation complète du module de nommage avec vérification multi-hôtes et validation navigateur";
expect(formatTitle(veryLongTitle).length === 49 && formatTitle(veryLongTitle).endsWith("…"), "formatTitle troncature à 48 caractères avec …");

// 28-32: sessionName et taskName
const termSession = sessionName({ kind: "terminal", project: "sandbox-repo", host: "local" });
expect(termSession === "sandbox-repo · Mini PC · Terminal", "sessionName terminal", termSession);

const agentSession = sessionName({
  project: "sandbox-repo",
  host: "local",
  provider: "claude-openrouter",
  title: "Vérifier le nommage",
  id: "a1234567",
});
expect(
  agentSession === "sandbox-repo · Mini PC · Claude (OpenRouter) · Vérifier le nommage",
  "sessionName agent",
  agentSession
);

const emptyTitleSession = sessionName({
  project: "sandbox-repo",
  host: "oracle",
  provider: "hermes",
  title: "",
  id: "d9f5ac61-8888",
});
expect(
  emptyTitleSession === "sandbox-repo · Oracle · Hermes · Session sans titre d9f5",
  "sessionName titre vide",
  emptyTitleSession
);

const simpleTask = taskName({
  project: "sandbox-repo",
  host: "local",
  engine: "claude-openrouter/sonnet",
  title: "Corriger le bug",
  id: "t123",
});
expect(
  simpleTask === "sandbox-repo · Mini PC · Claude (OpenRouter) · Corriger le bug",
  "taskName tâche",
  simpleTask
);

const emptyTask = taskName({
  project: "/var/repos/backend",
  host: "oracle",
  engine: "hermes",
  title: "task_e4f1a234",
  id: "e4f1a234",
});
expect(
  emptyTask === "backend · Oracle · Hermes · Tâche sans titre e4f1",
  "taskName tâche titre identifiant",
  emptyTask
);

// 33-52 (T30) : titres de fenêtres du Bureau « Outil · Projet · Machine », doublons numérotés, jamais « local »
const FORBIDDEN_WINDOW_NAME = /\blocal\b|terminal\s*\d/i;
expect(toolFromCommand("freebuff") === "FreeBuff", "toolFromCommand('freebuff')", toolFromCommand("freebuff"));
expect(toolFromCommand("hermes --yolo") === "Hermes", "toolFromCommand('hermes --yolo')");
expect(toolFromCommand("pi") === "Pi", "toolFromCommand('pi')");
expect(toolFromCommand('"C:\\Program Files\\nodejs\\codex.cmd" run') === "Codex", "toolFromCommand chemin Windows .cmd");
expect(toolFromCommand("/usr/local/bin/claude") === "Claude", "toolFromCommand chemin Linux");
expect(toolFromCommand("htop") === "Htop", "toolFromCommand commande inconnue capitalisée");
expect(toolFromCommand("") === "Terminal" && toolFromCommand(undefined) === "Terminal", "toolFromCommand vide -> Terminal");

const nameFreeBuff = windowName({ tool: "FreeBuff", project: "D:\\Projets\\AI-OS\\paseo-poste\\sandbox-repo", host: "local" });
expect(nameFreeBuff === "FreeBuff · sandbox-repo · Mini PC", "windowName FreeBuff", nameFreeBuff);
expect(windowName({ project: "/home/USERNAME/ai-hub", host: "oracle" }) === "Terminal · ai-hub · Oracle", "windowName terminal simple Oracle");
expect(windowName({ kind: "agent", provider: "hermes", project: "/home/USERNAME/ai-hub", host: "oracle" }) === "Hermes · ai-hub · Oracle", "windowName agent Hermes");
expect(windowName({ kind: "agent", provider: "claude-openrouter/sonnet", project: "sandbox-repo", host: "local" })
  === "Claude (OpenRouter) · sandbox-repo · Mini PC", "windowName agent OpenRouter");
expect(windowName({ kind: "agent", provider: "pi", project: "sandbox-repo", host: "local" }) === "Pi · sandbox-repo · Mini PC", "windowName agent Pi");
expect(windowName({ kind: "agent", project: "sandbox-repo", host: "local" }) === "Agent · sandbox-repo · Mini PC", "windowName agent sans harnais");
expect(windowName({ tool: "Terminal", host: "local" }) === "Terminal · Sans projet · Mini PC", "windowName sans projet");
for (const host of ["local", "LOCAL", "Local"]) {
  expect(!FORBIDDEN_WINDOW_NAME.test(windowName({ tool: "FreeBuff", project: "sandbox-repo", host })), `windowName jamais « local » (hôte ${host})`);
}

const dupes = numberDuplicates(["A · p · Mini PC", "B · p · Mini PC", "A · p · Mini PC", "A · p · Mini PC"]);
expect(dupes[0] === "A · p · Mini PC" && dupes[1] === "B · p · Mini PC", "numberDuplicates : uniques non numérotés");
expect(dupes[2] === "A · p · Mini PC (2)" && dupes[3] === "A · p · Mini PC (3)", "numberDuplicates : doublons numérotés (2) (3)", dupes.join(" | "));
expect(numberDuplicates(["X"]).join() === "X" && numberDuplicates([]).length === 0, "numberDuplicates : cas simples");

expect(isAutoTerminalName("sandbox-repo terminal 5") && isAutoTerminalName("Terminal 12") && isAutoTerminalName("terminal"), "isAutoTerminalName : noms automatiques");
expect(!isAutoTerminalName("Mon build") && !isAutoTerminalName("terminal-notes") && !isAutoTerminalName(""), "isAutoTerminalName : vrais noms conservés");

console.log(`Total tests unitaires names.js : ${passedTests} cas validés (attendu >= 25).`);

// ==============================================================================
// (b) TEST SERVEUR : displayName dans WebSocket et intégrité SHA-1 de hosts.json
// ==============================================================================
console.log("\n=== (b) Test serveur : WebSocket et intégrité hosts.json ===");

const hostsFile = (process.env.DASHBOARD_HOSTS_FILE || join(dashboardDir, "hosts.json"));
const sha1Before = createHash("sha1").update(readFileSync(hostsFile)).digest("hex");

const ws = new WebSocket(url, { origin });
const inbox = [];
ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

async function waitForWs(predicate, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const idx = inbox.findIndex(predicate);
    if (idx >= 0) return inbox.splice(idx, 1)[0];
    await delay(100);
  }
  fail(`Délai dépassé pour : ${label}`);
}

const stateMsg = await waitForWs((m) => m.type === "state", "réception de l'état serveur initial");
const localHost = stateMsg.payload?.hosts?.find((h) => h.label === "local");
expect(Boolean(localHost), "hôte 'local' présent dans state.hosts");
expect(localHost.displayName === "Mini PC", "localHost.displayName === 'Mini PC'", localHost.displayName);

const oracleHost = stateMsg.payload?.hosts?.find((h) => h.label === "oracle");
if (oracleHost) {
  expect(oracleHost.displayName === "Oracle", "oracleHost.displayName === 'Oracle'", oracleHost.displayName);
}

// Vérification de l'intégrité de hosts.json : empreinte SHA-1 inchangée SANS afficher le contenu ni le hash
const sha1After = createHash("sha1").update(readFileSync(hostsFile)).digest("hex");
expect(sha1Before === sha1After, "empreinte SHA-1 de hosts.json strictement identique (fichier non modifié)");

// ==============================================================================
// (c) TEST NAVIGATEUR PLAYWRIGHT : 6 vues, texte visible sans 'local', agent PONG
// ==============================================================================
console.log("\n=== (c) Test navigateur Playwright : 6 vues et session réelle ===");

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

let createdAgentId = null;
const launchedTerminals = [];
let createdTaskId = null;
const daemon = new DaemonClient({
  url: daemonUrl,
  clientId: `verify-names-${Date.now()}`,
  clientType: "cli",
  reconnect: { enabled: false },
});

try {
  await daemon.connect();

  console.log(`Navigation vers ${httpUrl}...`);
  await page.goto(httpUrl, { waitUntil: "networkidle" });
  await delay(1500);

  // 1. Fonction pour vérifier qu'aucun nom de machine visible n'affiche "local"
  async function checkNoVisibleLocal(viewName) {
    const visibleIssues = await page.evaluate((vName) => {
      const issues = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        // Ignore balises techniques, URL techniques, code, scripts, styles
        if (parent.closest("script, style, pre, code, .machine-card-url, .technical-url")) continue;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const text = node.textContent;
        // Vérifie si "local" apparaît comme mot entier isolé
        if (/\blocal\b/i.test(text)) {
          // Exclut les URL ou adresses IP
          if (/https?:\/\/|wss?:\/\/|127\.0\.0\.1|localhost/i.test(text)) continue;
          // Exclut les commandes techniques (« node …\postectl.mjs session show local … ») : « local » y est l'identifiant d'hôte à saisir.
          if (/postectl\.mjs/i.test(text)) continue;
          // Exclut si c'est un attribut title ou data non affiché directement
          issues.push({ text: text.trim(), tag: parent.tagName, class: parent.className, view: vName });
        }
      }
      return issues;
    }, viewName);

    expect(
      visibleIssues.length === 0,
      `Vue ${viewName} : aucun mot 'local' visible comme nom de machine`,
      visibleIssues.length > 0 ? JSON.stringify(visibleIssues) : "0 occurrence"
    );
  }

  // Vérification des 6 vues
  const views = [
    { name: "bureau", hash: "#bureau" },
    { name: "agents", hash: "#agents" }, // ex-Tâches, Sessions, Chronologie (fusionnées dans la page Agents)
    { name: "connexions", hash: "#connexions" }, // ex-Machines : fusionnée dans Connexions
    { name: "reception", hash: "#reception" },
  ];

  for (const v of views) {
    await page.evaluate((h) => { window.location.hash = h; }, v.hash);
    await delay(600);
    await checkNoVisibleLocal(v.name);
  }

  // 2. Création d'une tâche de test pour les captures et validation du nommage tâche
  console.log("\n--- Création tâche de test ---");
  const taskTitle = "Vérifier le nommage clair";
  ws.send(JSON.stringify({
    type: "task.create",
    host: "local",
    project: SANDBOX,
    engine: "claude-openrouter/sonnet",
    title: taskTitle,
  }));
  const taskCreatedMsg = await waitForWs((m) => (m.type === "task.changed" && m.task?.title === taskTitle) || (m.type === "tasks" && m.tasks?.some((t) => t.title === taskTitle)), "création tâche");
  if (taskCreatedMsg.task?.id) {
    createdTaskId = taskCreatedMsg.task.id;
  } else if (taskCreatedMsg.tasks) {
    createdTaskId = taskCreatedMsg.tasks.find((t) => t.title === taskTitle)?.id;
  }

  // 3. Lancement d'un vrai agent claude-openrouter/sonnet
  console.log("\n--- Lancement agent claude-openrouter/sonnet ---");
  const prompt = "Reply with the single word PONG and do nothing else.";
  const agentTitle = "Test PONG T19";
  ws.send(JSON.stringify({
    type: "launch.start",
    host: "local",
    cwd: SANDBOX,
    kind: "agent",
    provider: "claude-openrouter",
    model: "sonnet",
    title: agentTitle,
    prompt,
  }));

  const started = await waitForWs(
    (m) => m.type === "launch.started" && m.kind === "agent",
    "agent lancé",
    25000
  );
  createdAgentId = started.agentId;
  expect(Boolean(createdAgentId), "agent créé avec identifiant", createdAgentId);

  // Attendre que l'agent soit visible dans le DOM du dashboard
  await page.evaluate(() => { window.location.hash = "#agents"; });
  await delay(2000);

  // Extraire le nom de session affiché dans la vue Sessions ou dans le Rail
  const renderedSessionNames = await page.evaluate(() => {
    const names = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (text.includes(" · ") && text.length < 140) names.push(text);
    }
    return names;
  });

  console.log("Noms de sessions détectés dans le DOM :", JSON.stringify(renderedSessionNames));
  const expectedPrefix = "sandbox-repo · Mini PC · Claude (OpenRouter) · ";
  const matchingSession = renderedSessionNames.find((n) => n.startsWith(expectedPrefix));
  expect(
    Boolean(matchingSession),
    "nom de session affiché respecte le schéma Projet · Machine · Harnais · titre",
    matchingSession || "NON TROUVÉ"
  );

  // 3 bis (T30). Lanceurs rapides du Bureau : « Outil · Projet · Machine », doublons numérotés, jamais « terminal N ».
  console.log("\n--- Lanceurs rapides : titres des fenêtres du Bureau ---");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => { window.location.hash = "#bureau"; });
  await delay(800);
  const baselineIds = new Set(await page.evaluate(() => window.__getWindows().map((w) => w.terminalId).filter(Boolean)));
  ws.send(JSON.stringify({ type: "launch.start", host: "local", cwd: SANDBOX, kind: "terminal", ref: "verify-names-seed" }));
  const seed = await waitForWs((m) => m.type === "launch.started" && m.ref === "verify-names-seed", "terminal de départ", 25000);
  launchedTerminals.push(seed.terminalId);
  await page.evaluate(({ terminalId, cwd }) => {
    // Fenêtre au format ancien (sans champ « tool ») : le titre doit quand même s'afficher au nouveau format.
    window.__getWindows().push({ id: "vn-legacy", type: "terminal", host: "local", terminalId, cwd, x: 24, y: 24, w: 560, h: 340,
      z: 900, minimized: false, maximized: false });
    window.__changed("add");
  }, { terminalId: seed.terminalId, cwd: SANDBOX });
  await delay(600);
  const windowsInfo = () => page.evaluate(() => window.__getWindows().map((w, i) => ({
    id: w.id, terminalId: w.terminalId || "", tool: w.tool || "",
    title: document.querySelectorAll(".win")[i]?.querySelector(".win-title")?.textContent || "",
    sub: document.querySelectorAll(".win")[i]?.querySelector(".win-sub")?.textContent || "",
  })));
  let current = await windowsInfo();
  const legacy = current.find((t) => t.id === "vn-legacy");
  expect(/^Terminal · sandbox-repo · Mini PC( \(\d+\))?$/.test(legacy?.title || ""), "fenêtre ancien format (sans outil) affichée « Terminal · sandbox-repo · Mini PC »", legacy?.title);

  // Clique un lanceur rapide puis attend que sa fenêtre apparaisse (le démon peut mettre plusieurs secondes).
  const clickAndWait = async (widgetId) => {
    const countNow = async () => (await windowsInfo()).filter((t) => t.terminalId && !baselineIds.has(t.terminalId) && t.terminalId !== seed.terminalId).length;
    const before = await countNow();
    await page.locator(`.widget-btn[data-widget-id="${widgetId}"]`).click();
    const end = Date.now() + 30000;
    while (Date.now() < end && (await countNow()) <= before) await delay(300);
    await delay(500);
  };
  await clickAndWait("w-freebuff");
  await clickAndWait("w-terminal-local");
  await clickAndWait("w-freebuff");
  current = await windowsInfo();
  console.log("Titres de fenêtres :", JSON.stringify(current.map((t) => t.title)));
  // Fenêtres créées par les lanceurs rapides pendant ce test (jamais celles qui existaient déjà).
  const created = current.filter((t) => t.terminalId && t.id !== "vn-legacy" && !baselineIds.has(t.terminalId) && t.terminalId !== seed.terminalId);
  const freebuffs = created.filter((t) => t.tool === "FreeBuff");
  const plainTerminals = created.filter((t) => !t.tool || t.tool === "Terminal");
  expect(freebuffs.length === 2 && plainTerminals.length === 1, "3 fenêtres créées par lanceurs : 2 FreeBuff + 1 Terminal", `${freebuffs.length} FreeBuff, ${plainTerminals.length} Terminal`);
  // Le dossier dépend de la mise en page courante des données (sandbox-repo, fix-claude…) : on valide le format, pas le dossier.
  const projectOfLaunch = (freebuffs[0]?.title.match(/^FreeBuff · (.+?) · Mini PC( \(\d+\))?$/) || [])[1] || "sandbox-repo";
  expect(freebuffs.every((t) => /^FreeBuff · .+ · Mini PC( \(\d+\))?$/.test(t.title)), "lanceur FreeBuff : « FreeBuff · <projet> · Mini PC »", freebuffs.map((t) => t.title).join(" | "));
  expect(/ \(([2-9]|[1-9]\d+)\)$/.test(freebuffs[1].title) && freebuffs[0].title !== freebuffs[1].title, "deux FreeBuff identiques : le second est numéroté « (n) »", freebuffs[1].title);
  expect(new RegExp(`^Terminal · ${projectOfLaunch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · Mini PC \\(([2-9]|[1-9]\\d+)\\)$`).test(plainTerminals[0].title), "lanceur Terminal Mini PC doublonnant l'ancien : numéroté « (n) »", plainTerminals[0].title);
  expect(new Set(current.map((t) => t.title)).size === current.length, "tous les titres sont uniques (numérotation des doublons seulement)");
  expect(current.every((t) => !FORBIDDEN_WINDOW_NAME.test(t.title) && !FORBIDDEN_WINDOW_NAME.test(t.sub)),
    "aucun titre/sous-titre de fenêtre ne contient « local » ou « terminal N »");
  for (const t of created) launchedTerminals.push(t.terminalId);
  await page.evaluate(() => {
    // Ne laisse pas la fenêtre factice dans la mise en page enregistrée.
    const list = window.__getWindows();
    const i = list.findIndex((w) => w.id === "vn-legacy");
    if (i >= 0) { list.splice(i, 1); window.__changed("remove"); }
  });

  // 4. Captures d'écran requises
  console.log("\n--- Prise des captures d'écran requises (sombre et clair) ---");

  // A. Thème sombre
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await delay(300);

  // Rail sombre
  await page.evaluate(() => { window.location.hash = "#bureau"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-rail-dark.png") });
  console.log("OK Capture: names-rail-dark.png");

  // Sessions sombre
  await page.evaluate(() => { window.location.hash = "#agents"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-sessions-dark.png") });
  console.log("OK Capture: names-sessions-dark.png");

  // Tâches sombre
  await page.evaluate(() => { window.location.hash = "#agents"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-tasks-dark.png") });
  console.log("OK Capture: names-tasks-dark.png");

  // Boîte de réception sombre
  await page.evaluate(() => { window.location.hash = "#reception"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-inbox-dark.png") });
  console.log("OK Capture: names-inbox-dark.png");

  // B. Thème clair
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await delay(300);

  // Rail clair
  await page.evaluate(() => { window.location.hash = "#bureau"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-rail-light.png") });
  console.log("OK Capture: names-rail-light.png");

  // Sessions clair
  await page.evaluate(() => { window.location.hash = "#agents"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-sessions-light.png") });
  console.log("OK Capture: names-sessions-light.png");

  // Tâches clair
  await page.evaluate(() => { window.location.hash = "#agents"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-tasks-light.png") });
  console.log("OK Capture: names-tasks-light.png");

  // Boîte de réception clair
  await page.evaluate(() => { window.location.hash = "#reception"; });
  await delay(400);
  await page.screenshot({ path: join(screenshotsDir, "names-inbox-light.png") });
  console.log("OK Capture: names-inbox-light.png");

  // C. Vue mobile 390 px : vérification scrollWidth === clientWidth
  console.log("\n--- Vérification responsive mobile (390 px) ---");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    window.location.hash = "#agents";
  });
  await delay(600);

  const mobileDims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  console.log(`Dimensions 390 px : scrollWidth=${mobileDims.scrollWidth}, clientWidth=${mobileDims.clientWidth}`);
  expect(
    mobileDims.scrollWidth === mobileDims.clientWidth,
    "responsive mobile 390 px : scrollWidth === clientWidth (aucun débordement horizontal)",
    `${mobileDims.scrollWidth} === ${mobileDims.clientWidth}`
  );
  await page.screenshot({ path: join(screenshotsDir, "names-mobile-390.png") });
  console.log("OK Capture: names-mobile-390.png");

} finally {
  console.log("\n--- Nettoyage ---");
  // Nettoyage de la tâche
  if (createdTaskId) {
    ws.send(JSON.stringify({ type: "task.delete", id: createdTaskId }));
    console.log("Tâche de test supprimée :", createdTaskId);
  }
  // Nettoyage des terminaux de test créés par ce script (jamais ceux de Philippe)
  for (const terminalId of launchedTerminals) {
    try { await daemon.killTerminal(terminalId); console.log("Terminal de test arrêté :", terminalId); } catch (e) { console.log("Échec arrêt terminal :", e.message); }
  }
  // Nettoyage de l'agent
  if (createdAgentId) {
    try {
      await daemon.deleteAgent(createdAgentId);
      console.log("Agent de test supprimé via daemon :", createdAgentId);
    } catch (e) {
      console.log("Échec suppression agent :", e.message);
    }
  }
  await daemon.close().catch(() => {});
  ws.close();
  await browser.close().catch(() => {});
}

console.log(`\n\x1b[32m=== TOUS LES TESTS VERIFY-NAMES SONT VALIDES (${passedTests}/${totalTests}) ===\x1b[0m\n`);
