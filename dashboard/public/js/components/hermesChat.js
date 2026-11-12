// Bouton « Telegram » de la barre du haut, version Hermes : état de la passerelle (service sur Oracle) et discussion récente.
// Données : handlers/hermeschat.mjs (hermes.status / hermes.state, hermes.restart). Tous les textes passent par textContent.
import { el } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";

const TICK_MS = 5_000;
let state = null;
let thinking = false;      // un message est parti vers Hermes : en attente de sa réponse
let sayError = "";
const listeners = new Set();
on("hermes.state", (m) => {
  state = m;
  if (m.said) { thinking = false; sayError = m.said.ok ? "" : m.said.error || "Hermes n'a pas répondu."; }
  for (const fn of listeners) { try { fn(); } catch { /* ignoré */ } }
});
on("hermes.said", (m) => { if (m.pending) { thinking = true; sayError = ""; for (const fn of listeners) { try { fn(); } catch { /* ignoré */ } } } });
onConnection((up) => { if (up) send({ type: "hermes.status" }); });

// « il y a 3 min » à partir d'une date ISO.
function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

// { tone: ok|attention|inactif, label } selon la passerelle et la connexion Telegram.
export function hermesSummary(st) {
  if (!st) return { tone: "inactif", label: "État inconnu" };
  if (!st.available) return { tone: "inactif", label: "Hermes n'est pas sur cette machine" };
  if (st.gateway !== "active") return { tone: "danger", label: "Hermes est arrêté" };
  if (st.connected === false) return { tone: "attention", label: "Hermes tourne, Telegram non connecté" };
  return { tone: "ok", label: "Hermes en marche, connecté à Telegram" };
}

export function createTelegramButton() {
  const led = el("span", { class: "led led-inactif", "aria-hidden": "true" });
  const button = el("button", {
    class: "btn btn-sm", type: "button", id: "topbar-telegram", "aria-haspopup": "dialog", "aria-expanded": "false",
    "aria-controls": "telegram-panel", title: "Hermes sur Telegram",
  }, led, el("span", { class: "telegram-label" }, "Hermes"));
  const statusEl = el("p", { class: "telegram-status", role: "status" });
  const chat = el("div", { class: "hermes-chat", role: "log", "aria-label": "Discussion avec Hermes" });
  const restartBtn = el("button", { class: "btn btn-sm", type: "button" }, "Relancer Hermes");
  const input = el("textarea", { class: "hermes-input", rows: "2", maxlength: "2000", placeholder: "Écrire à Hermes… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)", "aria-label": "Message à Hermes" });
  const sendBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, "Envoyer");
  const info = el("p", { class: "hermes-info", role: "status", "aria-live": "polite" });
  const composer = el("div", { class: "hermes-composer" }, input, sendBtn);
  const submit = () => {
    const text = input.value.trim();
    if (!text || thinking) return;
    send({ type: "hermes.say", text });
    input.value = "";
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
  const panel = el("aside", { class: "telegram-panel hermes-panel", id: "telegram-panel", "aria-label": "Hermes sur Telegram", hidden: true },
    el("header", { class: "telegram-head" }, el("strong", {}, "Hermes · Telegram"),
      el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: () => setOpen(false) }, "×")),
    statusEl, chat, info, composer, el("div", { class: "telegram-ctl-actions" }, restartBtn));

  function render() {
    const sum = hermesSummary(state);
    led.className = `led led-${sum.tone}`;
    button.dataset.state = sum.tone;
    button.setAttribute("aria-label", `Hermes : ${sum.label}`);
    statusEl.textContent = sum.label;
    statusEl.classList.toggle("is-stopped", sum.tone === "danger");
    const msgs = state?.messages || [];
    const stick = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 30;
    chat.replaceChildren(...(msgs.length ? msgs.map((m) => el("div", { class: `hermes-msg hermes-${m.role}` },
      el("div", { class: "hermes-bubble" }, m.text),
      el("time", { class: "hermes-time", datetime: m.at, title: new Date(m.at).toLocaleString("fr-FR") }, ago(m.at))))
      : [el("p", { class: "telegram-empty" }, state?.available ? "Aucun message pour l'instant." : "Aucune discussion à afficher ici.")]));
    if (stick) chat.scrollTop = chat.scrollHeight;
    restartBtn.disabled = !state?.available;
    input.disabled = !state?.available;
    sendBtn.disabled = !state?.available || thinking;
    info.textContent = thinking ? "Hermes réfléchit…" : sayError;
    info.classList.toggle("is-error", Boolean(sayError) && !thinking);
  }

  let timer = null;
  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    clearInterval(timer);
    timer = open ? setInterval(() => send({ type: "hermes.status" }), thinking ? 2_500 : TICK_MS) : null;
    if (open) { send({ type: "hermes.status" }); render(); chat.scrollTop = chat.scrollHeight; }
  }
  button.addEventListener("click", () => setOpen(panel.hidden));
  restartBtn.addEventListener("click", async () => {
    const yes = await confirmDialog({
      title: "Relancer Hermes ?",
      message: "La passerelle Hermes redémarre (quelques secondes) ; les messages envoyés pendant ce temps sont reçus ensuite.",
      confirmLabel: "Relancer",
    });
    if (yes) send({ type: "hermes.restart" });
  });
  const inDialog = (t) => Boolean(t?.closest?.("dialog")) || Boolean(document.querySelector("dialog[open]"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden && !inDialog(e.target)) { setOpen(false); button.focus(); } });
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target) && !inDialog(e.target)) setOpen(false);
  });
  listeners.add(render);
  setInterval(() => send({ type: "hermes.status" }), 30_000);
  document.body.append(panel);
  render();
  return button;
}
