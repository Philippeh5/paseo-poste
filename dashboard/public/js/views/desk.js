// Vue « Bureau » : surface libre de fenêtres déplaçables (terminaux et sessions d'agents).
import { registerView } from "./registry.js";
import { el, icons, iconEl, folderName, agentStatus, hostStatus, led, readPref } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { getState, isReady, findAgent, findTerminal, findHost, allProjects, subscribe as subscribeState } from "../core/state.js";
import { attachTerminal } from "../core/terminals.js";
import { mountAgentPanel } from "../core/agentfeed.js";
import { confirmDialog, promptDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import {
  GRID, MIN_W, MIN_H, snap, getWindows, getLayouts, setSurface, getSurface, subscribeDesk, changed, raiseWindow,
  closeWindow, openAgentWindow, openTerminalWindow, openTerminalInFolder, setWebMode, arrangeGrid, groupByMachine,
  saveLayout, loadLayout, deleteLayout,
  getView, setView, subscribeView, zoomAt, zoomStep, resetZoom, toWorld, fitAll, ZOOM_MIN, ZOOM_MAX, getAutoOpen, setAutoOpen,
} from "../core/deskstore.js";
import { mountWebWindow, webAddress } from "../core/webwindow.js";
import { mountWidgetBar } from "../components/widgetBar.js";
import { hostLabel, windowName, numberDuplicates, isAutoTerminalName, isIdentifier } from "../core/names.js";

const MOBILE = "(max-width: 720px)";
const isMobile = () => window.matchMedia(MOBILE).matches;
const DROP_TYPE = "application/x-paseo-item";

let ctx = null;
let cleanups = [];
let surfaceEl = null;
let worldEl = null;
let zoomLabel = null;
let dockEl = null;
let emptyEl = null;
let layoutSelect = null;
let deleteButton = null;
const nodes = new Map();
// Titres affichés (id de fenêtre -> « Outil · Projet · Machine »), recalculés à chaque rendu pour numéroter les doublons.
let titleById = new Map();
// Tâches confiées à FreeBuff (handlers/freebuff.mjs) : une pastille dans le dock par lancement dont le terminal existe encore.
let fbJobs = [];
const FB_TONE = { running: "attention", done: "ok", failed: "danger" };
const FB_TEXT = { running: "en cours", done: "terminée", failed: "échec" };

// ---------- Émission de desk.state (debounce 300 ms) ----------
// Branchée au niveau du module : l'état du bureau est envoyé même quand une autre vue est affichée.
let deskStateTimer = 0;
function emitDeskState() {
  clearTimeout(deskStateTimer);
  deskStateTimer = setTimeout(() => {
    const list = getWindows();
    const top = Math.max(0, ...list.filter((w) => !w.minimized).map((w) => w.z || 0));
    const windows = list.map((w) => ({
      id: w.id,
      kind: w.type === "agent" ? "agent" : w.type === "web" ? "web" : "terminal",
      host: w.host,
      port: w.port ?? null,
      url: w.type === "web" ? webAddress(w) : null,
      mode: w.mode ?? null,
      cwd: w.cwd ?? null,
      title: w.title ?? null,
      terminalId: w.terminalId ?? null,
      agentId: w.agentId ?? null,
      minimized: Boolean(w.minimized),
      focused: !w.minimized && (w.z || 0) === top,
      x: w.x ?? 0,
      y: w.y ?? 0,
      w: w.w ?? 480,
      h: w.h ?? 320,
    }));
    send({ type: "desk.state", windows });
  }, 300);
}
subscribeDesk(emitDeskState);
onConnection((up) => up && emitDeskState());

// ---------- Rangement automatique ----------
// Une fenêtre dont la session est fermée (agent « closed », ou agent / terminal disparu d'une machine connectée) n'a plus rien à montrer :
// elle quitte le Bureau toute seule. Seules les fenêtres partent, jamais une session. Une fenêtre n'est retirée que si le constat tient sur
// au moins 5 s (une reconnexion qui vide la liste un instant ne doit rien effacer).
const goneSince = new Map();
subscribeState((state) => {
  if (!isReady() || readPref("desk.autoTidy") === "0") return;
  const gone = new Set();
  // La fenêtre au premier plan n'est jamais retirée : on l'a peut-être ouverte exprès pour lire une session fermée.
  const shownWins = getWindows().filter((w) => !w.minimized);
  const front = shownWins.length ? shownWins.reduce((a, b) => ((b.z || 0) >= (a.z || 0) ? b : a)) : null;
  for (const win of getWindows()) {
    if (front && win.id === front.id) continue;
    const host = findHost(state, win.host);
    if (!host || host.status !== "connected") continue;
    const dead = win.type === "terminal" ? Boolean(win.terminalId) && !findTerminal(state, win.host, win.terminalId)
      : win.type === "agent" ? (() => { const a = findAgent(state, win.host, win.agentId); return !a || a.status === "closed"; })() : false;
    if (dead) gone.add(win.id);
  }
  const now = Date.now();
  const confirmed = [...gone].filter((id) => now - (goneSince.get(id) ?? now) >= 5000);
  for (const id of [...goneSince.keys()]) if (!gone.has(id)) goneSince.delete(id);
  for (const id of gone) if (!goneSince.has(id)) goneSince.set(id, now);
  if (!confirmed.length) return;
  for (const id of confirmed) closeWindow(id);
  toast(`${confirmed.length} fenêtre${confirmed.length > 1 ? "s" : ""} rangée${confirmed.length > 1 ? "s" : ""} (session fermée).`);
});

// ---------- Informations d'état d'une fenêtre ----------
function describe(win) {
  const state = getState();
  const host = findHost(state, win.host);
  const hostTone = host ? hostStatus(host.status) : { label: "Machine inconnue", tone: "danger" };
  const offline = !host || host.status !== "connected";
  // Fenêtre web : indépendante des machines Paseo (relais du poste ou Chrome distant), jamais rangée automatiquement.
  if (win.type === "web") {
    return { mode: "live", tone: "ok", label: win.mode === "chrome" ? "Chrome distant" : "Relais", sub: webAddress(win), folder: "" };
  }
  if (win.type === "terminal") {
    const info = findTerminal(state, win.host, win.terminalId);
    if (info?.cwd && win.cwd !== info.cwd) win.cwd = info.cwd;
    let mode = "live";
    if (!isReady()) mode = "loading";
    else if (offline) mode = "offline";
    else if (!info) mode = "closed";
    const tones = {
      live: ["ok", "Terminal actif"], loading: ["inactif", "Chargement"],
      offline: [hostTone.tone, hostTone.label], closed: ["inactif", "Terminal fermé"],
    };
    const [tone, label] = tones[mode];
    // « sandbox-repo terminal 5 » (nom automatique du démon) n'apprend rien : seul un vrai nom est montré.
    const sub = info?.name && !isAutoTerminalName(info.name) ? info.name : "";
    return { mode, tone, label, sub, folder: folderName(win.cwd) || "" };
  }
  const agent = findAgent(state, win.host, win.agentId);
  if (agent?.cwd && win.cwd !== agent.cwd) win.cwd = agent.cwd;
  const missing = { label: isReady() ? "Agent introuvable" : "Chargement", tone: "inactif" };
  const status = agent ? agentStatus(agent.status) : missing;
  const mode = offline && isReady() ? "offline" : "live";
  return {
    mode,
    agent,
    tone: mode === "offline" ? hostTone.tone : status.tone,
    label: mode === "offline" ? hostTone.label : status.label,
    sub: [agent?.title, win.title].find((t) => t && !isIdentifier(t)) || "",
    folder: folderName(win.cwd) || "",
    attention: agent?.status === "waiting-permission",
  };
}

// ---------- Géométrie ----------
function applyGeometry(node, win) {
  const style = node.root.style;
  style.setProperty("--x", `${win.x}px`);
  style.setProperty("--y", `${win.y}px`);
  style.setProperty("--w", `${win.w}px`);
  style.setProperty("--h", `${win.h}px`);
  style.zIndex = String(win.z || 1);
  // Une fenêtre agrandie remplit la zone visible, quels que soient le zoom et la position de la vue.
  const fill = win.maximized && !isMobile();
  const { z, x: vx, y: vy } = getView();
  const surf = getSurface();
  for (const [name, value] of [["--mx", -vx / z], ["--my", -vy / z], ["--mw", surf.w / z], ["--mh", surf.h / z]]) {
    if (fill) style.setProperty(name, `${value}px`);
    else style.removeProperty(name);
  }
  node.root.classList.toggle("is-max", Boolean(win.maximized));
  node.root.classList.toggle("is-min", Boolean(win.minimized));
  node.maxButton.innerHTML = win.maximized ? icons.restore : icons.maximize;
  node.maxButton.setAttribute("aria-label", win.maximized ? "Restaurer la fenêtre" : "Agrandir la fenêtre");
}

function startDrag(event, win, node) {
  if (event.button !== 0 || event.target.closest("button") || isMobile() || win.maximized) return;
  const bar = node.bar;
  const start = { x: event.clientX, y: event.clientY, wx: win.x, wy: win.y };
  bar.setPointerCapture(event.pointerId);
  node.root.classList.add("is-dragging");
  const move = (ev) => {
    // Bureau infini : pas de bornes ; le déplacement écran est converti dans le repère zoomé des fenêtres.
    const { z } = getView();
    win.x = snap(start.wx + (ev.clientX - start.x) / z);
    win.y = snap(start.wy + (ev.clientY - start.y) / z);
    applyGeometry(node, win);
  };
  const end = () => {
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", end);
    bar.removeEventListener("pointercancel", end);
    node.root.classList.remove("is-dragging");
    changed("move");
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
}

function startResize(event, win, node) {
  if (event.button !== 0 || isMobile() || win.maximized) return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget;
  const dir = handle.dataset.dir;
  const start = { x: event.clientX, y: event.clientY, wx: win.x, wy: win.y, ww: win.w, wh: win.h };
  handle.setPointerCapture(event.pointerId);
  node.root.classList.add("is-dragging");
  const move = (ev) => {
    const { z } = getView();
    const dx = (ev.clientX - start.x) / z;
    const dy = (ev.clientY - start.y) / z;
    if (dir.includes("e")) win.w = Math.max(MIN_W, snap(start.ww + dx));
    if (dir.includes("s")) win.h = Math.max(MIN_H, snap(start.wh + dy));
    if (dir.includes("w")) {
      win.x = Math.min(snap(start.wx + dx), start.wx + start.ww - MIN_W);
      win.w = start.wx + start.ww - win.x;
    }
    if (dir.includes("n")) {
      win.y = Math.min(snap(start.wy + dy), start.wy + start.wh - MIN_H);
      win.h = start.wy + start.wh - win.y;
    }
    applyGeometry(node, win);
  };
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    node.root.classList.remove("is-dragging");
    changed("resize");
    node.term?.fit();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

// Équivalent clavier : flèches = déplacer, Maj + flèches = redimensionner (pas de 8 px).
function barKeydown(event, win, node) {
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (!step || event.target !== node.bar || isMobile() || win.maximized) return;
  event.preventDefault();
  if (event.shiftKey) {
    win.w = Math.max(MIN_W, win.w + step[0] * GRID);
    win.h = Math.max(MIN_H, win.h + step[1] * GRID);
  } else {
    win.x += step[0] * GRID;
    win.y += step[1] * GRID;
  }
  applyGeometry(node, win);
  changed("move");
}

// ---------- Construction d'une fenêtre ----------
function iconButton(label, svg, onClick, extra = "") {
  const b = el("button", {
    class: `win-btn ${extra}`.trim(), type: "button", "aria-label": label, title: label, onclick: onClick,
  });
  b.innerHTML = svg;
  return b;
}

// La croix : après confirmation, ARRÊTE vraiment le terminal ou l'agent sur la machine et retire la fenêtre (rien ne reste ouvert,
// aucune proposition de rouvrir). Pour seulement ranger la fenêtre, on la réduit.
async function stopAndClose(win) {
  if (win.type === "web") { closeWindow(win.id); return; } // rien à arrêter : la page reste servie par la machine
  const isTerm = win.type === "terminal";
  const ok = await confirmDialog({
    title: isTerm ? "Fermer ce terminal ?" : "Arrêter cet agent ?",
    message: isTerm
      ? "Le terminal est arrêté sur la machine et son contenu est perdu. Pour seulement le ranger, utilisez le bouton réduire."
      : "L’agent est arrêté et sa session fermée. Pour seulement le ranger, utilisez le bouton réduire.",
    confirmLabel: isTerm ? "Fermer le terminal" : "Arrêter l’agent",
    danger: true,
  });
  if (!ok) return;
  if (isTerm) send({ type: "term.kill", host: win.host, terminalId: win.terminalId });
  else send({ type: "agent.close", host: win.host, agentId: win.agentId, stop: true });
  closeWindow(win.id);
}

function createNode(win) {
  const ledSlot = el("span", { class: "win-led-slot" });
  const title = el("strong", { class: "win-title" });
  const sub = el("span", { class: "win-sub mono" });
  const badge = el("span", { class: "pastille", hidden: true }, "Permission requise");
  const stateLabel = el("span", { class: "win-state" });
  const minButton = iconButton("Réduire dans le dock", icons.minimize, () => {
    win.minimized = true;
    changed("minimize");
  });
  const maxButton = iconButton("Agrandir la fenêtre", icons.maximize, () => toggleMax(win));
  maxButton.classList.add("win-max");
  const fitButton = iconButton("Ajuster la taille", icons.fit, () => {
    node.term?.fit();
    changed("fit");
  });
  fitButton.classList.add("win-fit");
  const closeButton = iconButton(
    win.type === "web" ? "Fermer la fenêtre web" : win.type === "terminal" ? "Fermer et arrêter le terminal" : "Arrêter l’agent et fermer la fenêtre",
    icons.close, () => stopAndClose(win), "win-close",
  );
  const bar = el("header", { class: "win-bar", tabindex: "0",
    "aria-label": "Barre de titre : flèches pour déplacer" },
    ledSlot, el("span", { class: "win-kind", "aria-hidden": "true" }), title, sub, badge, stateLabel,
    el("span", { class: "win-controls" }, minButton, maxButton, fitButton, closeButton),
  );
  bar.querySelector(".win-kind").innerHTML = win.type === "terminal" ? icons.terminal : win.type === "web" ? icons.web : icons.agent;
  const body = el("div", { class: "win-body" });
  const handles = ["n", "e", "s", "w", "ne", "nw", "se", "sw"].map((dir) => {
    const handle = el("span", { class: `win-handle h-${dir}`, dataset: { dir }, "aria-hidden": "true" });
    handle.addEventListener("pointerdown", (event) => startResize(event, win, node));
    return handle;
  });
  const root = el("section", { class: `win win-${win.type}`, role: "group" }, bar, body, ...handles);
  const node = {
    root, bar, body, ledSlot, title, sub, badge, stateLabel, maxButton, bodyKey: "", panel: null, term: null, ro: null,
    ledKey: "",
  };
  root.addEventListener("pointerdown", () => raiseWindow(win.id), true);
  bar.addEventListener("pointerdown", (event) => startDrag(event, win, node));
  bar.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button") && !isMobile()) toggleMax(win);
  });
  bar.addEventListener("keydown", (event) => barKeydown(event, win, node));
  let frame = 0;
  node.ro = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => node.term?.fit());
  });
  node.ro.observe(body);
  return node;
}

