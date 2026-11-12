// dashboard/scripts/verify-agentmode.mjs
// Vérification complète du ticket T28 : Mode « Agent » (bascule) du poste de commande (N10).
// - G1 : enable/answer/disable via WS, caps respectés, persistance, état restitué après relecture du fichier.
// - G2 : test API : GET /api/v1/mandate correct ; avec « supprimer » interdit et mode actif, la suppression de tâche via l'API renvoie 403 ; mode désactivé -> autorisée (avec confirm).
// - G3 : suites existantes (lister commandes et résultats).
// - G4 : sans mot-clé « local » dans les textes visibles.
// - G5 : vérification navigateur : la pastille s'affiche quand actif et « Reprendre la main » la fait disparaître.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  DEFAULT_QUESTIONS,
  DEFAULT_FORBIDDEN,
  freshState,
} from "../handlers/agentmode.mjs";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = join(dashboardDir, "..");
const scratchDir = join(rootDir, ".foreman", "scratch", `t28-agentmode-${process.pid}`);
rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });

const PORT = 7088;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ui`;

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`OK   ${label}`);
}

function fail(label, detail = "") {
  failed++;
  console.error(`FAIL ${label}${detail ? ` -> ${detail}` : ""}`);
}

function expect(cond, label, detail = "") {
  if (cond) ok(label);
  else fail(label, detail);
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// -----------------------------------------------------------------------------
// 1. Tests unitaires purs de agentmode.mjs
// -----------------------------------------------------------------------------
section("Tests unitaires purs de handlers/agentmode.mjs");

expect(Array.isArray(DEFAULT_QUESTIONS) && DEFAULT_QUESTIONS.length === 3, "DEFAULT_QUESTIONS contient 3 questions");
expect(DEFAULT_QUESTIONS[0] === "Sur quel projet l'agent doit-il travailler ?", "Question 1 correcte");
expect(DEFAULT_QUESTIONS[1] === "Que doit-il faire ?", "Question 2 correcte");
expect(DEFAULT_QUESTIONS[2] === "Que lui est-il interdit de faire sans demander ?", "Question 3 correcte");

expect(Array.isArray(DEFAULT_FORBIDDEN) && DEFAULT_FORBIDDEN.length === 3, "DEFAULT_FORBIDDEN contient 3 interdictions");
expect(DEFAULT_FORBIDDEN.includes("supprimer"), "Interdiction 'supprimer' présente");
expect(DEFAULT_FORBIDDEN.includes("pousser sur GitHub"), "Interdiction 'pousser sur GitHub' présente");
expect(DEFAULT_FORBIDDEN.includes("éteindre une machine"), "Interdiction 'éteindre une machine' présente");

const s0 = freshState({});
expect(s0.enabled === false, "État par défaut : enabled = false");
expect(s0.project === null && s0.brief === null && s0.since === null, "Champs nuls par défaut");
expect(s0.questions.length === 3, "3 questions par défaut");
expect(Array.isArray(s0.answers) && s0.answers.length === 0, "answers vide par défaut");

const sActive = freshState({ enabled: true, project: "mon-projet" });
expect(sActive.enabled === true && sActive.project === "mon-projet", "freshState avec enabled=true");
expect(sActive.forbidden.length === 3, "Interdictions par défaut appliquées quand actif");

// -----------------------------------------------------------------------------
// 2. Serveur de test isolé (port 7088, scratchData)
// -----------------------------------------------------------------------------
section("Démarrage du serveur isolé sur le port 7088");

// Machine factice (daemon jamais joint) : le serveur jetable doit connaître l'hôte « local » pour créer des tâches,
// sans dépendre d'un hosts.json du dépôt (ignoré par git, absent sur Oracle).
const hostsFile = join(scratchDir, "hosts.json");
writeFileSync(hostsFile, JSON.stringify({ hosts: [{ label: "local", url: "ws://127.0.0.1:1/ws" }] }));

function startServer() {
  const env = {
    ...process.env,
    DASHBOARD_PORT: String(PORT),
    DASHBOARD_DATA_DIR: scratchDir,
    DASHBOARD_HOST: "127.0.0.1",
    DASHBOARD_HOSTS_FILE: hostsFile,
  };
  delete env.DASHBOARD_PASSWORD;

  const proc = spawn(process.execPath, [join(dashboardDir, "server.mjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const state = { proc, log: "" };
  proc.stdout.on("data", (d) => {
    state.log += d;
  });
  proc.stderr.on("data", (d) => {
    state.log += d;
  });
  return state;
}

async function connectWs(srv) {
  for (let i = 0; i < 200 && !srv.log.includes("Paseo dashboard :"); i++) {
    await sleep(100);
  }
  const ws = new WebSocket(WS_URL, { origin: BASE_URL });
  const inbox = [];
  ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });

  const take = async (pred, label, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const idx = inbox.findIndex(pred);
      if (idx >= 0) return inbox.splice(idx, 1)[0];
      await sleep(25);
    }
    fail(`Délai dépassé pour : ${label}`);
    return null;
  };

  const rpc = (msg, pred, label, timeout) => {
    inbox.length = 0;
    ws.send(JSON.stringify(msg));
    return take(pred, label, timeout);
  };

  return { ws, inbox, rpc, take };
}

let srv = startServer();
let wsClient = await connectWs(srv);

// -----------------------------------------------------------------------------
// G1 : WebSocket enable/answer/disable, caps respectés, persistance, relecture
// -----------------------------------------------------------------------------
section("G1 : WebSocket messages, caps, persistance et relecture");

// (a) agentmode.get
const initReply = await wsClient.rpc(
  { type: "agentmode.get", ref: "g1" },
  (m) => m.type === "agentmode.state",
  "agentmode.get"
);
expect(initReply && initReply.enabled === false, "agentmode.get renvoie initialement enabled=false");
expect(initReply?.ref === "g1", "Ref renvoyée correctement dans agentmode.state");

// (b) Caps respectés
const overBrief = "A".repeat(2001);
const briefErr = await wsClient.rpc(
  { type: "agentmode.enable", brief: overBrief },
  (m) => m.type === "error",
  "brief > 2000 caractères"
);
expect(briefErr && /brief/i.test(briefErr.message), "Cap brief <= 2000 car. respecté (erreur renvoyée)");

const overProject = "P".repeat(201);
const projErr = await wsClient.rpc(
  { type: "agentmode.enable", project: overProject },
  (m) => m.type === "error",
  "project > 200 caractères"
);
expect(projErr && /projet/i.test(projErr.message), "Cap projet <= 200 car. respecté (erreur renvoyée)");

// (c) agentmode.enable valide
const enableReply = await wsClient.rpc(
  {
    type: "agentmode.enable",
    project: "paseo-lab",
    brief: "Implémenter le Mode Agent T28",
    forbidden: ["supprimer", "pousser sur GitHub", "éteindre une machine"],
    ref: "g2",
  },
  (m) => m.type === "agentmode.state",
  "agentmode.enable valide"
);
expect(enableReply?.enabled === true, "agentmode.enable passe enabled à true");
expect(enableReply?.project === "paseo-lab", "Projet correctement enregistré");
expect(enableReply?.brief === "Implémenter le Mode Agent T28", "Brief correctement enregistré");
expect(enableReply?.forbidden?.length === 3, "3 interdictions enregistrées");
expect(typeof enableReply?.since === "string" && enableReply.since.length > 0, "since renseigné (date ISO)");
expect(enableReply?.answers?.length === 3, "Réponses initiales automatiquement construites");

// (d) agentmode.answer
const overAnswer = "R".repeat(2001);
const ansErr = await wsClient.rpc(
  { type: "agentmode.answer", answer: overAnswer },
  (m) => m.type === "error",
  "answer > 2000 caractères"
);
expect(ansErr && /réponse/i.test(ansErr.message), "Cap answer <= 2000 car. respecté (erreur renvoyée)");

const answerReply = await wsClient.rpc(
  {
    type: "agentmode.answer",
    question: "Où exécuter les tests ?",
    answer: "Depuis la racine avec node dashboard/scripts/verify-*.mjs",
  },
  (m) => m.type === "agentmode.state",
  "agentmode.answer valide"
);
expect(
  answerReply?.answers?.some((a) => a.question === "Où exécuter les tests ?" && a.answer.includes("node dashboard/scripts/verify-*.mjs")),
  "Nouvelle réponse correctement ajoutée dans answers"
);

// (e) Persistance sur disque dans agent-mode.json
const savedPath = join(scratchDir, "agent-mode.json");
expect(existsSync(savedPath), "Fichier agent-mode.json créé sur le disque");
const diskJson = JSON.parse(readFileSync(savedPath, "utf8"));
expect(diskJson.enabled === true && diskJson.project === "paseo-lab", "agent-mode.json contient l'état actif");

// (f) Relecture après redémarrage du serveur
wsClient.ws.close();
srv.proc.kill();
await new Promise((r) => srv.proc.on("exit", r));

srv = startServer();
wsClient = await connectWs(srv);

const restoredReply = await wsClient.rpc(
  { type: "agentmode.get" },
  (m) => m.type === "agentmode.state",
  "agentmode.get après redémarrage"
);
expect(restoredReply?.enabled === true, "État enabled restauré après relecture du fichier");
expect(restoredReply?.project === "paseo-lab", "Projet restauré après relecture du fichier");
expect(restoredReply?.brief === "Implémenter le Mode Agent T28", "Brief restauré après relecture du fichier");
expect(
  restoredReply?.answers?.some((a) => a.question === "Où exécuter les tests ?"),
  "Réponses restaurées après relecture du fichier"
);

// -----------------------------------------------------------------------------
// G2 : Test API (GET /api/v1/mandate, 403 sur suppression interdite, autorisation si désactivé)
// -----------------------------------------------------------------------------
section("G2 : API /api/v1/mandate, refus 403 et autorisation à la désactivation");

// (a) GET /api/v1/mandate
const mandateRes = await fetch(`${BASE_URL}/api/v1/mandate`);
expect(mandateRes.status === 200, "GET /api/v1/mandate renvoie HTTP 200");
const mandateBody = await mandateRes.json();
expect(mandateBody.ok === true, "GET /api/v1/mandate payload ok = true");
const mandate = mandateBody.data;
expect(mandate.enabled === true, "Mandat enabled = true");
expect(mandate.project === "paseo-lab", "Mandat project = 'paseo-lab'");
expect(mandate.brief === "Implémenter le Mode Agent T28", "Mandat brief conforme");
expect(Array.isArray(mandate.forbidden) && mandate.forbidden.includes("supprimer"), "Mandat forbidden contient 'supprimer'");

// (b) Création d'une tâche de test via API
const createTaskRes = await fetch(`${BASE_URL}/api/v1/tasks`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Agent-Name": "test-verify" },
  body: JSON.stringify({ title: "Tâche de vérification suppression T28" }),
});
expect(createTaskRes.status === 200, "Création d'une tâche de test via API HTTP 200");
const createdTaskBody = await createTaskRes.json();
const testTaskId = createdTaskBody.data.task.id;
expect(Boolean(testTaskId), "Tâche créée avec un identifiant valide");

// (c) Tentative de suppression avec mode actif et « supprimer » interdit -> Refus 403
const deleteForbiddenRes = await fetch(`${BASE_URL}/api/v1/tasks/${testTaskId}?confirm=true`, {
  method: "DELETE",
  headers: { "X-Agent-Name": "test-verify" },
});
expect(deleteForbiddenRes.status === 403, "Suppression de tâche refusée avec HTTP 403 quand 'supprimer' est interdit");
const deleteForbiddenBody = await deleteForbiddenRes.json();
expect(deleteForbiddenBody.ok === false, "Réponse DELETE ok = false");
expect(
  /interdit par le mandat/i.test(deleteForbiddenBody.error?.message || ""),
  "Message d'erreur indique clairement « interdit par le mandat »",
  deleteForbiddenBody.error?.message
);

// (d) Test CLI postectl mandate
const postectlPath = join(rootDir, "tools", "postectl.mjs");
const postectlText = spawnSync(process.execPath, [postectlPath, "--url", BASE_URL, "mandate"], {
  encoding: "utf8",
});
expect(postectlText.status === 0, "postectl mandate termine avec code 0");
expect(postectlText.stdout.includes("Mode Agent actif sur paseo-lab"), "postectl mandate affiche le projet actif");
expect(postectlText.stdout.includes("Interdictions : supprimer"), "postectl mandate affiche les interdictions");

const postectlJson = spawnSync(process.execPath, [postectlPath, "--url", BASE_URL, "--json", "mandate"], {
  encoding: "utf8",
});
expect(postectlJson.status === 0, "postectl --json mandate termine avec code 0");
const postectlParsed = JSON.parse(postectlJson.stdout.trim());
expect(postectlParsed.enabled === true && postectlParsed.project === "paseo-lab", "postectl --json renvoie le mandat");

// (e) Désactivation du mode Agent -> suppression autorisée avec confirm
const disableReply = await wsClient.rpc(
  { type: "agentmode.disable" },
  (m) => m.type === "agentmode.state",
  "agentmode.disable"
);
expect(disableReply?.enabled === false, "Mode Agent désactivé via WS");

const mandateAfterDisable = await (await fetch(`${BASE_URL}/api/v1/mandate`)).json();
expect(mandateAfterDisable.data.enabled === false, "Mandat désactivé après disable");

// Suppression de la tâche maintenant que le mode est inactif
const deleteAllowedRes = await fetch(`${BASE_URL}/api/v1/tasks/${testTaskId}?confirm=true`, {
  method: "DELETE",
  headers: { "X-Agent-Name": "test-verify" },
});
expect(deleteAllowedRes.status === 200, "Suppression de tâche autorisée HTTP 200 après désactivation du mode Agent");
const deleteAllowedBody = await deleteAllowedRes.json();
expect(deleteAllowedBody.ok === true && deleteAllowedBody.data.deleted === true, "Tâche bien supprimée");

// -----------------------------------------------------------------------------
// G4 : Journalisation boîte de réception et absence du mot « local » dans les textes visibles
// -----------------------------------------------------------------------------
section("G4 : Journalisation et absence du mot « local » dans les textes visibles");

const inboxRes = await fetch(`${BASE_URL}/api/v1/inbox`);
const inboxBody = await inboxRes.json();
const items = inboxBody.data.items;

const activationItem = items.find((i) => i.title === "Mode Agent activé");
expect(Boolean(activationItem), "Élément d'activation présent dans la boîte de réception");
expect(activationItem?.host === "Mini PC", "Hôte d'activation nommé 'Mini PC' (jamais 'local')", activationItem?.host);
expect(!/local/i.test(activationItem?.title || ""), "Titre d'activation sans 'local'");
expect(!/local/i.test(activationItem?.body || ""), "Corps d'activation sans 'local'");

const deactivationItem = items.find((i) => i.title === "Mode Agent désactivé");
expect(Boolean(deactivationItem), "Élément de désactivation présent dans la boîte de réception");
expect(deactivationItem?.host === "Mini PC", "Hôte de désactivation nommé 'Mini PC' (jamais 'local')", deactivationItem?.host);
expect(!/local/i.test(deactivationItem?.title || ""), "Titre de désactivation sans 'local'");
expect(!/local/i.test(deactivationItem?.body || ""), "Corps de désactivation sans 'local'");

// -----------------------------------------------------------------------------
// G5 : Vérification navigateur (Playwright) : pastille visible et Reprendre la main
// -----------------------------------------------------------------------------
section("G5 : Vérification navigateur Playwright (pastille et Reprendre la main)");

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

let browser = null;
try {
  const playwright = await getPlaywright();
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  console.log(`Navigation vers ${BASE_URL}...`);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Attendre le bouton Mode Agent dans la topbar
  const agentBtn = page.locator("#agentmode-btn");
  await agentBtn.waitFor({ state: "visible", timeout: 8000 });
  expect(await agentBtn.isVisible(), "Bouton 'Mode Agent' visible dans la topbar quand inactif");

  // Cliquer pour ouvrir le dialogue
  await agentBtn.click();
  const dialog = page.locator("#agentmode-dialog");
  await dialog.waitFor({ state: "visible", timeout: 4000 });
  expect(await dialog.isVisible(), "Dialogue Mode Agent ouvert");

  // Vérifier les 3 questions dans le dialogue
  const dialogText = await dialog.innerText();
  expect(dialogText.includes("Sur quel projet l'agent doit-il travailler ?"), "Question 1 visible dans le dialogue");
  expect(dialogText.includes("Que doit-il faire ?"), "Question 2 visible dans le dialogue");
  expect(dialogText.includes("Que lui est-il interdit de faire sans demander ?"), "Question 3 visible dans le dialogue");
  expect(dialogText.includes("postectl"), "Mention claire de lecture via postectl/MCP présente");

  // Remplir le brief et cliquer sur « Confier le poste »
  await page.fill("#agentmode-brief", "Mission automatisée Playwright");
  // T31 : « Lancer l'agent maintenant » est cochée par défaut ; ce test (T28) ne vérifie que la pastille, sans lancement.
  expect(await page.locator("#agentmode-launch").isChecked(), "Case « Lancer l'agent maintenant » cochée par défaut");
  await page.uncheck("#agentmode-launch");
  const enableBtn = page.locator("#dialog-agentmode-enable-btn");
  await enableBtn.click();

  // Attendre que la pastille apparaisse dans la topbar
  const badge = page.locator("#agentmode-badge");
  await badge.waitFor({ state: "visible", timeout: 6000 });
  const badgeText = await badge.innerText();
  expect(badgeText.includes("Jarvis"), "Pastille 'Jarvis' affichée dans la topbar", badgeText);

  // Le bouton « Reprendre la main » est présent
  const takeoverBtn = page.locator("#agentmode-takeover-btn");
  expect(await takeoverBtn.isVisible(), "Bouton 'Reprendre la main' visible dans la topbar quand actif");

  // Cliquer sur « Reprendre la main »
  await takeoverBtn.click();

  // La pastille doit disparaître
  await badge.waitFor({ state: "detached", timeout: 6000 });
  expect((await page.locator("#agentmode-badge").count()) === 0, "La pastille a disparu après clic sur 'Reprendre la main'");

  // Le bouton initial « Mode Agent » est revenu
  await agentBtn.waitFor({ state: "visible", timeout: 4000 });
  expect(await agentBtn.isVisible(), "Bouton 'Mode Agent' redevenu visible après reprise de la main");

  await browser.close();
  browser = null;
  ok("Test navigateur Playwright validé (affichage pastille, activation, reprise de la main)");
} catch (e) {
  fail("Erreur lors de la vérification navigateur Playwright", e.stack || e.message);
} finally {
  if (browser) await browser.close();
}

// -----------------------------------------------------------------------------
// Nettoyage final
// -----------------------------------------------------------------------------
section("Nettoyage du serveur et du dossier temporaire");

try {
  wsClient.ws.close();
} catch {}
try {
  srv.proc.kill();
} catch {}
await sleep(300);

try {
  rmSync(scratchDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
} catch (e) {
  console.warn(`Nettoyage partiel de ${scratchDir} : ${e.code}`);
}

console.log(`\n=== BILAN : ${passed} OK, ${failed} FAIL ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("VERIFY_AGENTMODE_PASS");
  process.exit(0);
}
