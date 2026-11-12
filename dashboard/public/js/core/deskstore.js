// Modèle du Bureau : fenêtres, mises en page nommées et persistance côté serveur (handlers/layouts.mjs).
// Le modèle vit hors de la vue : il survit aux changements de vue et reste utilisable depuis le rail.
import { send, on, onConnection } from "./socket.js";
import { toast } from "./toast.js";
import { getState, isReady, subscribe as subscribeState } from "./state.js";

export const GRID = 8;
export const MIN_W = 280;
export const MIN_H = 160;
const DEFAULT_SIZE = { terminal: { w: 1420, h: 903 }, agent: { w: 520, h: 432 } };

const windows = [];
const listeners = new Set();
const intents = new Map();
let layouts = [];
let zCounter = 1;
let restored = false;
let persistTimer = 0;
let surface = { w: 1000, h: 600 };

export const snap = (value) => Math.round(value / GRID) * GRID;
const newId = () =>
  globalThis.crypto?.randomUUID?.() || `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const getWindows = () => windows;
export const getLayouts = () => layouts;
export const setSurface = (w, h) => {
  surface = { w, h };
};
export const getSurface = () => surface;

// ---------- Vue du bureau infini : zoom + position (conservés par viewer dans localStorage) ----------
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const VIEW_KEY = "paseo-desk-view";
const viewListeners = new Set();
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

function loadView() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(VIEW_KEY) || "null");
    if (raw && [raw.z, raw.x, raw.y].every(Number.isFinite)) return { z: clampZoom(raw.z), x: raw.x, y: raw.y };
  } catch { /* stockage indisponible ou corrompu : vue par défaut */ }
  return { z: 1, x: 0, y: 0 };
}
let view = loadView();
let viewTimer = 0;

export const getView = () => view;
export const subscribeView = (fn) => {
  viewListeners.add(fn);
  return () => viewListeners.delete(fn);
};
export function setView(next) {
  const z = clampZoom(next.z ?? view.z);
  const x = Number.isFinite(next.x) ? next.x : view.x;
  const y = Number.isFinite(next.y) ? next.y : view.y;
  if (z === view.z && x === view.x && y === view.y) return;
  view = { z, x, y };
  for (const fn of viewListeners) fn(view);
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    try { globalThis.localStorage?.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* stockage indisponible */ }
  }, 150);
}
// Change le zoom en gardant fixe le point (px, py) de la surface (centre par défaut).
export function zoomAt(z, px = surface.w / 2, py = surface.h / 2) {
  const next = clampZoom(z);
  const wx = (px - view.x) / view.z;
  const wy = (py - view.y) / view.z;
  setView({ z: next, x: px - wx * next, y: py - wy * next });
}
export function zoomStep(direction, px, py) {
  const next = direction > 0
    ? ZOOM_STEPS.find((s) => s > view.z + 0.001)
    : [...ZOOM_STEPS].reverse().find((s) => s < view.z - 0.001);
  if (next) zoomAt(next, px, py);
}
export const resetZoom = () => zoomAt(1);
// Coordonnées d'un point de la surface (px) dans le repère des fenêtres.
export const toWorld = (px, py) => ({ x: (px - view.x) / view.z, y: (py - view.y) / view.z });
// Rectangle du repère des fenêtres actuellement visible.
export const visibleRect = () => ({ x: -view.x / view.z, y: -view.y / view.z, w: surface.w / view.z, h: surface.h / view.z });
// Ajuste zoom et position pour englober toutes les fenêtres visibles (jamais plus que 100 %).
export function fitAll() {
  const items = windows.filter((w) => !w.minimized);
  if (!items.length) return setView({ z: 1, x: 0, y: 0 });
  const pad = 32;
  const x0 = Math.min(...items.map((w) => w.x));
  const y0 = Math.min(...items.map((w) => w.y));
  const x1 = Math.max(...items.map((w) => w.x + w.w));
  const y1 = Math.max(...items.map((w) => w.y + w.h));
  const z = clampZoom(Math.min(1, (surface.w - pad * 2) / Math.max(1, x1 - x0), (surface.h - pad * 2) / Math.max(1, y1 - y0)));
  setView({ z, x: (surface.w - (x1 - x0) * z) / 2 - x0 * z, y: (surface.h - (y1 - y0) * z) / 2 - y0 * z });
}

if (typeof window !== "undefined") {
  window.__getWindows = getWindows;
  window.__changed = changed;
  window.__openAgentWindow = openAgentWindow;
  window.__openTerminalWindow = openTerminalWindow;
  window.__getDeskView = getView;
}

export function subscribeDesk(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(reason) {
  for (const fn of listeners) fn(reason);
}

export function currentLayout() {
  const keep = (win) => ({
    type: win.type, host: win.host, terminalId: win.terminalId, agentId: win.agentId, workspaceId: win.workspaceId,
    cwd: win.cwd, title: win.title, tool: win.tool, x: win.x, y: win.y, w: win.w, h: win.h,
    minimized: win.minimized, maximized: win.maximized, z: win.z,
  });
  return windows.map(keep);
}

function persist() {
  if (!restored) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => send({ type: "layout.autosave", windows: currentLayout() }), 500);
}
// À appeler après toute modification faite directement sur un objet fenêtre (déplacement, taille…).
export function changed(reason = "change") {
  persist();
  emit(reason);
}

const cascadeIndex = () => windows.length % 8;
const LARGE_TERMINAL_SIZE = { w: 1420, h: 903 };

let upcomingLargeTerminal = false;
let upcomingLargeTimer = 0;

export function markUpcomingLargeTerminal() {
  upcomingLargeTerminal = true;
  clearTimeout(upcomingLargeTimer);
  upcomingLargeTimer = setTimeout(() => { upcomingLargeTerminal = false; }, 12000);
}

function isFullScreenCommand(text) {
  if (!text) return false;
  const s = String(text).trim().toLowerCase();
  return s.startsWith("freebuff") || s.startsWith("htop") || s.startsWith("top") ||
    s.startsWith("vim") || s.startsWith("vi ") || s.startsWith("nano") || s.startsWith("less");
}

let widgetActions = new Map();
on("widgets.list", (msg) => {
  if (Array.isArray(msg.widgets)) widgetActions = new Map(msg.widgets.map((w) => [w.id, w]));
});
on("widgets.changed", (msg) => {
  if (Array.isArray(msg.widgets)) widgetActions = new Map(msg.widgets.map((w) => [w.id, w]));
});

if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".widget-btn");
    if (!btn) return;
    const title = btn.title || "";
    const label = btn.textContent || "";
    const id = btn.dataset?.widgetId || "";
    const w = widgetActions.get(id);
    if (id === "w-freebuff" || /freebuff/i.test(label) || /freebuff/i.test(title) ||
        isFullScreenCommand(label) || isFullScreenCommand(title) ||
        w?.action?.type === "freebuff" || isFullScreenCommand(w?.action?.command)) {
      markUpcomingLargeTerminal();
    }
  }, true);
}

function placeNew(type, at, large = false) {
  const baseSize = DEFAULT_SIZE[type] || DEFAULT_SIZE.terminal;
  const size = (type === "terminal" && large) ? LARGE_TERMINAL_SIZE : baseSize;
  // Le bureau est infini : la fenêtre apparaît dans la zone actuellement visible (repère des fenêtres).
  const vis = visibleRect();
  const w = Math.min(size.w, Math.max(MIN_W, snap(vis.w - 32)));
  const h = Math.min(size.h, Math.max(MIN_H, snap(vis.h - 32)));
  const step = cascadeIndex() * 32;
  const x = at ? snap(at.x) : snap(vis.x) + 24 + step;
  const y = at ? snap(at.y) : snap(vis.y) + 24 + step;
  // La fenêtre reste entièrement visible, même déposée près d'un bord.
  const fit = (value, sizeVal, start, room) => Math.max(start, Math.min(value, snap(start + room - sizeVal)));
  return { x: fit(x, w, snap(vis.x), vis.w), y: fit(y, h, snap(vis.y), vis.h), w, h };
}

function addWindow(fields, at) {
  const win = {
    id: newId(), minimized: false, maximized: false, z: ++zCounter,
    ...placeNew(fields.type, at, fields.large), ...fields,
  };
  windows.push(win);
  changed("add");
  return win;
}

function focusExisting(win) {
  win.minimized = false;
  win.z = ++zCounter;
  changed("raise");
  return win;
}

export function openAgentWindow(host, agentId, { at, cwd, title } = {}) {
  const found = windows.find((w) => w.type === "agent" && w.host === host && w.agentId === agentId);
  if (found) return focusExisting(found);
  return addWindow({ type: "agent", host, agentId, cwd, title }, at);
}
export function openTerminalWindow(host, terminalId, { at, cwd, workspaceId, large = false, tool } = {}) {
  const found = windows.find((w) => w.type === "terminal" && w.host === host && w.terminalId === terminalId);
  if (found) {
    if (tool && !found.tool) found.tool = tool;
    return focusExisting(found);
  }
  return addWindow({ type: "terminal", host, terminalId, cwd, workspaceId, large, tool }, at);
}

// Outil lancé par un lanceur rapide (« FreeBuff », « Hermes »…), retrouvé à la réponse launch.started via `ref`.
const toolByRef = new Map();
export function noteLaunchTool(ref, tool) {
  if (!ref || !tool) return;
  toolByRef.set(ref, tool);
  if (toolByRef.size > 50) toolByRef.delete(toolByRef.keys().next().value);
}

// Demande au serveur un nouveau terminal dans `cwd` ; la fenêtre apparaît à la réponse launch.started.
export function openTerminalInFolder({ host, cwd, at, windowId = null, navigate = false, large = false }) {
  const ref = `desk:${newId()}`;
  intents.set(ref, { at, windowId, navigate, large });
  const sent = send({ type: "launch.start", host, cwd, kind: "terminal", ref });
  if (!sent) {
    intents.delete(ref);
    toast("Connexion au serveur indisponible, réessayez dans un instant.", { kind: "error" });
  }
  return sent;
}

export function raiseWindow(id) {
  const win = windows.find((w) => w.id === id);
  if (!win || win.z === zCounter) return;
  win.z = ++zCounter;
  emit("raise");
  persist();
}
export function closeWindow(id) {
  const index = windows.findIndex((w) => w.id === id);
  if (index < 0) return;
  windows.splice(index, 1);
  changed("remove");
}

export function applyLayout(list, { persistNow = true } = {}) {
  windows.length = 0;
  for (const w of list || []) {
    windows.push({ minimized: false, maximized: false, w: 520, h: 340, x: 24, y: 24, ...w, id: newId() });
  }
  zCounter = windows.reduce((max, w) => Math.max(max, w.z || 0), 0) + 1;
  if (persistNow) persist();
  emit("layout");
}

const live = () => windows.filter((w) => !w.minimized);

export function arrangeGrid() {
  const items = live();
  if (!items.length) return;
  const gap = GRID;
  const fitCols = Math.max(1, Math.floor((surface.w - gap) / (MIN_W + gap)));
  const cols = Math.min(fitCols, Math.max(1, Math.round(Math.sqrt((items.length * surface.w) / Math.max(surface.h, 1)))));
  const rows = Math.ceil(items.length / cols);
  const cellW = Math.max(MIN_W, Math.floor((surface.w - gap * (cols + 1)) / cols / GRID) * GRID);
  const cellH = Math.max(MIN_H, Math.floor((surface.h - gap * (rows + 1)) / rows / GRID) * GRID);
  items.forEach((win, i) => {
    Object.assign(win, {
      maximized: false, w: cellW, h: cellH,
      x: gap + (i % cols) * (cellW + gap), y: gap + Math.floor(i / cols) * (cellH + gap),
    });
  });
  setView({ z: 1, x: 0, y: 0 });
  changed("arrange");
}

export function groupByMachine() {
  const items = live();
  if (!items.length) return;
  const gap = GRID;
  const hostsInOrder = [...new Set(items.map((w) => w.host || ""))].sort();
  const columns = hostsInOrder.length;
  const colW = Math.max(MIN_W, Math.floor((surface.w - gap * (columns + 1)) / columns / GRID) * GRID);
  hostsInOrder.forEach((host, col) => {
    const group = items.filter((w) => (w.host || "") === host);
    const rowH = Math.max(MIN_H, Math.floor((surface.h - gap * (group.length + 1)) / group.length / GRID) * GRID);
    group.forEach((win, row) => {
      Object.assign(win, {
        maximized: false, w: colW, h: rowH, x: gap + col * (colW + gap), y: gap + row * (rowH + gap),
      });
    });
  });
  setView({ z: 1, x: 0, y: 0 });
  changed("arrange");
}

// ---------- Mises en page nommées ----------
export const saveLayout = (name) => send({ type: "layout.save", name, windows: currentLayout() });
export const loadLayout = (name) => send({ type: "layout.load", name });
export const deleteLayout = (name) => send({ type: "layout.delete", name });

on("layout.list", (msg) => {
  layouts = msg.layouts || [];
  if (!restored) {
    restored = true;
    if (!windows.length && msg.current?.windows?.length) applyLayout(msg.current.windows, { persistNow: false });
  }
  emit("layouts");
});
on("layout.loaded", (msg) => {
  applyLayout(msg.windows);
  toast(`Mise en page « ${msg.name} » chargée.`);
});
on("layout.saved", (msg) => toast(`Mise en page « ${msg.name} » enregistrée.`));
on("layout.deleted", (msg) => toast(`Mise en page « ${msg.name} » supprimée.`));
onConnection((connected) => {
  if (connected) send({ type: "layout.list" });
});

// ---------- Réponses de lancement ----------
on("launch.started", (msg) => {
  const intent = intents.get(msg.ref);
  intents.delete(msg.ref);
  const info = { cwd: msg.cwd, workspaceId: msg.workspaceId };
  if (msg.kind === "terminal" && intent?.windowId) {
    const win = windows.find((w) => w.id === intent.windowId);
    if (win) {
      Object.assign(win, { terminalId: msg.terminalId, workspaceId: msg.workspaceId });
      changed("reopen");
      return;
    }
  }
  const at = intent?.at;
  const tool = toolByRef.get(msg.ref);
  toolByRef.delete(msg.ref);
  const isLarge = Boolean(intent?.large || upcomingLargeTerminal || isFullScreenCommand(msg.command));
  upcomingLargeTerminal = false;
  if (msg.kind === "terminal") openTerminalWindow(msg.host, msg.terminalId, { at, large: isLarge, tool, ...info });
  else if (msg.kind === "agent") openAgentWindow(msg.host, msg.agentId, { at, cwd: msg.cwd });
  if (intent?.navigate && location.hash !== "#bureau") location.hash = "#bureau";
  else if (!intent) toast(`${msg.kind === "terminal" ? "Terminal" : "Agent"} ouvert sur le Bureau.`);
});

// ---------- Ouverture automatique des NOUVELLES sessions ----------
// Une session lancée ailleurs que par ce navigateur (Hermes, un orchestrateur, une tâche, un autre écran) s'ouvre en fenêtre sur le Bureau.
// Ce qui existe déjà au chargement n'est jamais ouvert. Au plus 6 ouvertures par minute ; activé par défaut depuis le 2026-10-30 (demande de Philippe : voir les sessions lancées par les tâches) ; désactivable par la case du Bureau.
const AUTO_KEY = "desk.autoOpen";
export const getAutoOpen = () => { try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; } };
export function setAutoOpen(on) { try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* stockage indisponible : réglage non gardé */ } }
let knownSessions = null;
let autoOpened = [];
subscribeState(() => {
  if (!isReady()) return;
  const st = getState();
  const items = [
    ...(st.agents || []).filter((a) => a.status !== "closed").map((a) => ({ id: `a|${a.host}|${a.agentId}`, a })),
    ...(st.terminals || []).map((t) => ({ id: `t|${t.host}|${t.terminalId}`, t })),
  ];
  if (knownSessions === null) { knownSessions = new Set(items.map((i) => i.id)); return; }
  for (const item of items) {
    if (knownSessions.has(item.id)) continue;
    knownSessions.add(item.id);
    if (!getAutoOpen()) continue;
    const now = Date.now();
    autoOpened = autoOpened.filter((t) => now - t < 60_000);
    if (autoOpened.length >= 6) continue;
    autoOpened.push(now);
    if (item.a) openAgentWindow(item.a.host, item.a.agentId, { cwd: item.a.cwd, title: item.a.title });
    else openTerminalWindow(item.t.host, item.t.terminalId, { cwd: item.t.cwd, workspaceId: item.t.workspaceId });
  }
});