function toggleMax(win) {
  win.maximized = !win.maximized;
  changed("maximize");
  requestAnimationFrame(() => nodes.get(win.id)?.term?.fit());
}

function destroyNode(node) {
  node.ro.disconnect();
  node.panel?.destroy();
  node.root.remove();
}

function note(text, detail, button) {
  return el("div", { class: "win-note" }, el("p", {}, text), detail && el("p", { class: "mono" }, detail), button);
}

function updateBody(win, node, info) {
  if (win.type === "web") {
    const webKey = `web:${win.mode}:${win.port ?? win.url}${win.path || ""}`;
    if (webKey !== node.bodyKey) {
      node.bodyKey = webKey;
      node.panel?.destroy();
      node.panel = mountWebWindow(node.body, win, { onMode: (mode) => setWebMode(win.id, mode) });
    }
    return;
  }
  const key = win.type === "terminal" ? `${info.mode}:${win.terminalId}` : `${info.mode}:${win.agentId}`;
  if (key !== node.bodyKey) {
    node.bodyKey = key;
    node.panel?.destroy();
    node.panel = null;
    node.term = null;
    if (info.mode === "live" && win.type === "terminal") {
      node.term = attachTerminal(win.host, win.terminalId, node.body);
    } else if (info.mode === "live") {
      node.panel = mountAgentPanel(node.body, { host: win.host, agentId: win.agentId });
    } else if (info.mode === "closed") {
      const reopen = el("button", {
        class: "btn btn-primary btn-sm", type: "button", disabled: !win.cwd,
        onclick: () => openTerminalInFolder({ host: win.host, cwd: win.cwd, windowId: win.id }),
      }, iconEl(icons.plus), " Rouvrir un terminal ici");
      node.body.replaceChildren(note("Terminal fermé", win.cwd || "Dossier inconnu", reopen));
    } else if (info.mode === "offline") {
      node.body.replaceChildren(note(`Machine « ${hostLabel(win.host)} » hors ligne`, "Reconnexion automatique en cours."));
    } else {
      node.body.replaceChildren(note("Chargement…"));
    }
  }
  node.panel?.update(info.agent);
}

