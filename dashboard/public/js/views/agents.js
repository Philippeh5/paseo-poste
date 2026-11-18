// Page « Agents » : qui fait quoi, où, est-ce bloqué ? Fusion des anciennes vues Sessions, Projets, Agent, Groupes, Chronologie et
// Tâches (leurs ancres mènent ici : voir ALIASES dans main.js). Données : handlers/agentsoverview.mjs (agents du daemon ET terminaux
// d'agents, avec dernière action, état « en attente », fichiers réservés, tâche liée, quota).
// Panneau de droite (clic sur un projet ou sur « Conversations / Tâches / Historique / Orchestrateur ») : on y monte le code de
// rendu des anciennes vues, devenues des composants (components/groupesPanel.js, tasksPanel.js, timelinePanel.js, orchestratorPanel.js).
// SÉCURITÉ : libellés, statuts et lignes d'écran viennent de sessions externes (données NON FIABLES) : uniquement des nœuds texte
// (el() crée des nœuds texte), jamais innerHTML.
import { registerView } from "./registry.js";
import { el, icons, led, readPref, writePref } from "../core/util.js";
import { hostLabel, modelDisplay } from "../core/names.js";
import { getOverview, subscribeOverview, stateUi, agoText } from "../core/agentsoverview.js";
import { openAgentWindow, openTerminalWindow } from "../core/deskstore.js";
import { openAgentDrawer, openDrawer } from "../core/drawer.js";
import { subscribeCoord, getBoards, unreadOf, dirKey } from "../components/coordteam.js";
import groupesPanel from "../components/groupesPanel.js";
import tasksPanel from "../components/tasksPanel.js";
import timelinePanel from "../components/timelinePanel.js";
import orchestratorPanel from "../components/orchestratorPanel.js";

if (!document.querySelector("link[data-agents-css]")) {
  document.head.append(el("link", { rel: "stylesheet", href: "css/agents.css", "data-agents-css": "" }));
}

const GROUP_PREF = "paseo-agents-group";
const GROUPINGS = [["project", "Projet"], ["host", "Machine"], ["tool", "Outil"]];
const TABS = [
  { id: "conversation", label: "Conversation", panel: groupesPanel, opts: (p) => (p ? { dir: p.dir } : {}) },
  { id: "fiche", label: "Fiche projet", panel: groupesPanel, opts: (p) => ({ ...(p ? { dir: p.dir } : {}), brief: true }) },
  { id: "taches", label: "Tâches", panel: tasksPanel, opts: (p) => ({ project: p ? p.name : "" }) },
  { id: "historique", label: "Historique", panel: timelinePanel, opts: (p) => ({ project: p ? p.folder : "" }) },
  { id: "orchestrateur", label: "Orchestrateur", panel: orchestratorPanel, opts: () => ({}) },
];
// Anciennes ancres → onglet du panneau (main.js les redirige vers #agents ; l'ancre d'origine reste lisible ici).
const TAB_OF_HASH = { groupes: "conversation", taches: "taches", chronologie: "historique", agent: "orchestrateur" };
const STATE_FILTERS = [["", "Tous"], ["active", "Actifs"], ["waiting", "En attente"], ["blocked", "Bloqués"], ["idle", "Au repos"]];

let ctx = null;
let root = null;
let listBox = null;
let summaryBox = null;
let panelBox = null;
let filterSelect = null;
let stops = [];
let timer = null;
let signature = "";
let grouping = readPref(GROUP_PREF, "project");
if (!GROUPINGS.some(([id]) => id === grouping)) grouping = "project";
let stateFilter = "";
let panel = null; // { project|null, tab, mod }
let pendingTab = TAB_OF_HASH[decodeURIComponent(location.hash.slice(1))] || null;

window.addEventListener("hashchange", (event) => {
  const from = decodeURIComponent(new URL(event.newURL).hash.slice(1));
  if (!TAB_OF_HASH[from]) return;
  if (root) openPanel(null, TAB_OF_HASH[from]);
  else pendingTab = TAB_OF_HASH[from];
});

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const folderOf = (dir) => String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";
const projectRef = (a) => ({ key: a.project.key, name: a.project.name, dir: a.project.dir, host: a.host, folder: folderOf(a.project.dir) });

// ---------- Actions sur un agent ----------
function openOnDesk(a) {
  if (a.kind === "terminal") openTerminalWindow(a.host, a.terminalId, { cwd: a.cwd, tool: a.tool });
  else openAgentWindow(a.host, a.agentId, { cwd: a.cwd, title: a.title });
  ctx.navigate("bureau");
}

