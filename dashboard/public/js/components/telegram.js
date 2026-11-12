// Bouton « Telegram » de la barre du haut (T32) : pastille verte (bot en marche) ou grise (arrêté) et panneau en lecture
// seule — état du bot, 20 dernières commandes, aide-mémoire. Données : handlers/telegram.mjs (message telegram.status).
// T48 : supervision du bot par le tableau de bord (handlers/telegramctl.mjs, messages telegramctl.*) — état du processus,
// bouton « Relancer Telegram » (avec confirmation intégrée) et « Journal ». Rien d'autre n'est commandé ici.
// Tous les textes passent par textContent (el() crée des nœuds texte) : aucun innerHTML avec du contenu dynamique.
import { el } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";

export const STALE_MS = 90_000; // même seuil que le serveur : au-delà, « bot arrêté » même sans nouveau message
const SHOWN = 20;
const TICK_MS = 5_000;

const CHEAT_SHEET = [
  ["/poste  ou  menu", "Menu en boutons : agent, terminal / FreeBuff, tâches, boîte de réception, état, Mode Agent, fermer des sessions."],
  ["/poste état · sessions · tâches · boîte · projets", "Lire l'état du poste (aucune confirmation)."],
  ["/poste tâche Titre [projet X]", "Créer une tâche (✅/❌ avant d'écrire)."],
  ["/poste fermer sessions inactives", "Fermer des sessions : la liste exacte est montrée avant ✅."],
  ["/poste supprimer tâches terminées", "Supprimer des tâches : liste exacte puis ✅."],
  ["/poste valider boîte", "Marquer la boîte de réception comme traitée."],
  ["/launch Projet prompt", "Ouvrir une session Claude Code sur un projet."],
  ["/calendrier", "Les 7 prochains jours."],
];

let status = null;       // dernier telegram.status reçu
let receivedAt = 0;      // Date.now() à la réception (pour prolonger l'âge sans nouveau message)
const listeners = new Set();

let ctl = null;          // dernier telegramctl.state reçu (null tant que le serveur n'a pas répondu)
let restarting = false;  // entre le clic confirmé et la réponse du serveur
on("telegramctl.state", (m) => {
  ctl = m;
  if (m.busy || m.ref === RESTART_REF) restarting = false;
  for (const fn of listeners) { try { fn(); } catch { /* ignoré */ } }
});
const RESTART_REF = "ui-restart";
on("telegram.status", (m) => {
  status = m;
  receivedAt = Date.now();
  for (const fn of listeners) { try { fn(); } catch { /* ignoré */ } }
});
onConnection((up) => { if (up) { send({ type: "telegram.status" }); send({ type: "telegramctl.get" }); } });

