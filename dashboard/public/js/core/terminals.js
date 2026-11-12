// Registre des terminaux xterm. Le serveur ne sait pas « fermer » un flux terminal avant la fin du
// navigateur : les instances survivent donc aux changements de vue et se rattachent à de nouveaux conteneurs.
import { send, on, onConnection } from "./socket.js";
import { token, onThemeChange } from "./theme.js";

const terms = new Map();
const keyOf = (host, terminalId) => `${host}\u0000${terminalId}`;

export const xtermAvailable = () => Boolean(window.Terminal && window.FitAddon);

function xtermTheme() {
  return {
    background: token("--sol"),
    foreground: token("--texte"),
    cursor: token("--accent"),
    cursorAccent: token("--sol"),
    selectionBackground: token("--accent-doux"),
    black: token("--panneau-2"),
    brightBlack: token("--inactif"),
    red: token("--danger"),
    green: token("--ok"),
    yellow: token("--attention"),
    blue: token("--accent"),
    white: token("--texte-doux"),
    brightWhite: token("--texte"),
  };
}
const fontFamily = () => token("--police-mono") || "monospace";

function sendResize(item) {
  const { terminal, host, terminalId } = item;
  const rows = terminal.rows;
  const cols = terminal.cols;
  if (!rows || !cols) return;
  item.lastSentRows = rows;
  item.lastSentCols = cols;
  send({ type: "term.resize", host, terminalId, rows, cols });
}

function fitItem(item, immediate = false) {
  const { wrapper, fit, terminal } = item;
  if (!wrapper.isConnected || wrapper.clientWidth < 20 || wrapper.clientHeight < 20) return;
  try {
    fit.fit();
  } catch {
    return;
  }
  const rows = terminal.rows;
  const cols = terminal.cols;
  if (!rows || !cols) return;

  if (immediate) {
    clearTimeout(item.resizeTimer);
    item.resizeTimer = 0;
    sendResize(item);
    return;
  }

  if (item.lastSentRows !== rows || item.lastSentCols !== cols) {
    clearTimeout(item.resizeTimer);
    item.resizeTimer = setTimeout(() => {
      item.resizeTimer = 0;
      sendResize(item);
    }, 100);
  }
}

function openStream(item) {
  const { terminal, host, terminalId } = item;
  item.opened = send({ type: "term.open", host, terminalId, rows: terminal.rows, cols: terminal.cols });
  sendResize(item);
}

function create(host, terminalId) {
  const wrapper = document.createElement("div");
  wrapper.className = "xterm-wrap";
  const terminal = new window.Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: fontFamily(),
    fontSize: 13,
    theme: xtermTheme(),
    scrollback: 5000,
  });
  const fit = new window.FitAddon.FitAddon();
  terminal.loadAddon(fit);
  const item = {
    host, terminalId, terminal, fit, wrapper, opened: false,
    lastSentRows: 0, lastSentCols: 0, resizeTimer: 0,
    get rows() { return terminal.rows; },
    get cols() { return terminal.cols; },
  };
  terminal.onData((data) => send({ type: "term.input", host, terminalId, data }));
  return item;
}

if (typeof window !== "undefined") {
  window.__terms = terms;
}

// Rattache le terminal (host, terminalId) à `container`. Crée l'instance au premier appel.
export function attachTerminal(host, terminalId, container) {
  if (!xtermAvailable()) {
    container.textContent = "xterm.js est indisponible (réseau vers jsDelivr).";
    return null;
  }
  const key = keyOf(host, terminalId);
  let item = terms.get(key);
  if (!item) {
    item = create(host, terminalId);
    terms.set(key, item);
  }
  container.replaceChildren(item.wrapper);
  if (!item.wrapper.querySelector(".xterm")) item.terminal.open(item.wrapper);
  requestAnimationFrame(() => {
    fitItem(item, true);
    if (!item.opened) openStream(item);
    else sendResize(item);
  });
  return {
    fit: (immediate = false) => fitItem(item, immediate),
    focus: () => item.terminal.focus(),
    rows: () => item.terminal.rows,
    cols: () => item.terminal.cols,
    item,
  };
}

// Libère les terminaux qui n'existent plus côté daemon (hôte connecté, terminal absent).
export function pruneTerminals(state) {
  const connected = new Set((state.hosts || []).filter((h) => h.status === "connected").map((h) => h.label));
  const live = new Set((state.terminals || []).map((t) => keyOf(t.host, t.terminalId)));
  for (const [key, item] of terms) {
    if (connected.has(item.host) && !live.has(key)) {
      clearTimeout(item.resizeTimer);
      item.terminal.dispose();
      item.wrapper.remove();
      terms.delete(key);
    }
  }
}

function writeSnapshot(item, msg) {
  item.terminal.reset();
  if (msg.data) {
    item.terminal.write(Uint8Array.from(atob(msg.data), (ch) => ch.charCodeAt(0)));
  } else if (msg.state) {
    const rows = [...(msg.state.scrollback || []), ...(msg.state.grid || [])];
    item.terminal.write(rows.map((r) => r.map((c) => c.char).join("").replace(/\s+$/, "")).join("\r\n"));
  }
}

on("term.output", (msg) => {
  const item = terms.get(keyOf(msg.host, msg.terminalId));
  if (item && msg.data) item.terminal.write(Uint8Array.from(atob(msg.data), (ch) => ch.charCodeAt(0)));
});
on("term.snapshot", (msg) => {
  const item = terms.get(keyOf(msg.host, msg.terminalId));
  if (item) writeSnapshot(item, msg);
});
on("term.killed", (msg) => {
  const item = terms.get(keyOf(msg.host, msg.terminalId));
  if (!item) return;
  clearTimeout(item.resizeTimer);
  item.terminal.dispose();
  item.wrapper.remove();
  terms.delete(keyOf(msg.host, msg.terminalId));
});

// Nouvelle connexion = nouveaux abonnements côté serveur : on rouvre tous les flux.
onConnection((connected) => {
  for (const item of terms.values()) {
    if (!connected) item.opened = false;
    else if (!item.opened) {
      item.rows = 0;
      item.cols = 0;
      openStream(item);
    }
  }
});

onThemeChange(() => {
  for (const item of terms.values()) item.terminal.options.theme = xtermTheme();
});
// Quand les polices web arrivent, xterm doit remesurer ses cellules.
document.fonts?.ready.then(() => {
  for (const item of terms.values()) {
    item.terminal.options.fontFamily = fontFamily();
    fitItem(item);
  }
});