// « Outil · Projet · Machine », avec « (2) » seulement si deux fenêtres identiques coexistent.
function computeTitles() {
  const wins = getWindows();
  const base = wins.map((win) => {
    if (win.type === "web") return win.title || `Web · ${webAddress(win)}`;
    const info = describe(win);
    return windowName({
      kind: win.type === "agent" ? "agent" : "terminal",
      tool: win.tool,
      provider: info.agent?.provider,
      project: win.cwd || info.folder,
      host: win.host,
    });
  });
  const numbered = numberDuplicates(base);
  titleById = new Map(wins.map((win, i) => [win.id, numbered[i]]));
}

function updateNode(win, node) {
  const info = describe(win);
  const name = titleById.get(win.id) || "";
  node.title.textContent = name;
  node.sub.textContent = info.sub;
  node.root.setAttribute("aria-label", `${win.type === "terminal" ? "Terminal" : win.type === "web" ? "Fenêtre web" : "Agent"} ${name}`);
  node.root.dataset.tone = info.tone;
  node.stateLabel.textContent = info.label;
  node.badge.hidden = !info.attention;
  const ledKey = `${info.tone}:${info.mode === "live" && (info.tone === "ok" || info.attention)}`;
  if (ledKey !== node.ledKey) {
    node.ledKey = ledKey;
    const pulse = info.attention || (win.type === "agent" && info.tone === "ok");
    node.ledSlot.replaceChildren(led(info.tone, { pulse, label: info.label }));
  }
  updateBody(win, node, info);
  return info;
}

