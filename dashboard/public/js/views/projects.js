// Vue « Projets » : sessions regroupées par projet suivi (note N02).
import { registerView } from "./registry.js";
import {
  el,
  led,
  agentStatus,
  formatDuration,
  readPref,
  writePref,
} from "../core/util.js";
import { openAgentWindow, openTerminalWindow } from "../core/deskstore.js";
import { hostLabel, harnessLabel, sessionName, projectLabel } from "../core/names.js";
import {
  projectExtras,
  githubPill,
  FOLDER_ICON,
  onProjectsChange,
} from "../core/projects.js";
import { send, on, onConnection } from "../core/socket.js";
import { getState, sameDir, dedupeProjects } from "../core/state.js";

const PREF_SHOW_CLOSED = "paseo-proj-view-closed";

if (!document.querySelector("link[data-projects-view-css]")) {
  document.head.append(
    el("link", { rel: "stylesheet", href: "css/projects-view.css", "data-projects-view-css": "" })
  );
}

let ctx = null;
let root = null;
let cleanups = [];
let signature = "";
let showClosed = false;
let serverProjects = [];

// Écoute de project.list pour connaître les projets suivis réels
on("project.list", (msg) => {
  if (Array.isArray(msg?.projects)) {
    serverProjects = msg.projects;
    render();
  }
});
onConnection((up) => {
  if (up) send({ type: "project.list" });
});

