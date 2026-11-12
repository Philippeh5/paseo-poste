// « Activité de l'agent » (T29) : historique des actions de l'agent faites par l'API (postectl / MCP / REST), mis à jour
// en direct par la diffusion WebSocket agentactivity.added. Données : handlers/agentactivity.mjs.
// Tous les textes passent par textContent (el() crée des nœuds texte) : aucun innerHTML avec du contenu dynamique.
import { el, readPref, writePref } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";
import { subscribeAgentMode } from "./agentmode.js";

const KEEP = 50; // entrées gardées en mémoire
const SHOWN = 20; // entrées affichées
const REFRESH_MS = 10_000; // rafraîchissement des horodatages relatifs

let entries = []; // la plus récente en premier
const listeners = new Set();
const notify = () => { for (const fn of listeners) { try { fn(entries); } catch { /* ignoré */ } } };

on("agentactivity.list", (m) => {
  entries = (Array.isArray(m.entries) ? m.entries : []).slice(0, KEEP);
  notify();
});
on("agentactivity.added", (m) => {
  if (!m.entry || entries.some((e) => e.id === m.entry.id)) return;
  entries = [m.entry, ...entries].slice(0, KEEP);
  notify();
});
onConnection((up) => { if (up) send({ type: "agentactivity.list", limit: KEEP }); });

// Horodatage relatif en français : « à l'instant », « il y a 5 s », « il y a 3 min », « il y a 2 h », « il y a 4 j ».
export function relativeTime(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s) || s < 3) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

// Remplit `container` avec la liste (la plus récente en haut) et la tient à jour ; renvoie la fonction d'arrêt.
export function mountActivityList(container, { limit = SHOWN } = {}) {
  const render = () => {
    const now = Date.now();
    const items = entries.slice(0, limit).map((entry) => el("li", {
      class: `agentactivity-item${entry.ok ? "" : " is-refused"}`,
      dataset: { id: entry.id },
    },
    el("time", { class: "agentactivity-time", datetime: entry.at, title: new Date(entry.at).toLocaleString("fr-FR") },
      relativeTime(entry.at, now)),
    el("span", { class: "agentactivity-text" }, entry.summary)));
    container.replaceChildren(...(items.length ? items
      : [el("li", { class: "agentactivity-empty" }, "Aucune action de l'agent pour l'instant.")]));
  };
  listeners.add(render);
  const timer = setInterval(render, REFRESH_MS);
  render();
  return () => { listeners.delete(render); clearInterval(timer); };
}

// Panneau flottant, visible tant que le Mode Agent est actif ; repliable (préférence mémorisée).
export function initAgentActivityPanel() {
  if (document.getElementById("agentactivity-panel")) return;
  const list = el("ol", { class: "agentactivity-list", "aria-live": "polite" });
  const toggle = el("button", {
    class: "agentactivity-toggle", type: "button", id: "agentactivity-toggle", "aria-controls": "agentactivity-list",
  }, el("strong", {}, "Activité de l'agent"), el("span", { class: "agentactivity-chevron", "aria-hidden": "true" }));
  list.id = "agentactivity-list";
  const panel = el("aside", {
    class: "agentactivity-panel", id: "agentactivity-panel", "aria-label": "Activité de l'agent", hidden: true,
  }, toggle, list);

  const setCollapsed = (collapsed) => {
    panel.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  setCollapsed(readPref("paseo-agentactivity-collapsed") === "1");
  toggle.addEventListener("click", () => {
    const collapsed = !panel.classList.contains("is-collapsed");
    setCollapsed(collapsed);
    writePref("paseo-agentactivity-collapsed", collapsed ? "1" : "0");
  });

  mountActivityList(list);
  subscribeAgentMode((mode) => { panel.hidden = !mode?.enabled; });
  document.body.append(panel);
}
