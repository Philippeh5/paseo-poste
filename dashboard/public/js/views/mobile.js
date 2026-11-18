// Vue « Téléphone » : accueil pensé pour un petit écran, à la manière de l'application mobile de Claude.
// Trois onglets : Sessions (à traiter / actives / par projet, anciennes repliées), Crédits (jauges et courbes d'usage),
// Ranger (archiver les anciennes sessions, à la demande ou automatiquement). Tous les textes passent par el() (nœuds texte).
import { registerView } from "./registry.js";
import { el, icons, iconEl, folderName, agentStatus, led, readPref, writePref } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { openAgentDrawer } from "../core/drawer.js";
import { openAgentWindow } from "../core/deskstore.js";
import { sessionName } from "../core/names.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import { subscribeAgentMode, getAgentModeState } from "../components/agentmode.js";
import { alertCount, subscribeAlerts } from "../components/agentalerts.js";

const TAB_PREF = "paseo-mobile-tab";
const RANGE_PREF = "paseo-mobile-range";
const BUSY = new Set(["running", "working", "initializing"]);
const WAITING = new Set(["waiting-permission", "waiting_permission"]);
const TABS = [["sessions", "Sessions"], ["credits", "Crédits"], ["ranger", "Ranger"]];
const AGES = [[1, "1 h"], [6, "6 h"], [24, "24 h"], [168, "7 j"]];
const RANGES = [[24, "24 h"], [168, "7 j"]];
const SVG_NS = "http://www.w3.org/2000/svg";

let ctx = null;
let root = null;
let body = null;
let tabbar = null;
let cleanups = [];
let tab = "sessions";
let query = "";
let quota = null;
let history = { points: [] };
let tidy = { auto: false, olderThanHours: 24 };
let preview = null;
let fbJobs = [];
let delegated = [];
let range = 24;
let openProjects = new Set();
let tickTimer = 0;
let delegTimer = 0;
const oldMs = () => tidy.olderThanHours * 3_600_000; // « ancienne » = le seuil de rangement choisi dans l'onglet Ranger

const svgEl = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const kid of kids) if (kid) node.append(kid);
  return node;
};

export function ago(ms) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "à l’instant";
  if (m < 60) return `il y a ${m} min`;
  if (m < 2880) return `il y a ${Math.floor(m / 60)} h`;
  return `il y a ${Math.floor(m / 1440)} j`;
}
export const toneOfPct = (pct) => (pct >= 90 ? "danger" : pct >= 70 ? "attention" : "ok");
const idleFor = (a, now = Date.now()) => {
  const at = Date.parse(a.updatedAt || "");
  return Number.isFinite(at) ? now - at : 0;
};
const projectOf = (state, a) => {
  const ws = state.workspaces.find((w) => w.host === a.host && w.workspaceId === a.workspaceId);
  const dir = ws?.directory || a.cwd || "";
  return { key: dir.toLowerCase() || "?", name: folderName(dir) || "Sans projet" };
};
const nameOf = (a) => sessionName({ project: a.cwd || a.workspaceId, host: a.host, provider: a.provider, model: a.model, title: a.title, kind: "agent", id: a.agentId });

function open(a) {
  openAgentDrawer(a.host, a.agentId, {
    actions: [{ label: "Ouvrir sur le Bureau", onClick: () => { openAgentWindow(a.host, a.agentId, { cwd: a.cwd, title: a.title }); location.hash = "#bureau"; } }],
  });
}

// ---------- Sessions ----------
function row(a, now) {
  const st = agentStatus(a.status);
  const wait = WAITING.has(a.status);
  const stale = !BUSY.has(a.status) && !wait && idleFor(a, now) >= oldMs();
  const canShelve = !BUSY.has(a.status) && !wait;
  return el("li", { class: `m-row${wait ? " is-wait" : ""}${stale ? " is-old" : ""}` },
    el("button", { class: "m-row-main", type: "button", onclick: () => open(a) },
      led(st.tone, { pulse: wait || BUSY.has(a.status), label: st.label }),
      el("span", { class: "m-row-text" },
        el("strong", {}, nameOf(a)),
        el("span", { class: "m-row-sub" }, `${st.label} · ${a.updatedAt ? ago(idleFor(a, now)) : "—"}`)),
      iconEl(icons.chevronRight)),
    canShelve && el("button", { class: "m-shelve", type: "button", "aria-label": `Ranger ${nameOf(a)}`, title: "Ranger (archiver)",
      onclick: () => { send({ type: "agent.close", host: a.host, agentId: a.agentId }); toast("Session rangée."); } }, iconEl(icons.close)));
}

