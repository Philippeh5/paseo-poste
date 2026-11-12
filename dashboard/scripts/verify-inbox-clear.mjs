// dashboard/scripts/verify-inbox-clear.mjs
// Vérification automatique du ticket T22a :
// Point 1 : Bandeau d'explication repliable (aria-expanded, persistance localStorage, légende des types)
// Point 2 : Éléments demandant décision (boutons Accepter / Passer à la suite, dialogue accessible, Échap, focus, action destructrice avec case à cocher)
// Captures : screenshots/inbox-clear-*.png (clair, sombre, mobile 390px sans défilement horizontal, dialogs)

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

console.log("=== Lancement de la vérification T22a (inbox-clear) ===");

const playwright = await getPlaywright();
const browser = await playwright.chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  // Interception et capture des messages WebSocket envoyés par le client
  await context.addInitScript(() => {
    window.__wsSent = [];
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
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = OrigWS[k];
  });

  const page = await context.newPage();

  console.log(`\n1. Navigation vers ${httpUrl}/#reception...`);
  await page.goto(`${httpUrl}/#reception`, { waitUntil: "networkidle" });
  await delay(1200);

  // Vérification de la vue active
  const activeTab = await page.evaluate(() => {
    const tab = document.querySelector('.viewbar a[aria-selected="true"]');
    return tab ? { id: tab.id, text: tab.textContent.trim(), href: tab.getAttribute("href") } : null;
  });
  expect(activeTab?.href === "#reception", "onglet #reception actif", JSON.stringify(activeTab));

  // =========================================================================
  // POINT 1 : Bandeau d'explication repliable
  // =========================================================================
  console.log("\n2. Vérification du bandeau d'explication (Point 1)...");

  const bannerInfo = await page.evaluate(() => {
    const banner = document.querySelector(".inbox-banner");
    const toggle = banner?.querySelector(".inbox-banner-toggle");
    const body = banner?.querySelector("#inbox-banner-body");
    const title = toggle?.textContent?.trim();
    const ariaExpanded = toggle?.getAttribute("aria-expanded");
    const ariaControls = toggle?.getAttribute("aria-controls");
    const text = body?.querySelector(".inbox-banner-text")?.textContent?.trim();
    const legendItems = [...(body?.querySelectorAll(".inbox-banner-legend-item") || [])].map((el) => el.textContent.trim());
    return {
      exists: Boolean(banner),
      hasHeader: Boolean(banner?.querySelector(".inbox-banner-header")),
      hasToggle: Boolean(toggle),
      title,
      ariaExpanded,
      ariaControls,
      bodyExists: Boolean(body),
      bodyHidden: body?.hasAttribute("hidden") || body?.hidden,
      textLength: text?.length || 0,
      legendCount: legendItems.length,
      legendItems,
    };
  });

  expect(bannerInfo.exists, "bandeau .inbox-banner présent en tête de vue");
  expect(bannerInfo.hasHeader && bannerInfo.hasToggle, "en-tête et bouton de bascule (.inbox-banner-toggle) présents");
  expect(bannerInfo.ariaExpanded === "true", "bandeau déplié par défaut (aria-expanded='true')");
  expect(bannerInfo.ariaControls === "inbox-banner-body", "aria-controls pointe vers inbox-banner-body");
  expect(!bannerInfo.bodyHidden, "corps du bandeau visible par défaut");
  expect(bannerInfo.textLength > 60, "texte explicatif présent en français (2-3 phrases)");
  expect(bannerInfo.legendCount >= 4, "légende des types présente (Permission, Fin, Erreur, Machine)", `${bannerInfo.legendCount} éléments`);

  // Test du repliage
  console.log("Test du repliage du bandeau...");
  await page.click(".inbox-banner-toggle");
  await delay(200);

  const collapsedState = await page.evaluate(() => {
    const toggle = document.querySelector(".inbox-banner-toggle");
    const body = document.querySelector("#inbox-banner-body");
    const lsVal = window.localStorage.getItem("paseo:inbox-banner-expanded");
    return {
      ariaExpanded: toggle?.getAttribute("aria-expanded"),
      bodyHidden: body?.hasAttribute("hidden") || body?.hidden,
      lsVal,
    };
  });

  expect(collapsedState.ariaExpanded === "false", "bandeau replié (aria-expanded='false')");
  expect(collapsedState.bodyHidden, "corps du bandeau masqué (attribut hidden)");
  expect(collapsedState.lsVal === "false", "préférence mémorisée dans localStorage ('false')");

  // Test de persistance après rechargement de la page
  console.log("Test de la persistance de l'état replié après rechargement...");
  await page.reload({ waitUntil: "networkidle" });
  await delay(800);

  const reloadedState = await page.evaluate(() => {
    const toggle = document.querySelector(".inbox-banner-toggle");
    const body = document.querySelector("#inbox-banner-body");
    return {
      ariaExpanded: toggle?.getAttribute("aria-expanded"),
      bodyHidden: body?.hasAttribute("hidden") || body?.hidden,
    };
  });
  expect(reloadedState.ariaExpanded === "false", "état replié persisté après rechargement (aria-expanded='false')");
  expect(reloadedState.bodyHidden, "corps toujours masqué après rechargement");

  // Dépliage et vérification de la persistance à 'true'
  await page.click(".inbox-banner-toggle");
  await delay(200);

  const reOpenedState = await page.evaluate(() => {
    const toggle = document.querySelector(".inbox-banner-toggle");
    const body = document.querySelector("#inbox-banner-body");
    const lsVal = window.localStorage.getItem("paseo:inbox-banner-expanded");
    return {
      ariaExpanded: toggle?.getAttribute("aria-expanded"),
      bodyHidden: body?.hasAttribute("hidden") || body?.hidden,
      lsVal,
    };
  });
  expect(reOpenedState.ariaExpanded === "true", "bandeau redéplié (aria-expanded='true')");
  expect(!reOpenedState.bodyHidden, "corps de nouveau visible");
  expect(reOpenedState.lsVal === "true", "préférence mise à jour dans localStorage ('true')");

  // =========================================================================
  // POINT 2 : Éléments qui demandent une décision & fenêtre de validation
  // =========================================================================
  console.log("\n3. Vérification des éléments de décision et fenêtre de validation (Point 2)...");

  // Injection d'éléments de test dans la boîte de réception
  const testItems = [
    {
      id: "perm-standard-1",
      t: new Date().toISOString(),
      kind: "permission",
      status: "nouveau",
      host: "local",
      project: "sandbox-repo",
      agentId: "ag-test-1",
      agentTitle: "Agent Normal",
      title: "Permission requise : Shell (tests)",
      body: "npm test -- --bail",
      action: {
        type: "permission",
        requestId: "req-std-1",
        danger: false,
        actions: [
          { id: "act-allow-1", label: "Autoriser", behavior: "allow" },
          { id: "act-deny-1", label: "Refuser", behavior: "deny" },
        ],
      },
    },
    {
      id: "perm-next-2",
      t: new Date(Date.now() - 60000).toISOString(),
      kind: "permission",
      status: "nouveau",
      host: "local",
      project: "sandbox-repo",
      agentId: "ag-test-2",
      agentTitle: "Agent Suivant",
      title: "Permission requise : File Write",
      body: "src/index.js",
      action: {
        type: "permission",
        requestId: "req-next-2",
        danger: false,
        actions: [{ id: "act-allow-2", behavior: "allow" }, { id: "act-deny-2", behavior: "deny" }],
      },
    },
    {
      id: "perm-danger-3",
      t: new Date(Date.now() - 120000).toISOString(),
      kind: "permission",
      status: "nouveau",
      host: "local",
      project: "sandbox-repo",
      agentId: "ag-test-3",
      agentTitle: "Agent Destructif",
      title: "Permission requise : Shell Risqué",
      body: "rm -rf build/ dist/",
      action: {
        type: "permission",
        requestId: "req-danger-3",
        danger: true,
        actions: [{ id: "act-allow-3", behavior: "allow" }, { id: "act-deny-3", behavior: "deny" }],
      },
    },
    {
      id: "fin-item-4",
      t: new Date(Date.now() - 180000).toISOString(),
      kind: "fin",
      status: "nouveau",
      host: "local",
      project: "sandbox-repo",
      agentId: "ag-test-4",
      agentTitle: "Agent Fini",
      title: "Mission terminée avec succès",
      body: "Tous les fichiers ont été vérifiés.",
    },
  ];

  await page.evaluate((items) => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "inbox.list", items }),
    }));
  }, testItems);
  await delay(300);

  // Vérification de la présence des boutons sur l'élément de permission
  const itemButtons = await page.evaluate(() => {
    const itemEl = document.getElementById("inbox-item-perm-standard-1");
    const approveBtn = itemEl?.querySelector('button[data-fk="perm-standard-1:allow"]');
    const denyBtn = itemEl?.querySelector('button[data-fk="perm-standard-1:deny"]');
    const finEl = document.getElementById("inbox-item-fin-item-4");
    const finApproveBtn = finEl?.querySelector('button[data-fk="fin-item-4:allow"]');
    return {
      approveText: approveBtn?.textContent?.trim(),
      denyText: denyBtn?.textContent?.trim(),
      finHasDecisionBtns: Boolean(finApproveBtn),
    };
  });

  expect(itemButtons.approveText?.includes("Accepter"), "bouton « Accepter » présent sur la permission", itemButtons.approveText);
  expect(itemButtons.denyText?.includes("Passer à la suite"), "bouton « Passer à la suite » présent sur la permission", itemButtons.denyText);
  expect(!itemButtons.finHasDecisionBtns, "les éléments non-décisionnels (fin) n'ont pas les boutons Accepter/Passer");

  // --- Test A : Clic sur « Accepter » ouvre la fenêtre de validation ---
  console.log("Test de l'ouverture du dialogue de validation pour « Accepter »...");
  await page.click('button[data-fk="perm-standard-1:allow"]');
  await delay(200);

  const dialogAcceptInfo = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    const title = dialog?.querySelector("#inbox-dialog-title")?.textContent?.trim();
    const desc = dialog?.querySelector("#inbox-dialog-desc")?.textContent?.trim();
    const summary = dialog?.querySelector(".inbox-decision-summary")?.textContent?.trim();
    const pre = dialog?.querySelector(".inbox-dialog-pre")?.textContent?.trim();
    const dangerBox = dialog?.querySelector(".inbox-dialog-danger-box");
    const okBtn = dialog?.querySelector("footer .btn-primary, footer .btn-danger");
    const cancelBtn = dialog?.querySelector("footer .btn:not(.btn-primary):not(.btn-danger)");
    return {
      open: dialog?.open,
      title,
      desc,
      hasSummary: Boolean(summary),
      preText: pre,
      hasDangerBox: Boolean(dangerBox),
      okLabel: okBtn?.textContent?.trim(),
      cancelLabel: cancelBtn?.textContent?.trim(),
      focusedTag: document.activeElement?.tagName,
      focusedText: document.activeElement?.textContent?.trim(),
    };
  });

  expect(dialogAcceptInfo.open, "dialogue de validation ouvert (dialog.open === true)");
  expect(dialogAcceptInfo.title?.includes("Valider et accepter"), "titre du dialogue indique l'acceptation de l'action", dialogAcceptInfo.title);
  expect(dialogAcceptInfo.preText === "npm test -- --bail", "détail de l'action affiché dans le résumé", dialogAcceptInfo.preText);
  expect(!dialogAcceptInfo.hasDangerBox, "pas d'avertissement de danger pour action normale");
  expect(dialogAcceptInfo.okLabel?.includes("Accepter l’action"), "libellé du bouton de confirmation", dialogAcceptInfo.okLabel);
  expect(dialogAcceptInfo.cancelLabel === "Annuler", "bouton Annuler présent");

  // Capture d'écran du dialogue standard
  await page.screenshot({ path: join(screenshotsDir, "inbox-clear-dialog-light.png") });
  console.log("Capture enregistrée : screenshots/inbox-clear-dialog-light.png");

  // Test de fermeture par Échap
  console.log("Test de fermeture du dialogue par Échap...");
  await page.keyboard.press("Escape");
  await delay(200);

  const dialogClosedEscape = await page.evaluate(() => {
    return document.querySelector("dialog.inbox-decision-dialog") === null;
  });
  expect(dialogClosedEscape, "le dialogue se ferme sur la touche Échap");

  // Vérifier qu'aucun message perm.respond n'a été envoyé lors de l'annulation
  const sentAfterEscape = await page.evaluate(() => {
    return window.__wsSent.filter((m) => m.type === "perm.respond").length;
  });
  expect(sentAfterEscape === 0, "aucun message perm.respond envoyé lors d'une annulation par Échap");

  // Réouverture et confirmation de « Accepter »
  console.log("Test de confirmation de « Accepter »...");
  await page.click('button[data-fk="perm-standard-1:allow"]');
  await delay(200);
  await page.click("dialog.inbox-decision-dialog footer button.btn-primary");
  await delay(200);

  const sentAfterAccept = await page.evaluate(() => {
    return window.__wsSent.findLast((m) => m.type === "perm.respond");
  });
  expect(sentAfterAccept?.behavior === "allow" && sentAfterAccept?.requestId === "req-std-1",
    "perm.respond envoyé avec behavior='allow' après validation", JSON.stringify(sentAfterAccept));

  // --- Test B : Clic sur « Passer à la suite » ouvre la fenêtre de refus / skip ---
  console.log("\nTest du bouton « Passer à la suite »...");
  await page.click('button[data-fk="perm-next-2:deny"]');
  await delay(200);

  const dialogSkipInfo = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    const title = dialog?.querySelector("#inbox-dialog-title")?.textContent?.trim();
    const okBtn = dialog?.querySelector("footer button.btn-ghost, footer button.btn-primary, footer button:not(:first-child)");
    return {
      open: dialog?.open,
      title,
      okLabel: okBtn?.textContent?.trim(),
    };
  });

  expect(dialogSkipInfo.open, "dialogue de décision ouvert pour Passer à la suite");
  expect(dialogSkipInfo.title?.includes("Passer à la suite"), "titre du dialogue indique 'Passer à la suite'", dialogSkipInfo.title);
  expect(dialogSkipInfo.okLabel?.includes("Passer à la suite"), "bouton de confirmation étiqueté 'Passer à la suite'");

  // Confirmation de « Passer à la suite »
  await page.click("dialog.inbox-decision-dialog footer button:not(:first-child)");
  await delay(200);

  const sentAfterSkip = await page.evaluate(() => {
    return window.__wsSent.findLast((m) => m.type === "perm.respond");
  });
  expect(sentAfterSkip?.behavior === "deny" && sentAfterSkip?.requestId === "req-next-2",
    "perm.respond envoyé avec behavior='deny' après passage à la suite", JSON.stringify(sentAfterSkip));

  // --- Test C : Action destructrice / sensible (danger: true) ---
  console.log("\nTest de l'action sensible / destructrice (danger: true)...");
  await page.click('button[data-fk="perm-danger-3:allow"]');
  await delay(200);

  const dialogDangerInfo = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    const title = dialog?.querySelector("#inbox-dialog-title")?.textContent?.trim();
    const dangerBox = dialog?.querySelector(".inbox-dialog-danger-box");
    const checkbox = dialog?.querySelector("#inbox-danger-check");
    const okBtn = dialog?.querySelector("footer button.btn-danger");
    return {
      open: dialog?.open,
      title,
      hasDangerBox: Boolean(dangerBox),
      hasCheckbox: Boolean(checkbox),
      checkboxChecked: checkbox?.checked,
      okDisabled: okBtn?.disabled,
      okLabel: okBtn?.textContent?.trim(),
    };
  });

  expect(dialogDangerInfo.open, "dialogue de confirmation ouvert pour action risquée");
  expect(dialogDangerInfo.title?.includes("sensible") || dialogDangerInfo.title?.includes("Confirmation"),
    "titre alerte sur l'action sensible", dialogDangerInfo.title);
  expect(dialogDangerInfo.hasDangerBox, "encart de danger (.inbox-dialog-danger-box) présent");
  expect(dialogDangerInfo.hasCheckbox, "case à cocher de confirmation explicite présente");
  expect(dialogDangerInfo.okDisabled === true, "bouton d'approbation désactivé tant que la case n'est pas cochée");

  // Capture d'écran du dialogue danger
  await page.screenshot({ path: join(screenshotsDir, "inbox-clear-dialog-danger.png") });
  console.log("Capture enregistrée : screenshots/inbox-clear-dialog-danger.png");

  // Coche de la case de confirmation
  console.log("Coche de la case de confirmation...");
  await page.click("#inbox-danger-check");
  await delay(100);

  const enabledState = await page.evaluate(() => {
    const okBtn = document.querySelector("dialog.inbox-decision-dialog footer button.btn-danger");
    return { okDisabled: okBtn?.disabled };
  });
  expect(enabledState.okDisabled === false, "bouton d'approbation activé après avoir coché 'J’ai vérifié'");

  // Validation
  await page.click("dialog.inbox-decision-dialog footer button.btn-danger");
  await delay(200);

  const sentAfterDanger = await page.evaluate(() => {
    return window.__wsSent.findLast((m) => m.type === "perm.respond");
  });
  expect(sentAfterDanger?.behavior === "allow" && sentAfterDanger?.requestId === "req-danger-3",
    "perm.respond envoyé pour action destructrice après confirmation explicite", JSON.stringify(sentAfterDanger));

  // --- Test D : Raccourcis clavier a / r / Escape ---
  console.log("\nTest des raccourcis clavier (a pour Accepter, r pour Passer à la suite)...");
  // Sélectionner le premier élément resté ouvert
  await page.evaluate((items) => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        type: "inbox.list",
        items: [{
          id: "perm-kbd",
          t: new Date().toISOString(),
          kind: "permission",
          status: "nouveau",
          host: "local",
          project: "sandbox-repo",
          agentId: "ag-kbd",
          title: "Permission clavier",
          body: "echo test",
          action: { type: "permission", requestId: "req-kbd", danger: false },
        }],
      }),
    }));
  });
  await delay(200);

  // Appui sur 'a'
  await page.keyboard.press("a");
  await delay(200);

  const openedByKbdA = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    return dialog?.open === true;
  });
  expect(openedByKbdA, "touche 'a' ouvre le dialogue d'acceptation");
  await page.keyboard.press("Escape");
  await delay(200);

  // Appui sur 'r'
  await page.keyboard.press("r");
  await delay(200);
  const openedByKbdR = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    return dialog?.open === true && dialog?.querySelector("#inbox-dialog-title")?.textContent?.includes("Passer à la suite");
  });
  expect(openedByKbdR, "touche 'r' ouvre le dialogue de passage à la suite");
  await page.keyboard.press("Escape");
  await delay(200);

  // =========================================================================
  // CAPTURES D'ÉCRAN COMPLÈTES (Clair, Sombre, Mobile 390px)
  // =========================================================================
  console.log("\n4. Réalisation des captures d'écran requises...");

  // Injection d'une liste représentative pour les captures
  await page.evaluate((items) => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "inbox.list", items }),
    }));
  }, testItems);
  await delay(200);

  // 1. Thème clair
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "inbox-clear-light.png") });
  console.log("Capture enregistrée : screenshots/inbox-clear-light.png");

  // 2. Thème sombre
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "inbox-clear-dark.png") });
  console.log("Capture enregistrée : screenshots/inbox-clear-dark.png");

  // 3. Format mobile 390px sans défilement horizontal
  await page.setViewportSize({ width: 390, height: 844 });
  await delay(300);

  const horizontalScroll = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      overflows: doc.scrollWidth > doc.clientWidth || body.scrollWidth > body.clientWidth,
    };
  });
  expect(!horizontalScroll.overflows, "aucun défilement horizontal en 390px",
    `doc: ${horizontalScroll.docScrollWidth} vs ${horizontalScroll.docClientWidth}`);

  await page.screenshot({ path: join(screenshotsDir, "inbox-clear-mobile.png") });
  console.log("Capture enregistrée : screenshots/inbox-clear-mobile.png");

  console.log(`\n=================================================`);
  console.log(`VÉRIFICATION T22a RÉUSSIE : ${passedTests}/${totalTests} assertions OK`);
  console.log(`=================================================`);
} finally {
  await browser.close();
}