const normDir = (d) => String(d || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const sameDirLocal = (a, b) => Boolean(a && b) && normDir(a) === normDir(b);
const insideDir = (child, dir) => Boolean(child && dir) && `${normDir(child)}/`.startsWith(`${normDir(dir)}/`);

function sessionDir(state, session) {
  if (session.cwd) return session.cwd;
  if (session.workspaceId) {
    const ws = state.workspaces?.find((w) => w.host === session.host && w.workspaceId === session.workspaceId);
    if (ws?.directory) return ws.directory;
  }
  return "";
}

function getCollapsePref(key, defaultValue = false) {
  try {
    const raw = readPref(`paseo-proj-collapse-${key}`, null);
    return raw !== null ? raw === "1" : defaultValue;
  } catch {
    return defaultValue;
  }
}

function setCollapsePref(key, isCollapsed) {
  try {
    writePref(`paseo-proj-collapse-${key}`, isCollapsed ? "1" : "0");
  } catch {
    // stockage indisponible
  }
}

function renderSessionRow(state, session) {
  const isTerminal = session.kind === "terminal" || session.provider === "terminal";
  const status = isTerminal ? { label: "Actif", tone: "ok" } : agentStatus(session.status);
  const attention = !isTerminal && (session.status === "waiting-permission" || session.status === "waiting_permission");
  const sDir = sessionDir(state, session);
  const sName = sessionName({
    project: sDir || session.workspaceId,
    host: session.host,
    provider: isTerminal ? "terminal" : session.provider,
    model: isTerminal ? undefined : session.model,
    title: session.title,
    kind: isTerminal ? "terminal" : "agent",
    id: isTerminal ? session.terminalId : session.agentId,
  });

  const onClick = () => {
    if (isTerminal) {
      openTerminalWindow(session.host, session.terminalId, {
        cwd: session.cwd,
        workspaceId: session.workspaceId,
      });
    } else {
      openAgentWindow(session.host, session.agentId, {
        cwd: session.cwd,
        title: session.title,
      });
    }
    location.hash = "#bureau";
  };

  const mLabel = hostLabel(session.host);
  const hLabel = isTerminal ? "Terminal" : harnessLabel(session.provider);

  return el("li", { class: "proj-session-li" },
    el("button", {
      class: `proj-session-btn${attention ? " is-attention" : ""}`,
      type: "button",
      onclick: onClick,
      "data-host": session.host,
      "data-kind": isTerminal ? "terminal" : "agent",
      "data-id": isTerminal ? session.terminalId : session.agentId,
      title: `${sName} — Cliquer pour ouvrir sur le Bureau`,
    },
      led(status.tone, { pulse: attention || status.tone === "ok", label: status.label }),
      el("div", { class: "proj-session-main" },
        el("strong", { class: "proj-session-name" }, sName),
        el("div", { class: "proj-session-meta" },
          el("span", { class: "proj-session-pill" }, mLabel),
          el("span", { class: "proj-session-sep" }, "·"),
          el("span", { class: "proj-session-pill" }, hLabel),
          session.model ? el("span", { class: "proj-session-model muted mono" }, `(${session.model})`) : null,
        ),
      ),
      attention ? el("span", { class: "pastille" }, "Permission requise") : null,
      el("span", { class: "proj-session-status" }, status.label),
      !isTerminal && session.status !== "closed" && session.duration
        ? el("span", { class: "proj-session-dur num" }, formatDuration(session.duration))
        : null,
    ),
  );
}

function renderProjectCard(state, project, sessions) {
  const pKey = `${project.host}::${normDir(project.directory)}`;
  const isCollapsed = getCollapsePref(pKey, false);
  const cardId = `proj-sessions-${project.id || Math.abs(hashCode(pKey))}`;
  const mLabel = hostLabel(project.host);

  const toggleBtn = el("button", {
    class: "btn btn-sm proj-toggle-btn",
    type: "button",
    "aria-expanded": String(!isCollapsed),
    "aria-controls": cardId,
    title: isCollapsed ? "Afficher les sessions" : "Masquer les sessions",
  },
    el("span", { class: "proj-toggle-label" }, isCollapsed ? "Afficher les sessions" : "Masquer les sessions"),
    el("span", { class: "proj-toggle-icon", "aria-hidden": "true" }, isCollapsed ? "▸" : "▾"),
  );

  const sessionsContainer = el("div", {
    id: cardId,
    class: "proj-card-sessions",
    role: "region",
    "aria-label": `Sessions du projet ${project.name}`,
    hidden: isCollapsed,
  });

  const updateSessionsBody = (collapsed) => {
    if (collapsed) {
      sessionsContainer.hidden = true;
      sessionsContainer.replaceChildren();
    } else {
      sessionsContainer.hidden = false;
      if (!sessions.length) {
        sessionsContainer.replaceChildren(el("p", { class: "muted proj-empty" }, "Aucune session."));
      } else {
        sessionsContainer.replaceChildren(el("ul", { class: "proj-sessions-list" },
          sessions.map((s) => renderSessionRow(state, s)),
        ));
      }
    }
  };

  updateSessionsBody(isCollapsed);

  toggleBtn.addEventListener("click", () => {
    const nextCollapsed = toggleBtn.getAttribute("aria-expanded") === "true";
    toggleBtn.setAttribute("aria-expanded", String(!nextCollapsed));
    toggleBtn.title = nextCollapsed ? "Afficher les sessions" : "Masquer les sessions";
    toggleBtn.querySelector(".proj-toggle-label").textContent =
      nextCollapsed ? "Afficher les sessions" : "Masquer les sessions";
    toggleBtn.querySelector(".proj-toggle-icon").textContent =
      nextCollapsed ? "▸" : "▾";
    setCollapsePref(pKey, nextCollapsed);
    updateSessionsBody(nextCollapsed);
  });

  const extras = projectExtras(project) || el("div", { class: "proj-meta" }, githubPill(null));

  return el("article", {
    class: "proj-card",
    "data-project-id": project.id || pKey,
    "data-project-name": project.name,
    "data-project-host": project.host,
  },
    el("header", { class: "proj-card-header" },
      el("div", { class: "proj-card-info" },
        el("div", { class: "proj-card-top" },
          project.color
            ? el("span", { class: "proj-swatch", style: `background:${project.color}`, title: "Couleur du projet" })
            : null,
          el("h2", { class: "proj-card-title" }, project.name),
          el("span", { class: "proj-card-host mono muted" }, mLabel),
        ),
        el("div", { class: "proj-card-dir mono muted wrap" }, project.directory),
        extras,
      ),
      el("div", { class: "proj-card-actions" },
        el("span", { class: "proj-card-count num" }, `${sessions.length} session${sessions.length > 1 ? "s" : ""}`),
        toggleBtn,
      ),
    ),
    sessionsContainer,
  );
}

function renderOtherCard(state, otherSessions) {
  const isCollapsed = getCollapsePref("other", true);
  const cardId = "proj-sessions-other";

  const toggleBtn = el("button", {
    class: "btn btn-sm proj-toggle-btn",
    type: "button",
    "aria-expanded": String(!isCollapsed),
    "aria-controls": cardId,
    title: isCollapsed ? "Afficher les sessions" : "Masquer les sessions",
  },
    el("span", { class: "proj-toggle-label" }, isCollapsed ? "Afficher les sessions" : "Masquer les sessions"),
    el("span", { class: "proj-toggle-icon", "aria-hidden": "true" }, isCollapsed ? "▸" : "▾"),
  );

  const sessionsContainer = el("div", {
    id: cardId,
    class: "proj-card-sessions",
    role: "region",
    "aria-label": "Autres sessions",
    hidden: isCollapsed,
  });

  const updateSessionsBody = (collapsed) => {
    if (collapsed) {
      sessionsContainer.hidden = true;
      sessionsContainer.replaceChildren();
    } else {
      sessionsContainer.hidden = false;
      if (!otherSessions.length) {
        sessionsContainer.replaceChildren(el("p", { class: "muted proj-empty" }, "Aucune session."));
      } else {
        sessionsContainer.replaceChildren(el("ul", { class: "proj-sessions-list" },
          otherSessions.map((s) => renderSessionRow(state, s)),
        ));
      }
    }
  };

  updateSessionsBody(isCollapsed);

  toggleBtn.addEventListener("click", () => {
    const nextCollapsed = toggleBtn.getAttribute("aria-expanded") === "true";
    toggleBtn.setAttribute("aria-expanded", String(!nextCollapsed));
    toggleBtn.title = nextCollapsed ? "Afficher les sessions" : "Masquer les sessions";
    toggleBtn.querySelector(".proj-toggle-label").textContent =
      nextCollapsed ? "Afficher les sessions" : "Masquer les sessions";
    toggleBtn.querySelector(".proj-toggle-icon").textContent =
      nextCollapsed ? "▸" : "▾";
    setCollapsePref("other", nextCollapsed);
    updateSessionsBody(nextCollapsed);
  });

  return el("article", {
    class: "proj-card proj-card-other",
    "data-project-id": "other",
  },
    el("header", { class: "proj-card-header" },
      el("div", { class: "proj-card-info" },
        el("div", { class: "proj-card-top" },
          el("h2", { class: "proj-card-title" }, "Autres sessions"),
        ),
        el("p", { class: "muted", style: "font-size: var(--t-12)" },
          "Sessions qui n’appartiennent à aucun projet suivi."),
      ),
      el("div", { class: "proj-card-actions" },
        el("span", { class: "proj-card-count num" },
          `${otherSessions.length} session${otherSessions.length > 1 ? "s" : ""}`),
        toggleBtn,
      ),
    ),
    sessionsContainer,
  );
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function getFollowedList(state) {
  return dedupeProjects(rawFollowedList(state));
}
function rawFollowedList(state) {
  if (serverProjects.length > 0) {
    return serverProjects.map((p) => ({
      id: p.id,
      host: p.host,
      directory: p.dir || p.directory,
      name: p.name || projectLabel(p.dir || p.directory),
      color: p.color,
    }));
  }
  if (Array.isArray(state?.followedProjects) && state.followedProjects.length > 0) {
    return state.followedProjects.map((p) => ({
      id: p.id || `${p.host}-${normDir(p.directory)}`,
      host: p.host,
      directory: p.directory,
      name: p.name || projectLabel(p.directory),
      color: p.color,
    }));
  }
  return [];
}

function build(state) {
  const followed = getFollowedList(state);
  const allSessions = [
    ...(state.agents || []).map((a) => ({ ...a, kind: "agent" })),
    ...(state.terminals || []).map((t) => ({ ...t, kind: "terminal" })),
  ];
  const visible = allSessions.filter((s) => showClosed || s.status !== "closed");
  const closedCount = allSessions.filter((s) => s.status === "closed").length;

  const toggleClosed = el("label", { class: "check" },
    el("input", {
      type: "checkbox",
      checked: showClosed,
      onchange: (e) => {
        showClosed = e.target.checked;
        writePref(PREF_SHOW_CLOSED, showClosed ? "1" : "0");
        signature = "";
        render();
      },
    }),
    ` Afficher les sessions fermées (${closedCount})`
  );

  // Affectation des sessions aux projets suivis
  const map = new Map();
  for (const p of followed) {
    map.set(`${p.host}::${normDir(p.directory)}`, []);
  }
  const other = [];

  for (const s of visible) {
    const dir = sessionDir(state, s);
    let match = followed.find((p) => p.host === s.host && sameDirLocal(dir, p.directory));
    if (!match && dir) {
      const candidates = followed
        .filter((p) => p.host === s.host && insideDir(dir, p.directory))
        .sort((a, b) => (b.directory?.length || 0) - (a.directory?.length || 0));
      match = candidates[0] || null;
    }
    if (!match && s.workspaceId) {
      match = followed.find((p) => p.host === s.host && sameDirLocal(p.directory, s.workspaceId));
    }

    if (match) {
      map.get(`${match.host}::${normDir(match.directory)}`).push(s);
    } else {
      other.push(s);
    }
  }

  const cards = followed.map((p) => {
    const list = map.get(`${p.host}::${normDir(p.directory)}`) || [];
    return renderProjectCard(state, p, list);
  });

  const cardsContainer = el("div", { class: "projects-cards" },
    followed.length
      ? cards
      : el("div", { class: "empty-state" },
        el("h2", {}, "Aucun projet suivi"),
        el("p", {}, "Choisissez vos projets dans le rail ou via le bouton « Ajouter un projet »."),
      ),
    renderOtherCard(state, other),
  );

  return el("div", { class: "projects-page view-page" },
    el("div", { class: "projects-header view-toolbar" },
      el("h1", { class: "view-title" }, "Projets"),
      el("div", { class: "projects-header-actions" }, toggleClosed),
    ),
    cardsContainer,
  );
}

function render() {
  if (!root || !ctx) return;
  const state = ctx.state;
  const followed = getFollowedList(state);
  const sig = JSON.stringify([
    followed.map((p) => [p.host, p.directory, p.name, p.color]),
    (state.agents || []).map((a) => [a.host, a.agentId, a.status, a.title, a.cwd, a.workspaceId]),
    (state.terminals || []).map((t) => [t.host, t.terminalId, t.title, t.cwd, t.workspaceId]),
    showClosed,
  ]);

  if (sig !== signature) {
    signature = sig;
    root.replaceChildren(build(state));
  }

  for (const node of root.querySelectorAll(".proj-session-dur")) {
    const btn = node.closest(".proj-session-btn");
    const id = btn?.dataset?.id;
    const kind = btn?.dataset?.kind;
    if (kind === "agent") {
      const agent = (state.agents || []).find((a) => a.agentId === id);
      if (agent && agent.status !== "closed" && agent.duration) {
        node.textContent = formatDuration(agent.duration);
      }
    }
  }
}

const view = {
  id: "projets",
  title: "Projets",
  short: "Projets",
  icon: FOLDER_ICON,
  order: 25,
  mount(container, context) {
    ctx = context;
    showClosed = readPref(PREF_SHOW_CLOSED, "0") === "1";
    signature = "";
    root = el("div", { class: "view-host" });
    container.replaceChildren(root);
    cleanups = [
      ctx.onState(render),
      onProjectsChange(render),
    ];
    send({ type: "project.list" });
    render();
  },
  unmount() {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    root = null;
    ctx = null;
  },
};

registerView(view);
export default view;
