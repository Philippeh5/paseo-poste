// dashboard/scripts/verify-sidechat.mjs
// Vérification automatique du ticket T24 : Discussion avec un LLM sur le côté (panneau non bloquant)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const here = fileURLToPath(new URL(".", import.meta.url));
const dashboardDir = join(here, "..");
const screenshotsDir = join(dashboardDir, "screenshots");
mkdirSync(screenshotsDir, { recursive: true });

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const httpUrl = url.replace("ws:", "http:").replace("wss:", "https:").replace("/ui", "");

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

console.log("=== Lancement de la vérification T24 (side-chat) ===");

const playwright = await getPlaywright();
const browser = await playwright.chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  // Interception et capture des messages WebSocket envoyés et reçus
  await context.addInitScript(() => {
    window.__wsSent = [];
    window.__wsReceived = [];
    window.__wsInstances = [];
    const OrigWS = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new OrigWS(...args);
      window.__wsInstances.push(ws);
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          window.__wsSent.push(JSON.parse(data));
        } catch {
          window.__wsSent.push(data);
        }
        return origSend(data);
      };
      ws.addEventListener("message", (event) => {
        try {
          window.__wsReceived.push(JSON.parse(event.data));
        } catch {
          window.__wsReceived.push(event.data);
        }
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = OrigWS[k];
  });

  const page = await context.newPage();

  console.log(`\n1. Navigation vers ${httpUrl}/#bureau...`);
  await page.goto(`${httpUrl}/#bureau`, { waitUntil: "networkidle" });
  await delay(1200);

  // Le bouton « Discussion » a disparu de la barre du haut : le panneau s'ouvre au clavier
  // (Ctrl+Maj+L) et est créé paresseusement à la première ouverture.
  console.log("\n2. Ouverture du panneau « Discussion » via le raccourci Ctrl+Maj+L...");
  await page.keyboard.press("Control+Shift+L");
  await delay(200);

  const panelAfterOpen = await page.evaluate(() => {
    const p = document.getElementById("sidechat");
    return {
      panelHidden: p?.hidden,
      bodyClass: document.body.classList.contains("sidechat-open"),
      activeTag: document.activeElement?.tagName,
      activeName: document.activeElement?.getAttribute("name"),
    };
  });
  expect(panelAfterOpen.panelHidden === false, "panneau visible (hidden === false)");
  expect(panelAfterOpen.bodyClass === true, "body possède la classe sidechat-open");
  expect(panelAfterOpen.activeTag === "TEXTAREA" && panelAfterOpen.activeName === "prompt",
    "le focus est placé sur le textarea de saisie");

  // Fermeture par la touche Échap (panneau déjà ouvert)
  console.log("Fermeture par Échap...");
  await page.keyboard.press("Escape");
  await delay(200);

  const panelClosedEscape = await page.evaluate(() => {
    const p = document.getElementById("sidechat");
    return {
      panelHidden: p?.hidden,
      bodyClass: document.body.classList.contains("sidechat-open"),
    };
  });
  expect(panelClosedEscape.panelHidden === true, "panneau masqué après Échap");
  expect(!panelClosedEscape.bodyClass, "body ne possède plus sidechat-open");

  // Test du raccourci clavier Ctrl+Shift+L (bascule ouvrir / refermer)
  console.log("\nTest du raccourci clavier Ctrl+Shift+L...");
  await page.keyboard.press("Control+Shift+L");
  await delay(200);
  const openedByKbd = await page.evaluate(() => {
    const p = document.getElementById("sidechat");
    return { hidden: p?.hidden, bodyClass: document.body.classList.contains("sidechat-open") };
  });
  expect(openedByKbd.hidden === false && openedByKbd.bodyClass === true,
    "Ctrl+Shift+L ouvre le panneau");

  // Fermeture via Ctrl+Shift+L
  await page.keyboard.press("Control+Shift+L");
  await delay(200);
  const closedByKbd = await page.evaluate(() => {
    const p = document.getElementById("sidechat");
    return { hidden: p?.hidden };
  });
  expect(closedByKbd.hidden === true, "Ctrl+Shift+L referme le panneau (bascule)");

  // Réouverture pour la suite des tests
  await page.keyboard.press("Control+Shift+L");
  await delay(200);

  // 4. Test d'interactivité : changement de vue (onglets désormais dans le menu) et panneau resté ouvert
  console.log("\n5. Test de persistance lors du changement de vue...");
  // Les onglets sont dans le menu déroulant : naviguer via le hash équivaut au clic sur un onglet.
  await page.evaluate(() => { location.hash = "#taches"; });
  await delay(300);

  const viewChangeState = await page.evaluate(() => {
    const p = document.getElementById("sidechat");
    const hash = window.location.hash;
    const bodyClass = document.body.classList.contains("sidechat-open");
    return { hash, hidden: p?.hidden, bodyClass };
  });
  expect(viewChangeState.hash === "#taches", "le hash a changé pour #taches");
  expect(viewChangeState.hidden === false, "le panneau latéral reste ouvert après changement de vue");
  expect(viewChangeState.bodyClass === true, "body.sidechat-open conservé");

  // Retour sur #bureau
  await page.evaluate(() => { location.hash = "#bureau"; });
  await delay(300);

  // 5. Test des sélecteurs fournisseur / modèle
  console.log("\n6. Vérification des sélecteurs fournisseur et modèle...");
  const selectorsInfo = await page.evaluate(() => {
    const p = document.getElementById("sidechat");
    const provSelect = p?.querySelector('select[name="sidechat-provider"]');
    const modelSelect = p?.querySelector('select[name="sidechat-model"]');
    const provOptions = [...(provSelect?.options || [])].map((o) => o.value);
    const modelOptions = [...(modelSelect?.options || [])].map((o) => ({ value: o.value, text: o.text }));
    return {
      hasProv: Boolean(provSelect),
      hasModel: Boolean(modelSelect),
      provCount: provOptions.length,
      provOptions,
      modelCount: modelOptions.length,
      currentProv: provSelect?.value,
      currentModel: modelSelect?.value,
      firstModel: modelOptions[0]?.value,
    };
  });
  expect(selectorsInfo.hasProv && selectorsInfo.hasModel, "sélecteurs fournisseur et modèle présents");
  expect(selectorsInfo.provCount >= 2, "au moins 2 fournisseurs (OpenRouter, NVIDIA)", `${selectorsInfo.provCount}`);
  expect(selectorsInfo.modelCount >= 1, "liste des modèles non vide", `${selectorsInfo.modelCount} modèles`);

  // 6. Test d'un envoi réel : « Reply with the single word PONG »
  console.log("\n7. Test d'envoi réel d'un message LLM ('Reply with the single word PONG')...");

  // Sélection du fournisseur nvidia et du modèle sans coût nemotron
  await page.evaluate(() => {
    const provSelect = document.querySelector('#sidechat select[name="sidechat-provider"]');
    if (provSelect && provSelect.value !== "nvidia") {
      provSelect.value = "nvidia";
      provSelect.dispatchEvent(new Event("change"));
    }
    const modelSelect = document.querySelector('#sidechat select[name="sidechat-model"]');
    if (modelSelect && modelSelect.value !== "nvidia/nemotron-3-ultra-550b-a55b") {
      modelSelect.value = "nvidia/nemotron-3-ultra-550b-a55b";
      modelSelect.dispatchEvent(new Event("change"));
    }
  });
  await delay(200);

  // Saisie du prompt
  await page.fill('#sidechat textarea[name="prompt"]', "Reply with the single word PONG");
  await delay(100);
  await page.click('#sidechat button[type="submit"]');

  // Attente de l'apparition du message utilisateur
  const userMsgRendered = await page.evaluate(() => {
    const msgs = [...document.querySelectorAll("#sidechat-body .llmchat-msg-user")];
    return msgs.some((m) => m.textContent.includes("PONG"));
  });
  expect(userMsgRendered, "message utilisateur affiché dans le corps de discussion");

  // Attente de la réponse de l'assistant (jusqu'à 45s)
  console.log("Attente de la réponse du modèle gratuit via WebSocket...");
  let gotAssistantReply = false;
  let replyText = "";
  for (let i = 0; i < 90; i++) {
    await delay(500);
    const check = await page.evaluate(() => {
      const msgs = [...document.querySelectorAll("#sidechat-body .llmchat-msg-assistant")];
      const last = msgs[msgs.length - 1];
      const err = document.querySelector("#sidechat-body .llmchat-error");
      return {
        hasReply: Boolean(last),
        text: last?.querySelector(".llmchat-msg-content")?.textContent?.trim() || "",
        error: err?.textContent?.trim() || "",
      };
    });
    if (check.hasReply) {
      gotAssistantReply = true;
      replyText = check.text;
      break;
    }
    if (check.error) {
      console.log(`Erreur retournée par le serveur : ${check.error}`);
      replyText = check.error;
      gotAssistantReply = true;
      break;
    }
  }

  expect(gotAssistantReply && replyText.toUpperCase().includes("PONG"),
    "vraie réponse reçue du modèle LLM contenant 'PONG'", replyText.slice(0, 60));

  // 7. Vérification de la conversation conservée après changement de vue
  console.log("\n8. Vérification que la conversation est conservée après changement de vue...");
  await page.evaluate(() => { location.hash = "#reception"; });
  await delay(300);

  const msgsAfterViewChange = await page.evaluate(() => {
    const userMsgs = document.querySelectorAll("#sidechat-body .llmchat-msg-user").length;
    const assistMsgs = document.querySelectorAll("#sidechat-body .llmchat-msg-assistant").length;
    return { userMsgs, assistMsgs };
  });
  expect(msgsAfterViewChange.userMsgs >= 1 && msgsAfterViewChange.assistMsgs >= 1,
    "messages conservés dans le panneau après changement d'onglet",
    `user=${msgsAfterViewChange.userMsgs}, assist=${msgsAfterViewChange.assistMsgs}`);

  await page.evaluate(() => { location.hash = "#bureau"; });
  await delay(200);

  // 8. Bouton « Copier la dernière réponse »
  console.log("\n9. Test du bouton « Copier la dernière réponse »...");
  const copyBtnInfo = await page.evaluate(() => {
    const btn = document.getElementById("sidechat-copy");
    return { exists: Boolean(btn), text: btn?.textContent?.trim() };
  });
  expect(copyBtnInfo.exists, "bouton #sidechat-copy présent");
  await page.click("#sidechat-copy");
  await delay(300);
  const copyFeedback = await page.evaluate(() => document.getElementById("sidechat-copy")?.textContent?.trim());
  expect(copyFeedback?.includes("Copié"), "feedback 'Copié !' observé sur le bouton de copie", copyFeedback);

  // 9. Bouton « Nouvelle discussion » efface
  console.log("\n10. Test du bouton « Nouvelle discussion »...");
  await page.click("#sidechat-new");
  await delay(200);

  const clearedState = await page.evaluate(() => {
    const msgs = document.querySelectorAll("#sidechat-body .llmchat-msg");
    const empty = document.querySelector("#sidechat-body .llmchat-empty");
    return { count: msgs.length, hasEmpty: Boolean(empty) };
  });
  expect(clearedState.count === 0, "messages effacés après clic sur 'Nouvelle discussion'");
  expect(clearedState.hasEmpty, "état vide réaffiché avec aide");

  // 10. Ouverture depuis le lanceur type « LLM direct »
  console.log("\n11. Test de l'ouverture depuis le lanceur (type LLM direct)...");
  await page.keyboard.press("Escape");
  await delay(200);
  await page.click("#launch-open");
  await delay(200);
  await page.selectOption("#launch-dialog select[name='kind']", "llm");
  await delay(100);
  await page.selectOption("#launch-dialog select[name='provider']", "nvidia");
  await delay(100);
  await page.selectOption("#launch-dialog select[name='model']", "nvidia/nemotron-3-ultra-550b-a55b");
  await delay(100);
  await page.click("#launch-dialog button[type='submit']");
  await delay(300);

  const launcherTest = await page.evaluate(() => {
    const dialog = document.getElementById("launch-dialog");
    const p = document.getElementById("sidechat");
    const prov = p?.querySelector("select[name='sidechat-provider']")?.value;
    const mod = p?.querySelector("select[name='sidechat-model']")?.value;
    return {
      dialogClosed: !dialog?.open,
      sidechatOpen: !p?.hidden,
      provider: prov,
      model: mod,
    };
  });
  expect(launcherTest.dialogClosed, "la modale du lanceur s'est fermée");
  expect(launcherTest.sidechatOpen, "le panneau latéral sidechat s'est ouvert depuis le lanceur");
  expect(launcherTest.provider === "nvidia", "fournisseur transmis depuis le lanceur", launcherTest.provider);
  expect(launcherTest.model === "nvidia/nemotron-3-ultra-550b-a55b", "modèle transmis depuis le lanceur",
    launcherTest.model);

  // 10. Captures d'écran (clair, sombre)
  console.log("\n11. Prise des captures d'écran...");
  // Ré-ajouter un message pour une jolie capture
  await page.fill('#sidechat textarea[name="prompt"]', "Bonjour ! Prêt pour le service.");
  await page.click('#sidechat button[type="submit"]');
  await delay(300);

  // Thème clair
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "sidechat-light.png") });
  console.log("Capture enregistrée : screenshots/sidechat-light.png");

  // Thème sombre
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "sidechat-dark.png") });
  console.log("Capture enregistrée : screenshots/sidechat-dark.png");

  // 11. Format mobile 390 px sans défilement horizontal
  console.log("\n12. Test à 390 px (responsive sans défilement horizontal)...");
  await page.setViewportSize({ width: 390, height: 844 });
  await delay(300);

  const overflowInfo = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const sidechat = document.getElementById("sidechat");
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      sidechatScrollWidth: sidechat?.scrollWidth || 0,
      sidechatClientWidth: sidechat?.clientWidth || 0,
      overflow: doc.scrollWidth > doc.clientWidth || body.scrollWidth > body.clientWidth ||
        (sidechat && sidechat.scrollWidth > sidechat.clientWidth),
    };
  });
  expect(!overflowInfo.overflow, "aucun défilement horizontal à 390 px",
    `doc: ${overflowInfo.docScrollWidth} vs ${overflowInfo.docClientWidth}`);

  await page.screenshot({ path: join(screenshotsDir, "sidechat-390.png") });
  console.log("Capture enregistrée : screenshots/sidechat-390.png");

  // 12. Aucune clé d'API dans les messages WebSocket
  console.log("\n13. Vérification de l'absence de clé dans les messages WebSocket...");
  const keyLeak = await page.evaluate(() => {
    const keyRegex = /sk-[a-zA-Z0-9_\-\.]{12,}/g;
    const allSent = JSON.stringify(window.__wsSent || []);
    const allRecv = JSON.stringify(window.__wsReceived || []);
    const sentMatches = allSent.match(keyRegex) || [];
    const recvMatches = allRecv.match(keyRegex) || [];
    return {
      sentLeaks: sentMatches,
      recvLeaks: recvMatches,
    };
  });
  expect(keyLeak.sentLeaks.length === 0, "aucune clé dans les messages envoyés au serveur");
  expect(keyLeak.recvLeaks.length === 0, "aucune clé dans les messages reçus du serveur");

  console.log(`\n=================================================`);
  console.log(`VÉRIFICATION T24 RÉUSSIE : ${passedTests}/${totalTests} assertions OK`);
  console.log(`=================================================`);
} finally {
  await browser.close();
}