// ---------- Rendu ----------
// Pastilles FreeBuff : clic = ouvrir le terminal dans une fenêtre, × = fermer ce terminal (libère la session unique de FreeBuff).
function freebuffChips() {
  const state = getState();
  return fbJobs.filter((j) => j.terminalId && findTerminal(state, j.host, j.terminalId)).slice(0, 3).map((j) => {
    const text = j.status === "done" && j.completed === false ? "non terminée" : FB_TEXT[j.status] || j.status;
    return el("span", { class: "dock-chip dock-fb", "data-tone": FB_TONE[j.status] || "inactif" },
      el("button", { class: "dock-fb-main", type: "button", title: `FreeBuff ${text} : ouvrir son terminal`,
        onclick: () => { openTerminalWindow(j.host, j.terminalId, { cwd: undefined }); toast("Terminal FreeBuff ouvert."); } },
      led(FB_TONE[j.status] || "inactif", { label: text, pulse: j.status === "running" }), ` FreeBuff · ${j.project || "?"} · ${text}`),
      j.status !== "running" && el("button", { class: "dock-fb-close", type: "button", "aria-label": "Fermer le terminal FreeBuff", title: "Fermer ce terminal FreeBuff",
        onclick: () => { send({ type: "term.kill", host: j.host, terminalId: j.terminalId }); toast("Terminal FreeBuff fermé."); } }, iconEl(icons.close)));
  });
}