function readTerminal(a) {
  if (a.kind === "agent") {
    openAgentDrawer(a.host, a.agentId, { actions: [{ label: "Ouvrir sur le Bureau", onClick: () => openOnDesk(a) }] });
    return;
  }
  openDrawer({
    title: `${a.toolName} · ${a.project.name}`,
    subtitle: `${hostLabel(a.host)} · terminal ${String(a.terminalId).slice(0, 8)}`,
    meta: a.cwd || "",
    actions: [{ label: "Ouvrir sur le Bureau", onClick: () => openOnDesk(a) }],
    build(body) {
      const pre = el("pre", { class: "ag-scrollback", id: "ag-scrollback", "aria-live": "polite", tabindex: "0" }, "Lecture de l'écran…");
      const note = el("p", { class: "muted ag-scrollback-note" }, "200 dernières lignes, sans couleurs, relues toutes les 5 s. Texte affiché tel quel (donnée de la session).");
      body.append(note, pre);
      const ask = () => ctx.send({ type: "windows.scrollback", host: a.host, terminalId: a.terminalId, lines: 200 });
      const off = ctx.on("windows.scrollback", (m) => {
        if (m.terminalId !== a.terminalId) return;
        const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        pre.textContent = (Array.isArray(m.lines) ? m.lines : []).join("\n") || "(écran vide)";
        if (stick) pre.scrollTop = pre.scrollHeight;
      });
      ask();
      const t = setInterval(ask, 5000);
      return () => { off(); clearInterval(t); };
    },
  });
}

async function sendMessage(a) {
  const text = await ctx.prompt({
    title: `Message à ${a.label || a.toolName}`,
    label: a.kind === "terminal" ? "Texte tapé dans son terminal (suivi d'Entrée)" : "Message envoyé à la session",
    confirmLabel: "Envoyer", maxLength: 1000,
  });
  if (!text) return;
  if (a.kind === "agent") ctx.send({ type: "agent.send", host: a.host, agentId: a.agentId, text });
  // Terminal connu de la coordination : le poste tape le message (signé « Philippe ») ; sinon saisie directe confirmée.
  else if (a.registered) ctx.send({ type: "coord.send", to: a.key, text });
  else ctx.send({ type: "windows.send", host: a.host, terminalId: a.terminalId, text, enter: true, confirm: true });
  ctx.toast("Message envoyé.");
}

async function stopAgent(a) {
  const terminal = a.kind === "terminal";
  const ok = await ctx.confirm({
    title: terminal ? "Fermer ce terminal ?" : "Arrêter cet agent ?",
    message: terminal
      ? `Le terminal de ${a.label || a.toolName} (${hostLabel(a.host)}) sera fermé : l'agent qui y tourne s'arrête aussitôt, son travail non enregistré est perdu.`
      : `${a.label || a.toolName} (${hostLabel(a.host)}) reçoit une demande d'interruption : il s'arrête à la fin de l'étape en cours.`,
    confirmLabel: terminal ? "Fermer le terminal" : "Arrêter", danger: true,
  });
  if (!ok) return;
  if (terminal) ctx.send({ type: "term.kill", host: a.host, terminalId: a.terminalId });
  else ctx.send({ type: "agent.stop", host: a.host, agentId: a.agentId });
  ctx.toast(terminal ? "Terminal fermé." : "Arrêt demandé.");
}

