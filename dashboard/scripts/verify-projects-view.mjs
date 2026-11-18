// dashboard/scripts/verify-projects-view.mjs
// Vérification complète du ticket T21 : Vue Projets avec sessions regroupées par projet suivi.
// 1. Vue accessible via #projets
// 2. Un projet suivi apparaît
// 3. Une session de test (claude-openrouter/sonnet, prompt PONG dans sandbox-repo) apparaît DANS sa carte avec le nom du schéma
// 4. Bouton masque/affiche les sessions (valeurs aria-expanded mesurées)
// 5. Persistance du masquage après rechargement
// 6. Section « Autres sessions » repliée par défaut
// 7. Captures d'écran requises (clair, sombre, 390 px) avec scrollWidth === clientWidth
// 8. Nettoyage de l'agent de test

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

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

let createdAgentId = null;
let sandboxFollowedByTest = false;

const ws = new WebSocket(url, { origin });
const inbox = [];
ws.on("message", (raw) => {
  try {
    inbox.push(JSON.parse(raw.toString()));
  } catch {}
});

async function waitForWs(pred, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const idx = inbox.findIndex(pred);
    if (idx >= 0) return inbox.splice(idx, 1)[0];
    await delay(50);
  }
  fail(`Délai dépassé WS : ${label}`);
}

const daemon = new DaemonClient({ url: daemonUrl, clientId: `paseo-verify-pv-${Date.now()}`, clientType: "cli", reconnect: { enabled: false } });

