// Vérification du fil d'agent lisible : réflexions repliées, en-têtes structurés, outils (Ticket T16 PARTIE B).
// Usage : node dashboard/scripts/verify-agent-feed.mjs
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const screenshotsDir = join(here, "..", "screenshots");
mkdirSync(screenshotsDir, { recursive: true });

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
  throw new Error("playwright non trouvé");
}

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");

const fail = (msg) => { throw new Error(msg); };
const expect = (cond, label, detail = "") => {
  if (!cond) fail(`${label} : ${detail}`);
  console.log(`OK ${label}${detail ? ` (${detail})` : ""}`);
};

const pw = await getPlaywright();
const browser = await pw.chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const ws = new WebSocket(url, { origin });
const inbox = [];
ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
await new Promise((resolve) => ws.once("open", resolve));

async function receive(predicate, label, timeout = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const idx = inbox.findIndex(predicate);
    if (idx >= 0) return inbox.splice(idx, 1)[0];
    await delay(100);
  }
  fail(`Délai dépassé pour : ${label}`);
}

let agentId = null;

try {
  console.log("--- 1. Lancement d'un agent avec réflexion (claude-nvidia / sonnet) ---");
  const prompt = "Say hello in one short sentence.";
  const cwd = "D:/Projets/AI-OS/paseo-poste/sandbox-repo";
  ws.send(JSON.stringify({
    type: "launch.start",
    host: "local",
    cwd,
    kind: "agent",
    provider: "claude-nvidia",
    model: "sonnet",
    title: "Test Feed Claude",
    prompt,
  }));

  const started = await receive((m) => m.type === "launch.started" && m.kind === "agent", "lancement agent");
  agentId = started.agentId;
  console.log("Agent créé avec ID :", agentId);

  ws.send(JSON.stringify({ type: "agent.watch", host: "local", agentId }));

  console.log("Attente de la fin du tour...");
  await receive((m) => m.type === "agent.event" && m.agentId === agentId &&
    m.event?.event?.type === "turn_completed", "fin du tour de l'agent", 40000);
  console.log("Tour terminé avec succès côté daemon.");

  console.log("--- 2. Ouverture de la vue Bureau et de la fenêtre d'agent ---");
  await page.goto((url.replace("ws:", "http:").replace(/\/ui$/, "")) + "/#bureau", { waitUntil: "networkidle" });
  await page.waitForSelector(".desk", { timeout: 10000 });

  await page.evaluate(({ host, id }) => {
    // Nettoie l'espace pour ce test
    const wins = window.__getWindows ? window.__getWindows() : [];
    wins.length = 0;
    if (window.__changed) window.__changed("clean");
    if (window.__openAgentWindow) {
      window.__openAgentWindow(host, id);
    }
  }, { host: "local", id: agentId });

  await page.waitForSelector(".win.win-agent", { timeout: 10000 });
  await page.waitForSelector(".win.win-agent .thread-assistant_message", { timeout: 15000 });
  await delay(800);

  console.log("--- 3. Vérifications DOM dans la fenêtre d'agent ---");
  const feedInfo = await page.evaluate(() => {
    const win = document.querySelector(".win.win-agent");
    const thread = win.querySelector(".thread");
    const reasonings = [...thread.querySelectorAll("details.thread-reasoning")];
    const assistantMsgs = [...thread.querySelectorAll(".thread-assistant_message")];
    const whoAgents = [...thread.querySelectorAll(".who.who-agent")];
    const toolbar = win.querySelector(".agent-panel-toolbar");
    const checkbox = win.querySelector(".agent-toggle-reasoning input[type='checkbox']");

    // Vérifie qu'aucun texte brut "Reasoning" n'apparaît hors du bloc replié
    const cloned = thread.cloneNode(true);
    for (const d of cloned.querySelectorAll("details.thread-reasoning")) d.remove();
    const outsideText = cloned.textContent || "";
    const hasRawReasoningOutside = /\breasoning\b/i.test(outsideText);

    return {
      reasoningCount: reasonings.length,
      firstReasoningOpen: reasonings[0]?.open ?? null,
      summaryTitle: reasonings[0]?.querySelector(".thread-reasoning-title")?.textContent?.trim() || "",
      summaryPreview: reasonings[0]?.querySelector(".thread-reasoning-preview")?.textContent?.trim() || "",
      reasoningText: reasonings[0]?.querySelector(".thread-reasoning-text")?.textContent?.trim() || "",
      assistantCount: assistantMsgs.length,
      whoAgentText: whoAgents[0]?.textContent?.trim() || "",
      assistantText: assistantMsgs[0]?.querySelector("p")?.textContent?.trim() || "",
      hasRawReasoningOutside,
      hasToolbar: Boolean(toolbar),
      checkboxChecked: checkbox?.checked ?? null,
    };
  });

  console.log("Valeurs mesurées dans le DOM :", JSON.stringify(feedInfo, null, 2));

  expect(feedInfo.reasoningCount >= 1, "Au moins un bloc details de réflexion présent",
    `${feedInfo.reasoningCount} bloc(s)`);
  expect(feedInfo.firstReasoningOpen === false, "Bloc details de réflexion fermé par défaut",
    `open=${feedInfo.firstReasoningOpen}`);
  expect(feedInfo.summaryTitle === "Réflexion", "Titre de sommaire égal à 'Réflexion'",
    feedInfo.summaryTitle);
  expect(feedInfo.whoAgentText === "Agent", "En-tête de message 'Agent' présent",
    feedInfo.whoAgentText);
  expect(feedInfo.assistantText.length > 0, "Message de l'agent non vide",
    feedInfo.assistantText);
  expect(!feedInfo.hasRawReasoningOutside, "Aucun texte 'Reasoning' visible hors du bloc replié",
    "extérieur propre");
  expect(feedInfo.hasToolbar, "Barre d'outils avec interrupteur présente");

  console.log("--- 4. Capture : Thème sombre, bloc replié ---");
  const shotDarkClosed = join(screenshotsDir, "feed-dark-closed.png");
  await page.screenshot({ path: shotDarkClosed });
  console.log("Capture enregistrée :", shotDarkClosed);

  console.log("--- 5. Interrupteur « Afficher la réflexion » (ouvrir les blocs) ---");
  await page.locator(".win.win-agent .agent-toggle-reasoning").click();
  await delay(500);

  const isOpenNow = await page.evaluate(() => {
    const d = document.querySelector(".win.win-agent details.thread-reasoning");
    return d?.open;
  });
  expect(isOpenNow === true, "Blocs de réflexion ouverts après clic sur l'interrupteur", `open=${isOpenNow}`);

  console.log("--- 6. Capture : Thème sombre, bloc ouvert ---");
  const shotDarkOpen = join(screenshotsDir, "feed-dark-open.png");
  await page.screenshot({ path: shotDarkOpen });
  console.log("Capture enregistrée :", shotDarkOpen);

  console.log("--- 7. Repli du bloc et bascule au thème clair ---");
  await page.locator(".win.win-agent .agent-toggle-reasoning").click();
  await delay(300);

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await delay(500);

  console.log("--- 8. Capture : Thème clair, bloc replié ---");
  const shotLightClosed = join(screenshotsDir, "feed-light-closed.png");
  await page.screenshot({ path: shotLightClosed });
  console.log("Capture enregistrée :", shotLightClosed);

  // Remet le thème sombre
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await delay(300);

  console.log("--- 9. Vue mobile 390 px (vérification sans défilement horizontal) ---");
  await page.setViewportSize({ width: 390, height: 844 });
  await delay(800);

  const scrollCheck = await page.evaluate(() => {
    const thread = document.querySelector(".win.win-agent .thread") || document.querySelector(".thread");
    if (!thread) return { ok: false, error: "thread non trouvé" };
    return {
      ok: true,
      scrollWidth: thread.scrollWidth,
      clientWidth: thread.clientWidth,
      diff: thread.scrollWidth - thread.clientWidth,
    };
  });
  console.log("Mesure défilement horizontal 390 px :", JSON.stringify(scrollCheck));
  expect(scrollCheck.ok && scrollCheck.scrollWidth <= scrollCheck.clientWidth,
    "390 px sans défilement horizontal (scrollWidth === clientWidth)",
    `scrollWidth=${scrollCheck.scrollWidth}, clientWidth=${scrollCheck.clientWidth}`);

  console.log("--- 10. Capture : Mobile 390 px ---");
  const shotMobile = join(screenshotsDir, "feed-mobile-390.png");
  await page.screenshot({ path: shotMobile });
  console.log("Capture enregistrée :", shotMobile);

  console.log("--- 11. Vérification dans le tiroir de détail ---");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto((url.replace("ws:", "http:").replace(/\/ui$/, "")) + "/#sessions", { waitUntil: "networkidle" });
  await page.waitForSelector(`.agent-row[data-agent="${agentId}"]`, { timeout: 10000 });
  await page.locator(`.agent-row[data-agent="${agentId}"]`).click();
  await page.waitForSelector(".drawer .thread-reasoning", { timeout: 10000 });
  await delay(600);

  const drawerCheck = await page.evaluate(() => {
    const drawer = document.querySelector(".drawer");
    const reasoning = drawer?.querySelector("details.thread-reasoning");
    const who = drawer?.querySelector(".who.who-agent");
    return {
      hasDrawer: Boolean(drawer),
      hasReasoning: Boolean(reasoning),
      reasoningClosed: reasoning ? !reasoning.open : false,
      hasWhoAgent: Boolean(who),
    };
  });
  console.log("Mesure tiroir de détail :", JSON.stringify(drawerCheck));
  expect(drawerCheck.hasReasoning && drawerCheck.reasoningClosed && drawerCheck.hasWhoAgent,
    "Tiroir de détail affiche le fil d'agent structuré avec réflexion repliée");

  const shotDrawer = join(screenshotsDir, "feed-drawer.png");
  await page.screenshot({ path: shotDrawer });
  console.log("Capture enregistrée :", shotDrawer);

  console.log("\n==========================================");
  console.log("VERIFY_AGENT_FEED_PASS");
  console.log("==========================================\n");
} finally {
  if (agentId) {
    console.log("Nettoyage de l'agent de test :", agentId);
    try {
      ws.send(JSON.stringify({ type: "agent.unwatch", host: "local", agentId }));
    } catch {}
    try {
      const { createPaseoApi } = await import("@getpaseo/client");
      const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
      const daemon = new DaemonClient({
        url: "ws://127.0.0.1:6767/ws",
        clientId: `paseo-feed-cleanup-${Date.now()}`,
        clientType: "cli",
        reconnect: { enabled: false },
      });
      await daemon.connect();
      const api = createPaseoApi(daemon);
      await api.agents.ref(agentId).archive();
      await api.dispose();
      await daemon.close();
      console.log("Agent de test archivé avec succès.");
    } catch (e) {
      console.error("Erreur archivage agent :", e.message);
    }
  }
  try { ws.close(); } catch {}
  try { await context.close(); } catch {}
  try { await browser.close(); } catch {}
}