// « 3 min », « 2 h 05 », « 4 j » : durée écoulée depuis `iso` (pour « en marche depuis … »).
export function durationFrom(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)} j`;
}

// État du processus selon le superviseur : { tone: ok|attention|danger|inactif, label, detail }.
export function ctlSummary(state, now = Date.now()) {
  if (!state?.available) return null;
  if (state.busy) {
    const label = state.busy === "stopping" ? "Arrêt en cours…" : "Relance en cours…";
    return { tone: "attention", label, detail: "" };
  }
  const n = state.restarts || 0;
  const restarts = `${n} redémarrage${n > 1 ? "s" : ""}`;
  if (state.running) {
    const who = state.adopted ? "adopté (déjà lancé avant le tableau de bord)" : "lancé par le tableau de bord";
    return { tone: "ok", label: `En marche depuis ${durationFrom(state.since, now)}`, detail: `${who} · ${restarts}` };
  }
  if (state.nextRetryAt) {
    const wait = Math.max(0, Math.ceil((Date.parse(state.nextRetryAt) - now) / 1000));
    return { tone: "attention", label: `Arrêté — nouvelle tentative dans ${wait} s`, detail: restarts };
  }
  if (state.gaveUp) return { tone: "danger", label: "Arrêté — relance automatique abandonnée", detail: restarts };
  return { tone: "inactif", label: "Arrêté", detail: state.autostart ? restarts : "lancement automatique désactivé" };
}

// Âge courant du dernier signe de vie, en ms (null si le bot n'a jamais donné signe de vie).
function currentAge(now = Date.now()) {
  return status?.ageMs == null ? null : status.ageMs + Math.max(0, now - receivedAt);
}
// Le bot a battu récemment (.heartbeat.json, lu par telegram.mjs).
function isBeating(now = Date.now()) {
  const age = currentAge(now);
  return Boolean(status?.running) && age !== null && age <= STALE_MS;
}
// Le superviseur sait que le processus est arrêté (et que ce n'est pas une relance en cours).
const supervisorSaysStopped = () => Boolean(ctl?.available) && !ctl.running && !ctl.busy;
export function isRunning(now = Date.now()) {
  return isBeating(now) && !supervisorSaysStopped();
}

// « il y a 12 s », « il y a 3 min », « il y a 2 h », « il y a 4 j ».
export function relativeFrom(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

export function statusLine(now = Date.now()) {
  if (!status) return "Vérification de l'état du bot…";
  if (isRunning(now)) {
    const age = currentAge(now);
    return age < 3000 ? "Le bot répond à l'instant" : `Le bot répond depuis ${relativeFrom(age)}`;
  }
  if (isBeating(now)) return `Le bot est arrêté — dernier signe de vie ${relativeFrom(currentAge(now))}`;
  return ctl?.available
    ? "Le bot est arrêté — utilise « Relancer Telegram »"
    : "Le bot est arrêté — lance start_telegram_assistant.bat";
}

// Dialogue « Journal » : dernières lignes de data/telegram-bot.log (déjà masquées par le serveur).
let logPre = null;
on("telegramctl.logs", (m) => {
  if (!logPre?.isConnected) return;
  logPre.textContent = m.lines?.length ? m.lines.join("\n") : "Le journal est vide pour l'instant.";
  logPre.scrollTop = logPre.scrollHeight;
});
function openLogs() {
  const previous = document.activeElement;
  const pre = el("pre", {
    class: "telegram-log", tabindex: "0", "aria-label": "Dernières lignes du journal",
  }, "Chargement…");
  const dialog = el("dialog", { class: "dialog telegram-log-dialog", "aria-label": "Journal du bot Telegram" });
  const refresh = () => send({ type: "telegramctl.logs", lines: 100 });
  dialog.append(
    el("div", { class: "dialog-body" },
      el("div", { class: "dialog-head" }, el("h2", {}, "Journal du bot Telegram"),
        el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: () => dialog.close() },
          "×")),
      el("p", { class: "dialog-text" }, "100 dernières lignes de data/telegram-bot.log ; les secrets sont masqués."),
      pre),
    el("footer", { class: "dialog-foot" },
      el("button", { class: "btn", type: "button", onclick: refresh }, "Actualiser"),
      el("button", { class: "btn btn-primary", type: "button", onclick: () => dialog.close() }, "Fermer")));
  dialog.addEventListener("close", () => { dialog.remove(); if (logPre === pre) logPre = null; previous?.focus?.(); });
  document.body.append(dialog);
  logPre = pre;
  dialog.showModal();
  refresh();
}

// Crée le bouton « Telegram » (à poser dans la barre du haut) et son panneau.
export function createTelegramButton() {
  const led = el("span", { class: "led led-inactif", "aria-hidden": "true" });
  const button = el("button", {
    class: "btn btn-sm", type: "button", id: "topbar-telegram", "aria-haspopup": "dialog", "aria-expanded": "false",
    "aria-controls": "telegram-panel", title: "Bot Telegram du poste",
  }, led, el("span", { class: "telegram-label" }, "Telegram"));

  const statusEl = el("p", { class: "telegram-status", id: "telegram-status", role: "status" });
  const hint = el("p", { class: "telegram-hint" },
    "Lecture seule côté Telegram : le seul geste possible ici est de relancer le bot.");
  const ctlLed = el("span", { class: "led led-inactif", "aria-hidden": "true" });
  const ctlLabel = el("strong", { class: "telegram-ctl-label", id: "telegram-ctl-label" });
  const ctlDetail = el("span", { class: "telegram-ctl-detail", id: "telegram-ctl-detail" });
  const ctlError = el("p", { class: "telegram-ctl-error", id: "telegram-ctl-error", role: "alert" });
  const restartBtn = el("button", {
    class: "btn btn-sm btn-primary", type: "button", id: "telegram-restart",
  }, "Relancer Telegram");
  const logsBtn = el("button", { class: "btn btn-sm", type: "button", id: "telegram-logs" }, "Journal");
  const ctlBox = el("section", {
    class: "telegram-ctl", id: "telegram-ctl", "aria-label": "Supervision du bot", hidden: true,
  },
    el("p", { class: "telegram-ctl-state", id: "telegram-ctl-state", role: "status" }, ctlLed, ctlLabel),
    ctlDetail, ctlError, el("div", { class: "telegram-ctl-actions" }, restartBtn, logsBtn));
  const list = el("ol", { class: "telegram-recent", id: "telegram-recent", "aria-label": "Dernières commandes" });
  const cheat = el("details", { class: "telegram-cheat", id: "telegram-cheat" },
    el("summary", {}, "Aide-mémoire des commandes et menus"),
    el("dl", {}, ...CHEAT_SHEET.flatMap(([cmd, what]) => [el("dt", {}, cmd), el("dd", {}, what)])));
  const panel = el("aside", {
    class: "telegram-panel", id: "telegram-panel", "aria-label": "Bot Telegram", hidden: true,
  }, el("header", { class: "telegram-head" }, el("strong", {}, "Telegram"),
    el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", id: "telegram-close", onclick: () => setOpen(false) }, "×")),
  statusEl, hint, ctlBox, el("h3", {}, "Dernières commandes"), list, cheat);

  function render() {
    const now = Date.now();
    const running = isRunning(now);
    led.className = `led ${running ? "led-ok" : "led-inactif"}`;
    button.dataset.state = status ? (running ? "running" : "stopped") : "unknown";
    button.setAttribute("aria-label", `Telegram : ${running ? "bot en marche" : status ? "bot arrêté" : "état inconnu"}`);
    statusEl.textContent = statusLine(now);
    statusEl.classList.toggle("is-stopped", Boolean(status) && !running);
    const sum = ctlSummary(ctl, now);
    ctlBox.hidden = !sum;
    if (sum) {
      ctlLed.className = `led led-${sum.tone}${sum.tone === "attention" ? " led-pulse" : ""}`;
      ctlBox.dataset.tone = sum.tone;
      ctlLabel.textContent = restarting && !ctl.busy ? "Relance demandée…" : sum.label;
      ctlDetail.textContent = sum.detail;
      ctlError.textContent = ctl.lastError || "";
      ctlError.hidden = !ctl.lastError;
      restartBtn.disabled = Boolean(ctl.busy) || restarting;
      if (ctl.busy) restarting = false;
    }
    const recent = (status?.recent || []).slice(0, SHOWN);
    list.replaceChildren(...(recent.length ? recent.map((entry) => el("li", {
      class: `telegram-item${entry.result === "non effectué" ? " is-failed" : ""}`,
    }, el("time", { class: "telegram-time", datetime: entry.at, title: new Date(entry.at).toLocaleString("fr-FR") },
      relativeFrom(now - Date.parse(entry.at))),
    el("span", { class: "telegram-text" }, entry.label),
    entry.result ? el("span", { class: "telegram-result" }, entry.result) : null))
      : [el("li", { class: "telegram-empty" }, "Aucune commande enregistrée pour l'instant.")]));
  }

  let timer = null;
  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    clearInterval(timer);
    timer = open ? setInterval(render, TICK_MS) : null;
    if (open) { send({ type: "telegram.status" }); send({ type: "telegramctl.get" }); render(); }
  }
  button.addEventListener("click", () => setOpen(panel.hidden));
  restartBtn.addEventListener("click", async () => {
    const yes = await confirmDialog({
      title: "Relancer Telegram ?",
      message: "Le bot sera arrêté puis relancé ; les messages envoyés pendant ce temps sont reçus ensuite.",
      confirmLabel: "Relancer",
    });
    if (!yes) return;
    restarting = true;
    send({ type: "telegramctl.restart", ref: RESTART_REF });
    render();
  });
  logsBtn.addEventListener("click", openLogs);
  // Un dialogue ouvert depuis le panneau (confirmation, journal) ne doit ni le fermer ni réagir à Échap à sa place.
  const inDialog = (target) => Boolean(target?.closest?.("dialog")) || Boolean(document.querySelector("dialog[open]"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden && !inDialog(event.target)) { setOpen(false); button.focus(); }
  });
  document.addEventListener("pointerdown", (event) => {
    const outside = !panel.contains(event.target) && !button.contains(event.target);
    if (!panel.hidden && outside && !inDialog(event.target)) setOpen(false);
  });

  listeners.add(render);
  setInterval(render, 15_000); // la pastille passe au gris même sans nouveau message du serveur
  document.body.append(panel);
  render();
  return button;
}
