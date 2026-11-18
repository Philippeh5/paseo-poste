// Rail gauche : machines (voyants) puis « Projets suivis » avec leurs agents et terminaux.
// Chaque élément se glisse sur le Bureau ; le bouton + ouvre un terminal dans le dossier du projet.
// Les terminaux où tourne un agent (Claude Code, FreeBuff…) s'affichent comme des agents, avec leur état, d'après
// agents.overview (core/agentsoverview.js) : sans cela, le rail ne montrait que des « terminaux » anonymes.
import { el, icons, iconEl, agentStatus, hostStatus, led } from "./util.js";
import { subscribe, getState, followedProjects, agentsOfProject, terminalsOfProject } from "./state.js";
import { openAgentWindow, openTerminalWindow, openTerminalInFolder, getWindows, closeWindow, subscribeDesk } from "./deskstore.js";
import { send } from "./socket.js";
import { confirmDialog } from "./confirm.js";
import { toast } from "./toast.js";
import { isSelected, selectProject, isCollapsed, toggleCollapsed, onSelectionChange, getSelectedProject } from "./selection.js";
import { projectExtras, projectMenuButton, projectsToolbar, projectsHint, projectsSignature, isStarred, toggleStar } from "./projects.js";
import { hostLabel, sessionName, gatewayModelsVersion } from "./names.js";
import { getOverview, subscribeOverview, overviewOfTerminal, stateUi } from "./agentsoverview.js";

const DROP_TYPE = "application/x-paseo-item";
const MAX_AGENTS = 8;
const MAX_TERMINALS = 6;
const extraSections = [];
let root;
let signature = "";
let customRender = null; // rail d'une vue qui dessine elle-même sa colonne (champ `rail` du registre)

function draggable(node, payload) {
  node.draggable = true;
  node.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData(DROP_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", payload.label || "");
    event.dataTransfer.effectAllowed = "copy";
  });
  return node;
}

const closeRail = () => document.body.classList.remove("rail-open");
function goDesk() {
  if (location.hash !== "#bureau") location.hash = "#bureau";
  closeRail();
}

function machineRow(host, state) {
  const hs = hostStatus(host.status);
  const mLabel = hostLabel(host);
  const count = state.agents.filter((a) => a.host === host.label && a.status !== "closed").length;
  const row = el("button", {
    class: "rail-item", type: "button",
    title: `${mLabel} · ${hs.label} — glisser sur le Bureau pour ouvrir un terminal`,
    onclick: () => {
      location.hash = `#connexions`;
      closeRail();
    },
  },
    led(hs.tone, { pulse: hs.tone === "attention", label: hs.label }),
    el("span", { class: "grow" }, mLabel),
    el("small", {}, `${hs.label}${count ? ` · ${count} agent${count > 1 ? "s" : ""}` : ""}`),
  );
  return draggable(row, { kind: "machine", host: host.label, label: mLabel });
}

function agentRow(agent) {
  const status = agentStatus(agent.status);
  const attention = agent.status === "waiting-permission";
  const name = sessionName({
    project: agent.cwd || agent.workspaceId,
    host: agent.host,
    provider: agent.provider,
    model: agent.model,
    title: agent.title,
    kind: "agent",
    id: agent.agentId,
  });
  const row = el("button", {
    class: `rail-item${attention ? " is-attention" : ""}`, type: "button",
    title: `${name} · ${status.label}`,
    onclick: () => {
      openAgentWindow(agent.host, agent.agentId, { cwd: agent.cwd, title: agent.title });
      goDesk();
    },
  },
    led(status.tone, { pulse: attention, label: status.label }),
    el("span", { class: "grow" }, name),
    attention && el("small", {}, "permission"),
  );
  return draggable(row, {
    kind: "agent", host: agent.host, agentId: agent.agentId, cwd: agent.cwd, title: agent.title,
    label: name,
  });
}

