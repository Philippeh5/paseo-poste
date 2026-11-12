// Vue « Chronologie » : une frise horizontale par machine, une barre par période de travail d'un agent.
// Dessin sur <canvas> (étiquettes, règle et tableau accessible en DOM). Aucune bibliothèque externe ;
// toutes les couleurs viennent des jetons CSS du thème courant. Données : handlers/timeline.mjs.
import { registerView } from "./registry.js";
import { el, led, icons, hostStatus, formatDuration } from "../core/util.js";
import { openAgentDrawer } from "../core/drawer.js";
import { onThemeChange } from "../core/theme.js";
import { hostLabel, harnessLabel, sessionName, projectLabel } from "../core/names.js";
import { mountActivityList } from "../components/agentactivity.js";

const RULER_H = 28; // hauteur de la règle des heures
const LANE_H = 24; // hauteur d'un couloir (barre 20 px + 4 px d'écart)
const BAR_H = 20;
const PAD_Y = 8; // marge haute/basse d'une piste
const MIN_ROW_H = 44;
const MARKER = 8;
const MAX_DRAWN = 500; // épisodes dessinés au plus (les plus récents)
const FETCH_DAYS = 8; // un peu plus que la fenêtre maximale (7 j)
const WINDOWS = [
  { label: "1 h", ms: 3_600_000 },
  { label: "6 h", ms: 21_600_000 },
  { label: "24 h", ms: 86_400_000 },
  { label: "7 jours", ms: 604_800_000 },
];
const MIN_MS = 5 * 60_000; // zoom maximal : 5 minutes
const MAX_MS = WINDOWS.at(-1).ms;

// État → jeton sémantique, libellé et glyphe (le glyphe évite de se fier à la seule couleur).
const ACTIVE = { token: "--ok", label: "Actif", glyph: "●" };
const WAITING = { token: "--attention", label: "Permission requise", glyph: "◆" };
const STATUS = {
  running: ACTIVE, working: ACTIVE, initializing: { ...ACTIVE, label: "Initialisation" },
  "waiting-permission": WAITING, waiting_permission: WAITING,
  error: { token: "--danger", label: "Erreur", glyph: "✕" },
  closed: { token: "--inactif", label: "Terminé", glyph: "✓" },
  interrupted: { token: "--inactif", label: "Interrompu", glyph: "–" },
};
const statusOf = (ep) => STATUS[ep.status] || STATUS.closed;

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Couleur de texte lisible sur un fond donné : le jeton (clair ou foncé) au meilleur contraste.
function luminance(color) {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return 0.5;
  const channel = (i) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
function textOn(background) {
  const bg = luminance(background);
  const ratio = (c) => (Math.max(bg, luminance(c)) + 0.05) / (Math.min(bg, luminance(c)) + 0.05);
  const dark = cssVar("--sol");
  const light = cssVar("--texte");
  return ratio(dark) >= ratio(light) ? dark : light;
}

// ---------- État du module ----------
let ctx = null;
let root = null;
let episodes = [];
let windowMs = WINDOWS[1].ms;
let viewEnd = Date.now();
let follow = true; // la fenêtre suit « maintenant »
let layout = []; // zones cliquables du dernier dessin : { x1, x2, y1, y2, ep }
let hostRows = []; // [{ label, top, height }]
let cleanups = [];
let timers = [];
let drag = null;
const dom = {};

const viewStart = () => viewEnd - windowMs;
const toX = (t, width) => ((t - viewStart()) / windowMs) * width;

function fetchEpisodes() {
  ctx?.send({ type: "timeline.list", since: new Date(Date.now() - FETCH_DAYS * 86_400_000).toISOString() });
}
let fetchTimer = 0;
const fetchSoon = () => {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(fetchEpisodes, 250);
};

function receive(message) {
  episodes = (message.episodes || []).slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  paint();
}

const bounds = (ep, now) => [new Date(ep.start).getTime(), ep.end ? new Date(ep.end).getTime() : now];
const overlaps = (ep, now) => {
  const [s, e] = bounds(ep, now);
  return e >= viewStart() && s <= viewEnd;
};

// Pistes : une par machine connue, puis les machines qui n'ont plus que des épisodes passés.
function hostLabels() {
  const known = (ctx?.state?.hosts || []).map((h) => h.label);
  const extra = [...new Set(episodes.map((e) => e.host))].filter((h) => !known.includes(h));
  return [...known, ...extra];
}

// Couloirs : chaque épisode prend le premier couloir libre (calcul en pixels, donc dépend du zoom).
function assignLanes(list, width, now) {
  const laneEnds = [];
  return list.map((ep) => {
    const [s, e] = bounds(ep, now);
    const x1 = toX(s, width);
    const x2 = Math.max(x1 + 3, toX(e, width));
    let lane = laneEnds.findIndex((end) => end + 2 <= x1);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = x2;
    return { ep, lane, x1, x2 };
  });
}

// ---------- Dessin ----------
function sizeCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = `${height}px`;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);
  return g;
}

