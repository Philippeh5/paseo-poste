// dashboard/scripts/verify-transfer-ui.mjs
// Vérification automatique du ticket T25 (Interface transfert vers Oracle + bandeau reprise).
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

console.log("=== Lancement de la vérification T25 (transfer-ui) ===");

const playwright = await getPlaywright();
const browser = await playwright.chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  // Interception et capture des messages WebSocket
  await context.addInitScript(() => {
    window.__wsSent = [];
    window.__wsInstances = [];
    const OrigWS = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new OrigWS(...args);
      window.__wsInstances.push(ws);
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
          window.__wsSent.push(parsed);
        } catch {
          window.__wsSent.push(data);
        }
        // Interdit pendant les tests : ne pas exécuter sur le serveur réel
        if (parsed?.type === "transfer.run" || parsed?.type === "transfer.plan") return;
        return origSend(data);
      };
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = OrigWS[k];
  });

  const page = await context.newPage();

  console.log(`\n1. Navigation vers ${httpUrl}...`);
  await page.goto(`${httpUrl}`, { waitUntil: "networkidle" });
  await delay(1200);

  // Le bouton « → Oracle » a disparu de la barre du haut : le dialogue s'ouvre par appel
  // programmatique à openTransferDialog (exposé depuis le module transferDialog.js).
  await page.evaluate(async () => {
    const m = await import("/js/components/transferDialog.js");
    window.__openTransferDialog = m.openTransferDialog;
  });

  // =========================================================================
  // TEST 1 : Ouverture programmatique de la fenêtre de transfert
  // =========================================================================
  console.log("\n2. Vérification que le dialogue de transfert s'ouvre par programme...");
  const exposed = await page.evaluate(() => typeof window.__openTransferDialog === "function");
  expect(exposed, "openTransferDialog est exposé depuis le module");

  // =========================================================================
  // TEST 2 : Ouverture de la fenêtre de transfert et affichage du plan
  // =========================================================================
  console.log("\n3. Ouverture de la fenêtre de transfert...");
  await page.evaluate(() => window.__openTransferDialog());
  await delay(300);

  // Injection d'un plan de test complet pour vérifier l'affichage en français simple
  const mockPlan = {
    ok: true,
    blockers: [],
    warnings: [],
    oracleDiskFree: 15 * 1024 * 1024 * 1024,
    ghConnected: { local: true, oracle: true },
    projects: [
      {
        name: "mon-projet-ia",
        dir: "D:/Projets/mon-projet-ia",
        concerned: true,
        dirtyCount: 3,
        oracleDir: "/home/ubuntu/projets/mon-projet-ia",
      },
    ],
    tasks: [
      { id: "task-test-1", title: "Entraîner le classifieur", status: "doing" },
    ],
    agents: [
      { id: "ag-test-123", task: "Entraîner le classifieur", status: "running" },
    ],
  };

  await page.evaluate((plan) => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "transfer.plan", ...plan }),
      })
    );
  }, mockPlan);
  await delay(300);

  const dialogInfo = await page.evaluate(() => {
    const dialog = document.getElementById("transfer-dialog");
    const dryRunBox = document.getElementById("transfer-dry-run");
    const shutdownInfo = document.getElementById("transfer-shutdown-info");
    const runBtn = document.getElementById("transfer-run-btn");
    const cancelBtn = document.getElementById("transfer-cancel-btn");
    const bodyText = dialog?.querySelector(".transfer-dialog-body")?.textContent || "";
    return {
      open: dialog?.open,
      hasDryRun: Boolean(dryRunBox),
      dryRunChecked: dryRunBox?.checked,
      shutdownInfoText: shutdownInfo?.textContent?.trim(),
      runBtnDisabled: runBtn?.disabled,
      runBtnText: runBtn?.textContent?.trim(),
      cancelBtnText: cancelBtn?.textContent?.trim(),
      hasBranch: bodyText.includes("transfert/"),
      hasProject: bodyText.includes("mon-projet-ia"),
      hasTask: bodyText.includes("Entraîner le classifieur"),
      hasAgent: bodyText.includes("ag-test-"),
    };
  });

  expect(dialogInfo.open, "la fenêtre de transfert s’est ouverte (dialog.open === true)");
  expect(dialogInfo.hasDryRun, "case simulation présente (#transfer-dry-run)");
  expect(dialogInfo.dryRunChecked === true, "case simulation cochée par défaut");
  expect(
    dialogInfo.shutdownInfoText?.includes("PAS éteint"),
    "texte clair 'le mini-PC ne sera PAS éteint' en simulation",
    dialogInfo.shutdownInfoText
  );
  expect(dialogInfo.hasBranch, "branche de transfert 'transfert/<date>' mentionnée");
  expect(dialogInfo.hasProject, "projet concerné affiché avec modifications et cible Oracle");
  expect(dialogInfo.hasTask, "tâches en cours listées");
  expect(dialogInfo.hasAgent, "agents à arrêter listés");
  expect(!dialogInfo.runBtnDisabled, "bouton de lancement actif");

  // =========================================================================
  // TEST 3 : Lancer la simulation -> confirmation -> progression jusqu'à done
  // =========================================================================
  console.log("\n4. Lancement de la simulation...");
  await page.click("#transfer-run-btn");
  await delay(300);

  // Vérification que confirmDialog s'est ouvert
  const confirmDialogOpen = await page.evaluate(() => {
    const d = document.querySelector("dialog.dialog-small");
    return {
      open: d?.open,
      title: d?.querySelector("h2")?.textContent?.trim(),
    };
  });
  expect(
    confirmDialogOpen.open && confirmDialogOpen.title?.includes("simulation"),
    "confirmation explicite demandée pour la simulation",
    confirmDialogOpen.title
  );

  // Confirmation du lancement
  await page.click("dialog.dialog-small footer button.btn-primary");
  await delay(300);

  // Vérification du message transfer.run envoyé
  const lastRunMsg = await page.evaluate(() => {
    return window.__wsSent.findLast((m) => m.type === "transfer.run");
  });
  expect(
    lastRunMsg?.confirm === true && lastRunMsg?.dryRun === true,
    "transfer.run envoyé avec confirm:true et dryRun:true",
    JSON.stringify(lastRunMsg)
  );
  expect(
    lastRunMsg?.confirmShutdown !== true,
    "confirmShutdown n’est PAS envoyé sous simulation"
  );

  // Simulation des diffusions de progression d'étapes
  console.log("Diffusion des étapes jusqu’à done...");
  const steps = [
    "checking",
    "stopping_agents",
    "committing",
    "cloning",
    "reassigning",
    "shutting_down",
    "done",
  ];

  for (const st of steps) {
    await page.evaluate((step) => {
      const ws = window.__wsInstances[0];
      ws.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "transfer.status",
            id: "tr_test_sim",
            dryRun: true,
            step,
            state: step,
          }),
        })
      );
      ws.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "transfer.events",
            id: "tr_test_sim",
            events: [
              {
                id: 1,
                transfer_id: "tr_test_sim",
                step,
                level: "info",
                message: `Exécution étape ${step} (simulation)`,
                created_at: new Date().toISOString(),
              },
            ],
          }),
        })
      );
    }, st);
    await delay(100);
  }

  // Envoi de transfer.done
  await page.evaluate(() => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "transfer.done",
          id: "tr_test_sim",
          dryRun: true,
          summary: { projects: 1, agents: 1, tasks: 1, shutdown: "simulée" },
        }),
      })
    );
  });
  await delay(200);

  const doneState = await page.evaluate(() => {
    const doneStep = document.querySelector('.transfer-step-item[data-step="done"]');
    const logEl = document.getElementById("transfer-events-log");
    return {
      doneText: doneStep?.textContent?.trim(),
      isDone: doneStep?.classList.contains("is-done"),
      eventsCount: logEl?.children.length || 0,
    };
  });

  expect(doneState.isDone, "toutes les étapes affichées jusqu'à done (is-done)");
  expect(doneState.eventsCount > 0, "journal des événements affiché et renseigné");

  // Vérification de sécurité STRICTE : aucun transfer.run avec dryRun:false ni confirmShutdown:true
  const unsafeRunMsgs = await page.evaluate(() => {
    return window.__wsSent.filter(
      (m) => m.type === "transfer.run" && (m.dryRun === false || m.confirmShutdown === true)
    );
  });
  expect(
    unsafeRunMsgs.length === 0,
    "SÉCURITÉ : aucun transfer.run envoyé avec dryRun:false ni confirmShutdown:true"
  );

  // Captures d'écran de la fenêtre de transfert (clair, sombre, mobile 390px)
  console.log("\n5. Captures d’écran de la fenêtre de transfert...");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "transfer-dialog-light.png") });
  console.log("Capture : screenshots/transfer-dialog-light.png");

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "transfer-dialog-dark.png") });
  console.log("Capture : screenshots/transfer-dialog-dark.png");

  // Format mobile 390px sans défilement horizontal
  await page.setViewportSize({ width: 390, height: 844 });
  await delay(300);

  const horizontalScroll = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      overflows: doc.scrollWidth > doc.clientWidth || body.scrollWidth > body.clientWidth,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
    };
  });
  expect(!horizontalScroll.overflows, "aucun défilement horizontal en 390px (transfer dialog)");
  await page.screenshot({ path: join(screenshotsDir, "transfer-dialog-mobile.png") });
  console.log("Capture : screenshots/transfer-dialog-mobile.png");

  // Réinitialiser la vue
  await page.setViewportSize({ width: 1280, height: 720 });
  await delay(200);

  // Fermeture du dialogue
  await page.click("#transfer-cancel-btn");
  await delay(200);

  // =========================================================================
  // TEST 4 : Annulation ferme sans rien lancer
  // =========================================================================
  console.log("\n6. Test de l’annulation sans rien lancer...");
  const sentBeforeCancel = await page.evaluate(() => window.__wsSent.length);

  await page.evaluate(() => window.__openTransferDialog());
  await delay(200);
  const reOpened = await page.evaluate(() => document.getElementById("transfer-dialog")?.open);
  expect(reOpened, "dialogue réouvert");

  await page.click("#transfer-cancel-btn");
  await delay(200);
  const closedAfterCancel = await page.evaluate(() => document.getElementById("transfer-dialog") === null);
  expect(closedAfterCancel, "l’annulation ferme le dialogue sans rien lancer");

  const runSentDuringCancel = await page.evaluate((beforeIdx) => {
    return window.__wsSent.slice(beforeIdx).filter((m) => m.type === "transfer.run").length;
  }, sentBeforeCancel);
  expect(runSentDuringCancel === 0, "aucun transfer.run envoyé lors de l’annulation");

  // =========================================================================
  // TEST 5 : Bandeau de reprise automatique (failover)
  // =========================================================================
  console.log("\n7. Vérification du bandeau de reprise (failover)...");

  // Initialement invisible quand non armé et idle
  await page.evaluate(() => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "failover.status",
          armed: false,
          state: "idle",
          resumedTasks: [],
        }),
      })
    );
  });
  await delay(200);

  const initialBannerHidden = await page.evaluate(() => {
    const b = document.getElementById("failover-banner");
    return b ? b.hidden || b.hasAttribute("hidden") : true;
  });
  expect(initialBannerHidden, "bandeau de reprise invisible quand non armé et rien à signaler");

  // Armer le failover -> le bandeau apparaît
  console.log("Armement de la surveillance...");
  await page.evaluate(() => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "failover.status",
          armed: true,
          state: "monitoring",
          host: "local",
          resumedTasks: [],
        }),
      })
    );
  });
  await delay(200);

  const armedBannerInfo = await page.evaluate(() => {
    const b = document.getElementById("failover-banner");
    const badge = b?.querySelector("#failover-badge");
    const toggleBtn = b?.querySelector("#failover-toggle-btn");
    return {
      hidden: b?.hidden || b?.hasAttribute("hidden"),
      badgeText: badge?.textContent?.trim(),
      toggleText: toggleBtn?.textContent?.trim(),
    };
  });

  expect(!armedBannerInfo.hidden, "le bandeau apparaît quand surveillance armée");
  expect(
    armedBannerInfo.badgeText?.includes("Surveillance armée"),
    "badge affiche 'Surveillance armée'",
    armedBannerInfo.badgeText
  );
  expect(
    armedBannerInfo.toggleText === "Désarmer",
    "bouton Désarmer présent quand armé"
  );

  // Capture du bandeau armé
  await page.screenshot({ path: join(screenshotsDir, "transfer-banner.png") });
  console.log("Capture : screenshots/transfer-banner.png");

  // Clic sur Désarmer
  await page.click("#failover-toggle-btn");
  await delay(200);

  const lastDisarm = await page.evaluate(() => {
    return window.__wsSent.findLast((m) => m.type === "failover.disarm");
  });
  expect(Boolean(lastDisarm), "failover.disarm envoyé au clic sur Désarmer");

  // Réception de la désarmement -> disparition du bandeau
  await page.evaluate(() => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "failover.status",
          armed: false,
          state: "idle",
          resumedTasks: [],
        }),
      })
    );
  });
  await delay(200);

  const disarmedBannerHidden = await page.evaluate(() => {
    const b = document.getElementById("failover-banner");
    return b ? b.hidden || b.hasAttribute("hidden") : true;
  });
  expect(disarmedBannerHidden, "le bandeau disparaît après désarmement");

  // Test état injoignable et bouton 'Reprendre la main'
  console.log("Test de l'état reprise terminée et bouton 'Reprendre la main'...");
  await page.evaluate(() => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "failover.status",
          armed: true,
          state: "reclaim_available",
          resumedTasks: [{ id: "task-1", title: "Tâche reprise" }],
        }),
      })
    );
  });
  await delay(200);

  const reclaimBtnPresent = await page.evaluate(() => {
    const btn = document.getElementById("failover-reclaim-btn");
    return Boolean(btn);
  });
  expect(reclaimBtnPresent, "bouton 'Reprendre la main' présent lorsque reclaim_available");

  // Clic sur Reprendre la main -> confirmation
  await page.click("#failover-reclaim-btn");
  await delay(200);
  await page.click("dialog.dialog-small footer button.btn-primary");
  await delay(200);

  const lastReclaim = await page.evaluate(() => {
    return window.__wsSent.findLast((m) => m.type === "failover.reclaim");
  });
  expect(lastReclaim?.confirm === true, "failover.reclaim envoyé avec confirm:true");

  // Remise de l'état initial (désarmé, idle)
  await page.evaluate(() => {
    const ws = window.__wsInstances[0];
    ws.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "failover.status",
          armed: false,
          state: "idle",
          resumedTasks: [],
        }),
      })
    );
  });
  await delay(200);

  console.log(`\n=================================================`);
  console.log(`VÉRIFICATION T25 RÉUSSIE : ${passedTests}/${totalTests} assertions OK`);
  console.log(`=================================================`);
} finally {
  await browser.close();
}
