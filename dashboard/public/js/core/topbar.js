// Barre du haut : nom, sélecteur de vues (contrôle segmenté : Bureau, Tâches, Projets, Sessions…), Lancer, thème.
import { el, icons, iconEl } from "./util.js";
import { getViews, onViewsChange } from "../views/registry.js";
import { setupLauncher } from "./launcher.js";
import { toggleTheme, currentTheme, onThemeChange } from "./theme.js";
import { subscribe, getState, pendingAgents } from "./state.js";
import { openAgentDrawer } from "./drawer.js";
import { on, send, onConnection } from "./socket.js";
import { toggleSideChat, setSideChatButton } from "../components/llmchat.js";
import { toggleJarvis, setJarvisButton } from "../components/jarvis.js";
import { subscribeAgentMode, openAgentModeDialog, disableAgentMode } from "../components/agentmode.js";
import { initAgentActivityPanel } from "../components/agentactivity.js";
import { createTelegramButton } from "../components/hermesChat.js";
import "./gatewaymodels.js";
import { createQuotaGauge } from "../components/quota.js";
import { subscribeAlerts, alertCount } from "../components/agentalerts.js";
import { confirmDialog } from "./confirm.js";
import { subscribeCoord, teamBadgeCount, unreadGroups } from "../components/coordteam.js";

const BRAND_MARK = '<svg viewBox="0 0 24 24" class="brand-mark" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="4" width="18" height="12" rx="2.5"/>' +
  '<path d="M8 20h8M12 16v4M7 9.5l2.5 2L7 13.5M12 13.5h4"/></svg>';

const CHAT_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 4h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7l-4 3V6a2 2 0 0 1 2-2z"/></svg>';

let tablist;
let viewSwitch;   // bouton unique « vue courante ▾ » ; les autres vues sont dans le menu déroulant
let viewMenu;
let pendingButton;
let pendingText;
let pendingLed;
let themeButton;
let actionsEl;
let active = "bureau";
let unreadCount = 0;

function updatePageTitle() {
  const base = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
}

// T34 : nombre d'alertes de l'agent (demande en attente depuis plus de 2 min, session muette) : badge de l'onglet Agent
// et de la pastille « Jarvis ». Recalculé toutes les 10 s (les seuils dépendent de l'heure).
let agentAlerts = 0;
function renderAgentAlerts() {
  agentAlerts = alertCount();
  renderSwitch();
  const badge = tablist?.querySelector("#tab-agent .tab-badge");
  if (badge) {
    badge.textContent = String(agentAlerts);
    badge.hidden = agentAlerts === 0;
  }
  const pill = document.getElementById("agentmode-badge");
  if (pill) {
    pill.classList.toggle("is-alert", agentAlerts > 0);
    pill.querySelector(".agentmode-pill-alert")?.remove();
    if (agentAlerts > 0) {
      pill.append(el("span", { class: "agentmode-pill-alert" },
        ` · ${agentAlerts} attente${agentAlerts > 1 ? "s" : ""}`));
    }
    pill.title = agentAlerts > 0
      ? `Un agent attend ta réponse ou semble bloqué (${agentAlerts}) : ouvrez la vue Agent`
      : "Jarvis, agent aux commandes (cliquer pour voir le mandat)";
  }
}

// T36 : projets où plusieurs sessions travaillent ensemble (ou dont une session ne peut pas être contrainte) : badge « Équipe » de l'onglet Agent.
let teamCount = 0;
function renderTeamBadge() {
  const badge = tablist?.querySelector("#tab-agent .team-badge");
  if (badge) {
    badge.textContent = String(teamCount);
    badge.hidden = teamCount === 0;
  }
}
let groupsUnread = 0;
function renderGroupsBadge() {
  renderSwitch();
  const badge = tablist?.querySelector("#tab-groupes .tab-badge");
  if (badge) { badge.textContent = String(groupsUnread); badge.hidden = groupsUnread === 0; }
}
subscribeCoord((boards) => { teamCount = teamBadgeCount(boards); renderTeamBadge(); groupsUnread = unreadGroups(boards); renderGroupsBadge(); });