function renderDock(frontId) {
  const minimized = getWindows().filter((w) => w.minimized);
  // Téléphone : la bande liste TOUTES les fenêtres (celle au premier plan est marquée) pour passer de l'une à l'autre d'un tap.
  const strip = isMobile() ? getWindows() : minimized;
  const fb = freebuffChips();
  dockEl.hidden = strip.length === 0 && fb.length === 0;
  // « Ranger » : retire du Bureau les fenêtres réduites dont l'agent est inactif, en erreur ou introuvable (ou dont le terminal est
  // fermé). Seules les fenêtres disparaissent : aucune session n'est arrêtée ni archivée, on les rouvre depuis le rail.
  const stale = minimized.filter((win) => {
    if (win.type === "web") return false; // une fenêtre web réduite n'est jamais « inactive » : elle reste jusqu'à sa fermeture
    const info = describe(win);
    if (info.mode === "loading" || info.mode === "offline") return false;
    return win.type === "terminal" ? info.mode === "closed" : !info.agent || ["idle", "closed", "error"].includes(info.agent.status);
  });
  const tidy = stale.length ? el("button", {
    class: "dock-chip dock-tidy", type: "button", title: "Retirer du Bureau les fenêtres réduites inactives (les sessions ne sont pas arrêtées)",
    onclick: () => { for (const win of stale) closeWindow(win.id); toast(`${stale.length} fenêtre${stale.length > 1 ? "s" : ""} rangée${stale.length > 1 ? "s" : ""}.`); },
  }, `Ranger ${stale.length} inactif${stale.length > 1 ? "s" : ""}`) : null;
  dockEl.replaceChildren(el("span", { class: "dock-label" }, isMobile() ? "Fenêtres" : "Dock"), ...(tidy ? [tidy] : []), ...fb, ...strip.map((win) => {
    const info = describe(win);
    const name = titleById.get(win.id) || "";
    const chip = el("button", {
      class: `dock-chip${win.id === frontId ? " is-front" : ""}`, type: "button", title: "Restaurer", "data-tone": info.tone,
      "aria-current": win.id === frontId ? "true" : null,
      onclick: () => {
        win.minimized = false;
        raiseWindow(win.id);
        changed("restore");
        requestAnimationFrame(() => nodes.get(win.id)?.term?.fit());
      },
    }, led(info.tone, { label: info.label }), ` ${name}`);
    return chip;
  }));
}