try {
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  expect(true, "connexion WebSocket au dashboard établie");

  // 1. Vérifier si sandbox-repo est déjà suivi, sinon le suivre
  ws.send(JSON.stringify({ type: "project.list" }));
  const initialProjectsMsg = await waitForWs((m) => m.type === "project.list", "project.list initial");
  const existingSandbox = (initialProjectsMsg.projects || []).find(
    (p) => p.host === "local" && (p.dir === SANDBOX || p.dir === "D:\\Projets\\AI-OS\\paseo-poste\\sandbox-repo")
  );

  if (!existingSandbox) {
    console.log("Suivi de sandbox-repo pour le test...");
    ws.send(JSON.stringify({ type: "project.follow", host: "local", dir: SANDBOX }));
    await waitForWs((m) => m.type === "project.followed", "project.follow sandbox-repo");
    sandboxFollowedByTest = true;
    console.log("sandbox-repo est maintenant suivi.");
  } else {
    console.log("sandbox-repo est déjà suivi.");
  }

  // 2. Lancement d'un agent de test
  console.log("\n--- Lancement agent claude-openrouter/sonnet ---");
  const prompt = "Reply with the single word PONG and do nothing else.";
  const agentTitle = "Test PONG T21";
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
  expect(Boolean(createdAgentId), "agent de test créé avec identifiant", createdAgentId);

  // 3. Playwright browser
  console.log("\n--- Lancement navigateur Playwright ---");
  const playwright = await getPlaywright();
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  console.log(`Navigation vers ${httpUrl}/#projets...`);
  await page.goto(`${httpUrl}/#projets`, { waitUntil: "networkidle" });
  await delay(1500);

  // Vérification de la vue active et du sélecteur
  const activeTab = await page.evaluate(() => {
    const tab = document.querySelector('.viewbar a[aria-selected="true"]');
    return tab ? { id: tab.id, text: tab.textContent.trim(), href: tab.getAttribute("href") } : null;
  });
  expect(activeTab?.href === "#projets", "onglet #projets actif dans le sélecteur", JSON.stringify(activeTab));

  // Vérification de la présence de la carte sandbox-repo
  const sandboxCard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".proj-card")];
    for (const c of cards) {
      const title = c.querySelector(".proj-card-title")?.textContent.trim();
      if (title === "sandbox-repo") {
        const count = c.querySelector(".proj-card-count")?.textContent.trim();
        const ghPill = c.querySelector(".gh-pill")?.textContent.trim();
        const toggleBtn = c.querySelector(".proj-toggle-btn");
        const ariaExpanded = toggleBtn?.getAttribute("aria-expanded");
        return {
          found: true,
          title,
          count,
          hasGhPill: Boolean(ghPill),
          ariaExpanded,
        };
      }
    }
    return { found: false };
  });
  expect(sandboxCard.found, "carte du projet suivi sandbox-repo trouvée", JSON.stringify(sandboxCard));
  expect(sandboxCard.ariaExpanded === "true", "carte sandbox-repo déployée par défaut (aria-expanded='true')");

  // Vérification de la session DANS la carte sandbox-repo avec le schéma Projet · Machine · Harnais · tâche
  const sessionInCard = await page.evaluate((expectedTitle) => {
    const cards = [...document.querySelectorAll(".proj-card")];
    const card = cards.find((c) => c.querySelector(".proj-card-title")?.textContent.trim() === "sandbox-repo");
    if (!card) return null;
    const sessionNames = [...card.querySelectorAll(".proj-session-name")].map((el) => el.textContent.trim());
    const sessionBtns = [...card.querySelectorAll(".proj-session-btn")].map((btn) => ({
      name: btn.querySelector(".proj-session-name")?.textContent.trim(),
      meta: btn.querySelector(".proj-session-meta")?.textContent.trim(),
      status: btn.querySelector(".proj-session-status")?.textContent.trim(),
    }));
    const match = sessionBtns.find((s) => s.name?.includes(expectedTitle));
    return { sessionNames, match };
  }, agentTitle);

  console.log("Sessions trouvées dans la carte sandbox-repo :", JSON.stringify(sessionInCard?.sessionNames));
  expect(
    Boolean(sessionInCard?.match),
    "session de test apparaît DANS la carte sandbox-repo",
    JSON.stringify(sessionInCard?.match)
  );

  const expectedPrefix = "sandbox-repo · Mini PC · Claude (OpenRouter) · ";
  const hasExpectedSchema = sessionInCard?.match?.name?.startsWith(expectedPrefix);
  expect(
    hasExpectedSchema,
    "nom de session conforme au schéma Projet · Machine · Harnais · tâche",
    sessionInCard?.match?.name
  );

  // 4. Test du bouton masquer / afficher les sessions
  console.log("\n--- Test du bouton masquer / afficher les sessions ---");
  const toggleBtnSelector = '.proj-card[data-project-name="sandbox-repo"] .proj-toggle-btn';
  const sessionsContainerSelector = '.proj-card[data-project-name="sandbox-repo"] .proj-card-sessions';

  // Clic pour masquer
  await page.click(toggleBtnSelector);
  await delay(300);

  const collapsedState = await page.evaluate(({ btnSel, sessSel }) => {
    const btn = document.querySelector(btnSel);
    const sess = document.querySelector(sessSel);
    return {
      ariaExpanded: btn?.getAttribute("aria-expanded"),
      hidden: sess?.hidden,
      label: btn?.querySelector(".proj-toggle-label")?.textContent.trim(),
    };
  }, { btnSel: toggleBtnSelector, sessSel: sessionsContainerSelector });

  expect(collapsedState.ariaExpanded === "false", "aria-expanded est 'false' après le premier clic");
  expect(collapsedState.hidden === true, "conteneur de sessions est masqué (hidden=true)");

  // 5. Persistance après rechargement
  console.log("\n--- Test persistance après rechargement ---");
  await page.reload({ waitUntil: "networkidle" });
  await delay(1200);

  const reloadedState = await page.evaluate(({ btnSel, sessSel }) => {
    const btn = document.querySelector(btnSel);
    const sess = document.querySelector(sessSel);
    return {
      ariaExpanded: btn?.getAttribute("aria-expanded"),
      hidden: sess?.hidden,
      label: btn?.querySelector(".proj-toggle-label")?.textContent.trim(),
    };
  }, { btnSel: toggleBtnSelector, sessSel: sessionsContainerSelector });

  expect(reloadedState.ariaExpanded === "false", "persistance : aria-expanded reste 'false' après rechargement");
  expect(reloadedState.hidden === true, "persistance : sessions restent masquées après rechargement");

  // Clic pour ré-afficher
  await page.click(toggleBtnSelector);
  await delay(300);

  const reExpandedState = await page.evaluate(({ btnSel, sessSel }) => {
    const btn = document.querySelector(btnSel);
    const sess = document.querySelector(sessSel);
    return {
      ariaExpanded: btn?.getAttribute("aria-expanded"),
      hidden: sess?.hidden,
      label: btn?.querySelector(".proj-toggle-label")?.textContent.trim(),
    };
  }, { btnSel: toggleBtnSelector, sessSel: sessionsContainerSelector });

  expect(reExpandedState.ariaExpanded === "true", "aria-expanded redevient 'true' après le second clic");
  expect(reExpandedState.hidden === false, "conteneur de sessions est de nouveau visible (hidden=false)");

  // 6. Vérification de la section Autres sessions
  const otherCard = await page.evaluate(() => {
    const card = document.querySelector(".proj-card-other");
    if (!card) return null;
    const btn = card.querySelector(".proj-toggle-btn");
    const sess = card.querySelector(".proj-card-sessions");
    return {
      found: true,
      ariaExpanded: btn?.getAttribute("aria-expanded"),
      hidden: sess?.hidden,
      count: card.querySelector(".proj-card-count")?.textContent.trim(),
    };
  });
  expect(otherCard?.found, "section 'Autres sessions' présente", JSON.stringify(otherCard));
  expect(otherCard?.ariaExpanded === "false", "section 'Autres sessions' repliée par défaut (aria-expanded='false')");
  expect(otherCard?.hidden === true, "sessions de 'Autres sessions' masquées par défaut");

  // 7. Prise des captures d'écran requises
  console.log("\n--- Prise des captures d'écran requises (clair, sombre, 390 px) ---");

  // A. Thème sombre
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await delay(300);
  await page.screenshot({ path: join(screenshotsDir, "projets-dark.png") });
  console.log("OK Capture: projets-dark.png");

  // B. Thème clair
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await delay(300);
  await page.screenshot({ path: join(screenshotsDir, "projets-light.png") });
  console.log("OK Capture: projets-light.png");

  // C. Responsive mobile (390 px)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await delay(500);

  const mobileDims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  console.log(`Dimensions 390 px : scrollWidth=${mobileDims.scrollWidth}, clientWidth=${mobileDims.clientWidth}`);
  expect(
    mobileDims.scrollWidth === mobileDims.clientWidth,
    "responsive mobile 390 px : scrollWidth === clientWidth (aucun défilement horizontal)",
    `${mobileDims.scrollWidth} === ${mobileDims.clientWidth}`
  );
  await page.screenshot({ path: join(screenshotsDir, "projets-mobile-390.png") });
  console.log("OK Capture: projets-mobile-390.png");

  await browser.close().catch(() => {});
} finally {
  console.log("\n--- Nettoyage ---");
  if (createdAgentId) {
    try {
      await daemon.connect(); await daemon.deleteAgent(createdAgentId);
      console.log("Agent de test supprimé via daemon :", createdAgentId);
    } catch (e) {
      console.log("Échec suppression agent :", e.message);
    }
  }
  if (sandboxFollowedByTest) {
    // Si sandbox-repo a été ajouté uniquement par notre test, on le retire pour restaurer l'état
    ws.send(JSON.stringify({ type: "project.list" }));
    try {
      const listMsg = await waitForWs((m) => m.type === "project.list", "project.list cleanup", 5000);
      const target = (listMsg.projects || []).find((p) => p.dir === SANDBOX || p.dir.includes("sandbox-repo"));
      if (target?.id) {
        ws.send(JSON.stringify({ type: "project.unfollow", id: target.id }));
        console.log("sandbox-repo désuivi après le test :", target.id);
      }
    } catch {}
  }
  await daemon.close().catch(() => {});
  ws.close();
}

console.log(`\n\x1b[32m=== TOUS LES TESTS VERIFY-PROJECTS-VIEW SONT VALIDES (${passedTests}/${totalTests}) ===\x1b[0m\n`);