// ---------- Rendu ----------
// Le libellé n'apporte rien quand il répète « outil · projet » (libellé automatique d'un terminal lancé par le poste).
const showLabel = (a) => {
  const l = String(a.label || "").toLowerCase();
  return Boolean(l) && ![a.toolName, a.tool].some((t) => l === `${String(t).toLowerCase()} · ${a.project.name.toLowerCase()}`);
};
function agentCard(a) {
  const ui = stateUi(a.state);
  const attention = a.state === "waiting" || a.state === "blocked";
  const model = a.model ? modelDisplay(a.tool, a.model) : "";
  const btn = (label, action, onclick, cls = "") => el("button", { type: "button", class: `btn btn-sm ${cls}`.trim(), dataset: { action }, onclick }, label);
  const meta = [];
  if (a.files?.length) {
    meta.push(el("span", { class: "ag-meta-item", dataset: { meta: "files" } }, el("span", { class: "label-caps" }, "Réservé "),
      ...a.files.slice(0, 4).flatMap((f, i) => [i ? ", " : "", el("code", {}, f)]), a.files.length > 4 ? ` +${a.files.length - 4}` : ""));
  }
  if (a.task) meta.push(el("span", { class: "ag-meta-item", dataset: { meta: "task" } }, el("span", { class: "label-caps" }, "Tâche "), a.task.title || a.task.id, a.task.status ? ` (${a.task.status})` : ""));
  if (a.quota) {
    meta.push(el("span", { class: `ag-meta-item ag-quota is-${a.quota.state}`, dataset: { meta: "quota" }, title: a.quota.detail || "" },
      el("span", { class: "label-caps" }, "Quota "), `${a.quota.name}${a.quota.usedPct != null ? ` ${a.quota.usedPct} %` : ""}`,
      a.quota.state === "exhausted" ? " · épuisé" : a.quota.state === "slow" ? " · ralenti" : ""));
  }
  const ago = a.lastActivityAt ? el("span", { class: "ag-ago num", dataset: { at: a.lastActivityAt, approx: a.approx ? "1" : "" } }, agoText(a.lastActivityAt, { approx: a.approx })) : null;
  return el("article", {
    class: `ag-card is-${a.state}`, dataset: { key: a.key, state: a.state, kind: a.kind, tool: a.tool },
    "aria-label": `${a.toolName}, ${a.project.name}, ${ui.label}`,
  },
  el("div", { class: "ag-head" },
    el("span", { class: "ag-status" }, led(ui.tone, { pulse: a.state === "active" || attention, label: ui.label }),
      el("span", { class: "ag-state" }, ui.label)),
    el("strong", { class: "ag-tool" }, a.toolName),
    model ? el("span", { class: "ag-model muted" }, model) : null,
    el("span", { class: "ag-chip", title: "Machine" }, hostLabel(a.host)),
    grouping !== "project" ? el("span", { class: "ag-chip", title: a.project.dir || "" }, a.project.name) : null,
    a.kind === "terminal" ? el("span", { class: "ag-chip mono", title: `Terminal ${a.terminalId}` }, `term ${String(a.terminalId).slice(0, 4)}`) : null,
    attention ? el("span", { class: "pastille ag-pastille" }, a.reason === "permission" ? "Permission" : a.reason === "question" ? "Question" : ui.label) : null),
  showLabel(a) ? el("p", { class: "ag-label muted" }, a.label) : null,
  el("p", { class: "ag-action" }, a.lastAction
    ? [el("span", { class: "label-caps" }, a.lastActionSource === "statut" ? "Dit faire " : a.lastActionSource === "terminal" ? "Dernière action " : "Mission "), `« ${a.lastAction} »`]
    : el("span", { class: "muted" }, a.kind === "terminal" ? "Pas encore de ligne lue sur son écran." : "Aucune action déclarée.")),
  el("p", { class: "ag-statetext" }, a.stateText, ago ? " · dernier signe de vie " : "", ago),
  meta.length ? el("div", { class: "ag-meta" }, ...meta) : null,
  a.pending?.length ? el("p", { class: "ag-pending" }, el("span", { class: "label-caps" }, "Demande "), a.pending[0].title) : null,
  el("div", { class: "ag-actions" },
    btn("Ouvrir sur le Bureau", "desk", () => openOnDesk(a), "btn-primary"),
    a.pending?.length ? btn("Répondre", "answer", () => readTerminal(a)) : null,
    btn(a.kind === "terminal" ? "Lire le terminal" : "Lire le fil", "read", () => readTerminal(a)),
    btn("Envoyer un message", "message", () => sendMessage(a)),
    btn("Arrêter", "stop", () => stopAgent(a), "btn-danger-ghost")));
}

function countsText(list) {
  const c = { active: 0, waiting: 0, blocked: 0, idle: 0 };
  for (const a of list) if (a.state in c) c[a.state] += 1;
  return [c.active && plural(c.active, "actif", "actifs"), c.waiting && `${c.waiting} en attente`, c.blocked && plural(c.blocked, "bloqué", "bloqués"),
    c.idle && `${c.idle} au repos`].filter(Boolean).join(" · ") || "aucun agent";
}

function groupsOf(list) {
  const map = new Map();
  for (const a of list) {
    const key = grouping === "host" ? a.host : grouping === "tool" ? a.tool : a.project.key;
    if (!map.has(key)) {
      map.set(key, {
        key, agents: [],
        title: grouping === "host" ? hostLabel(a.host) : grouping === "tool" ? a.toolName : a.project.name,
        sub: grouping === "project" ? hostLabel(a.host) : "",
        project: grouping === "project" ? projectRef(a) : null,
      });
    }
    map.get(key).agents.push(a);
  }
  return [...map.values()];
}