function render() {
  if (!surfaceEl) return;
  const windows = getWindows();
  computeTitles();
  const ids = new Set(windows.map((w) => w.id));
  for (const [id, node] of nodes) {
    if (!ids.has(id)) {
      destroyNode(node);
      nodes.delete(id);
    }
  }
  for (const win of windows) {
    let node = nodes.get(win.id);
    if (!node) {
      node = createNode(win);
      nodes.set(win.id, node);
      worldEl.append(node.root);
    }
    updateNode(win, node);
    applyGeometry(node, win);
  }
  emptyEl.hidden = windows.length > 0;
  // Téléphone : une seule fenêtre à la fois, en plein écran (la plus récemment utilisée) ; les autres se choisissent dans la bande du dock.
  const shown = windows.filter((w) => !w.minimized);
  const front = shown.length ? shown.reduce((a, b) => ((b.z || 0) >= (a.z || 0) ? b : a)) : null;
  for (const win of windows) nodes.get(win.id)?.root.classList.toggle("is-back", Boolean(front) && win.id !== front.id);
  renderDock(front?.id);
  if (isMobile() && front) requestAnimationFrame(() => nodes.get(front.id)?.term?.fit());
  renderLayoutSelect();
}

function renderLayoutSelect() {
  if (!layoutSelect) return;
  const layouts = getLayouts();
  const previous = layoutSelect.value;
  layoutSelect.replaceChildren(
    el("option", { value: "" }, layouts.length ? "Mises en page…" : "Aucune mise en page"),
    ...layouts.map((l) => el("option", { value: l.name }, `${l.name} (${l.count})`)),
  );
  layoutSelect.value = layouts.some((l) => l.name === previous) ? previous : "";
  deleteButton.disabled = !layoutSelect.value;
}

// ---------- Dépôt depuis le rail ----------
function dropAt(event) {
  const rect = surfaceEl.getBoundingClientRect();
  const at = toWorld(event.clientX - rect.left, event.clientY - rect.top);
  return { x: at.x - 24, y: at.y - 16 };
}

function handleDrop(item, at) {
  if (item.kind === "agent") openAgentWindow(item.host, item.agentId, { at, cwd: item.cwd, title: item.title });
  else if (item.kind === "terminal") openTerminalWindow(item.host, item.terminalId, { at, cwd: item.cwd });
  else if (item.kind === "project") openTerminalInFolder({ host: item.host, cwd: item.cwd, at });
  else if (item.kind === "machine") {
    const first = allProjects(getState()).find((p) => p.host === item.host);
    if (first) openTerminalInFolder({ host: item.host, cwd: first.directory, at });
    else toast(`Aucun projet connu sur « ${hostLabel(item.host)} » : lancez-en un depuis « Lancer ».`, { kind: "error" });
  }
}

