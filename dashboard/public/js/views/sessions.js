import { registerView } from "./registry.js";
import {
  el, icons, folderName, agentStatus, hostStatus, formatDuration, led, readPref, writePref,
} from "../core/util.js";
import { openAgentDrawer } from "../core/drawer.js";
import { openAgentWindow } from "../core/deskstore.js";
import { hostLabel, harnessLabel, sessionName } from "../core/names.js";

const PREF = "paseo-sessions-closed";
let cleanups = [];
let root = null;
let ctx = null;
let showClosed = false;
let signature = "";

function projectOf(state, agent) {
  const workspace = state.workspaces.find((w) => w.host === agent.host && w.workspaceId === agent.workspaceId);
  const directory = workspace?.directory || agent.cwd || "";
  return { key: directory.toLowerCase(), name: folderName(directory) || "Projet inconnu", directory };
}

function agentRow(agent, depth) {
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
  const open = () => openAgentDrawer(agent.host, agent.agentId, {
    actions: [{
      label: "Ouvrir sur le Bureau",
      onClick: () => {
        openAgentWindow(agent.host, agent.agentId, { cwd: agent.cwd, title: agent.title });
        location.hash = "#bureau";
      },
    }],
  });
  return el("button", {
    class: `agent-row${attention ? " is-attention" : ""}`, type: "button", style: `--depth:${depth}`, onclick: open,
    "data-host": agent.host, "data-agent": agent.agentId,
  },
    led(status.tone, { pulse: attention || status.tone === "ok", label: status.label }),
    el("span", { class: "agent-main" },
      el("strong", {}, name),
      el("span", { class: "agent-meta" }, `${harnessLabel(agent.provider)} · ${agent.model || "—"}`),
    ),
    attention && el("span", { class: "pastille" }, "Permission requise"),
    el("span", { class: "agent-status" }, status.label),
    el("span", { class: "agent-dur num" },
      agent.status === "closed" ? "" : formatDuration(agent.duration)),
  );
}

function agentTree(agents, parentId, depth, seen) {
  const rows = [];
  for (const agent of agents.filter((a) => (a.parentAgentId || null) === parentId)) {
    if (seen.has(agent.agentId)) continue;
    seen.add(agent.agentId);
    rows.push(el("li", { class: "tree-item" }, agentRow(agent, depth), (() => {
      const kids = agentTree(agents, agent.agentId, depth + 1, seen);
      return kids.length ? el("ul", { class: "tree-list" }, kids) : null;
    })()));
  }
  return rows;
}

function build(state) {
  const visible = state.agents.filter((a) => showClosed || a.status !== "closed");
  const closedCount = state.agents.length - state.agents.filter((a) => a.status !== "closed").length;
  const ids = new Set(visible.map((a) => a.agentId));
  const toggle = el("label", { class: "check" },
    el("input", { type: "checkbox", checked: showClosed, onchange: (e) => {
      showClosed = e.target.checked;
      writePref(PREF, showClosed ? "1" : "0");
      signature = "";
      render();
    } }),
    ` Afficher les agents fermés (${closedCount})`,
  );
  const hosts = state.hosts.map((host) => {
    const mine = visible.filter((a) => a.host === host.label);
    // Un sous-agent dont le parent est masqué ou absent remonte à la racine.
    const parentOf = (a) => (a.parentAgentId && ids.has(a.parentAgentId) ? a.parentAgentId : null);
  const orphans = new Map(mine.map((a) => [a.agentId, parentOf(a)]));
    const flat = mine.map((a) => ({ ...a, parentAgentId: orphans.get(a.agentId) }));
    const projects = new Map();
    for (const agent of flat) {
      const p = projectOf(state, agent);
      if (!projects.has(p.key)) projects.set(p.key, { ...p, agents: [] });
      projects.get(p.key).agents.push(agent);
    }
    const hs = hostStatus(host.status);
    const mLabel = hostLabel(host);
    return el("section", { class: "tree-host", "aria-label": `Machine ${mLabel}` },
      el("header", { class: "tree-host-head" },
        led(hs.tone, { pulse: hs.tone === "attention", label: hs.label }),
        el("h2", {}, mLabel),
        el("span", { class: "muted" }, `${hs.label} · ${mine.length} agent${mine.length > 1 ? "s" : ""}`),
      ),
      projects.size
        ? [...projects.values()].map((p) => el("div", { class: "tree-project" },
          el("h3", {}, p.name, el("span", { class: "mono muted" }, ` ${p.directory}`)),
          el("ul", { class: "tree-list root" }, agentTree(p.agents, null, 0, new Set()))))
        : el("p", { class: "muted tree-none" },
        host.status === "connected" ? "Aucune session active." : "Machine hors ligne."),
    );
  });
  return el("div", { class: "view-page" },
    el("div", { class: "view-toolbar" }, el("h1", { class: "view-title" }, "Sessions"), toggle),
    el("div", { class: "tree" }, hosts.length ? hosts : el("p", { class: "muted" }, "Aucune machine configurée.")),
  );
}

function render() {
  if (!root) return;
  const state = ctx.state;
  const sig = JSON.stringify([state.hosts.map((h) => [h.label, h.status, h.displayName]), showClosed,
    state.agents.map((a) => [a.host, a.agentId, a.status, a.title, a.parentAgentId, a.workspaceId, a.cwd, a.model])]);
  if (sig !== signature) {
    signature = sig;
    root.replaceChildren(build(state));
  }
  for (const node of root.querySelectorAll(".agent-dur")) {
    const agent = state.agents.find((a) => a.agentId === node.closest(".agent-row").dataset.agent);
    if (agent && agent.status !== "closed") node.textContent = formatDuration(agent.duration);
  }
}

const view = {
  id: "sessions",
  title: "Sessions",
  short: "Sessions",
  icon: icons.sessions,
  order: 30,
  mount(container, context) {
    ctx = context;
    showClosed = readPref(PREF) === "1";
    signature = "";
    root = el("div", { class: "view-host" });
    container.replaceChildren(root);
    cleanups = [ctx.onState(render)];
    render();
  },
  unmount() {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    root = null;
  },
};

registerView(view);
export default view;
