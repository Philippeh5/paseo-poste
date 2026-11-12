// Vue « Cockpit » : le poste autonome d'un coup de pouce, pensée d'abord pour le téléphone (une colonne, boutons ≥ 44 px).
// Idées à valider (Valider / Refuser), mode d'autonomie par projet (Arrêt · Idées · Autonome), cerveau en cours, arrêt d'urgence.
// Données : handlers/autonomy.mjs (autonomy.*, idea.*, brain.wake) et handlers/emergency.mjs (emergency.*), projets via project.list.
import { registerView } from "./registry.js";
import { el, icons } from "../core/util.js";

if (!document.querySelector("link[data-cockpit-css]")) {
  document.head.append(el("link", { rel: "stylesheet", href: "css/cockpit.css", "data-cockpit-css": "" }));
}

const MODES = [["off", "Arrêt"], ["ideas", "Idées"], ["auto", "Autonome"]];
const BEATS = [[15, "15 min"], [30, "30 min"], [60, "1 h"], [180, "3 h"], [720, "12 h"]];
const MODE_HELP = {
  off: "Aucun travail.", ideas: "Propose des idées et attend ta validation.", auto: "Fait, teste et fusionne seul.",
};
const ago = (ms) => {
  if (!ms) return "jamais";
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "à l'instant" : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`;
};
const nameOf = (dir) => String(dir).split("/").filter(Boolean).pop() || dir;

let ctx = null, root = null, cleanups = [];
let st = { autonomy: { projects: {}, runs: [], running: null, stopped: false }, ideas: [], projects: [], emergency: { stopped: false }, comments: new Map() };

function ideaCard(idea) {
  const note = el("input", { type: "text", class: "cockpit-note", placeholder: "Commentaire (facultatif)", maxlength: "300", "aria-label": `Commentaire pour « ${idea.title} »` });
  const decide = (decision) => ctx.send({ type: "idea.decide", id: idea.id, decision, comment: note.value.trim() || undefined });
  return el("li", { class: "cockpit-card cockpit-idea" },
    el("div", { class: "cockpit-idea-head" },
      el("span", { class: "cockpit-chip" }, nameOf(idea.project)),
      el("time", { class: "cockpit-muted", datetime: new Date(idea.createdAt).toISOString() }, ago(idea.createdAt))),
    el("h3", { class: "cockpit-idea-title" }, idea.title),
    idea.body ? el("p", { class: "cockpit-idea-body" }, idea.body) : null,
    note,
    el("div", { class: "cockpit-actions" },
      el("button", { type: "button", class: "btn btn-primary cockpit-big", onclick: () => decide("approve") }, "Valider"),
      el("button", { type: "button", class: "btn cockpit-big", onclick: () => decide("refuse") }, "Refuser")));
}

function projectCard(p) {
  const cfg = st.autonomy.projects[p.dir] || { mode: "off", heartbeatMin: 60, lastBeat: 0 };
  const group = el("div", { class: "cockpit-seg", role: "radiogroup", "aria-label": `Autonomie de ${p.name || nameOf(p.dir)}` },
    ...MODES.map(([value, label]) => el("button", {
      type: "button", role: "radio", "aria-checked": String(cfg.mode === value), class: `cockpit-seg-btn${cfg.mode === value ? " is-on" : ""} mode-${value}`,
      onclick: async () => {
        if (value === "auto" && cfg.mode !== "auto") {
          const ok = await ctx.confirm({ title: `Passer ${p.name || nameOf(p.dir)} en Autonome ?`, message: "Le cerveau modifiera et fusionnera seul, sans te demander. L'historique GitHub reste ton filet de sécurité.", confirmLabel: "Passer en Autonome" });
          if (!ok) return;
        }
        ctx.send({ type: "autonomy.set", dir: p.dir, mode: value, heartbeatMin: cfg.heartbeatMin });
      },
    }, label)));
  const beat = el("select", { class: "cockpit-select", "aria-label": `Fréquence du battement de ${p.name || nameOf(p.dir)}`, onchange: (e) => ctx.send({ type: "autonomy.set", dir: p.dir, mode: cfg.mode, heartbeatMin: Number(e.target.value) }) },
    ...BEATS.map(([v, l]) => el("option", { value: String(v), selected: v === cfg.heartbeatMin }, l)));
  const running = st.autonomy.running?.dir === p.dir;
  return el("li", { class: "cockpit-card" },
    el("div", { class: "cockpit-proj-head" }, el("h3", { class: "cockpit-proj-name" }, p.name || nameOf(p.dir)), running ? el("span", { class: "cockpit-chip cockpit-live" }, "Le cerveau travaille") : null),
    group,
    el("p", { class: "cockpit-muted" }, MODE_HELP[cfg.mode]),
    el("div", { class: "cockpit-row" },
      el("label", { class: "cockpit-label" }, "Battement", beat),
      el("span", { class: "cockpit-muted" }, `Dernier : ${ago(cfg.lastBeat)}`)),
    el("button", { type: "button", class: "btn cockpit-big", disabled: Boolean(st.autonomy.running) || st.emergency.stopped, onclick: () => ctx.send({ type: "brain.wake", dir: p.dir }) }, "Réveiller le cerveau maintenant"));
}

function paint() {
  if (!root) return;
  const stopped = st.emergency.stopped;
  const pending = st.ideas.filter((i) => i.status === "pending");
  const approved = st.ideas.filter((i) => i.status === "approved");
  const retired = st.ideas.filter((i) => i.status === "obsolete").sort((a, b) => (b.obsoleteAt || 0) - (a.obsoleteAt || 0)).slice(0, 5);
  const projects = st.projects.filter((p) => String(p.dir).startsWith("/"));
  const runs = [...st.autonomy.runs].reverse().slice(0, 5);
  root.replaceChildren(
    el("header", { class: "view-header" }, el("h1", { class: "view-title" }, "Cockpit")),
    el("section", { class: `cockpit-stop${stopped ? " is-stopped" : ""}`, "aria-live": "polite" },
      el("div", {}, el("strong", {}, stopped ? "ARRÊT D'URGENCE ACTIF" : "Les agents autonomes sont actifs"),
        el("p", { class: "cockpit-muted" }, stopped ? `Tout est bloqué${st.emergency.reason ? ` (${st.emergency.reason})` : ""}. Rien ne tourne tant que tu n'as pas repris.` : "Le bouton bloque immédiatement toute action des agents autonomes.")),
      stopped
        ? el("button", { type: "button", class: "btn btn-primary cockpit-big", onclick: () => ctx.send({ type: "emergency.resume" }) }, "Reprendre")
        : el("button", { type: "button", class: "btn btn-danger cockpit-big", onclick: async () => {
          const ok = await ctx.confirm({ title: "Arrêt d'urgence", message: "Bloquer immédiatement tous les agents autonomes ?", confirmLabel: "Tout arrêter", danger: true });
          if (ok) ctx.send({ type: "emergency.stop", reason: "arrêt depuis le cockpit" });
        } }, "Arrêt d'urgence")),
    el("section", { "aria-labelledby": "ck-ideas" },
      el("h2", { class: "cockpit-h", id: "ck-ideas" }, `Idées à valider${pending.length ? ` (${pending.length})` : ""}`),
      pending.length ? el("ul", { class: "cockpit-list" }, ...pending.map(ideaCard)) : el("p", { class: "cockpit-empty" }, "Aucune idée en attente."),
      approved.length ? el("p", { class: "cockpit-muted" }, `${approved.length} idée(s) validée(s), en cours de réalisation.`) : null,
      retired.length ? el("details", { class: "cockpit-retired" }, el("summary", { class: "cockpit-muted" }, `Idées retirées par le cerveau (${retired.length})`),
        el("ul", { class: "cockpit-report" }, ...retired.map((i) => el("li", {}, `${i.title} — ${i.obsoleteWhy || "déjà fait"}`)))) : null),
    el("section", { "aria-labelledby": "ck-projets" },
      el("h2", { class: "cockpit-h", id: "ck-projets" }, "Projets"),
      projects.length ? el("ul", { class: "cockpit-list" }, ...projects.map(projectCard)) : el("p", { class: "cockpit-empty" }, "Aucun projet suivi sur cette machine.")),
    el("section", { "aria-labelledby": "ck-runs" },
      el("h2", { class: "cockpit-h", id: "ck-runs" }, "Derniers réveils du cerveau"),
      runs.length ? el("ul", { class: "cockpit-list cockpit-runs" }, ...runs.map((r) => el("li", { class: "cockpit-run" },
        el("span", { class: `cockpit-chip status-${r.status === "done" ? "ok" : r.status === "running" ? "live" : "bad"}` }, r.status === "done" ? "Terminé" : r.status === "running" ? "En cours" : "Échec"),
        el("span", {}, `${nameOf(r.dir)} · ${r.engine === "claude" ? "Claude" : "gratuit"} · ${ago(r.at)}`),
        r.report ? el("ul", { class: "cockpit-report" }, ...[["Fait", r.report.fait], ["Bloqué", r.report.bloque], ["Prochaine étape", r.report.suite]].filter(([, v]) => v).map(([k, v]) => el("li", {}, `${k} : ${v}`))) : null))) : el("p", { class: "cockpit-empty" }, "Le cerveau ne s'est pas encore réveillé.")));
}

const view = {
  id: "cockpit", title: "Cockpit", short: "Cockpit", icon: icons.inbox, order: 5,
  mount(container, context) {
    ctx = context;
    root = el("div", { class: "view-body cockpit" });
    container.replaceChildren(root);
    cleanups = [
      ctx.on("autonomy.state", (m) => { st.autonomy = m; paint(); }),
      ctx.on("idea.list", (m) => { st.ideas = m.ideas; paint(); }),
      ctx.on("idea.changed", () => ctx.send({ type: "idea.list" })),
      ctx.on("emergency.state", (m) => { st.emergency = m; paint(); }),
      ctx.on("project.list", (m) => { st.projects = m.projects || []; paint(); }),
      ctx.onConnection((up) => up && refresh()),
    ];
    paint(); refresh();
  },
  unmount() { cleanups.forEach((fn) => fn?.()); cleanups = []; ctx = null; root = null; },
};
function refresh() { ctx.send({ type: "autonomy.list" }); ctx.send({ type: "idea.list" }); ctx.send({ type: "emergency.status" }); ctx.send({ type: "project.list" }); }
registerView(view);
export default view;
