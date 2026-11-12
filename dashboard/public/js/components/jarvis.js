// Chat avec Jarvis (orchestrateur) : panneau latéral en langage libre. Le serveur (handlers/jarvis.mjs) comprend le message avec
// l'état réel du poste ; une action proposée n'est envoyée au poste qu'après le clic « Confirmer » (messages `exec`).
// Fil unique (T43) : le panneau affiche le fil partagé avec Telegram (jarvis.thread au chargement, jarvis.msg en direct). Les
// actions à confirmer (`exec`) ne sont connues que du panneau qui a posé la question : ailleurs, le résumé s'affiche sans bouton.
import { send, on, onConnection } from "../core/socket.js";
import { el } from "../core/util.js";
import { closeSideChat } from "./llmchat.js";

const KEY = "paseo:jarvis-proposals";
const CLEARED = "paseo:jarvis-cleared";
const CHANNEL = { telegram: "Telegram", panneau: "Panneau" };
const MAX_LOCAL = 30;
let panel = null;
let body = null;
let input = null;
let toggleButton = null;
let items = []; // messages du fil (serveur) + erreurs locales (local: true), triés par date
let proposals = {}; // id du message du fil -> { exec, done } : seulement les propositions faites depuis ce panneau
let clearedAt = ""; // « Nouvelle discussion » : masque et écarte du contexte ce qui précède (propre à cet onglet)
let pending = null; // id de la question en cours
let started = false;
let localCount = 0;

const read = (key, fallback) => {
  try { return JSON.parse(window.sessionStorage?.getItem(key) || "null") ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { window.sessionStorage?.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
};
const saveProposals = () => {
  const keys = Object.keys(proposals);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_LOCAL))) delete proposals[key];
  write(KEY, proposals);
};

const byDate = (a, b) => String(a.at).localeCompare(String(b.at));
function merge(messages) {
  const known = new Set(items.map((x) => x.id));
  const fresh = (Array.isArray(messages) ? messages : []).filter((x) => x?.id && !known.has(x.id));
  if (fresh.length) items = [...items, ...fresh].sort(byDate);
}
const visible = () => items.filter((x) => !clearedAt || String(x.at) > clearedAt);

function bubble(item) {
  const channel = CHANNEL[item.channel];
  const node = el("div", { class: `jarvis-msg is-${item.role}${item.error ? " is-error" : ""}` });
  if (channel) {
    node.append(el("div", { class: `jarvis-chan is-${item.channel}`, title: item.at ? new Date(item.at).toLocaleString("fr-FR") : "" },
      channel));
  }
  node.append(el("div", { class: "jarvis-text" }, item.text));
  if (item.summary) node.append(el("pre", { class: "jarvis-summary" }, item.summary));
  const proposal = proposals[item.id];
  if (proposal?.exec && !proposal.done) {
    const ok = el("button", { type: "button", class: "btn btn-sm btn-primary" }, "✅ Confirmer");
    const no = el("button", { type: "button", class: "btn btn-sm" }, "❌ Annuler");
    ok.addEventListener("click", () => {
      for (const message of proposal.exec) send(message);
      proposal.done = "Demande envoyée au poste (une alerte apparaît s'il la refuse).";
      saveProposals();
      render();
    });
    no.addEventListener("click", () => { proposal.done = "Annulé."; saveProposals(); render(); });
    node.append(el("div", { class: "jarvis-actions" }, ok, no));
  } else if (proposal?.done) node.append(el("div", { class: "muted jarvis-done" }, proposal.done));
  else if (item.summary) node.append(el("div", { class: "muted jarvis-done" }, "À confirmer là où elle a été proposée."));
  return node;
}

function render() {
  if (!body) return;
  const shown = visible();
  body.replaceChildren(...(shown.length ? shown.map(bubble) : [el("p", { class: "muted" },
    "Parle-moi comme à un collègue : « T'as accès au groupe BlastWin ? », « ferme les sessions inactives », "
    + "« avance sur AI-OS », « dis au groupe de penser aux tests », « dis à Jarvis de… ». Je propose, tu confirmes. "
    + "La discussion est la même que sur Telegram.")]),
  ...(pending ? [el("div", { class: "jarvis-msg is-assistant muted" }, "Jarvis réfléchit…")] : []));
  body.scrollTop = body.scrollHeight;
}

function localError(text) {
  localCount += 1;
  items = [...items, { id: `local-${localCount}`, at: new Date().toISOString(), role: "assistant", text, error: true, local: true }]
    .sort(byDate);
}

function ask(text) {
  const id = `j${Date.now().toString(36)}`;
  pending = id;
  render();
  if (!send({ type: "jarvis.say", id, text, ...(clearedAt ? { since: clearedAt } : {}) })) {
    pending = null;
    localError("Connexion au serveur indisponible, réessaie dans un instant.");
    render();
  }
}

function loadThread() {
  send({ type: "jarvis.thread" });
}

function newDiscussion() {
  clearedAt = new Date().toISOString();
  write(CLEARED, clearedAt);
  items = items.filter((x) => !x.local);
  render();
}

function ensure() {
  if (panel) return panel;
  proposals = read(KEY, {});
  clearedAt = read(CLEARED, "");
  panel = el("aside", { id: "jarvis-panel", class: "sidechat jarvis", "aria-label": "Discussion avec Jarvis", hidden: true });
  body = el("div", { class: "sidechat-body jarvis-body", role: "log", "aria-live": "polite" });
  input = el("textarea", { class: "llmchat-textarea", rows: "2", placeholder: "Écris à Jarvis…", required: true });
  const form = el("form", { class: "sidechat-foot llmchat-foot" },
    el("div", { class: "llmchat-input-row" }, input, el("button", { type: "submit", class: "btn btn-primary btn-sm" }, "Envoyer")));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || pending) return;
    input.value = "";
    ask(text);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
  });
  panel.append(
    el("header", { class: "sidechat-head" }, el("h2", { class: "sidechat-title" }, "Jarvis"),
      el("div", {},
        el("button", { type: "button", class: "btn btn-sm", onclick: newDiscussion }, "Nouvelle discussion"),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Fermer Jarvis", onclick: closeJarvis }, "×"))),
    body, form);
  document.body.append(panel);
  if (!started) {
    started = true;
    on("jarvis.thread", (m) => { merge(m.messages); render(); });
    on("jarvis.msg", (m) => { merge([m.message]); render(); });
    on("jarvis.reply", (m) => {
      if (m.id !== pending) return;
      pending = null;
      if (m.ok) {
        if (m.exec && m.messageId) { proposals[m.messageId] = { exec: m.exec }; saveProposals(); }
      } else localError(m.error || "Erreur.");
      render();
    });
    onConnection((up) => { if (up && panel) loadThread(); }); // reconnexion : on récupère ce qui a été manqué
  }
  render();
  return panel;
}

export const isJarvisOpen = () => Boolean(panel) && !panel.hidden;

export function openJarvis() {
  closeSideChat();
  ensure().hidden = false;
  document.body.classList.add("sidechat-open");
  toggleButton?.setAttribute("aria-expanded", "true");
  loadThread();
  render();
  input.focus();
}

export function closeJarvis() {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove("sidechat-open");
  toggleButton?.setAttribute("aria-expanded", "false");
}

export function toggleJarvis() {
  if (isJarvisOpen()) closeJarvis();
  else openJarvis();
}

export function setJarvisButton(button) {
  toggleButton = button;
}