function section(title, count, list, now, { tone } = {}) {
  if (!list.length) return null;
  return el("section", { class: "m-section" },
    el("h2", { class: `m-h${tone ? ` is-${tone}` : ""}` }, title, el("span", { class: "m-count" }, String(count ?? list.length))),
    el("ul", { class: "m-list" }, list.map((a) => row(a, now))));
}

// Carte de l'agent aux commandes (mandat de Jarvis) : mission en cours ou repos, alertes, accès direct à la vue Agent.
function jarvisCard() {
  const mode = getAgentModeState();
  const alerts = alertCount();
  const on = mode?.enabled === true;
  return el("a", { class: `m-jarvis${on ? " is-on" : ""}${alerts ? " is-alert" : ""}`, href: "#agent" },
    led(alerts ? "attention" : on ? "ok" : "inactif", { pulse: on, label: on ? "actif" : "au repos" }),
    el("span", { class: "m-row-text" },
      el("strong", {}, on ? `Jarvis · ${folderName(mode.project || "") || "mission en cours"}` : "Jarvis au repos"),
      el("span", { class: "m-row-sub" }, alerts ? `${alerts} attente${alerts > 1 ? "s" : ""} : un agent a besoin de toi` : on ? "Mission en cours, rien ne bloque" : "Aucune mission : tu gardes la main")),
    iconEl(icons.chevronRight));
}

// Tâches confiées à FreeBuff par les agents (post_freebuff async) : les 3 plus récentes, en lecture seule.
const FB_STATE = { running: ["attention", "en cours"], done: ["ok", "terminée"], failed: ["danger", "échec"] };
function freebuffSection(now) {
  if (!fbJobs.length) return null;
  return el("section", { class: "m-section" },
    el("h2", { class: "m-h" }, "FreeBuff", el("span", { class: "m-count" }, String(fbJobs.length))),
    el("ul", { class: "m-list" }, fbJobs.slice(0, 3).map((j) => {
      const [tone, label] = j.status === "done" && j.completed === false ? ["attention", "non terminée"] : FB_STATE[j.status] || ["inactif", j.status];
      const at = Date.parse(j.finishedAt || j.startedAt || "");
      return el("li", { class: "m-row" },
        el("div", { class: "m-row-main" },
          led(tone, { pulse: j.status === "running", label }),
          el("span", { class: "m-row-text" },
            el("strong", {}, j.project || "FreeBuff"),
            el("span", { class: "m-row-sub" }, `${label}${Number.isFinite(at) ? ` · ${ago(now - at)}` : ""}${j.reply ? ` · ${j.reply}` : j.error ? ` · ${j.error}` : ""}`))),
        j.status === "running" && el("button", { class: "m-shelve", type: "button", "aria-label": `Annuler FreeBuff sur ${j.project}`, title: "Annuler ce lancement FreeBuff",
          onclick: () => { send({ type: "freebuff.cancel", jobId: j.jobId }); toast("Lancement FreeBuff annulé."); } }, iconEl(icons.close)));
    })));
}

