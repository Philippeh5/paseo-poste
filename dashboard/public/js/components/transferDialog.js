// Fenêtre modale de transfert vers Oracle (note N14 / T25).
import { el, icons, iconEl, escapeHtml } from "../core/util.js";
import { on, send } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";

const STEPS = [
  { id: "checking", label: "Contrôle des prérequis" },
  { id: "stopping_agents", label: "Arrêt des agents" },
  { id: "committing", label: "Commit & push GitHub" },
  { id: "cloning", label: "Clone & checkout Oracle" },
  { id: "reassigning", label: "Réaffectation des tâches" },
  { id: "shutting_down", label: "Extinction du mini-PC" },
  { id: "done", label: "Transfert terminé" },
];

let activeDialog = null;
let currentPlan = null;
let currentStatus = null;
let currentEvents = [];
let isRunning = false;

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "inconnu";
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} Go`;
}

export function openTransferDialog() {
  if (activeDialog) {
    activeDialog.focus();
    return;
  }

  const dialog = el("dialog", { class: "transfer-dialog", id: "transfer-dialog" });
  activeDialog = dialog;

  // Réinitialisation de l'état
  currentPlan = null;
  currentStatus = null;
  currentEvents = [];
  isRunning = false;

  let dryRun = true;
  let confirmShutdown = false;
  let force = false;

  // Création du conteneur principal
  const container = el("div", { class: "transfer-dialog-container" });

  // En-tête
  const titleEl = el("h2", {}, "Transférer le travail vers Oracle");
  const closeBtn = el(
    "button",
    {
      class: "icon-btn",
      type: "button",
      "aria-label": "Fermer",
      title: "Fermer la fenêtre (Échap)",
      onclick: () => handleClose(),
    },
    iconEl(icons.close || "✕")
  );
  const header = el("div", { class: "transfer-dialog-header" }, titleEl, closeBtn);

  // Corps
  const body = el("div", { class: "transfer-dialog-body" });

  // Pied de page
  const footer = el("div", { class: "transfer-dialog-footer" });

  container.append(header, body, footer);
  dialog.append(container);

  // Abonnements WebSocket
  const unsubs = [];
  unsubs.push(
    on("transfer.plan", (m) => {
      currentPlan = m;
      render();
    })
  );
  unsubs.push(
    on("transfer.status", (m) => {
      currentStatus = m;
      if (m.state && m.state !== "idle" && !m.state.startsWith("failed") && m.state !== "done") {
        isRunning = true;
      }
      if (m.state === "done" || m.state?.startsWith("failed") || m.state?.startsWith("partial")) {
        isRunning = false;
      }
      if (m.detail) {
        currentEvents.push({
          step: m.step || m.state,
          level: "info",
          message: m.detail,
          created_at: new Date().toISOString(),
        });
      }
      if (m.id) send({ type: "transfer.events", id: m.id });
      render();
    })
  );
  unsubs.push(
    on("transfer.done", (m) => {
      isRunning = false;
      if (currentStatus) currentStatus.state = "done";
      currentEvents.push({
        step: "done",
        level: "info",
        message: "Transfert terminé avec succès.",
        created_at: new Date().toISOString(),
      });
      if (m.id) send({ type: "transfer.events", id: m.id });
      render();
    })
  );
  unsubs.push(
    on("transfer.error", (m) => {
      isRunning = false;
      if (currentStatus) {
        currentStatus.state = m.state || "failed";
        currentStatus.error = m.message;
      }
      if (m.message) {
        currentEvents.push({
          step: m.step || "error",
          level: "error",
          message: m.message,
          created_at: new Date().toISOString(),
        });
      }
      if (m.id) send({ type: "transfer.events", id: m.id });
      render();
    })
  );
  unsubs.push(
    on("transfer.events", (m) => {
      if (Array.isArray(m.events) && m.events.length > 0) {
        currentEvents = m.events;
        updateEventsLog();
      }
    })
  );

  function cleanup() {
    activeDialog = null;
    dialog.remove();
  }

  function handleClose() {
    if (isRunning) {
      handleCancel();
      return;
    }
    dialog.close();
  }

  async function handleCancel() {
    if (isRunning) {
      send({ type: "transfer.cancel" });
    } else {
      dialog.close();
    }
  }

  async function handleRun() {
    if (!currentPlan) return;

    if (dryRun) {
      const ok = await confirmDialog({
        title: "Confirmer la simulation de transfert",
        message:
          "Une simulation va être exécutée : aucun commit, aucun push vers GitHub " +
          "et aucune extinction de machine ne seront effectués.",
        confirmLabel: "Lancer la simulation",
      });
      if (!ok) return;

      isRunning = true;
      currentStatus = { state: "checking", step: "checking" };
      render();
      send({
        type: "transfer.run",
        confirm: true,
        dryRun: true,
        force,
      });
    } else {
      const ok = await confirmDialog({
        title: "Confirmer le transfert réel vers Oracle",
        message:
          "Attention : le travail en cours sera committé sur une nouvelle branche, " +
          "poussé sur GitHub, cloné sur Oracle et les tâches y seront réaffectées.",
        confirmLabel: "Confirmer le transfert",
        danger: true,
        twoStep: true,
      });
      if (!ok) return;

      let willShutdown = false;
      if (confirmShutdown) {
        const okShutdown = await confirmDialog({
          title: "Confirmer l’extinction du mini-PC",
          message:
            "Le mini-PC recevra l’ordre d’extinction 60 secondes après la fin du transfert. " +
            "Ce compte à rebours reste annulable avec 'shutdown /a'. Confirmer l’extinction ?",
          confirmLabel: "Confirmer l’extinction",
          danger: true,
        });
        if (okShutdown) willShutdown = true;
      }

      isRunning = true;
      currentStatus = { state: "checking", step: "checking" };
      render();
      send({
        type: "transfer.run",
        confirm: true,
        dryRun: false,
        confirmShutdown: willShutdown,
        force,
      });
    }
  }

  function updateEventsLog() {
    const logEl = body.querySelector(".transfer-events-log");
    if (!logEl) return;
    logEl.replaceChildren();
    for (const ev of currentEvents) {
      const t = ev.created_at ? new Date(ev.created_at).toLocaleTimeString() : "";
      const isErr = ev.level === "error";
      const isWarn = ev.level === "warn";
      const lineClass = isErr ? "transfer-event-error" : isWarn ? "transfer-event-warn" : "";
      const line = el(
        "div",
        { class: `transfer-event-line ${lineClass}` },
        el("span", { class: "transfer-event-time" }, `[${t}]`),
        el("span", { class: "transfer-event-step text-muted" }, `[${ev.step}]`),
        el("span", { class: "transfer-event-msg" }, ev.message)
      );
      logEl.append(line);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function render() {
    // Rendu du corps
    body.replaceChildren();

    if (!currentPlan) {
      body.append(
        el(
          "div",
          { class: "empty-state" },
          el("p", { class: "text-muted" }, "Calcul du plan de transfert en cours…")
        )
      );
    } else {
      const plan = currentPlan;
      const concerned = (plan.projects || []).filter((p) => p.concerned);
      const now = new Date();
      const dateStamp =
        now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0");
      const branchDisplay = `transfert/${dateStamp}_*`;

      // Blocages éventuels (Erreurs)
      if (plan.blockers?.length) {
        const errList = el("ul", { class: "transfer-item-list" });
        for (const b of plan.blockers) {
          errList.append(el("li", {}, b.message));
        }
        body.append(
          el(
            "div",
            { class: "transfer-alert transfer-alert-error" },
            iconEl(icons.alert || "⚠"),
            el("div", {}, el("strong", {}, "Transfert bloqué :"), errList)
          )
        );
      }

      // Avertissements
      if (plan.warnings?.length) {
        const warnList = el("ul", { class: "transfer-item-list" });
        for (const w of plan.warnings) {
          warnList.append(el("li", {}, w.message));
        }
        body.append(
          el(
            "div",
            { class: "transfer-alert transfer-alert-warning" },
            iconEl(icons.alert || "⚠"),
            el("div", {}, el("strong", {}, "Avertissements :"), warnList)
          )
        );
      }

      // Section : Ce qui va se passer
      const overviewCard = el("div", { class: "transfer-card" });
      overviewCard.append(
        el(
          "div",
          { class: "text-sm" },
          el("strong", {}, "Branche créée : "),
          el("code", {}, branchDisplay)
        ),
        el(
          "div",
          { class: "text-sm" },
          el("strong", {}, "GitHub : "),
          `Mini-PC (${plan.ghConnected?.local ? "connecté" : "non connecté"}), ` +
            `Oracle (${plan.ghConnected?.oracle ? "connecté" : "non connecté"})`
        ),
        el(
          "div",
          { class: "text-sm" },
          el("strong", {}, "Espace Oracle libre : "),
          formatBytes(plan.oracleDiskFree)
        )
      );

      // Projets concernés
      const projSection = el("div", { class: "transfer-section" });
      projSection.append(el("h3", { class: "transfer-section-title" }, "Projets à transférer"));
      if (!concerned.length) {
        projSection.append(el("p", { class: "text-muted text-sm" }, "Aucun projet concerné par les tâches actuelles."));
      } else {
        const projList = el("ul", { class: "transfer-item-list" });
        for (const p of concerned) {
          const modText = p.dirtyCount > 0 ? `${p.dirtyCount} fichier(s) modifié(s)` : "propre";
          projList.append(
            el(
              "li",
              { class: "transfer-item" },
              el("span", { class: "font-medium" }, p.name),
              el("span", { class: "text-muted text-xs" }, `${modText} → ${p.oracleDir}`)
            )
          );
        }
        projSection.append(projList);
      }

      // Tâches en cours
      const taskSection = el("div", { class: "transfer-section" });
      taskSection.append(el("h3", { class: "transfer-section-title" }, "Tâches à réaffecter"));
      if (!plan.tasks?.length) {
        taskSection.append(el("p", { class: "text-muted text-sm" }, "Aucune tâche en cours ou à faire."));
      } else {
        const taskList = el("ul", { class: "transfer-item-list" });
        for (const t of plan.tasks) {
          taskList.append(
            el(
              "li",
              { class: "transfer-item" },
              el("span", {}, t.title),
              el("span", { class: "text-muted text-xs" }, `[${t.status}]`)
            )
          );
        }
        taskSection.append(taskList);
      }

      // Agents à arrêter
      const agentSection = el("div", { class: "transfer-section" });
      agentSection.append(el("h3", { class: "transfer-section-title" }, "Agents à arrêter"));
      if (!plan.agents?.length) {
        agentSection.append(el("p", { class: "text-muted text-sm" }, "Aucun agent lié à arrêter."));
      } else {
        const agentList = el("ul", { class: "transfer-item-list" });
        for (const a of plan.agents) {
          agentList.append(
            el(
              "li",
              { class: "transfer-item" },
              el("span", {}, a.task || a.id),
              el("span", { class: "text-muted text-xs" }, `agent ${a.id.slice(0, 8)}`)
            )
          );
        }
        agentSection.append(agentList);
      }

      body.append(overviewCard, projSection, taskSection, agentSection);

      // Si un statut ou une exécution est en cours ou terminée, afficher la liste des étapes
      if (currentStatus || isRunning) {
        const stepSection = el("div", { class: "transfer-section" });
        stepSection.append(el("h3", { class: "transfer-section-title" }, "Progression du transfert"));

        const stepper = el("div", { class: "transfer-stepper" });
        const curStep = currentStatus?.step || "checking";
        const curState = currentStatus?.state || "idle";
        const isFailed = curState.startsWith("failed") || curState.startsWith("partial");
        const curIdx = STEPS.findIndex((s) => s.id === curStep);

        for (let i = 0; i < STEPS.length; i++) {
          const st = STEPS[i];
          let statusText = "En attente";
          let itemClass = "";

          if (curState === "done") {
            statusText = "Terminé";
            itemClass = "is-done";
          } else if (i < curIdx) {
            statusText = "Terminé";
            itemClass = "is-done";
          } else if (i === curIdx) {
            if (isFailed) {
              statusText = `Échec (${currentStatus.error || "erreur"})`;
              itemClass = "is-failed";
            } else {
              statusText = "En cours…";
              itemClass = "is-active";
            }
          }

          stepper.append(
            el(
              "div",
              { class: `transfer-step-item ${itemClass}`, "data-step": st.id },
              el("span", { class: "transfer-step-name" }, `${i + 1}. ${st.label}`),
              el("span", { class: "transfer-step-status" }, statusText)
            )
          );
        }
        stepSection.append(stepper);

        // Journal des événements
        stepSection.append(
          el("h3", { class: "transfer-section-title", style: "margin-top: var(--space-2)" }, "Journal des événements"),
          el("div", { class: "transfer-events-log", id: "transfer-events-log" })
        );

        body.append(stepSection);
        updateEventsLog();
      }
    }

    // Rendu du pied de page
    footer.replaceChildren();

    // Options (Simulation, extinction, forçage)
    const optionsEl = el("div", { class: "transfer-footer-options" });

    // Case simulation
    const dryRunCheck = el("input", {
      type: "checkbox",
      id: "transfer-dry-run",
      checked: dryRun,
      disabled: isRunning,
      onchange: (e) => {
        dryRun = e.target.checked;
        render();
      },
    });
    optionsEl.append(
      el(
        "label",
        { class: "check", style: "font-weight: 500" },
        dryRunCheck,
        " Simulation (aucune action réelle)"
      )
    );

    // Information ou option d'extinction
    if (dryRun) {
      optionsEl.append(
        el("div", { class: "text-muted text-xs", id: "transfer-shutdown-info" }, "Le mini-PC ne sera PAS éteint.")
      );
    } else {
      const shutdownCheck = el("input", {
        type: "checkbox",
        id: "transfer-confirm-shutdown",
        checked: confirmShutdown,
        disabled: isRunning,
        onchange: (e) => {
          confirmShutdown = e.target.checked;
        },
      });
      optionsEl.append(
        el(
          "label",
          { class: "check text-xs", style: "color: var(--danger)" },
          shutdownCheck,
          " Éteindre le mini-PC après transfert (compte à rebours 60 s annulable)"
        )
      );
    }

    // Si forçage requis
    if (currentPlan?.forceRequired) {
      const forceCheck = el("input", {
        type: "checkbox",
        id: "transfer-force",
        checked: force,
        disabled: isRunning,
        onchange: (e) => {
          force = e.target.checked;
          render();
        },
      });
      optionsEl.append(
        el(
          "label",
          { class: "check text-xs", style: "color: var(--warning)" },
          forceCheck,
          " Forcer le transfert malgré les avertissements"
        )
      );
    }

    // Boutons d'action
    const actionsEl = el("div", { class: "transfer-footer-actions" });

    // Bouton Annuler
    const cancelBtn = el(
      "button",
      {
        class: "btn",
        type: "button",
        id: "transfer-cancel-btn",
        onclick: handleCancel,
      },
      isRunning ? "Interrompre" : "Annuler"
    );

    // Bouton Lancer
    const canLaunch =
      Boolean(currentPlan) &&
      (currentPlan.ok || (currentPlan.forceRequired && force)) &&
      !isRunning &&
      currentStatus?.state !== "done";

    const launchBtn = el(
      "button",
      {
        class: dryRun ? "btn btn-primary" : "btn btn-danger",
        type: "button",
        id: "transfer-run-btn",
        disabled: !canLaunch,
        onclick: handleRun,
      },
      dryRun ? "Lancer la simulation" : "Lancer le transfert"
    );

    actionsEl.append(cancelBtn, launchBtn);
    footer.append(optionsEl, actionsEl);
  }

  dialog.addEventListener("close", cleanup);
  document.body.append(dialog);
  dialog.showModal();

  // Premier appel pour récupérer le plan
  send({ type: "transfer.plan" });
  render();
}