function terminalRow(terminal) {
  const agent = overviewOfTerminal(terminal.host, terminal.terminalId);
  if (agent) return terminalAgentRow(terminal, agent);
  const name = sessionName({
    project: terminal.cwd || terminal.workspaceId,
    host: terminal.host,
    provider: "terminal",
    kind: "terminal",
    id: terminal.terminalId,
  });
  const row = el("button", {
    class: "rail-item", type: "button", title: name,
    onclick: () => {
      openTerminalWindow(terminal.host, terminal.terminalId, { cwd: terminal.cwd, workspaceId: terminal.workspaceId });
      goDesk();
    },
  }, iconEl(icons.terminal),
  el("span", { class: "grow" }, name));
  return draggable(row, {
    kind: "terminal", host: terminal.host, terminalId: terminal.terminalId, cwd: terminal.cwd,
    label: name,
  });
}

// Terminal d'agent : voyant + état en texte (jamais la couleur seule), dernière action en infobulle (texte brut).
function terminalAgentRow(terminal, agent) {
  const ui = stateUi(agent.state);
  const attention = agent.state === "waiting" || agent.state === "blocked";
  const name = `${agent.toolName} · ${agent.project.name}`;
  const row = el("button", {
    class: `rail-item${attention ? " is-attention" : ""}`, type: "button", dataset: { agentState: agent.state },
    title: `${name} · ${agent.stateText}${agent.lastAction ? ` — ${agent.lastAction}` : ""}`,
    onclick: () => {
      openTerminalWindow(terminal.host, terminal.terminalId, { cwd: terminal.cwd, workspaceId: terminal.workspaceId, tool: agent.tool });
      goDesk();
    },
  },
    led(ui.tone, { pulse: agent.state === "active" || attention, label: ui.label }),
    el("span", { class: "grow" }, name),
    el("small", {}, ui.label.toLowerCase()),
  );
  return draggable(row, {
    kind: "terminal", host: terminal.host, terminalId: terminal.terminalId, cwd: terminal.cwd,
    label: name,
  });
}

const ACTIVE = new Set(["running", "initializing", "waiting-permission"]);
const live = (state) => (state.agents || []).filter((a) => a.status !== "closed");

// Ferme des terminaux et des sessions d'agents. `stop` : arrête aussi celles qui travaillent encore.
async function closeSessions({ terminals = [], agents = [] }, what, { stop = false } = {}) {
  const working = stop ? agents.filter((a) => ACTIVE.has(a.status)).length : 0;
  const total = terminals.length + agents.length;
  if (!total) {
    toast("Rien à fermer.");
    return;
  }
  const parts = [];
  if (agents.length) parts.push(`${agents.length} session${agents.length > 1 ? "s" : ""} d'agent`);
  if (terminals.length) parts.push(`${terminals.length} terminal${terminals.length > 1 ? "aux" : ""}`);
  const ok = await confirmDialog({
    title: "Tout fermer ?",
    message: `${parts.join(" et ")} de ${what} ${total > 1 ? "seront fermés" : "sera fermé"}.${working ? ` Attention : ${working} travaille${working > 1 ? "nt" : ""} encore et ser${working > 1 ? "ont" : "a"} arrêtée${working > 1 ? "s" : ""}.` : ""}`,
    confirmLabel: "Fermer", danger: true,
  });
  if (!ok) return;
  for (const t of terminals) send({ type: "term.kill", host: t.host, terminalId: t.terminalId });
  for (const a of agents) send({ type: "agent.close", host: a.host, agentId: a.agentId, stop });
  toast(`${total} session${total > 1 ? "s" : ""} fermée${total > 1 ? "s" : ""}.`);
}

// « Inactifs » = agents au repos (ni en cours ni en attente de permission) et terminaux affichés dans aucune fenêtre du Bureau.
function inactive(state) {
  const shown = new Set(getWindows().filter((w) => w.type === "terminal").map((w) => `${w.host}|${w.terminalId}`));
  return {
    terminals: (state.terminals || []).filter((t) => !shown.has(`${t.host}|${t.terminalId}`)),
    agents: live(state).filter((a) => !ACTIVE.has(a.status)),
  };
}