// Tâches suivies par le poste : déléguées par un agent (post_create_task) ou lancées depuis l'interface ; qui les a demandées, quel moteur, où elles en sont.
const DELEG_STATE = { todo: ["inactif", "à démarrer"], doing: ["attention", "en cours"], review: ["ok", "à valider"], blocked: ["danger", "bloquée"], done: ["ok", "terminée"] };
function delegatedSection() {
  if (!delegated.length) return null;
  return el("section", { class: "m-section" },
    el("h2", { class: "m-h" }, "Tâches en cours", el("span", { class: "m-count" }, String(delegated.length))),
    el("ul", { class: "m-list" }, delegated.slice(0, 5).map((d) => {
      const [tone, label] = DELEG_STATE[d.status] || ["inactif", d.status];
      return el("li", { class: "m-row" },
        el("div", { class: "m-row-main" },
          led(tone, { pulse: d.status === "doing", label }),
          el("span", { class: "m-row-text" },
            el("strong", {}, d.title),
            el("span", { class: "m-row-sub" }, `${d.requester} → ${d.engine || "moteur à choisir"} · ${label}`))),
        d.status === "doing" && el("button", { class: "m-shelve", type: "button", "aria-label": `Arrêter ${d.title}`, title: "Arrêter cette tâche",
          onclick: () => { send({ type: "task.stop", id: d.taskId }); toast("Tâche arrêtée."); setTimeout(() => send({ type: "delegate.list" }), 1500); } }, iconEl(icons.close)));
    })));
}

function sessionsTab(state) {
  const now = Date.now();
  const q = query.trim().toLowerCase();
  const all = state.agents.filter((a) => a.status !== "closed" && (!q || nameOf(a).toLowerCase().includes(q)));
  const waiting = all.filter((a) => WAITING.has(a.status));
  const busy = all.filter((a) => BUSY.has(a.status));
  const rest = all.filter((a) => !WAITING.has(a.status) && !BUSY.has(a.status));
  const recent = rest.filter((a) => idleFor(a, now) < oldMs());
  const old = rest.filter((a) => idleFor(a, now) >= oldMs());
  const byProject = new Map();
  for (const a of recent) {
    const p = projectOf(state, a);
    if (!byProject.has(p.key)) byProject.set(p.key, { ...p, agents: [] });
    byProject.get(p.key).agents.push(a);
  }
  const search = el("input", { class: "m-search", type: "search", placeholder: "Rechercher une session", value: query, "aria-label": "Rechercher une session",
    oninput: (e) => { query = e.target.value; renderBody(true); } });
  const out = [jarvisCard(), el("div", { class: "m-stats" },
    stat(waiting.length, "à traiter", waiting.length ? "attention" : "inactif"), stat(busy.length, "actives", busy.length ? "ok" : "inactif"),
    stat(old.length, "anciennes", "inactif")), search,
  section("À traiter", null, waiting, now, { tone: "attention" }), section("Actives", null, busy, now), delegatedSection(), freebuffSection(now)];
  for (const p of [...byProject.values()].sort((x, y) => x.name.localeCompare(y.name))) {
    const isOpen = openProjects.has(p.key) || Boolean(q);
    out.push(el("section", { class: "m-section" },
      el("button", { class: "m-h m-fold", type: "button", "aria-expanded": String(isOpen),
        onclick: () => { openProjects.has(p.key) ? openProjects.delete(p.key) : openProjects.add(p.key); renderBody(true); } },
      el("span", {}, p.name), el("span", { class: "m-count" }, String(p.agents.length)), iconEl(isOpen ? icons.chevronDown : icons.chevronRight)),
      isOpen && el("ul", { class: "m-list" }, p.agents.map((a) => row(a, now)))));
  }
  if (old.length) {
    const isOpen = openProjects.has("__old") || Boolean(q);
    out.push(el("section", { class: "m-section" },
      el("button", { class: "m-h m-fold", type: "button", "aria-expanded": String(isOpen),
        onclick: () => { openProjects.has("__old") ? openProjects.delete("__old") : openProjects.add("__old"); renderBody(true); } },
      el("span", {}, `Anciennes (+${AGES.find(([h]) => h === tidy.olderThanHours)?.[1] ?? `${tidy.olderThanHours} h`})`), el("span", { class: "m-count" }, String(old.length)), iconEl(isOpen ? icons.chevronDown : icons.chevronRight)),
      isOpen && el("ul", { class: "m-list" }, old.map((a) => row(a, now))),
      isOpen && el("button", { class: "btn m-wide", type: "button", onclick: () => setTab("ranger") }, "Ranger les anciennes…")));
  }
  if (!all.length) out.push(el("p", { class: "m-empty" }, q ? "Aucune session ne correspond." : "Aucune session."));
  return out;
}
const stat = (n, label, tone) => el("div", { class: `m-stat is-${tone}` }, el("strong", {}, String(n)), el("span", {}, label));