function groupBlock(g) {
  const board = g.project ? getBoards().find((b) => dirKey(b.project.dir) === dirKey(g.project.dir)) : null;
  const unread = board ? unreadOf(board) : 0;
  const selected = panel?.project && g.project && panel.project.key === g.project.key;
  const head = g.project
    ? el("button", {
      type: "button", class: `ag-group-head${selected ? " is-selected" : ""}`, dataset: { project: g.title },
      "aria-pressed": String(Boolean(selected)), title: `${g.project.dir} — ouvrir la conversation, la fiche, les tâches et l'historique du projet`,
      onclick: () => openPanel(g.project, panel?.project?.key === g.project.key ? panel.tab : "conversation"),
    }, el("strong", {}, g.title), el("span", { class: "muted" }, g.sub), el("span", { class: "ag-group-counts muted" }, countsText(g.agents)),
    unread ? el("span", { class: "tab-badge", title: "Messages non lus dans la conversation du projet" }, String(unread)) : null,
    el("span", { class: "ag-group-open" }, "Conversation, fiche, tâches →"))
    : el("div", { class: "ag-group-head is-static" }, el("strong", {}, g.title), el("span", { class: "ag-group-counts muted" }, countsText(g.agents)));
  return el("section", { class: "ag-group", "aria-label": g.title }, head, el("div", { class: "ag-cards" }, ...g.agents.map(agentCard)));
}

function renderSummary(all) {
  if (!summaryBox) return;
  const c = { active: 0, waiting: 0, blocked: 0 };
  for (const a of all) if (a.state in c) c[a.state] += 1;
  const item = (state, n, text) => el("button", {
    type: "button", class: `ag-count${stateFilter === state ? " is-on" : ""}`, dataset: { count: state }, "aria-pressed": String(stateFilter === state),
    title: stateFilter === state ? "Afficher tous les agents" : `N'afficher que : ${text}`,
    onclick: () => { stateFilter = stateFilter === state ? "" : state; signature = ""; render(); },
  }, led(stateUi(state).tone, { label: stateUi(state).label }), el("span", { class: "num" }, String(n)), ` ${text}`);
  summaryBox.replaceChildren(
    item("active", c.active, c.active > 1 ? "actifs" : "actif"), el("span", { class: "muted", "aria-hidden": "true" }, "·"),
    item("waiting", c.waiting, "en attente"), el("span", { class: "muted", "aria-hidden": "true" }, "·"),
    item("blocked", c.blocked, c.blocked > 1 ? "bloqués" : "bloqué"));
}

function render() {
  if (!root) return;
  const { agents } = getOverview();
  const sig = JSON.stringify([grouping, stateFilter, panel?.project?.key, agents, getBoards().map((b) => [b.project.dir, unreadOf(b)])]);
  if (sig === signature) return;
  signature = sig;
  renderSummary(agents);
  if (filterSelect) filterSelect.value = stateFilter;
  const shown = stateFilter ? agents.filter((a) => a.state === stateFilter) : agents;
  if (!agents.length) {
    listBox.replaceChildren(el("div", { class: "empty-state ag-empty" },
      el("h2", {}, "Aucun agent en cours"),
      el("p", {}, "Les agents lancés dans un terminal (Claude Code, FreeBuff, Pi…) ou par le daemon apparaissent ici, avec leur projet, leur machine et leur dernière action."),
      el("button", { type: "button", class: "btn btn-primary", onclick: () => ctx.launcher.open({ kind: "agent" }) }, "Lancer un agent")));
    return;
  }
  listBox.replaceChildren(...(shown.length ? groupsOf(shown).map(groupBlock)
    : [el("p", { class: "muted ag-none" }, "Aucun agent dans cet état. ", el("button", { type: "button", class: "btn btn-sm", onclick: () => { stateFilter = ""; signature = ""; render(); } }, "Tout afficher"))]));
}

// Les durées (« il y a 40 s ») avancent sans reconstruire les cartes (un clic en cours ne tombe jamais sur un élément remplacé).
function tickAgo() {
  for (const node of root?.querySelectorAll(".ag-ago[data-at]") || []) node.textContent = agoText(node.dataset.at, { approx: node.dataset.approx === "1" });
}

// ---------- Panneau de droite ----------
function closePanel() {
  try { panel?.mod?.unmount(); } catch (e) { console.error("agents panel unmount", e); }
  panel = null;
  if (panelBox) { panelBox.hidden = true; panelBox.replaceChildren(); }
  root?.classList.remove("has-panel");
  signature = "";
  render();
}

