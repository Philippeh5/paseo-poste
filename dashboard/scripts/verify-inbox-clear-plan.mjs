// dashboard/scripts/verify-inbox-clear-plan.mjs
// Vérification automatique du ticket T22 (Point 3 : Plan généré à valider) :
// 1. Élément d'inbox de type plan (inbox.plan.create) avec 3 tâches (dont une dépendance).
// 2. Vérification qu'aucune tâche n'est créée avant validation.
// 3. Réordonnancement accessible des tâches (boutons Monter/Descendre).
// 4. Retrait d'une tâche.
// 5. Fenêtre de validation accessible (dialogue, Échap, résumé des tâches, confirmation).
// 6. Validation du plan -> tâches créées dans le store existant avec dépendances respectées.
// 7. Refus d'un plan -> 0 tâche créée.
// 8. Nettoyage complet (tâches et éléments d'inbox créés).
// 9. Captures d'écran screenshots/inbox-plan-*.png (clair, sombre, dialog, mobile 390px).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket as WsClient } from "ws";

const here = fileURLToPath(new URL(".", import.meta.url));
const dashboardDir = join(here, "..");
const screenshotsDir = join(dashboardDir, "screenshots");
mkdirSync(screenshotsDir, { recursive: true });

const wsUrl = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const httpUrl = wsUrl.replace("ws:", "http:").replace("wss:", "https:").replace("/ui", "");

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