// ---------- Crédits ----------
function ring(pct, size = 72) {
  const r = 28;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, pct));
  return svgEl("svg", { viewBox: "0 0 72 72", width: size, height: size, class: `m-ring is-${toneOfPct(v)}`, role: "img", "aria-label": `${v} % utilisé` },
    svgEl("circle", { cx: 36, cy: 36, r, class: "m-ring-bg" }),
    svgEl("circle", { cx: 36, cy: 36, r, class: "m-ring-fg", "stroke-dasharray": `${(c * v) / 100} ${c}`, transform: "rotate(-90 36 36)" }),
    (() => { const t = svgEl("text", { x: 36, y: 41, "text-anchor": "middle", class: "m-ring-text" }); t.textContent = `${Math.round(v)}%`; return t; })());
}

export function sparkPath(series, from, to, w = 300, h = 56) {
  const pts = series.filter((p) => p.t >= from);
  if (pts.length < 2) return "";
  const span = Math.max(1, to - from);
  return pts.map((p, i) => `${i ? "L" : "M"}${(((p.t - from) / span) * w).toFixed(1)} ${(h - (Math.min(100, p.v) / 100) * h).toFixed(1)}`).join(" ");
}

function spark(key) {
  const to = Date.now();
  const from = to - range * 3_600_000;
  const series = history.points.filter((p) => key in p.v).map((p) => ({ t: p.t, v: p.v[key] }));
  const d = sparkPath(series, from, to);
  const svg = svgEl("svg", { viewBox: "0 0 300 56", preserveAspectRatio: "none", class: "m-spark", role: "img",
    "aria-label": d ? `Usage sur ${range === 24 ? "24 h" : "7 jours"}` : "Pas encore assez de mesures" });
  svg.append(svgEl("line", { x1: 0, y1: 56 * 0.1, x2: 300, y2: 56 * 0.1, class: "m-spark-limit" }));
  if (d) svg.append(svgEl("path", { d, class: "m-spark-line" }));
  return el("div", { class: "m-spark-box" }, svg, !d && el("span", { class: "m-spark-note" }, "Courbe en cours de collecte…"));
}

function creditsTab() {
  const out = [el("div", { class: "m-seg", role: "group", "aria-label": "Période" },
    RANGES.map(([h, label]) => el("button", { type: "button", class: range === h ? "is-on" : "", "aria-pressed": String(range === h),
      onclick: () => { range = h; writePref(RANGE_PREF, String(h)); send({ type: "usage.history", hours: h }); renderBody(true); } }, label)))];
  const providers = (quota?.providers || []).filter((p) => (p.windows || []).length);
  if (!providers.length) out.push(el("p", { class: "m-empty" }, quota ? "Aucune donnée de quota pour l’instant." : "Chargement des quotas…"));
  const t = Date.now();
  for (const p of providers) {
    const st = p.state === "exhausted" ? "danger" : p.state === "slow" ? "attention" : p.state === "ok" ? "ok" : "inactif";
    out.push(el("section", { class: "m-card" },
      el("header", { class: "m-card-head" }, led(st, { label: p.state }), el("strong", {}, p.name),
        el("span", { class: "m-muted" }, p.state === "ok" ? "disponible" : p.detail || p.state)),
      p.windows.map((w) => {
        const key = `${p.id}/${w.id}`;
        const reset = w.resetsAt ? Date.parse(w.resetsAt) - t : null;
        return el("div", { class: "m-win" },
          el("div", { class: "m-win-top" }, ring(w.usedPct ?? 0),
            el("div", { class: "m-win-info" }, el("strong", {}, w.label || w.id),
              el("span", { class: "m-muted" }, w.usedPct == null ? "inconnu" : `${w.usedPct} % utilisé`),
              reset != null && reset > 0 && el("span", { class: "m-muted" }, `se réinitialise dans ${resetText(reset)}`))),
          spark(key));
      })));
  }
  out.push(el("p", { class: "m-foot" }, `Courbes : une mesure toutes les 5 min, conservées 14 jours (${history.points.length} mesures).`));
  return out;
}
function resetText(ms) {
  const m = Math.ceil(ms / 60_000);
  if (m < 90) return `${m} min`;
  if (m < 2880) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  return `${Math.round(m / 1440)} j`;
}