function paintRuler(width) {
  const g = sizeCanvas(dom.ruler, width, RULER_H);
  const ticks = Math.max(3, Math.min(12, Math.floor(width / 90)));
  const step = windowMs / ticks;
  g.font = `11px ${cssVar("--police-mono") || "monospace"}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = cssVar("--texte-doux");
  g.strokeStyle = cssVar("--trait");
  for (let i = 0; i <= ticks; i++) {
    const t = viewStart() + i * step;
    const x = Math.round(toX(t, width)) + 0.5;
    g.beginPath();
    g.moveTo(x, RULER_H - 7);
    g.lineTo(x, RULER_H);
    g.stroke();
    if (i === ticks) continue;
    const d = new Date(t);
    const label = windowMs >= 86_400_000
      ? d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })
      : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    g.fillText(label, x + 4, RULER_H / 2 - 2);
  }
  const nowX = toX(Date.now(), width);
  if (nowX >= 0 && nowX <= width) {
    g.fillStyle = cssVar("--accent");
    g.beginPath();
    g.moveTo(nowX - 5, RULER_H - 9);
    g.lineTo(nowX + 5, RULER_H - 9);
    g.lineTo(nowX, RULER_H - 1);
    g.fill();
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
}

function drawMarker(g, x, cy, type, halo) {
  const r = MARKER / 2;
  g.save();
  g.lineWidth = 2;
  g.strokeStyle = halo;
  if (type === "permission") { // losange
    g.fillStyle = cssVar("--attention");
    g.beginPath();
    g.moveTo(x, cy - r - 1); g.lineTo(x + r + 1, cy); g.lineTo(x, cy + r + 1); g.lineTo(x - r - 1, cy);
    g.closePath();
    g.stroke(); g.fill();
  } else if (type === "erreur") { // croix
    g.strokeStyle = halo;
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(x - r, cy - r); g.lineTo(x + r, cy + r); g.moveTo(x + r, cy - r); g.lineTo(x - r, cy + r);
    g.stroke();
    g.strokeStyle = cssVar("--danger");
    g.lineWidth = 2;
    g.stroke();
  } else if (type === "reprise") { // triangle vers la droite
    g.fillStyle = cssVar("--ok");
    g.beginPath(); g.moveTo(x - r, cy - r - 1); g.lineTo(x + r + 1, cy); g.lineTo(x - r, cy + r + 1);
    g.closePath();
    g.stroke(); g.fill();
  }
  g.restore();
}

function paint() {
  if (!root || !dom.tracks) return;
  const width = dom.tracks.parentElement.clientWidth;
  if (width <= 0) return;
  const now = Date.now();
  if (follow) viewEnd = now;
  paintRuler(width);

  const labels = hostLabels();
  const drawn = episodes.filter((ep) => overlaps(ep, now)).slice(-MAX_DRAWN);
  hostRows = [];
  let top = 0;
  for (const label of labels) {
    const lanes = assignLanes(drawn.filter((ep) => ep.host === label), width, now);
    const count = lanes.reduce((max, l) => Math.max(max, l.lane + 1), 1);
    const height = Math.max(MIN_ROW_H, count * LANE_H + PAD_Y * 2 - 4);
    hostRows.push({ label, top, height, lanes });
    top += height;
  }
  const total = Math.max(top, dom.scroll.clientHeight - RULER_H);
  const g = sizeCanvas(dom.tracks, width, total);
  layout = [];

  // Fond alterné et grille verticale
  hostRows.forEach((row, i) => {
    g.fillStyle = cssVar(i % 2 === 0 ? "--panneau" : "--panneau-2");
    g.fillRect(0, row.top, width, row.height);
  });
  g.fillStyle = cssVar("--sol");
  g.fillRect(0, top, width, total - top);
  const ticks = Math.max(3, Math.min(12, Math.floor(width / 90)));
  g.strokeStyle = cssVar("--trait");
  g.globalAlpha = 0.5;
  for (let i = 0; i <= ticks; i++) {
    const x = Math.round(toX(viewStart() + (i * windowMs) / ticks, width)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, total); g.stroke();
  }
  g.globalAlpha = 1;
  hostRows.forEach((row) => {
    g.fillStyle = cssVar("--trait");
    g.fillRect(0, row.top + row.height - 1, width, 1);
  });

  // Barres
  const font = `500 11px ${cssVar("--police-ui") || "sans-serif"}`;
  const halo = cssVar("--sol");
  for (const row of hostRows) {
    if (!row.lanes.length) {
      g.fillStyle = cssVar("--texte-doux");
      g.font = `12px ${cssVar("--police-ui") || "sans-serif"}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("Aucun travail sur cette période", width / 2, row.top + row.height / 2);
      continue;
    }
    for (const { ep, lane, x1, x2 } of row.lanes) {
      const y = row.top + PAD_Y + lane * LANE_H;
      const st = statusOf(ep);
      const color = cssVar(st.token);
      const cx1 = Math.max(0, x1);
      const cx2 = Math.min(width, x2);
      if (cx2 <= cx1) continue;
      g.globalAlpha = 0.92;
      g.fillStyle = color;
      roundRect(g, cx1, y, cx2 - cx1, BAR_H, 3);
      g.fill();
      g.globalAlpha = 1;
      if (cx2 - cx1 > 54) {
        g.save();
        g.beginPath(); g.rect(cx1 + 2, y, cx2 - cx1 - 4, BAR_H); g.clip();
        g.fillStyle = textOn(color);
        g.font = font;
        g.textAlign = "left";
        g.textBaseline = "middle";
        const name = sessionName({
          project: ep.project,
          host: ep.host,
          provider: ep.provider,
    model: ep.model,
          title: ep.title,
          kind: "agent",
          id: ep.agentId,
        });
        g.fillText(`${st.glyph} ${name}`, cx1 + 6, y + BAR_H / 2 + 0.5);
        g.restore();
      }
      for (const mk of ep.markers || []) {
        const t = new Date(mk.t).getTime();
        if (t < viewStart() || t > viewEnd) continue;
        drawMarker(g, toX(t, width), y + BAR_H / 2, mk.type, halo);
      }
      layout.push({ x1: cx1, x2: cx2, y1: y, y2: y + BAR_H, ep });
    }
  }

  // Ligne « maintenant »
  const nowX = toX(now, width);
  if (nowX >= 0 && nowX <= width) {
    g.strokeStyle = cssVar("--accent");
    g.lineWidth = 1.5;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(nowX + 0.5, 0); g.lineTo(nowX + 0.5, total); g.stroke();
    g.setLineDash([]);
    g.lineWidth = 1;
  }

  updateLabels();
  updateSummary(drawn);
  updateButtons();
}