function globalCloseBar(state) {
  const idle = inactive(state);
  const idleCount = idle.terminals.length + idle.agents.length;
  const all = { terminals: state.terminals || [], agents: live(state) };
  const allCount = all.terminals.length + all.agents.length;
  const btn = (label, title, onclick, disabled) => el("button", {
    class: "btn btn-sm", type: "button", title, onclick, disabled: disabled || null,
  }, label);
  return el("div", { class: "rail-closebar" },
    btn(`Fermer les inactifs (${idleCount})`, "Ferme les sessions d'agents au repos et les terminaux non affichés ; ceux qui travaillent ne sont pas touchés",
      () => closeSessions(idle, "toutes les pages (inactifs)"), !idleCount),
    btn(`Tout fermer (${allCount})`, "Ferme TOUT : terminaux et sessions d'agents, même ceux qui travaillent",
      async () => {
        await closeSessions(all, "toutes les machines", { stop: true });
        for (const w of [...getWindows()]) if (w.type === "terminal") closeWindow(w.id);
      }, !allCount),
  );
}

function projectBlock(project, state) {
  const agents = agentsOfProject(state, project).filter((a) => a.status !== "closed");
  const isAgent = (t) => Number(Boolean(overviewOfTerminal(t.host, t.terminalId)));
  const terminals = terminalsOfProject(state, project).sort((a, b) => isAgent(b) - isAgent(a)); // terminaux d'agents d'abord
  const mLabel = hostLabel(project.host);
  const add = el("button", {
    class: "icon-btn", type: "button", title: "Ouvrir un terminal dans ce dossier",
    "aria-label": `Ouvrir un terminal dans ${project.name} (${mLabel})`,
    onclick: () => {
      openTerminalInFolder({ host: project.host, cwd: project.directory, navigate: true });
      closeRail();
    },
  });
  add.innerHTML = icons.plus;
  const starred = isStarred(project);
  const star = el("button", {
    class: `icon-btn rail-star${starred ? " is-on" : ""}`, type: "button", "aria-pressed": String(starred),
    title: starred ? "Retirer des favoris" : "Mettre en favori (les favoris passent en premier)",
    "aria-label": `${starred ? "Retirer" : "Mettre"} ${project.name} ${starred ? "des" : "en"} favoris`,
    onclick: () => toggleStar(project),
  }, starred ? "★" : "☆");
  const collapsed = isCollapsed(project);
  const count = agents.length + terminals.length;
  const chevron = el("button", {
    class: "icon-btn rail-chevron", type: "button",
    title: collapsed ? "Déplier les sessions" : "Replier les sessions",
    "aria-expanded": String(!collapsed),
    "aria-label": `${collapsed ? "Déplier" : "Replier"} les sessions de ${project.name}`,
    onclick: () => toggleCollapsed(project),
  });
  chevron.innerHTML = collapsed ? icons.chevronRight : icons.chevronDown;
  const selected = isSelected(project);
  const headRow = el("button", {
    class: `rail-item rail-project-name${selected ? " is-selected" : ""}`, type: "button",
    title: `${project.directory} — clic : sélectionner ; re-clic : désélectionner (sans sélection, les raccourcis s'ouvrent dans le dossier des projets)`,
    "aria-pressed": String(selected),
    onclick: () => selectProject(isSelected(project) ? null : project),
  }, el("span", { class: "grow" }, project.name), count ? el("small", {}, String(count)) : null, el("small", {}, mLabel));
  const head = draggable(headRow, {
    kind: "project", host: project.host, cwd: project.directory, label: project.name,
  });
  const idleAgents = agents.filter((a) => !ACTIVE.has(a.status));
  const closable = terminals.length + idleAgents.length;
  const closeAll = closable ? el("button", {
    class: "icon-btn", type: "button", title: `Fermer les ${closable} terminaux et sessions au repos de ce projet`,
    "aria-label": `Fermer les terminaux et sessions au repos de ${project.name}`,
    onclick: () => closeSessions({ terminals, agents: idleAgents }, `le projet « ${project.name} »`),
  }) : null;
  if (closeAll) closeAll.innerHTML = icons.trash;
  const children = [
    ...agents.slice(0, MAX_AGENTS).map(agentRow),
    agents.length > MAX_AGENTS &&
      el("p", { class: "rail-more" }, `+ ${agents.length - MAX_AGENTS} autres (voir Agents)`),
    ...terminals.slice(0, MAX_TERMINALS).map(terminalRow),
    terminals.length > MAX_TERMINALS &&
      el("p", { class: "rail-more" }, `+ ${terminals.length - MAX_TERMINALS} terminaux`),
  ].filter(Boolean);
  return el("div", { class: `rail-project${selected ? " is-selected" : ""}` },
    el("div", { class: "rail-project-head" }, chevron, star, head, add, closeAll, projectMenuButton(project)),
    projectExtras(project),
    children.length && !collapsed ? el("div", { class: "rail-children" }, children) : null,
  );
}

