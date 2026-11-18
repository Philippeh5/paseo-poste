// Vue d'ensemble des agents (handlers/agentsoverview.mjs) : agents du daemon ET terminaux d'agents (Claude Code, FreeBuff…),
// avec leur état (actif, en attente, bloqué, au repos), leur dernière action et leurs fichiers réservés.
// Partagée par la page Agents et le rail. Les libellés et statuts sont des DONNÉES de sessions externes : à afficher en texte.
import { on, send, onConnection } from "./socket.js";

let overview = { agents: [], counts: { active: 0, waiting: 0, blocked: 0, idle: 0, unknown: 0, total: 0 }, at: null };
const listeners = new Set();

on("agents.overview", (m) => {
  overview = { agents: Array.isArray(m.agents) ? m.agents : [], counts: m.counts || overview.counts, at: m.at || null };
  for (const fn of listeners) { try { fn(overview); } catch (e) { console.error("agents.overview", e); } }
});
onConnection((up) => { if (up) send({ type: "agents.overview" }); });

export const getOverview = () => overview;
export function subscribeOverview(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const overviewOfTerminal = (host, terminalId) =>
  overview.agents.find((a) => a.kind === "terminal" && a.host === host && a.terminalId === terminalId) || null;
export const overviewOfAgent = (host, agentId) =>
  overview.agents.find((a) => a.kind === "agent" && a.host === host && a.agentId === agentId) || null;

// Ton de voyant et libellé court d'un état (jamais la couleur seule : le texte accompagne toujours le voyant).
export const STATE_UI = {
  active: { tone: "ok", label: "Actif" },
  waiting: { tone: "attention", label: "En attente" },
  blocked: { tone: "danger", label: "Bloqué" },
  idle: { tone: "inactif", label: "Au repos" },
  unknown: { tone: "inactif", label: "Inconnu" },
};
export const stateUi = (state) => STATE_UI[state] || STATE_UI.unknown;

// « il y a 40 s », « il y a 12 min », « il y a 3 h » (avec « au moins » si la date est une borne basse).
export function agoText(iso, { approx = false, now = Date.now() } = {}) {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  const txt = s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 172800 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} j`;
  return `il y a ${approx ? "au moins " : ""}${txt}`;
}