// ---------- Étiquettes, résumé, tableau accessible ----------
function updateLabels() {
  const hosts = ctx?.state?.hosts || [];
  dom.labels.replaceChildren(...hostRows.map((row) => {
    const info = hosts.find((h) => h.label === row.label);
    const status = info ? hostStatus(info.status) : { tone: "inactif", label: "Machine retirée" };
    const mLabel = hostLabel(row.label);
    return el("div", {
      class: "chrono-label", style: `height:${row.height}px`, title: `${mLabel} : ${status.label}`,
    },
      led(status.tone, { pulse: status.tone === "attention", label: status.label }),
      el("span", { class: "chrono-label-name" }, mLabel));
  }));
  dom.labelsBox.style.minHeight = `${dom.tracks.style.height}`;
}

function updateSummary(drawn) {
  const total = drawn.length;
  const active = drawn.filter((e) => !e.end).length;
  dom.summary.textContent = `${total} période${total > 1 ? "s" : ""} de travail${active ? `, ${active} en cours` : ""}`;
  const rows = hostRows.flatMap((row) => row.lanes.map(({ ep }) => {
    const sName = sessionName({
      project: ep.project,
      host: ep.host,
      provider: ep.provider,
    model: ep.model,
      title: ep.title,
      kind: "agent",
      id: ep.agentId,
    });
    return el("tr", {},
      el("td", {}, hostLabel(row.label)),
      el("td", {}, sName),
      el("td", {}, harnessLabel(ep.provider)),
      el("td", {}, projectLabel(ep.project) || "—"),
      el("td", {}, new Date(ep.start).toLocaleString("fr-FR")),
      el("td", {}, ep.end ? new Date(ep.end).toLocaleString("fr-FR") : "En cours"),
      el("td", {}, statusOf(ep).label));
  }));
  dom.table.replaceChildren(
    el("thead", {}, el("tr", {}, ...["Machine", "Agent", "Fournisseur", "Projet", "Début", "Fin", "Statut"]
      .map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows));
}

function updateButtons() {
  for (const btn of dom.windowBtns.querySelectorAll("button")) {
    const active = Math.abs(Number(btn.dataset.ms) - windowMs) < 1000;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
  dom.nowBtn.classList.toggle("is-active", follow);
}

// ---------- Infobulle ----------
function hitAt(x, y) {
  for (let i = layout.length - 1; i >= 0; i--) {
    const h = layout[i];
    if (x >= h.x1 - 2 && x <= h.x2 + 2 && y >= h.y1 && y <= h.y2) return h.ep;
  }
  return null;
}
function showTooltip(ep, clientX, clientY) {
  const [s, e] = bounds(ep, Date.now());
  const st = statusOf(ep);
  const markers = (ep.markers || []).filter((m) => m.type !== "fin");
  const name = sessionName({
    project: ep.project,
    host: ep.host,
    provider: ep.provider,
    model: ep.model,
    title: ep.title,
    kind: "agent",
    id: ep.agentId,
  });
  dom.tooltip.replaceChildren(
    el("strong", {}, name),
    el("div", { class: "tt-meta" }, `${harnessLabel(ep.provider)}${ep.model ? ` / ${ep.model}` : ""}`),
    el("div", { class: "tt-meta" }, `Projet : ${projectLabel(ep.project)} · Machine : ${hostLabel(ep.host)}`),
    el("div", { class: "tt-meta" }, `Début : ${new Date(s).toLocaleString("fr-FR")}`),
    el("div", { class: "tt-meta" }, ep.end ? `Fin : ${new Date(e).toLocaleString("fr-FR")}` : "En cours"),
    el("div", { class: "tt-meta" }, `Durée : ${formatDuration(e - s)}`),
    el("div", { class: "tt-status" }, `${st.glyph} ${st.label}`,
      markers.length ? ` · ${markers.length} événement${markers.length > 1 ? "s" : ""}` : ""));
  dom.tooltip.classList.add("is-visible");
  const box = dom.tooltip.getBoundingClientRect();
  const left = clientX + 14 + box.width > window.innerWidth - 8 ? clientX - box.width - 14 : clientX + 14;
  const topPos = Math.min(clientY - 8, window.innerHeight - box.height - 8);
  dom.tooltip.style.left = `${Math.max(8, left)}px`;
  dom.tooltip.style.top = `${Math.max(8, topPos)}px`;
}
const hideTooltip = () => dom.tooltip?.classList.remove("is-visible");

// ---------- Interactions ----------
function localPoint(event) {
  const rect = dom.tracks.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width };
}
function pan(deltaMs) {
  viewEnd = Math.min(Date.now() + windowMs * 0.1, viewEnd + deltaMs);
  follow = false;
  paint();
}
function zoomTo(ms, anchorRatio = 1) {
  const next = Math.min(MAX_MS, Math.max(MIN_MS, ms));
  const anchorTime = viewStart() + anchorRatio * windowMs;
  windowMs = next;
  viewEnd = anchorTime + (1 - anchorRatio) * windowMs;
  follow = anchorRatio === 1 && viewEnd >= Date.now() - 1000;
  if (follow) viewEnd = Date.now();
  paint();
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  drag = { startX: event.clientX, startEnd: viewEnd, moved: false, id: event.pointerId };
  dom.tracks.setPointerCapture?.(event.pointerId);
  hideTooltip();
}
function onPointerMove(event) {
  const p = localPoint(event);
  if (drag) {
    const dx = event.clientX - drag.startX;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (drag.moved) {
      viewEnd = Math.min(Date.now() + windowMs * 0.1, drag.startEnd - (dx / p.width) * windowMs);
      follow = false;
      dom.tracks.style.cursor = "grabbing";
      paint();
    }
    return;
  }
  const ep = hitAt(p.x, p.y);
  dom.tracks.style.cursor = ep ? "pointer" : "grab";
  if (ep) showTooltip(ep, event.clientX, event.clientY);
  else hideTooltip();
}
function onPointerUp(event) {
  if (!drag) return;
  const wasClick = !drag.moved;
  drag = null;
  dom.tracks.style.cursor = "grab";
  if (wasClick) {
    const p = localPoint(event);
    const ep = hitAt(p.x, p.y);
    if (ep) openAgentDrawer(ep.host, ep.agentId);
  }
}
function onWheel(event) {
  event.preventDefault();
  const p = localPoint(event);
  zoomTo(windowMs * (event.deltaY > 0 ? 1.3 : 1 / 1.3), p.x / p.width);
}
function onKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const keys = {
    ArrowLeft: () => pan(-windowMs * 0.25), ArrowRight: () => pan(windowMs * 0.25),
    "+": () => zoomTo(windowMs / 1.5), "-": () => zoomTo(windowMs * 1.5), Home: goNow,
  };
  if (!keys[event.key]) return;
  event.preventDefault();
  keys[event.key]();
}
function goNow() {
  follow = true;
  viewEnd = Date.now();
  paint();
}