export function setInboxUnread(count) {
  unreadCount = Math.max(0, Number(count) || 0);
  updatePageTitle();
  renderSwitch();
  const badge = tablist?.querySelector("#tab-reception .tab-badge");
  if (badge) {
    badge.textContent = String(unreadCount);
    badge.hidden = unreadCount === 0;
  } else if (tablist) {
    renderTabs();
  }
}

function setViewMenu(open) {
  viewMenu.hidden = !open;
  viewSwitch.setAttribute("aria-expanded", String(open));
  if (open) (viewMenu.querySelector('[aria-selected="true"]') || viewMenu.querySelector("a"))?.focus();
}

function renderSwitch() {
  if (!viewSwitch) return;
  const current = getViews().find((v) => v.id === active);
  const alerts = unreadCount + groupsUnread + agentAlerts;
  viewSwitch.replaceChildren(...[el("span", { class: "viewswitch-label" }, current?.title || "Vues"),
    alerts > 0 ? el("span", { class: "tab-badge viewswitch-badge", title: "Éléments à voir dans les autres vues" }, String(alerts)) : null,
    el("span", { class: "viewswitch-caret", "aria-hidden": "true" }, "▾")].filter(Boolean));
}

function renderTabs() {
  const links = getViews().map((view) => {
    const icon = el("span", { class: "tab-icon" });
    icon.innerHTML = view.icon || "";
    const badge = view.id === "reception"
      ? el("span", { class: "tab-badge", hidden: unreadCount === 0 }, String(unreadCount))
      : view.id === "agents" // page Agents (ex-Groupes et ex-Agent) : alertes d'agents, sinon conversations non lues
        ? (agentAlerts
          ? el("span", { class: "tab-badge tab-badge-alert", id: "agent-tab-badge", title: "Un agent attend ta réponse ou semble bloqué" }, String(agentAlerts))
          : el("span", { class: "tab-badge", hidden: groupsUnread === 0, title: "Projets avec des messages non lus" }, String(groupsUnread)))
        : null;
    const team = view.id === "agents"
      ? el("span", { class: "team-badge", id: "team-tab-badge", hidden: teamCount === 0,
        title: "Équipe : projets où plusieurs sessions travaillent ensemble" }, String(teamCount))
      : null;
    return el("a", {
      href: `#${view.id}`, role: "tab", id: `tab-${view.id}`, "aria-selected": String(view.id === active),
      "aria-controls": "view", tabindex: view.id === active ? "0" : "-1", dataset: { view: view.id },
      onclick: () => setViewMenu(false),
    }, icon, el("span", { class: "tab-long" }, view.title),
    el("span", { class: "tab-short" }, view.short || view.title), badge, team);
  });
  viewMenu.replaceChildren(...links);
  renderSwitch();
}

function onTabKeys(event) {
  const keys = { ArrowRight: 1, ArrowLeft: -1, Home: "first", End: "last" };
  if (!(event.key in keys)) return;
  const tabs = [...viewMenu.querySelectorAll("a")];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  const step = keys[event.key];
  const next = step === "first" ? 0 : step === "last" ? tabs.length - 1 : (index + step + tabs.length) % tabs.length;
  tabs[next].focus();
  location.hash = tabs[next].getAttribute("href");
}

function renderPending(state) {
  const waiting = pendingAgents(state);
  pendingButton.classList.toggle("has-pending", waiting.length > 0);
  pendingButton.setAttribute("aria-disabled", String(waiting.length === 0));
  pendingText.textContent = `${waiting.length} en attente`;
  pendingButton.title = waiting.length
    ? "Ouvrir l’agent qui attend une permission"
    : "Aucun agent n’attend de permission";
  pendingLed.className = `led ${waiting.length ? "led-attention led-pulse" : "led-inactif"}`;
}