function openPanel(project, tabId) {
  if (!root) return;
  const tab = TABS.find((t) => t.id === tabId) || TABS[0];
  try { panel?.mod?.unmount(); } catch (e) { console.error("agents panel unmount", e); }
  const body = el("div", { class: "ag-panel-body", id: "ag-panel-body" });
  panel = { project, tab: tab.id, mod: tab.panel };
  const tabs = el("div", { class: "ag-tabs", role: "tablist", "aria-label": "Sections du panneau" },
    ...TABS.map((t) => el("button", {
      type: "button", role: "tab", class: `ag-tab${t.id === tab.id ? " is-on" : ""}`, dataset: { agentsTab: t.id },
      "aria-selected": String(t.id === tab.id), onclick: () => openPanel(panel?.project ?? null, t.id),
    }, t.label)));
  panelBox.replaceChildren(
    el("header", { class: "ag-panel-head" },
      el("button", { type: "button", class: "btn btn-sm ag-panel-back", onclick: closePanel }, "← Agents"),
      el("h2", {}, project ? project.name : "Tous les projets"),
      project ? el("span", { class: "muted" }, hostLabel(project.host)) : null,
      project ? el("button", { type: "button", class: "btn btn-sm", title: "Afficher ces sections pour tous les projets", onclick: () => openPanel(null, panel.tab) }, "Tous les projets") : null,
      el("button", { type: "button", class: "icon-btn ag-panel-close", "aria-label": "Fermer le panneau", title: "Fermer le panneau", onclick: closePanel },
        el("span", { "aria-hidden": "true" }, "×"))),
    tabs, body);
  panelBox.hidden = false;
  root.classList.add("has-panel");
  try {
    tab.panel.mount(body, ctx, tab.opts(project));
  } catch (e) {
    console.error("agents panel mount", tab.id, e);
    body.replaceChildren(el("p", { class: "muted" }, "Cette section ne s'est pas chargée ; rechargez la page."));
  }
  signature = "";
  render();
}

const view = {
  id: "agents",
  title: "Agents",
  short: "Agents",
  icon: icons.agent,
  order: 15,
  rail: "none", // la page a son propre regroupement par projet
  mount(container, context) {
    ctx = context;
    signature = "";
    summaryBox = el("div", { class: "ag-summary", id: "ag-summary", "aria-live": "polite" });
    listBox = el("div", { class: "ag-list", id: "ag-list" });
    panelBox = el("aside", { class: "ag-panel", id: "ag-panel", hidden: true, "aria-label": "Détail du projet" });
    const groupSelect = el("select", { class: "select-sm", id: "ag-group", "aria-label": "Grouper par",
      onchange: (e) => { grouping = e.target.value; writePref(GROUP_PREF, grouping); signature = ""; render(); } },
    ...GROUPINGS.map(([id, label]) => el("option", { value: id, selected: id === grouping }, label)));
    filterSelect = el("select", { class: "select-sm", id: "ag-filter", "aria-label": "Filtrer par état",
      onchange: (e) => { stateFilter = e.target.value; signature = ""; render(); } },
    ...STATE_FILTERS.map(([id, label]) => el("option", { value: id }, label)));
    const openBtn = (tab, label) => el("button", { type: "button", class: "btn btn-sm", dataset: { agentsOpen: tab }, onclick: () => openPanel(null, tab) }, label);
    root = el("div", { class: "view-page ag-page", id: "ag-page" },
      el("div", { class: "view-toolbar ag-toolbar" },
        el("h1", { class: "view-title" }, "Agents"), summaryBox,
        el("label", { class: "check" }, "Grouper par ", groupSelect),
        el("label", { class: "check" }, "État ", filterSelect),
        el("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => ctx.launcher.open({ kind: "agent" }) }, "Lancer un agent")),
      el("div", { class: "ag-shortcuts", role: "group", "aria-label": "Voir pour tous les projets" },
        el("span", { class: "label-caps" }, "Tous les projets"),
        openBtn("conversation", "Conversations"), openBtn("taches", "Tâches"), openBtn("historique", "Historique"), openBtn("orchestrateur", "Orchestrateur")),
      el("div", { class: "ag-layout" }, listBox, panelBox));
    container.replaceChildren(root);
    stops = [
      subscribeOverview(() => render()),
      subscribeCoord(() => render()),
    ];
    ctx.send({ type: "agents.overview" });
    ctx.send({ type: "coord.get" });
    timer = setInterval(() => { if (!document.hidden) tickAgo(); }, 5000);
    render();
    if (pendingTab) { const t = pendingTab; pendingTab = null; openPanel(null, t); }
  },
  unmount() {
    clearInterval(timer);
    stops.forEach((fn) => fn());
    stops = [];
    try { panel?.mod?.unmount(); } catch (e) { console.error("agents panel unmount", e); }
    panel = null;
    root = listBox = summaryBox = panelBox = filterSelect = null;
    ctx = null;
  },
};

registerView(view);
export default view;