// ---------- Construction ----------
function build() {
  dom.windowBtns = el("div", { class: "chrono-window-btns", role: "group", "aria-label": "Durée affichée" },
    ...WINDOWS.map((w) => el("button", {
      type: "button", dataset: { ms: String(w.ms) }, onclick: () => zoomTo(w.ms, follow ? 1 : 0.5),
    }, w.label)));
  dom.nowBtn = el("button", { type: "button", onclick: goNow, title: "Revenir à maintenant" }, "Maintenant");
  dom.summary = el("span", { class: "chrono-summary", role: "status" });
  const nav = el("div", { class: "chrono-nav-btns", role: "group", "aria-label": "Navigation dans le temps" },
    el("button", { type: "button", onclick: () => pan(-windowMs * 0.5) }, "Précédent"), dom.nowBtn,
    el("button", { type: "button", onclick: () => pan(windowMs * 0.5) }, "Suivant"));
  const toolbar = el("div", { class: "chrono-toolbar" }, el("h1", { class: "view-title" }, "Chronologie"),
    dom.windowBtns, el("div", { class: "chrono-toolbar-sep", "aria-hidden": "true" }), nav, dom.summary);

  dom.ruler = el("canvas", { class: "chrono-ruler", "aria-hidden": "true" });
  dom.rulerBox = el("div", { class: "chrono-canvas-box" }, dom.ruler);
  dom.tracks = el("canvas", { class: "chrono-canvas", "aria-hidden": "true" });
  dom.tracks.addEventListener("pointerdown", onPointerDown);
  dom.tracks.addEventListener("pointermove", onPointerMove);
  dom.tracks.addEventListener("pointerup", onPointerUp);
  dom.tracks.addEventListener("pointercancel", () => { drag = null; });
  dom.tracks.addEventListener("pointerleave", () => { hideTooltip(); });
  dom.tracks.addEventListener("wheel", onWheel, { passive: false });
  dom.labels = el("div", { class: "chrono-label-list" });
  dom.labelsBox = el("div", { class: "chrono-labels" }, dom.labels);
  dom.canvasBox = el("div", { class: "chrono-canvas-box" }, dom.tracks);
  dom.scroll = el("div", {
    class: "chrono-scroll", tabindex: "0", role: "group",
    "aria-label": "Frise du temps : flèches gauche et droite pour naviguer, plus et moins pour zoomer",
  }, el("div", { class: "chrono-rulerrow" }, el("div", { class: "chrono-corner" }, "Machine"), dom.rulerBox),
  el("div", { class: "chrono-tracksrow" }, dom.labelsBox, dom.canvasBox));
  dom.scroll.addEventListener("keydown", onKey);

  const sw = (cls, text) => el("div", { class: "chrono-legend-item" },
    el("span", { class: `chrono-dot ${cls}` }), text);
  const mk = (glyph, token, text) => el("div", { class: "chrono-legend-item" },
    el("span", { class: "chrono-marker-glyph", style: `color:var(${token})`, "aria-hidden": "true" }, glyph), text);
  const legend = el("div", { class: "chrono-legend", "aria-label": "Légende" },
    sw("ok", "Actif"), sw("wait", "Attente de permission"), sw("fail", "Erreur"), sw("done", "Terminé / interrompu"),
    el("div", { class: "chrono-toolbar-sep", "aria-hidden": "true" }),
    mk("◆", "--attention", "Demande de permission"), mk("✕", "--danger", "Erreur"), mk("▶", "--ok", "Reprise"),
    el("div", { class: "chrono-legend-item chrono-hint" },
      "Molette : zoom · glisser : défiler · clic : ouvrir l’agent"));

  dom.table = el("table", { class: "chrono-sr-table" });
  dom.table.setAttribute("aria-label", "Récapitulatif des périodes de travail");
  dom.tooltip = el("div", { class: "chrono-tooltip", role: "tooltip" });
  document.body.append(dom.tooltip);
  dom.activity = el("ol", { class: "agentactivity-list" });
  const activity = el("section", { class: "agentactivity-section", "aria-label": "Activité de l'agent" },
    el("h2", {}, "Activité de l'agent"), dom.activity);
  return el("div", { class: "chrono-view" }, toolbar, dom.scroll, legend, dom.table, activity);
}

const view = {
  id: "chronologie",
  title: "Chronologie",
  short: "Chrono",
  icon: icons.timeline,
  order: 40,

  mount(container, context) {
    ctx = context;
    episodes = [];
    windowMs = WINDOWS[1].ms;
    viewEnd = Date.now();
    follow = true;
    root = build();
    container.replaceChildren(root);
    const resize = new ResizeObserver(() => paint());
    resize.observe(dom.canvasBox);
    cleanups = [
      () => resize.disconnect(),
      ctx.on("timeline.list", receive),
      ctx.on("timeline.changed", fetchSoon),
      ctx.onState(() => paint()),
      ctx.onConnection((up) => up && fetchEpisodes()),
      onThemeChange(() => paint()),
      mountActivityList(dom.activity),
    ];
    timers = [setInterval(() => !document.hidden && paint(), 3000)];
    fetchEpisodes();
    paint();
  },

  unmount() {
    cleanups.forEach((fn) => fn?.());
    timers.forEach(clearInterval);
    clearTimeout(fetchTimer);
    dom.tooltip?.remove();
    cleanups = [];
    timers = [];
    drag = null;
    root = ctx = null;
    Object.keys(dom).forEach((k) => delete dom[k]);
  },
};

registerView(view);
export default view;