function compute(state) {
  return JSON.stringify([
    state.hosts.map((h) => [h.label, h.status, h.displayName]),
    state.workspaces.map((w) => [w.host, w.directory]),
    state.agents.map((a) => [a.host, a.agentId, a.status, a.title, a.workspaceId, a.cwd]),
    state.terminals.map((t) => [t.host, t.terminalId, t.name, t.cwd, t.workspaceId]),
    state.followedProjects ?? null,
    projectsSignature(),
    gatewayModelsVersion(),
    state.agents.map((a) => a.model),
    getSelectedProject()?.key ?? null,
    [...getWindows()].filter((w) => w.type === "terminal").map((w) => w.terminalId),
    getOverview().agents.filter((a) => a.kind === "terminal").map((a) => [a.host, a.terminalId, a.state, a.stateText, a.lastAction, a.tool, a.project.name]),
  ]);
}

function render() {
  if (!root) return;
  const state = getState();
  if (customRender) {
    const body = el("div", {});
    customRender(body, { state });
    root.replaceChildren(body);
    return;
  }
  const sig = compute(state);
  if (sig === signature) return;
  signature = sig;
  const { projects } = followedProjects(state); // liste commune à toutes les pages (core/state.js)
  // Un seul hôte : la section « Machines » n'apporte rien (l'état des machines est dans Connexions).
  const machines = state.hosts.length <= 1 ? null : el("section", { class: "rail-section", "aria-label": "Machines" },
    el("h2", { class: "label-caps" }, "Machines"),
    state.hosts.length
      ? state.hosts.map((h) => machineRow(h, state))
      : el("p", { class: "rail-empty" }, "Aucune machine."),
  );
  const followed = el("section", { class: "rail-section", "aria-label": "Projets suivis" },
    el("h2", { class: "label-caps" }, "Projets suivis"),
    projectsToolbar(),
    globalCloseBar(state),
    projectsHint() ? el("p", { class: "rail-hint" }, projectsHint()) : null,
    projects.length ? projects.map((p) => projectBlock(p, state)) : el("p", { class: "rail-empty" }, "Aucun projet."),
  );
  const extras = extraSections.map((section) => {
    const body = el("div", {});
    section.render(body, { state });
    return el("section", { class: "rail-section", "aria-label": section.title },
      el("h2", { class: "label-caps" }, section.title), body);
  });
  root.replaceChildren(...[machines, followed, ...extras].filter(Boolean));
}

export function initRail(element) {
  root = element;
  render();
  subscribe(render);
  onSelectionChange(() => { signature = ""; render(); });
  document.addEventListener("gateway-models", () => { signature = ""; render(); });
  subscribeDesk(() => render());
  subscribeOverview(() => render());
  document.querySelector(".rail-backdrop")?.addEventListener("click", closeRail);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("rail-open")) closeRail();
  });
  return {
    // Contenu propre à la page courante (null : retour au rail projets). Appelé par main.js à chaque changement de page.
    setContent(fn) {
      customRender = typeof fn === "function" ? fn : null;
      signature = "";
      render();
    },
    // Ajoute une section sous « Projets suivis » : { id, title, render(container, { state }) }.
    addSection(section) {
      extraSections.push(section);
      signature = "";
      render();
      return () => {
        extraSections.splice(extraSections.indexOf(section), 1);
        signature = "";
        render();
      };
    },
  };
}