function bindDrop(surface) {
  const has = (event) => [...(event.dataTransfer?.types || [])].includes(DROP_TYPE);
  surface.addEventListener("dragover", (event) => {
    if (!has(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    surface.classList.add("is-drop");
  });
  surface.addEventListener("dragleave", (event) => {
    if (event.target === surface) surface.classList.remove("is-drop");
  });
  surface.addEventListener("drop", (event) => {
    surface.classList.remove("is-drop");
    if (!has(event)) return;
    event.preventDefault();
    try {
      handleDrop(JSON.parse(event.dataTransfer.getData(DROP_TYPE)), dropAt(event));
    } catch {
      toast("Élément déposé non reconnu.", { kind: "error" });
    }
  });
}

// ---------- Barre d'outils ----------
function toolbar() {
  const grid = el("button", { class: "btn btn-sm", type: "button", onclick: arrangeGrid }, "Ranger en grille");
  grid.prepend(iconEl(icons.grid));
  const group = el("button", { class: "btn btn-sm", type: "button", onclick: groupByMachine }, "Grouper par machine");
  group.prepend(iconEl(icons.group));
  layoutSelect = el("select", { class: "select-sm", "aria-label": "Mises en page enregistrées" });
  layoutSelect.addEventListener("change", () => {
    if (layoutSelect.value) loadLayout(layoutSelect.value);
    deleteButton.disabled = !layoutSelect.value;
  });
  const save = el("button", { class: "btn btn-sm", type: "button", onclick: saveCurrent }, "Enregistrer…");
  save.prepend(iconEl(icons.save));
  deleteButton = el("button", { class: "btn btn-sm btn-danger-ghost", type: "button", disabled: true,
    "aria-label": "Supprimer la mise en page choisie", onclick: removeSelected });
  deleteButton.innerHTML = icons.trash;
  return el("div", { class: "view-toolbar", role: "toolbar", "aria-label": "Outils du Bureau" },
    el("h1", { class: "view-title" }, "Bureau"),
    zoomControls(),
    el("div", { class: "toolbar-group desk-arrange" }, grid, group),
    el("div", { class: "toolbar-group desk-layouts" }, layoutSelect, save, deleteButton),
  );
}

// ---------- Zoom et déplacement (bureau infini) ----------
function zoomControls() {
  const out = el("button", { class: "btn btn-sm desk-zoom-out", type: "button", "aria-label": "Dézoomer",
    title: "Dézoomer (Ctrl + molette)", onclick: () => zoomStep(-1) }, "−");
  const inn = el("button", { class: "btn btn-sm desk-zoom-in", type: "button", "aria-label": "Zoomer",
    title: "Zoomer (Ctrl + molette)", onclick: () => zoomStep(1) }, "+");
  zoomLabel = el("output", { class: "desk-zoom-pct mono", "aria-live": "polite", title: "Niveau de zoom" });
  const reset = el("button", { class: "btn btn-sm desk-zoom-reset", type: "button", title: "Revenir à 100 %",
    onclick: resetZoom }, "100 %");
  const all = el("button", { class: "btn btn-sm desk-zoom-all", type: "button",
    title: "Ajuster zoom et position pour voir toutes les fenêtres", onclick: fitAll }, "Tout voir");
  const autoBox = el("label", { class: "check desk-auto", title: "Ouvre sur le Bureau les nouvelles sessions lancées ailleurs (Hermes, orchestrateur, tâches)" },
    el("input", { type: "checkbox", checked: getAutoOpen(), onchange: (e) => setAutoOpen(e.target.checked) }), " Ouvrir les nouvelles sessions");
  return el("div", { class: "toolbar-group desk-zoom", role: "group", "aria-label": "Zoom du Bureau" },
    out, zoomLabel, inn, reset, all, autoBox);
}

// Applique zoom + position : transformation du monde, grille de fond, pourcentage, fenêtres agrandies.
function applyView() {
  if (!surfaceEl || !worldEl) return;
  const { z, x, y } = getView();
  worldEl.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  const cell = 24 * z;
  surfaceEl.style.backgroundSize = `${cell}px ${cell}px`;
  surfaceEl.style.backgroundPosition = `${x}px ${y}px`;
  if (zoomLabel) zoomLabel.textContent = `${Math.round(z * 100)} %`;
  const zoomOut = document.querySelector(".desk-zoom-out");
  const zoomIn = document.querySelector(".desk-zoom-in");
  if (zoomOut) zoomOut.disabled = z <= ZOOM_MIN + 0.001;
  if (zoomIn) zoomIn.disabled = z >= ZOOM_MAX - 0.001;
  for (const win of getWindows()) {
    const node = nodes.get(win.id);
    if (node && win.maximized) applyGeometry(node, win);
  }
}

// Glisser sur le fond VIDE déplace la vue ; une fenêtre ou son contenu ne déclenche jamais le déplacement.
function bindPan(surface) {
  const isBackground = (event) => event.target === surface || event.target === worldEl;
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || isMobile() || !isBackground(event)) return;
    const start = { x: event.clientX, y: event.clientY, vx: getView().x, vy: getView().y };
    surface.setPointerCapture(event.pointerId);
    surface.classList.add("is-panning");
    const move = (ev) => setView({ x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y });
    const end = () => {
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", end);
      surface.removeEventListener("pointercancel", end);
      surface.classList.remove("is-panning");
    };
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", end);
    surface.addEventListener("pointercancel", end);
  });
  // Ctrl + molette : zoom autour du curseur. Molette seule sur le fond : déplacement (les fenêtres défilent normalement).
  surface.addEventListener("wheel", (event) => {
    if (isMobile()) return;
    const rect = surface.getBoundingClientRect();
    if (event.ctrlKey) {
      event.preventDefault();
      zoomAt(getView().z * Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    } else if (isBackground(event)) {
      event.preventDefault();
      const horizontal = event.shiftKey && !event.deltaX;
      setView({
        x: getView().x - (horizontal ? event.deltaY : event.deltaX),
        y: getView().y - (horizontal ? 0 : event.deltaY),
      });
    }
  }, { passive: false });
}

