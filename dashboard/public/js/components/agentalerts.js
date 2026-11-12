// Alertes de l'agent (T34) : demande de permission en attente depuis longtemps, session muette, session orpheline.
// Données : handlers/permpolicy.mjs (diffusion permpolicy.alerts). Les durées sont recalculées ici, en direct.
// Aussi : le texte de la politique de permissions en français simple (dialogue du mandat et vue Agent).
import { el } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";

export const WAIT_ALERT_MIN = 2;
export const STALL_MIN = 30;

let alerts = { waiting: [], stalled: [], orphans: [] };
const listeners = new Set();
const notify = () => { for (const fn of listeners) { try { fn(alerts); } catch { /* ignoré */ } } };
const list = (v) => (Array.isArray(v) ? v : []);

on("permpolicy.alerts", (m) => {
  alerts = { waiting: list(m.waiting), stalled: list(m.stalled), orphans: list(m.orphans) };
  notify();
});
onConnection((up) => { if (up) send({ type: "permpolicy.alerts.get" }); });

export function subscribeAlerts(fn) {
  listeners.add(fn);
  fn(alerts);
  return () => listeners.delete(fn);
}
export const getAlerts = () => alerts;

// Nombre de minutes écoulées depuis `iso` (entier, 0 si illisible).
export function minutesSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 60000));
}
export function durationText(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
// Ce qui exige l'attention de Philippe : demandes en attente depuis plus de 2 min et sessions semblant bloquées.
export function visibleAlerts(now = Date.now()) {
  return {
    waiting: alerts.waiting.filter((w) => minutesSince(w.since, now) >= WAIT_ALERT_MIN),
    stalled: alerts.stalled.filter((s) => minutesSince(s.since, now) >= STALL_MIN),
    orphans: alerts.orphans,
  };
}
export const alertCount = (now) => { const v = visibleAlerts(now); return v.waiting.length + v.stalled.length; };
export const waitingText = (min) => `Un agent attend ta réponse depuis ${durationText(min)}`;
export const stalledText = (min) => `Cette session semble bloquée : aucune activité depuis ${durationText(min)}`;
export const ORPHAN_TEXT = "Cette session attend encore une permission alors que sa tâche est terminée";

// ---------- Politique de permissions, en français simple ----------
export const POLICY = {
  allow: [
    "Lire des fichiers du dossier du projet",
    "Commandes simples en lecture seule (echo, grep, cat, ls, head, tail, wc, sort, uniq, diff, cut, tr, git status/log/diff/show/branch)",
    "Commandes postectl de la liste blanche (summary, sessions, tasks, task add/start/stop/restart/move/edit, mandate…)",
    "Modifier des fichiers du dossier du projet (dans le périmètre d'écriture, avec une sauvegarde avant)",
  ],
  deny: [
    "git commit, push, reset, checkout, clean, rebase, merge, stash (sauf « autoriser git » : add et commit -m seulement)",
    "Supprimer des fichiers, ou en déplacer hors du projet",
    "Écrire en dehors du dossier du projet (ou du périmètre d'écriture)",
    "Accès réseau extérieur, installation de paquets, extinction, sudo",
    "Répondre soi-même aux demandes de permission, donner un mode de permissions plus large à une tâche",
  ],
  ask: ["Tout le reste attend ta réponse dans la vue Agent. Une demande signalée dangereuse n'est jamais acceptée seule."],
};

export const WEB_LIMIT = "Les réponses données depuis l'interface web ne sont pas filtrées (le poste ne peut pas distinguer Philippe d'un agent local) : " +
  "elles sont journalisées dans l'activité (« Autorisé depuis l'interface »).";

export function policyBox({ id = "permpolicy-box" } = {}) {
  const block = (cls, title, items) => el("div", { class: `pp-col pp-${cls}` },
    el("strong", { class: "pp-title" }, title),
    el("ul", {}, ...items.map((t) => el("li", {}, t))));
  return el("div", { class: "pp-wrap", id },
    el("div", { class: "pp-box" },
      block("allow", "Autorisé automatiquement", POLICY.allow),
      block("deny", "Refusé automatiquement", POLICY.deny),
      block("ask", "Reste en attente pour toi", POLICY.ask)),
    el("p", { class: "pp-note muted text-muted text-xs", id: `${id}-note` }, WEB_LIMIT));
}