// ---------- Ranger ----------
function rangerTab() {
  const hours = tidy.olderThanHours;
  const out = [
    el("p", { class: "m-lead" }, "Archive les sessions inactives ou en erreur sans activité depuis la durée choisie. Les sessions actives, en attente de permission ou avec un sous-agent actif ne sont jamais touchées."),
    el("div", { class: "m-seg", role: "group", "aria-label": "Inactives depuis" },
      AGES.map(([h, label]) => el("button", { type: "button", class: hours === h ? "is-on" : "", "aria-pressed": String(hours === h),
        onclick: () => { tidy = { ...tidy, olderThanHours: h }; preview = null; send({ type: "tidy.set", auto: tidy.auto, olderThanHours: h }); send({ type: "tidy.preview", olderThanHours: h }); renderBody(true); } }, label))),
  ];
  const n = preview?.olderThanHours === hours ? preview.count : null;
  out.push(el("div", { class: "m-card" },
    el("strong", {}, n == null ? "Calcul…" : n === 0 ? "Rien à ranger" : `${n} session${n > 1 ? "s" : ""} à ranger`),
    n > 0 && el("ul", { class: "m-list m-compact" }, preview.agents.slice(0, 12).map((a) =>
      el("li", {}, el("span", {}, nameOf({ ...a, provider: "agent" })), el("span", { class: "m-muted" }, a.updatedAt ? ago(Date.now() - Date.parse(a.updatedAt)) : "")))),
    n > 12 && el("p", { class: "m-muted" }, `… et ${n - 12} autres`),
    el("button", { class: "btn btn-primary m-wide", type: "button", disabled: !n, onclick: async () => {
      const ok = await confirmDialog({ title: "Ranger les anciennes sessions", message: `Archiver ${n} session${n > 1 ? "s" : ""} inactive${n > 1 ? "s" : ""} depuis plus de ${AGES.find(([h]) => h === hours)?.[1] ?? `${hours} h`} ?`, confirmLabel: "Ranger" });
      if (ok) send({ type: "tidy.run", olderThanHours: hours });
    } }, n ? `Ranger ${n} session${n > 1 ? "s" : ""}` : "Ranger")));
  out.push(el("label", { class: "m-switch" },
    el("input", { type: "checkbox", checked: tidy.auto, onchange: (e) => { send({ type: "tidy.set", auto: e.target.checked, olderThanHours: tidy.olderThanHours }); } }),
    el("span", {}, el("strong", {}, "Ranger automatiquement"),
      el("small", { class: "m-muted" }, `Toutes les 10 min, les sessions inactives depuis plus de ${AGES.find(([h]) => h === hours)?.[1] ?? `${hours} h`}.`))));
  out.push(el("label", { class: "m-switch" },
    el("input", { type: "checkbox", checked: readPref("desk.autoTidy") !== "0", onchange: (e) => writePref("desk.autoTidy", e.target.checked ? "1" : "0") }),
    el("span", {}, el("strong", {}, "Bureau : retirer les fenêtres mortes"),
      el("small", { class: "m-muted" }, "Une fenêtre dont la session est fermée quitte le Bureau toute seule (sur cet appareil). Aucune session n’est arrêtée."))));
  return out;
}