async function saveCurrent() {
  const name = await promptDialog({
    title: "Enregistrer la mise en page",
    label: "Nom de la mise en page",
    value: layoutSelect.value || "Mon bureau",
    confirmLabel: "Enregistrer",
  });
  if (name) saveLayout(name);
}
async function removeSelected() {
  const name = layoutSelect.value;
  if (!name) return;
  const ok = await confirmDialog({
    title: `Supprimer « ${name} » ?`,
    message: "La mise en page enregistrée est supprimée du serveur. Les fenêtres ouvertes ne bougent pas.",
    confirmLabel: "Supprimer",
    danger: true,
  });
  if (ok) deleteLayout(name);
}

// ---------- Vue ----------
const view = {
  id: "bureau",
  title: "Bureau",
  short: "Bureau",
  icon: icons.desk,
  order: 10,
  rail: "projects", // projets suivis : agents et terminaux à glisser sur le Bureau
  mount(container, context) {
    ctx = context;
    surfaceEl = el("div", { class: "desk-surface", tabindex: "-1" });
    worldEl = el("div", { class: "desk-world" });
    surfaceEl.append(worldEl);
    emptyEl = el("div", { class: "desk-empty" },
      el("h2", {}, "Le bureau est vide"),
      el("p", {}, "Glissez un projet, un terminal ou un agent depuis le rail, ou utilisez le bouton + d’un projet " +
        "pour ouvrir un terminal dans son dossier."),
    );
    dockEl = el("div", { class: "desk-dock", role: "toolbar", "aria-label": "Fenêtres réduites", hidden: true });
    surfaceEl.append(emptyEl);
    const deskEl = el("div", { class: "desk" }, toolbar(), surfaceEl, dockEl);
    container.replaceChildren(deskEl);
    const unmountWidgetBar = mountWidgetBar(deskEl);
    bindDrop(surfaceEl);
    bindPan(surfaceEl);
    const resize = new ResizeObserver(() => {
      setSurface(surfaceEl.clientWidth, surfaceEl.clientHeight);
      render();
      applyView();
      for (const node of nodes.values()) node.term?.fit();
    });
    resize.observe(surfaceEl);
    setSurface(surfaceEl.clientWidth, surfaceEl.clientHeight);
    const mql = window.matchMedia(MOBILE);
    const onMobileChange = () => {
      render();
      requestAnimationFrame(() => {
        for (const node of nodes.values()) node.term?.fit();
      });
    };
    mql.addEventListener("change", onMobileChange);
    const onDeskEvent = (reason) => {
      render();
      if (["layout", "restore", "maximize", "resize", "arrange"].includes(reason)) {
        requestAnimationFrame(() => {
          for (const node of nodes.values()) node.term?.fit();
        });
      }
    };
    cleanups = [
      () => resize.disconnect(),
      () => mql.removeEventListener("change", onMobileChange),
      subscribeDesk(onDeskEvent),
      subscribeView(applyView),
      ctx.onState(render),
      on("freebuff.jobs", (m) => { fbJobs = m.jobs || []; if (surfaceEl) render(); }),
      onConnection((up) => { if (up) send({ type: "freebuff.jobs" }); }),
      unmountWidgetBar,
    ];
    send({ type: "freebuff.jobs" });
    render();
    applyView();
  },
  unmount() {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    for (const node of nodes.values()) destroyNode(node);
    nodes.clear();
    surfaceEl = worldEl = zoomLabel = dockEl = emptyEl = layoutSelect = deleteButton = null;
  },
};

registerView(view);
export default view;