// Client WebSocket direct vers le serveur pour contrôler l'état
class BackendClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.ws = null;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WsClient(this.endpoint, { headers: { Origin: new URL(wsUrl).origin.replace("ws:", "http:") } });
      this.ws.on("open", () => resolve());
      this.ws.on("error", (err) => reject(err));
      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw);
          const queue = this.pending.get(msg.type) || [];
          if (queue.length > 0) {
            const resolver = queue.shift();
            resolver(msg);
          }
        } catch {}
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(type, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pending.get(type) || [];
        const idx = queue.indexOf(resolve);
        if (idx >= 0) queue.splice(idx, 1);
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeoutMs);

      const resolver = (data) => {
        clearTimeout(timer);
        resolve(data);
      };

      if (!this.pending.has(type)) this.pending.set(type, []);
      this.pending.get(type).push(resolver);
    });
  }

  async getTasks() {
    this.send({ type: "task.list" });
    const reply = await this.waitFor("tasks");
    return reply.tasks || [];
  }

  async getInbox() {
    this.send({ type: "inbox.list" });
    const reply = await this.waitFor("inbox.list");
    return reply.items || [];
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

console.log("=== Lancement de la vérification T22b (inbox-plan) ===");

const backend = new BackendClient(wsUrl);
await backend.connect();
console.log("Connecté au serveur backend via WebSocket.");

const playwright = await getPlaywright();
const browser = await playwright.chromium.launch({ headless: true });

const createdTaskIdsToClean = [];
const createdInboxIdsToClean = [];

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });

  // Interception et wrapper WebSocket requis par les consignes T22
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

  const activeTab = await page.evaluate(() => {
    const tab = document.querySelector('.viewbar a[aria-selected="true"]');
    return tab ? { id: tab.id, text: tab.textContent.trim(), href: tab.getAttribute("href") } : null;
  });
  expect(activeTab?.href === "#reception", "onglet #reception actif", JSON.stringify(activeTab));

  // Enregistrer le nombre initial de tâches
  const initialTasks = await backend.getTasks();
  const initialTaskCount = initialTasks.length;
  console.log(`Nombre initial de tâches en base : ${initialTaskCount}`);

  // =========================================================================
  // ÉTAPE 1 : Création d'un plan de 3 tâches (dont une dépendance)
  // =========================================================================
  console.log("\n2. Création du plan proposé (3 tâches dont 1 dépendance)...");

  const planPayload = {
    title: "Plan T22 Refactor Architecture",
    body: "Proposition de refactorisation en 3 étapes avec dépendance.",
    project: "sandbox-repo",
    tasks: [
      {
        id: "task-build",
        title: "T22-T1 : Préparation et compilation",
        project: "sandbox-repo",
        harness: "claude-openrouter/sonnet",
      },
      {
        id: "task-test",
        title: "T22-T2 : Tests d'intégration",
        project: "sandbox-repo",
        harness: "claude-openrouter/sonnet",
        dependsOn: ["task-build"],
      },
      {
        id: "task-doc",
        title: "T22-T3 : Rédaction de la documentation",
        project: "sandbox-repo",
        harness: "claude-openrouter/sonnet",
      },
    ],
  };

  backend.send({ type: "inbox.plan.create", ...planPayload });
  const planCreated = await backend.waitFor("inbox.plan.created");
  const planItem = planCreated.item;
  createdInboxIdsToClean.push(planItem.id);

  expect(Boolean(planItem?.id), "plan généré créé via inbox.plan.create", planItem.id);
  expect(planItem.kind === "plan", "l'élément créé est bien de type 'plan'");
  expect(planItem.tasks?.length === 3, "le plan contient 3 tâches");

  await delay(600);

  // =========================================================================
  // ÉTAPE 2 : Vérification qu'aucune tâche n'est créée avant validation
  // =========================================================================
  console.log("\n3. Vérification qu'aucune tâche n'est créée avant validation...");
  const tasksBeforeValidation = await backend.getTasks();
  expect(
    tasksBeforeValidation.length === initialTaskCount,
    "aucune tâche n'a été créée avant la validation du plan",
    `${tasksBeforeValidation.length} vs ${initialTaskCount}`
  );

  // =========================================================================
  // ÉTAPE 3 : Vérification de l'affichage du plan dans l'inbox
  // =========================================================================
  console.log("\n4. Vérification de l'affichage du plan dans l'inbox...");

  const planDomInfo = await page.evaluate((planId) => {
    const card = document.getElementById(`inbox-item-${planId}`);
    if (!card) return null;
    const title = card.querySelector(".inbox-item-title")?.textContent?.trim();
    const pill = card.querySelector(".inbox-pill")?.textContent?.trim();
    const planContainer = card.querySelector(".inbox-plan-container");
    const taskRows = [...card.querySelectorAll(".inbox-plan-task")].map((row) => {
      const num = row.querySelector(".inbox-plan-task-num")?.textContent?.trim();
      const taskTitle = row.querySelector(".inbox-plan-task-title")?.textContent?.trim();
      const meta = row.querySelector(".inbox-plan-task-meta")?.textContent?.trim();
      const upBtn = row.querySelector('button[data-fk*=":up:"]');
      const downBtn = row.querySelector('button[data-fk*=":down:"]');
      const removeBtn = row.querySelector('button[data-fk*=":remove:"]');
      return {
        num,
        taskTitle,
        meta,
        hasUp: Boolean(upBtn),
        isUpDisabled: upBtn?.disabled,
        hasDown: Boolean(downBtn),
        isDownDisabled: downBtn?.disabled,
        hasRemove: Boolean(removeBtn),
      };
    });
    const validateBtn = card.querySelector('button[data-action="validate-plan"], .btn-permission-approve');
    const refuseBtn = card.querySelector('button[data-action="refuse-plan"], .btn-permission-deny');
    return {
      exists: true,
      title,
      pill,
      hasContainer: Boolean(planContainer),
      taskRows,
      validateLabel: validateBtn?.textContent?.trim(),
      refuseLabel: refuseBtn?.textContent?.trim(),
    };
  }, planItem.id);

  expect(planDomInfo?.exists, "carte du plan affichée dans le DOM");
  expect(planDomInfo?.pill?.includes("Plan"), "pastille 'Plan' présente sur la carte");
  expect(planDomInfo?.taskRows?.length === 3, "les 3 tâches sont affichées dans la liste");
  expect(planDomInfo?.taskRows[0].isUpDisabled === true, "premier bouton Monter désactivé");
  expect(planDomInfo?.taskRows[2].isDownDisabled === true, "dernier bouton Descendre désactivé");
  expect(planDomInfo?.taskRows[1].meta?.includes("Dépend de"), "dépendance affichée sur la tâche 2");
  expect(planDomInfo?.validateLabel?.includes("Valider"), "bouton 'Valider le plan' présent");
  expect(planDomInfo?.refuseLabel?.includes("Refuser"), "bouton 'Refuser' présent");

  // =========================================================================
  // ÉTAPE 4 : Réordonnancement accessible des tâches
  // =========================================================================
  console.log("\n5. Test du réordonnancement des tâches...");

  // Cliquer sur « Descendre » de la première tâche
  const firstDownSelector = `#inbox-item-${planItem.id} button[data-fk="plan:${planItem.id}:down:0"]`;
  await page.click(firstDownSelector);
  await delay(400);

  const reorderedDom = await page.evaluate((planId) => {
    const card = document.getElementById(`inbox-item-${planId}`);
    return [...card.querySelectorAll(".inbox-plan-task-title")].map((el) => el.textContent.trim());
  }, planItem.id);

  expect(
    reorderedDom[0] === "T22-T2 : Tests d'intégration" &&
    reorderedDom[1] === "T22-T1 : Préparation et compilation",
    "réordonnancement réussi : Tâche 2 passée en 1ère position",
    JSON.stringify(reorderedDom)
  );

  // =========================================================================
  // ÉTAPE 5 : Retrait d'une tâche
  // =========================================================================
  console.log("\n6. Test du retrait d'une tâche...");

  // Retirer la 3ème tâche (Documentation)
  const removeThirdSelector = `#inbox-item-${planItem.id} button[data-fk="plan:${planItem.id}:remove:2"]`;
  await page.click(removeThirdSelector);
  await delay(400);

  const afterRemovalDom = await page.evaluate((planId) => {
    const card = document.getElementById(`inbox-item-${planId}`);
    return [...card.querySelectorAll(".inbox-plan-task-title")].map((el) => el.textContent.trim());
  }, planItem.id);

  expect(
    afterRemovalDom.length === 2 && !afterRemovalDom.includes("T22-T3 : Rédaction de la documentation"),
    "tâche 3 retirée avec succès du plan (2 tâches restantes)",
    JSON.stringify(afterRemovalDom)
  );

  // =========================================================================
  // ÉTAPE 6 : Fenêtre de validation accessible (Annulation / Échap)
  // =========================================================================
  console.log("\n7. Test de la fenêtre de validation (dialogue accessible)...");

  // Clic sur « Valider le plan »
  const validateBtnSelector = `#inbox-item-${planItem.id} .btn-permission-approve`;
  await page.click(validateBtnSelector);
  await delay(300);

  const dialogInfo = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    const title = dialog?.querySelector("#inbox-dialog-title")?.textContent?.trim();
    const rows = [...(dialog?.querySelectorAll(".inbox-decision-task-row") || [])].map((r) => r.textContent.trim());
    const okBtn = dialog?.querySelector("footer .btn-primary");
    const cancelBtn = dialog?.querySelector("footer .btn:not(.btn-primary)");
    return {
      isOpen: dialog?.open,
      title,
      rowsCount: rows.length,
      okLabel: okBtn?.textContent?.trim(),
      cancelLabel: cancelBtn?.textContent?.trim(),
    };
  });

  expect(dialogInfo.isOpen === true, "dialogue de validation ouvert (dialog.open === true)");
  expect(dialogInfo.title?.includes("Valider"), "titre du dialogue indique la validation du plan");
  expect(dialogInfo.rowsCount === 2, "dialogue liste exactement les 2 tâches restantes");
  expect(dialogInfo.okLabel?.includes("Créer"), "bouton de confirmation prêt");

  // Capture d'écran du dialogue
  await page.screenshot({ path: join(screenshotsDir, "inbox-plan-dialog.png") });
  console.log("Capture enregistrée : screenshots/inbox-plan-dialog.png");

  // Test de fermeture par Échap
  console.log("Test fermeture par Échap...");
  await page.keyboard.press("Escape");
  await delay(300);

  const dialogClosed = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    return !dialog || !dialog.open;
  });
  expect(dialogClosed, "dialogue fermé sur Échap");

  const tasksAfterCancel = await backend.getTasks();
  expect(
    tasksAfterCancel.length === initialTaskCount,
    "aucune tâche créée après annulation par Échap",
    `${tasksAfterCancel.length} vs ${initialTaskCount}`
  );

  // =========================================================================
  // ÉTAPE 7 : Validation effective du plan -> Création des tâches
  // =========================================================================
  console.log("\n8. Validation effective du plan...");

  // Réouverture du dialogue
  await page.click(validateBtnSelector);
  await delay(300);

  // Confirmation de la création
  await page.click("dialog.inbox-decision-dialog footer .btn-primary");
  await delay(1200);

  const tasksAfterValidation = await backend.getTasks();
  const createdTasks = tasksAfterValidation.filter(
    (t) => t.title?.startsWith("T22-T1") || t.title?.startsWith("T22-T2")
  );

  createdTasks.forEach((t) => createdTaskIdsToClean.push(t.id));

  expect(
    createdTasks.length === 2,
    "exactement 2 tâches créées dans le store après validation",
    `${createdTasks.length} tâches`
  );

  const t1 = createdTasks.find((t) => t.title.includes("T22-T1"));
  const t2 = createdTasks.find((t) => t.title.includes("T22-T2"));
  expect(Boolean(t1 && t2), "les tâches T1 et T2 sont bien créées");
  expect(t2?.deps?.includes(t1?.id), "la dépendance T2 -> T1 est correctement enregistrée et résolue");

  // Statut du plan dans l'inbox
  const planTreatedStatus = await page.evaluate((planId) => {
    const card = document.getElementById(`inbox-item-${planId}`);
    const statusText = card?.querySelector(".inbox-status-text")?.textContent?.trim();
    const hasApprove = Boolean(card?.querySelector(".btn-permission-approve"));
    return { statusText, hasApprove };
  }, planItem.id);

  expect(planTreatedStatus.statusText?.includes("Traité"), "le plan est marqué comme Traité dans l'inbox");
  expect(!planTreatedStatus.hasApprove, "les boutons d'action sont retirés après validation");

  // =========================================================================
  // ÉTAPE 8 : Refus d'un plan généré -> 0 tâche créée
  // =========================================================================
  console.log("\n9. Test du refus d'un plan...");

  backend.send({
    type: "inbox.plan.create",
    title: "Plan T22 Refusé",
    body: "Ce plan sera refusé pour tester le comportement.",
    project: "sandbox-repo",
    tasks: [
      { id: "refused-1", title: "Tâche refusée A", project: "sandbox-repo" },
      { id: "refused-2", title: "Tâche refusée B", project: "sandbox-repo" },
    ],
  });

  const planRefusedCreated = await backend.waitFor("inbox.plan.created");
  const planRefusedItem = planRefusedCreated.item;
  createdInboxIdsToClean.push(planRefusedItem.id);
  await delay(500);

  // Cliquer sur « Refuser » dans le DOM
  const refuseBtnSelector = `#inbox-item-${planRefusedItem.id} .btn-permission-deny`;
  await page.click(refuseBtnSelector);
  await delay(300);

  // Vérifier ouverture du dialogue de confirmation de refus
  const refuseDialog = await page.evaluate(() => {
    const dialog = document.querySelector("dialog.inbox-decision-dialog");
    const title = dialog?.querySelector("#inbox-dialog-title")?.textContent?.trim();
    const okBtn = dialog?.querySelector("footer .btn-danger, footer .btn-primary");
    return {
      isOpen: dialog?.open,
      title,
      okLabel: okBtn?.textContent?.trim(),
    };
  });
  expect(refuseDialog.isOpen === true, "dialogue de confirmation du refus ouvert");
  expect(refuseDialog.title?.includes("Refuser"), "titre du dialogue de refus approprié");

  // Confirmer le refus
  await page.click("dialog.inbox-decision-dialog footer button:not(:first-child)");
  await delay(800);

  const tasksAfterRefusal = await backend.getTasks();
  const refusedTasksFound = tasksAfterRefusal.filter(
    (t) => t.title?.includes("Tâche refusée A") || t.title?.includes("Tâche refusée B")
  );
  expect(refusedTasksFound.length === 0, "aucune tâche créée suite au refus du plan", "0 tâche");

  // =========================================================================
  // ÉTAPE 9 : Captures d'écran requises
  // =========================================================================
  console.log("\n10. Réalisation des captures d'écran requises...");

  // Capture thème clair
  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-theme");
  });
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "inbox-plan-light.png") });
  console.log("Capture enregistrée : screenshots/inbox-plan-light.png");

  // Capture thème sombre
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await delay(200);
  await page.screenshot({ path: join(screenshotsDir, "inbox-plan-dark.png") });
  console.log("Capture enregistrée : screenshots/inbox-plan-dark.png");

  // Capture responsive mobile 390px sans défilement horizontal
  await page.setViewportSize({ width: 390, height: 844 });
  await delay(300);

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      hasHorizontalOverflow: doc.scrollWidth > doc.clientWidth,
    };
  });

  expect(!overflow.hasHorizontalOverflow, "aucun défilement horizontal en 390px", `doc: ${overflow.scrollWidth} vs ${overflow.clientWidth}`);
  await page.screenshot({ path: join(screenshotsDir, "inbox-plan-mobile.png") });
  console.log("Capture enregistrée : screenshots/inbox-plan-mobile.png");

} finally {
  console.log("\n11. Nettoyage de l'environnement de test...");
  // Nettoyage des tâches créées
  for (const tid of createdTaskIdsToClean) {
    backend.send({ type: "task.delete", id: tid });
    await delay(100);
  }
  // Nettoyage des éléments d'inbox créés
  if (createdInboxIdsToClean.length > 0) {
    backend.send({ type: "inbox.mark", ids: createdInboxIdsToClean, status: "traité" });
    await delay(100);
    backend.send({ type: "inbox.clear" });
    await delay(100);
  }
  console.log(`Nettoyé : ${createdTaskIdsToClean.length} tâche(s), ${createdInboxIdsToClean.length} plan(s).`);

  await browser.close();
  backend.close();
}

console.log("\n=================================================");
console.log(`VÉRIFICATION T22b RÉUSSIE : ${passedTests}/${totalTests} assertions OK`);
console.log("=================================================");