// ---------- Coque ----------
function renderBody(keepScroll = false) {
  if (!body) return;
  const y = keepScroll ? window.scrollY : 0;
  const state = ctx.state;
  const view = tab === "sessions" ? sessionsTab(state) : tab === "credits" ? creditsTab() : rangerTab();
  const focused = document.activeElement?.classList?.contains("m-search");
  const pos = focused ? document.activeElement.selectionStart : 0;
  body.replaceChildren(...view.filter(Boolean));
  if (focused) { const input = body.querySelector(".m-search"); input?.focus(); input?.setSelectionRange(pos, pos); }
  if (keepScroll) window.scrollTo(0, y);
  tabbar?.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
}
function setTab(next) {
  tab = next;
  writePref(TAB_PREF, next);
  if (next === "credits") { send({ type: "quota.get" }); send({ type: "usage.history", hours: range }); }
  if (next === "ranger") send({ type: "tidy.preview", olderThanHours: tidy.olderThanHours });
  renderBody();
}

const view = {
  id: "mobile",
  title: "Téléphone",
  short: "Accueil",
  icon: icons.sessions,
  order: 5,
  rail: "none",
  mount(container, context) {
    ctx = context;
    const saved = readPref(TAB_PREF);
    tab = TABS.some(([id]) => id === saved) ? saved : "sessions";
    range = Number(readPref(RANGE_PREF)) === 168 ? 168 : 24;
    query = "";
    body = el("div", { class: "m-body" });
    tabbar = el("nav", { class: "m-tabbar", "aria-label": "Sections" },
      TABS.map(([id, label]) => el("button", { type: "button", "data-tab": id, role: "tab", onclick: () => setTab(id) }, label)));
    root = el("div", { class: "m-root" }, body, tabbar);
    container.replaceChildren(root);
    cleanups = [
      subscribeAgentMode(() => { if (tab === "sessions" && root) renderBody(true); }),
      subscribeAlerts(() => { if (tab === "sessions" && root) renderBody(true); }),
      ctx.onState(() => { if (tab === "sessions" && !document.activeElement?.classList?.contains("m-search")) renderBody(true); }),
      on("quota.state", (m) => { quota = m; if (tab === "credits") renderBody(true); }),
      on("usage.history", (m) => { history = { points: m.points || [] }; if (tab === "credits") renderBody(true); }),
      on("tidy.settings", (m) => {
        const changed = m.olderThanHours !== tidy.olderThanHours;
        tidy = { auto: m.auto, olderThanHours: m.olderThanHours };
        if (changed) send({ type: "tidy.preview", olderThanHours: m.olderThanHours });
        renderBody(true);
      }),
      // Le poste diffuse « tasks » à chaque changement : on redemande alors la liste suivie (regroupé sur 400 ms).
      on("tasks", () => { clearTimeout(delegTimer); delegTimer = setTimeout(() => send({ type: "delegate.list" }), 400); }),
      on("delegate.list", (m) => { delegated = m.items || []; if (tab === "sessions" && root) renderBody(true); }),
      on("freebuff.jobs", (m) => { fbJobs = m.jobs || []; if (tab === "sessions" && root) renderBody(true); }),
      on("tidy.preview", (m) => { preview = m; if (tab === "ranger") renderBody(true); }),
      on("tidy.done", (m) => {
        toast(`${m.archived} session${m.archived > 1 ? "s" : ""} rangée${m.archived > 1 ? "s" : ""}${m.failed ? `, ${m.failed} échec(s)` : ""}.`, { kind: m.failed ? "error" : "info" });
        send({ type: "tidy.preview", olderThanHours: tidy.olderThanHours });
      }),
      onConnection((up) => { if (up) { send({ type: "quota.get" }); send({ type: "usage.history", hours: range }); send({ type: "tidy.get" }); send({ type: "freebuff.jobs" }); send({ type: "delegate.list" }); send({ type: "tidy.preview", olderThanHours: tidy.olderThanHours }); } }),
    ];
    tickTimer = setInterval(() => { if (tab === "sessions") send({ type: "delegate.list" }); if (tab === "sessions" && !document.activeElement?.classList?.contains("m-search")) renderBody(true); }, 30_000);
    renderBody();
  },
  unmount() {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    clearInterval(tickTimer);
    clearTimeout(delegTimer);
    root = body = tabbar = ctx = null;
  },
};

registerView(view);
export default view;
