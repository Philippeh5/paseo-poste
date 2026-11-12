// Bandeau de reprise automatique sous la barre du haut (note N14 / T25).
import { el, icons, iconEl } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";

let bannerEl = null;
let currentStatus = null;

const STATE_CONFIG = {
  idle: {
    label: "Surveillance désarmée",
    badgeClass: "failover-badge-armed",
    icon: icons.power || "•",
  },
  monitoring: {
    label: "Surveillance armée — mini-PC sous contrôle",
    badgeClass: "failover-badge-armed",
    icon: icons.shield || "✓",
  },
  suspect: {
    label: "Mini-PC suspect — pings sans réponse",
    badgeClass: "failover-badge-suspect",
    icon: icons.alert || "⚠",
  },
  unreachable: {
    label: "Mini-PC injoignable",
    badgeClass: "failover-badge-unreachable",
    icon: icons.alert || "⚠",
  },
  resuming: {
    label: "Reprise en cours sur Oracle…",
    badgeClass: "failover-badge-resuming",
    icon: icons.spinner || "⟳",
  },
  resumed: {
    label: "Reprise terminée sur Oracle",
    badgeClass: "failover-badge-resumed",
    icon: icons.check || "✓",
  },
  reclaim_available: {
    label: "Reprise terminée sur Oracle",
    badgeClass: "failover-badge-resumed",
    icon: icons.check || "✓",
  },
  reclaiming: {
    label: "Rapatriement des tâches en cours…",
    badgeClass: "failover-badge-resuming",
    icon: icons.spinner || "⟳",
  },
  resume_failed: {
    label: "Échec de reprise sur Oracle",
    badgeClass: "failover-badge-unreachable",
    icon: icons.alert || "⚠",
  },
};

function render() {
  if (!bannerEl) return;
  const s = currentStatus;

  // Invisible quand rien à signaler et non armé
  const hasResumedTasks = Array.isArray(s?.resumedTasks) && s.resumedTasks.length > 0;
  const isInterestingState = s?.state && !["idle", "monitoring"].includes(s.state);
  const shouldShow = Boolean(s?.armed || hasResumedTasks || isInterestingState);

  if (!shouldShow) {
    bannerEl.hidden = true;
    bannerEl.replaceChildren();
    return;
  }

  bannerEl.hidden = false;
  const st = STATE_CONFIG[s?.state] || STATE_CONFIG.idle;

  // Badge d'état
  const badge = el(
    "span",
    { class: `failover-banner-badge ${st.badgeClass}`, id: "failover-badge" },
    st.label
  );

  // Détails facultatifs (tâches reprises, injoignable depuis...)
  const details = [];
  if (hasResumedTasks) {
    details.push(`${s.resumedTasks.length} tâche(s) active(s) sur Oracle`);
  }
  if (s?.unreachableSince) {
    const t = new Date(s.unreachableSince).toLocaleTimeString();
    details.push(`injoignable depuis ${t}`);
  }
  const detailEl = details.length
    ? el("span", { class: "text-muted text-xs", id: "failover-detail" }, `(${details.join(" · ")})`)
    : null;

  const infoEl = el("div", { class: "failover-banner-info" }, badge, detailEl);

  // Actions
  const actions = [];

  // Bouton Reprendre la main si des tâches sont sur Oracle ou reclaim_available
  const canReclaim = s?.state === "reclaim_available" || s?.state === "resumed" || hasResumedTasks;
  if (canReclaim && s?.state !== "reclaiming") {
    const reclaimBtn = el(
      "button",
      {
        class: "btn btn-sm btn-primary",
        type: "button",
        id: "failover-reclaim-btn",
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Reprendre la main",
            message: "Rapatrier les tâches exécutées sur Oracle vers la machine principale ?",
            confirmLabel: "Reprendre la main",
          });
          if (ok) {
            send({ type: "failover.reclaim", confirm: true });
          }
        },
      },
      "Reprendre la main"
    );
    actions.push(reclaimBtn);
  }

  // Bouton Armer / Désarmer
  if (s?.armed) {
    const disarmBtn = el(
      "button",
      {
        class: "btn btn-sm",
        type: "button",
        id: "failover-toggle-btn",
        title: "Désactiver la surveillance automatique",
        onclick: () => send({ type: "failover.disarm" }),
      },
      "Désarmer"
    );
    actions.push(disarmBtn);
  } else {
    const armBtn = el(
      "button",
      {
        class: "btn btn-sm btn-primary",
        type: "button",
        id: "failover-toggle-btn",
        title: "Activer la surveillance automatique",
        onclick: () => send({ type: "failover.arm" }),
      },
      "Armer"
    );
    actions.push(armBtn);
  }

  const actionsEl = el("div", { class: "failover-banner-actions" }, ...actions);
  bannerEl.replaceChildren(infoEl, actionsEl);
}

export function initFailoverBanner(container) {
  bannerEl = container;

  on("failover.status", (m) => {
    currentStatus = m;
    render();
  });

  on("failover.armed", (m) => {
    if (currentStatus) currentStatus.armed = true;
    render();
  });

  on("failover.disarmed", (m) => {
    if (currentStatus) currentStatus.armed = false;
    render();
  });

  on("failover.reclaim.result", (m) => {
    if (m?.state && currentStatus) currentStatus.state = m.state;
    render();
  });

  onConnection((up) => {
    if (up) send({ type: "failover.status" });
  });

  // Requête initiale
  send({ type: "failover.status" });
  render();
}

export function getFailoverStatus() {
  return currentStatus;
}
