// Petits utilitaires partagés par la coque et les vues.
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// el("div", { class: "x", onclick: fn }, "texte", autreNoeud)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Élément <span> contenant une icône SVG de `icons`.
export function iconEl(svg) {
  const span = document.createElement("span");
  span.className = "btn-icon";
  span.innerHTML = svg;
  return span;
}

export function folderName(directory) {
  return directory ? String(directory).replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
}

export function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
export function readPref(key, fallback = null) {
  try {
    return safeStorage()?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePref(key, value) {
  try {
    safeStorage()?.setItem(key, value);
  } catch {
    // stockage indisponible : la préférence ne sera pas mémorisée
  }
}

const AGENT_STATUS = {
  error: ["Erreur", "danger"],
  "waiting-permission": ["Permission requise", "attention"],
  waiting_permission: ["Permission requise", "attention"],
  running: ["Actif", "ok"],
  working: ["Actif", "ok"],
  initializing: ["Initialisation", "ok"],
  idle: ["Inactif", "inactif"],
  closed: ["Fermé", "inactif"],
};
export function agentStatus(status) {
  const [label, tone] = AGENT_STATUS[status] || [status || "Inconnu", "inactif"];
  return { label, tone };
}

const HOST_STATUS = {
  connected: ["Connecté", "ok"],
  reconnecting: ["Reconnexion", "attention"],
  error: ["Indisponible", "danger"],
};
export function hostStatus(status) {
  const [label, tone] = HOST_STATUS[status] || [status || "Inconnu", "inactif"];
  return { label, tone };
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

// Voyant : forme + couleur ; l'état se lit aussi par le texte voisin.
export function led(tone, { pulse = false, label = "" } = {}) {
  return el("span", { class: `led led-${tone}${pulse ? " led-pulse" : ""}`, role: "img", "aria-label": label || tone });
}

const svg = (parts) =>
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts.join("")}</svg>`;
export const icons = {
  desk: svg(['<rect x="2.5" y="3.5" width="9" height="7" rx="1.5"/>',
    '<rect x="8.5" y="9.5" width="9" height="7" rx="1.5"/>']),
  tasks: svg(['<rect x="2.5" y="3" width="4" height="14" rx="1"/>', '<rect x="8" y="3" width="4" height="9" rx="1"/>',
    '<rect x="13.5" y="3" width="4" height="11.5" rx="1"/>']),
  sessions: svg(['<circle cx="10" cy="4.5" r="2"/><circle cx="4.5" cy="15" r="2"/><circle cx="15.5" cy="15" r="2"/>',
    '<path d="M10 6.5v3M10 9.5H4.5V13M10 9.5h5.5V13"/>']),
  timeline: svg(['<path d="M2.5 5h8M5.5 10h10M3.5 15h6.5"/>', '<circle cx="14" cy="5" r="1.3"/>',
    '<circle cx="3.2" cy="10" r="1.3"/><circle cx="14" cy="15" r="1.3"/>']),
  machines: svg(['<rect x="2.5" y="3" width="15" height="5.5" rx="1.3"/>',
    '<rect x="2.5" y="11.5" width="15" height="5.5" rx="1.3"/><path d="M5.5 5.8h.01M5.5 14.2h.01"/>']),
  inbox: svg(['<path d="M2.5 11.5l2.2-7h10.6l2.2 7v4a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>',
    '<path d="M2.5 11.5h4.3l1 2h4.4l1-2h4.3"/>']),
  sun: svg(['<circle cx="10" cy="10" r="3.2"/>',
    '<path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4',
    'M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>']),
  moon: svg(['<path d="M16.5 11.8A6.8 6.8 0 0 1 8.2 3.5a6.8 6.8 0 1 0 8.3 8.3z"/>']),
  plus: svg(['<path d="M10 4v12M4 10h12"/>']),
  chevronDown: svg(['<path d="M5 8l5 5 5-5"/>']),
  chevronRight: svg(['<path d="M8 5l5 5-5 5"/>']),
  close: svg(['<path d="M5 5l10 10M15 5L5 15"/>']),
  minimize: svg(['<path d="M5 14h10"/>']),
  maximize: svg(['<rect x="4.5" y="4.5" width="11" height="11" rx="1.2"/>']),
  restore: svg(['<rect x="3.5" y="6.5" width="10" height="10" rx="1.2"/><path d="M7 6.5V4.5h9.5v9.5h-2"/>']),
  menu: svg(['<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/>']),
  terminal: svg(['<rect x="2.5" y="3.5" width="15" height="13" rx="1.8"/><path d="M6 8l2.5 2L6 12M10.5 12.5H14"/>']),
  agent: svg(['<circle cx="10" cy="7" r="3"/><path d="M4 16.5c.6-3 3-4.5 6-4.5s5.4 1.5 6 4.5"/>']),
  stop: svg(['<rect x="5" y="5" width="10" height="10" rx="1.5"/>']),
  trash: svg(['<path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6"/>']),
  grid: svg(['<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="6" rx="1"/>',
    '<rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="11" width="6" height="6" rx="1"/>']),
  group: svg(['<rect x="2.5" y="3" width="6" height="14" rx="1"/><rect x="11.5" y="3" width="6" height="14" rx="1"/>']),
  save: svg(['<path d="M4 3.5h9l3 3V16a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 4 16z"/>',
    '<path d="M7 3.5V8h5V3.5M7 16.5v-4h6v4"/>']),
  send: svg(['<path d="M3 10l14-6.5L12.5 17 10 11z"/>']),
  fit: svg(['<path d="M4 4h8v8H4zM7 7l3 3M10 7l-3 3"/>']),
};
