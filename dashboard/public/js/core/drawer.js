// Tiroir droit réutilisable : détail d'un agent, d'une tâche ou de tout contenu fourni par une vue.
import { el, icons, agentStatus, formatDuration } from "./util.js";
import { getState, subscribe, findAgent } from "./state.js";
import { mountAgentPanel } from "./agentfeed.js";
import { hostLabel, harnessLabel, sessionName, modelDisplay } from "./names.js";

let root;
let titleEl;
let subtitleEl;
let metaEl;
let actionsEl;
let bodyEl;
let cleanup = null;
let returnFocus = null;
let onCloseCallback = null;

export function initDrawer(element) {
  root = element;
  titleEl = el("h2", { class: "drawer-title", tabindex: "-1" });
  subtitleEl = el("p", { class: "drawer-subtitle" });
  metaEl = el("p", { class: "drawer-meta mono" });
  actionsEl = el("div", { class: "drawer-actions" });
  bodyEl = el("div", { class: "drawer-body" });
  const closeButton = el("button", {
    class: "icon-btn", type: "button", "aria-label": "Fermer le tiroir (Échap)", title: "Fermer (Échap)",
    onclick: () => closeDrawer(),
  });
  closeButton.innerHTML = icons.close;
  root.append(
    el("header", { class: "drawer-head" },
      el("div", { class: "drawer-head-text" }, titleEl, subtitleEl, metaEl), closeButton),
    actionsEl,
    bodyEl,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isDrawerOpen() || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]") || event.target.closest?.(".xterm")) return;
    closeDrawer();
  });
}

export const isDrawerOpen = () => Boolean(root) && !root.hidden;

export function closeDrawer() {
  if (!root || root.hidden) return;
  cleanup?.();
  cleanup = null;
  root.hidden = true;
  document.body.classList.remove("drawer-open");
  bodyEl.replaceChildren();
  actionsEl.replaceChildren();
  onCloseCallback?.();
  onCloseCallback = null;
  returnFocus?.focus?.();
  returnFocus = null;
}

// openDrawer({ title, subtitle, meta, actions: [{ label, onClick }], build(body) -> cleanup?, onClose })
export function openDrawer({ title, subtitle = "", meta = "", actions = [], build, onClose }) {
  if (!root) return;
  if (isDrawerOpen()) {
    cleanup?.();
    onCloseCallback?.();
  } else {
    returnFocus = document.activeElement;
  }
  onCloseCallback = onClose || null;
  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;
  metaEl.textContent = meta;
  actionsEl.replaceChildren(...actions.map((a) =>
    el("button", { class: "btn btn-sm", type: "button", onclick: a.onClick }, a.label)));
  bodyEl.replaceChildren();
  cleanup = build?.(bodyEl) || null;
  root.hidden = false;
  document.body.classList.add("drawer-open");
  titleEl.focus({ preventScroll: true });
}

export function updateDrawerHeader({ title, subtitle, meta }) {
  if (title != null) titleEl.textContent = title;
  if (subtitle != null) subtitleEl.textContent = subtitle;
  if (meta != null) metaEl.textContent = meta;
}

const agentTitle = (agent, agentId) => sessionName({
  project: agent?.cwd,
  host: agent?.host,
  provider: agent?.provider,
  model: agent?.model,
  title: agent?.title,
  kind: "agent",
  id: agentId,
});
function agentSubtitle(agent) {
  if (!agent) return "Agent introuvable (archivé ou supprimé)";
  const { label } = agentStatus(agent.status);
  const model = `${harnessLabel(agent.provider)} · ${agent.model ? modelDisplay(agent.provider, agent.model) : "—"}`;
  return `${hostLabel(agent.host)} · ${model} · ${label} · ${formatDuration(agent.duration)}`;
}

// Ouvre le fil en direct d'un agent avec ses permissions, l'envoi de messages et l'arrêt.
export function openAgentDrawer(host, agentId, { actions = [] } = {}) {
  const agent = findAgent(getState(), host, agentId);
  let panel;
  openDrawer({
    title: agentTitle(agent, agentId),
    subtitle: agentSubtitle(agent),
    meta: agent?.cwd || "",
    actions,
    build(body) {
      panel = mountAgentPanel(body, { host, agentId });
      panel.update(agent);
      const off = subscribe((state) => {
        const fresh = findAgent(state, host, agentId);
        updateDrawerHeader({
          title: agentTitle(fresh, agentId), subtitle: agentSubtitle(fresh), meta: fresh?.cwd || "",
        });
        panel.update(fresh);
      });
      return () => {
        off();
        panel.destroy();
      };
    },
  });
}