function renderTheme() {
  const dark = currentTheme() === "dark";
  themeButton.innerHTML = dark ? icons.sun : icons.moon;
  themeButton.setAttribute("aria-label", dark ? "Passer au thème clair" : "Passer au thème sombre");
  themeButton.title = dark ? "Thème clair" : "Thème sombre";
}

export function initTopbar(root) {
  tablist = el("nav", { class: "viewbar", "aria-label": "Vues" });
  viewSwitch = el("button", { class: "btn btn-sm viewswitch", type: "button", id: "viewswitch", "aria-haspopup": "menu",
    "aria-expanded": "false", "aria-controls": "viewmenu", title: "Changer de vue", onclick: () => setViewMenu(viewMenu.hidden) });
  viewMenu = el("div", { class: "viewmenu", id: "viewmenu", role: "tablist", "aria-label": "Vues", hidden: true });
  tablist.append(viewSwitch, viewMenu);
  viewMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { setViewMenu(false); viewSwitch.focus(); return; }
    onTabKeys(event);
  });
  document.addEventListener("pointerdown", (event) => { if (!viewMenu.hidden && !tablist.contains(event.target)) setViewMenu(false); });
  const railToggle = el("button", {
    class: "icon-btn rail-toggle", type: "button", "aria-label": "Machines et projets",
    onclick: () => document.body.classList.toggle("rail-open"),
  });
  railToggle.innerHTML = icons.menu;
  const brand = el("a", { class: "brand", href: "#bureau", "aria-label": "Poste de commande Paseo" },
    el("span", { class: "brand-name" }, "Poste de commande"));
  brand.insertAdjacentHTML("afterbegin", BRAND_MARK);

  pendingLed = el("span", { class: "led led-inactif" });
  pendingText = el("span", { class: "pending-text" });
  pendingButton = el("button", { class: "pending", type: "button", "aria-live": "polite" }, pendingLed, pendingText);
  pendingButton.addEventListener("click", () => {
    const first = pendingAgents(getState())[0];
    if (first) openAgentDrawer(first.host, first.agentId);
  });

  const launch = el("button", { class: "btn btn-primary btn-sm", type: "button", id: "launch-open", "aria-label": "Lancer une session" },
    iconEl(icons.plus), el("span", { class: "launch-text" }, " Lancer"));
  const chatButton = el("button", {
    class: "btn btn-sm", type: "button", id: "topbar-sidechat",
    "aria-expanded": "false", "aria-controls": "sidechat",
    title: "Discussion avec un LLM (Ctrl+Maj+L)",
    onclick: () => toggleSideChat(),
  }, iconEl(CHAT_ICON), " Discussion");
  setSideChatButton(chatButton);
  const jarvisButton = el("button", {
    class: "btn btn-sm", type: "button", id: "topbar-jarvis", "aria-expanded": "false", "aria-controls": "jarvis-panel",
    title: "Parler à Jarvis, l'orchestrateur (comme sur Telegram)",
    onclick: () => toggleJarvis(),
  }, iconEl(CHAT_ICON), " Jarvis");
  setJarvisButton(jarvisButton);
  themeButton = el("button", { class: "icon-btn", type: "button", onclick: toggleTheme });

  const agentModeEl = el("div", { class: "agentmode-topbar", id: "agentmode-topbar" });
  function renderAgentMode(mode) {
    agentModeEl.replaceChildren();
    if (mode?.enabled) {
      const proj = mode.project ? ` — ${mode.project}` : "";
      const badge = el(
        "span",
        {
          class: "agentmode-pill",
          id: "agentmode-badge",
          title: "Jarvis, agent aux commandes (cliquer pour voir le mandat)",
          role: "button",
          tabindex: "0",
          "aria-label": `Jarvis, agent aux commandes${proj} : voir le mandat`,
          onclick: () => openAgentModeDialog(),
          onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAgentModeDialog(); } },
        },
        `Jarvis${proj}`
      );
      const takeoverBtn = el(
        "button",
        {
          class: "btn btn-sm btn-agentmode-takeover",
          id: "agentmode-takeover-btn",
          type: "button",
          title: "Reprendre la main",
          onclick: () => disableAgentMode(),
        },
        "Reprendre la main"
      );
      agentModeEl.append(badge, takeoverBtn);
    } else {
      const btn = el(
        "button",
        {
          class: "btn btn-sm",
          id: "agentmode-btn",
          type: "button",
          title: "Passer en mode Agent",
          onclick: () => openAgentModeDialog(),
        },
        "Mode Agent"
      );
      agentModeEl.append(btn);
    }
  }
  subscribeAgentMode((mode) => { renderAgentMode(mode); renderAgentAlerts(); });
  subscribeAlerts(renderAgentAlerts);
  setInterval(renderAgentAlerts, 10000);
  initAgentActivityPanel();

  // Arrêt d'urgence (ex-Cockpit) : accessible depuis toutes les pages. Handlers serveur : handlers/emergency.mjs.
  const emergencyButton = el("button", { class: "btn btn-sm btn-danger-ghost", type: "button", id: "topbar-emergency" });
  let stopped = false;
  const renderEmergency = () => {
    emergencyButton.classList.toggle("btn-danger", stopped);
    emergencyButton.classList.toggle("btn-danger-ghost", !stopped);
    emergencyButton.replaceChildren(el("span", { class: "emergency-text" }, stopped ? "Reprendre" : "Arrêt d’urgence"),
      el("span", { class: "emergency-short", "aria-hidden": "true" }, stopped ? "▶" : "■"));
    emergencyButton.setAttribute("aria-label", stopped ? "Arrêt d’urgence actif : reprendre les agents autonomes" : "Arrêt d’urgence des agents autonomes");
    emergencyButton.title = stopped ? "Arrêt d’urgence ACTIF : cliquer pour reprendre" : "Bloquer immédiatement tous les agents autonomes";
  };
  emergencyButton.addEventListener("click", async () => {
    if (stopped) { send({ type: "emergency.resume" }); return; }
    const ok = await confirmDialog({ title: "Arrêt d'urgence", message: "Bloquer immédiatement tous les agents autonomes ?", confirmLabel: "Tout arrêter", danger: true });
    if (ok) send({ type: "emergency.stop", reason: "arrêt depuis la barre du haut" });
  });
  on("emergency.state", (m) => { stopped = Boolean(m?.stopped); renderEmergency(); });
  onConnection((up) => up && send({ type: "emergency.status" }));
  renderEmergency();

  actionsEl = el("div", { class: "topbar-actions" }, agentModeEl, emergencyButton, pendingButton, launch, createTelegramButton(), themeButton, createQuotaGauge());

  root.replaceChildren(railToggle, brand, tablist, actionsEl);
  setupLauncher(launch);
  renderTabs();
  renderTheme();
  renderPending(getState());
  onViewsChange(renderTabs);
  onThemeChange(renderTheme);
  subscribe(renderPending);
  on("inbox.changed", (m) => setInboxUnread(m?.unreadCount));
  on("inbox.list", (m) => setInboxUnread(m?.unreadCount));
  // Le compteur de l'onglet doit être juste même si la Boîte de réception n'a jamais été ouverte.
  onConnection((up) => up && send({ type: "inbox.list" }));

  return {
    setActive(id) {
      // renderTabs reconstruit les onglets: on rend le focus à l'onglet actif si l'utilisateur naviguait au clavier.
      const hadFocus = tablist.contains(document.activeElement);
      active = id;
      renderTabs();
      updatePageTitle();
      if (hadFocus) viewMenu.querySelector('[aria-selected="true"]')?.focus();
    },
    // Ajoute un bouton d'action avant le bouton de thème : { id, label, title?, icon?, onClick }.
    addAction({ id, label, title, icon, onClick }) {
      const button = el("button", { class: "btn btn-sm", type: "button", id: `topbar-${id}`, title: title || label,
        onclick: onClick });
      if (icon) button.innerHTML = icon;
      button.append(label);
      actionsEl.insertBefore(button, themeButton);
      return () => button.remove();
    },
  };
}
