// Section « Journal » de la page Réception (ex-vue Journal) : ce qui s'est passé un jour donné, projet par projet (tâches, sessions, permissions automatiques,
// messages de groupe) avec, en tête, les rapports de fin de mission de Jarvis. Données : handlers/journal.mjs
// (journal.get -> journal.data) et handlers/missionreport.mjs (missionreport.get -> missionreport.data).
import { el, icons } from "../core/util.js";
import { defaultHost } from "../core/state.js";

// La feuille de style est chargée par la vue elle-même (index.html n'est pas modifié par ce module).
if (!document.querySelector('link[data-journal-css]')) {
  document.head.append(el("link", { rel: "stylesheet", href: "css/journal.css", "data-journal-css": "" }));
}

const glyph = (path) => '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" ' +
  `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
// Une forme et un libellé distincts par type : la couleur seule ne porte jamais le sens.
const KINDS = {
  tache: {
    label: "Tâche", icon: glyph('<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M7.5 10l2 2 3.5-4"/>'),
  },
  session: { label: "Session", icon: glyph('<circle cx="10" cy="10" r="6"/><path d="M10 6.5V10l2.5 1.5"/>') },
  permission: { label: "Permission", icon: glyph('<path d="M10 2.5l7 7.5-7 7.5L3 10z"/>') },
  message: { label: "Message", icon: glyph('<path d="M3.5 5.5h13v8h-7l-3.5 3v-3h-2.5z"/>') },
  rapport: { label: "Rapport", icon: glyph('<path d="M5 3h7l3 3v11H5z"/><path d="M8 10h5M8 13h5"/>') },
};
const TONES = { done: "ok", allow: "ok", blocked: "danger", deny: "danger", error: "danger", review: "attention" };
const OUTCOMES = { review: "À valider", done: "Terminé", error: "Erreur" };

const pad = (n) => String(n).padStart(2, "0");
const toDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromDay = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
const shiftDay = (day, delta) => { const d = fromDay(day); d.setDate(d.getDate() + delta); return toDay(d); };
const clock = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const longDay = (day) => fromDay(day).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

let ctx = null;
let dom = {};
let day = toDay(new Date());
let wanted = ""; // nom du projet choisi ("" = tous)
let data = null; // dernière réponse journal.data
let collapsed = new Set();
let openReports = new Map(); // runId -> texte du rapport (null tant qu'il charge)
let cleanups = [];
let refreshTimer = 0;

function fetchJournal() {
  ctx?.send({ type: "journal.get", day });
}
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => !document.hidden && fetchJournal(), 1500);
}

function reportRow(event) {
  const open = openReports.has(event.runId);
  const text = openReports.get(event.runId);
  const panel = el("pre", { class: "journal-report-text", id: `rapport-${event.runId}`, hidden: !open },
    text == null ? "Chargement du rapport…" : text);
  const button = el("button", {
    type: "button", class: "btn btn-sm", "aria-expanded": String(open), "aria-controls": `rapport-${event.runId}`,
    onclick: () => {
      if (openReports.has(event.runId)) openReports.delete(event.runId);
      else {
        openReports.set(event.runId, null);
        ctx.send({ type: "missionreport.get", runId: event.runId });
      }
      paint();
    },
  }, open ? "Masquer le rapport" : "Voir le rapport");
  const glyphNode = el("span", { class: `journal-glyph tone-${TONES[event.state] || "doux"}`, "aria-hidden": "true" });
  glyphNode.innerHTML = KINDS.rapport.icon;
  return el("li", { class: "journal-report" },
    el("time", { class: "journal-time", datetime: event.at }, clock(event.at)),
    el("div", { class: "journal-report-body" },
      el("div", { class: "journal-report-head" },
        el("span", { class: "journal-kind" }, glyphNode, KINDS.rapport.label),
        el("span", { class: "journal-text" }, event.text), button),
      panel));
}

function eventRow(event) {
  const kind = KINDS[event.kind] || KINDS.tache;
  const tone = TONES[event.state] || "doux";
  const glyphNode = el("span", { class: `journal-glyph tone-${tone}`, "aria-hidden": "true" });
  glyphNode.innerHTML = kind.icon;
  return el("li", { class: "journal-event" },
    el("time", { class: "journal-time", datetime: event.at }, clock(event.at)),
    el("div", { class: "journal-event-body" },
      el("span", { class: "journal-kind" }, glyphNode, kind.label),
      el("span", { class: "journal-text" }, event.text)));
}

function projectSection(project, index) {
  const key = `${project.host}|${project.dir || project.name}`;
  const isOpen = !collapsed.has(key);
  const bodyId = `journal-p${index}`;
  const reports = project.events.filter((e) => e.kind === "rapport");
  const others = project.events.filter((e) => e.kind !== "rapport");
  const head = el("button", {
    type: "button", class: "journal-project-head", "aria-expanded": String(isOpen), "aria-controls": bodyId,
    onclick: () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      paint();
    },
  },
  el("span", { class: "journal-chevron", "aria-hidden": "true" }),
  el("span", { class: "journal-project-name" }, project.name),
  project.host && el("span", { class: "journal-host" }, project.host),
  el("span", { class: "journal-count" }, `${project.events.length} événement${project.events.length > 1 ? "s" : ""}`));
  head.querySelector(".journal-chevron").innerHTML = isOpen ? icons.chevronDown : icons.chevronRight;
  const body = el("ol", { class: "journal-events", id: bodyId, hidden: !isOpen },
    reports.map(reportRow), others.map(eventRow));
  return el("section", { class: "journal-project" },
    el("h2", { class: "journal-project-title" }, head),
    project.dir && isOpen && el("p", { class: "journal-dir" }, project.dir),
    body);
}

function paint() {
  if (!dom.list) return;
  const names = [...new Set((data?.projects || []).map((p) => p.name))];
  if (wanted && !names.includes(wanted)) wanted = "";
  dom.project.replaceChildren(el("option", { value: "" }, "Tous les projets"),
    names.map((n) => el("option", { value: n, selected: n === wanted }, n)));
  dom.project.value = wanted;
  dom.date.value = day;
  dom.next.disabled = day >= toDay(new Date());
  dom.label.textContent = longDay(day);
  if (!data) {
    dom.list.replaceChildren(el("p", { class: "journal-note" }, "Chargement du journal…"));
    return;
  }
  const projects = data.projects.filter((p) => !wanted || p.name === wanted);
  if (!projects.length) {
    dom.list.replaceChildren(el("div", { class: "empty-state" },
      el("h2", {}, "Rien à signaler ce jour-là"),
      el("p", {}, "Aucune tâche, session, décision automatique ni message n’est daté de ce jour"
        + (wanted ? ` pour ${wanted}.` : "."))));
    return;
  }
  dom.list.replaceChildren(...projects.map(projectSection));
}

function receive(message) {
  if (message.day !== day) return;
  data = message;
  paint();
}

function receiveReport(message) {
  const report = message.report;
  if (!report || !openReports.has(report.runId)) return;
  openReports.set(report.runId, `${report.text}\n\n— ${OUTCOMES[report.outcome] || report.outcome}`);
  paint();
}

function setDay(next) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next > toDay(new Date())) return;
  day = next;
  data = null;
  paint();
  fetchJournal();
}

function build() {
  dom.date = el("input", {
    type: "date", class: "journal-date", id: "journal-day", max: toDay(new Date()), "aria-label": "Jour",
    onchange: (e) => setDay(e.target.value),
  });
  dom.project = el("select", {
    class: "select-sm journal-project-select", "aria-label": "Projet",
    onchange: (e) => { wanted = e.target.value; paint(); },
  });
  dom.prev = el("button", {
    type: "button", class: "btn btn-sm", "aria-label": "Jour précédent", onclick: () => setDay(shiftDay(day, -1)),
  }, "←");
  dom.next = el("button", {
    type: "button", class: "btn btn-sm", "aria-label": "Jour suivant", onclick: () => setDay(shiftDay(day, 1)),
  }, "→");
  dom.today = el("button", {
    type: "button", class: "btn btn-sm", onclick: () => setDay(toDay(new Date())),
  }, "Aujourd’hui");
  dom.label = el("p", { class: "journal-label", "aria-live": "polite" });
  dom.list = el("div", { class: "journal-list" });
  return el("div", { class: "view-page journal-view" },
    el("div", { class: "view-toolbar" },
      el("h2", { class: "view-title" }, "Journal du jour"),
      el("div", { class: "toolbar-group journal-controls" },
        dom.prev, dom.date, dom.next, dom.today, dom.project,
        el("button", { type: "button", class: "btn btn-sm", onclick: fetchJournal }, "Actualiser"))),
    dom.label, dom.list);
}

// Monte la section dans `container` ; renvoie la fonction de nettoyage.
export function mountJournal(container, context) {
  ctx = context;
  day = toDay(new Date());
  wanted = "";
  data = null;
  collapsed = new Set();
  openReports = new Map();
  container.replaceChildren(build());
  cleanups = [
    ctx.on("journal.data", receive),
    ctx.on("missionreport.data", receiveReport),
    ctx.on("tasks", () => day === toDay(new Date()) && refreshSoon()),
    ctx.on("timeline.changed", () => day === toDay(new Date()) && refreshSoon()),
    ctx.on("inbox.changed", () => day === toDay(new Date()) && refreshSoon()),
    ctx.onConnection((up) => up && fetchJournal()),
  ];
  paint();
  fetchJournal();
  return () => {
    cleanups.forEach((fn) => fn?.());
    cleanups = [];
    clearTimeout(refreshTimer);
    ctx = null;
    dom = {};
  };
}
