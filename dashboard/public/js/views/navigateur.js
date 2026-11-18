// Vue « Navigateur » : un vrai Chrome (sans écran) tourne SUR la machine ; on le voit et on le pilote d'ici (souris, clavier,
// molette), avec copie de la sélection vers le presse-papiers local et collage de texte. Pratique pour un serveur local, un site
// à session ouverte ou un texte à copier. Serveur : handlers/rbrowser.mjs. Textes via el() : aucun innerHTML dynamique.
import { registerView } from "./registry.js";
import { el } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";

const ICON = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.2 2.2 2.2 12.8 0 15M10 2.5c-2.2 2.2-2.2 12.8 0 15"/></svg>';
const W = 1280; const H = 800;
let root; let offs = []; let st = { state: "stopped", url: "", chrome: true }; let canvas; let ctx2d; let urlInput; let lastMove = 0; let draft = "";

const keyMsg = (e) => ({ type: "rbrowser.input", kind: "key", key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
function pos(e) { const r = canvas.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * (W / r.width)), y: Math.round((e.clientY - r.top) * (H / r.height)) }; }
const mods = (e) => ({ ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });

async function copySelection() { send({ type: "rbrowser.copy" }); }
async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); toast(text ? `Copié (${text.length} caractères)` : "Aucune sélection dans la page"); }
  catch { toast(text ? "Copie bloquée par le navigateur : sélectionnez le texte ci-dessous" : "Aucune sélection"); }
}

function buildCanvas() {
  canvas = el("canvas", { width: W, height: H, tabindex: "0", "aria-label": "Navigateur distant (cliquez puis tapez)", style: "width:100%;height:auto;max-height:75vh;object-fit:contain;background:#fff;border:1px solid var(--trait);border-radius:8px;outline-offset:2px;cursor:default" });
  ctx2d = canvas.getContext("2d");
  const down = (action) => (e) => { e.preventDefault(); canvas.focus(); send({ type: "rbrowser.input", kind: "mouse", action, button: e.button, ...pos(e), ...mods(e) }); };
  canvas.addEventListener("mousedown", down("down"));
  canvas.addEventListener("mouseup", down("up"));
  canvas.addEventListener("mousemove", (e) => { const t = Date.now(); if (t - lastMove < 60) return; lastMove = t; send({ type: "rbrowser.input", kind: "mouse", action: "move", button: -1, ...pos(e) }); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); send({ type: "rbrowser.input", kind: "wheel", dx: e.deltaX, dy: e.deltaY, ...pos(e) }); }, { passive: false });
  canvas.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // laissé à l'évènement « paste » (texte du presse-papiers local)
    if (e.key.length === 1 || /^(Enter|Backspace|Tab|Escape|Delete|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(e.key)) { e.preventDefault(); send(keyMsg(e)); }
  });
  canvas.addEventListener("paste", (e) => { e.preventDefault(); const text = e.clipboardData?.getData("text/plain"); if (text) send({ type: "rbrowser.paste", text }); });
  return canvas;
}

function render() {
  if (!root) return;
  const host = root.firstChild;
  const running = st.state === "running";
  urlInput = el("input", { class: "pilot-search", type: "text", placeholder: "Adresse (ex. http://127.0.0.1:3000 ou example.com)", value: st.url && st.url !== "about:blank" ? st.url : "", "aria-label": "Adresse",
    onkeydown: (e) => { if (e.key === "Enter") send({ type: "rbrowser.nav", url: e.target.value }); } });
  const btn = (label, fn, cls = "") => el("button", { class: `btn btn-sm ${cls}`, type: "button", disabled: !running, onclick: fn }, label);
  host.replaceChildren(
    el("header", { class: "pilot-head" }, el("h1", {}, "Navigateur"),
      el("span", { class: "pilot-summary" }, running ? "Chrome tourne sur la machine : cliquez dans l'image, puis tapez." : st.chrome ? "Arrêté." : "Aucun Chrome/Chromium trouvé sur cette machine."),
      running ? el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "rbrowser.stop" }) }, "Arrêter")
        : el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: !st.chrome || st.state === "starting", onclick: async () => {
          if (await confirmDialog({ title: "Démarrer le navigateur distant ?", message: "Lance un Chrome sans écran sur la machine (profil persistant ~/.paseo-browser-profile : les connexions aux sites restent).", confirmLabel: "Démarrer" })) {
            send({ type: "rbrowser.start", confirm: true }); } } }, st.state === "starting" ? "Démarrage…" : "Démarrer")),
    el("div", { class: "pilot-databar" }, btn("←", () => send({ type: "rbrowser.back" })), btn("→", () => send({ type: "rbrowser.forward" })),
      btn("↻", () => send({ type: "rbrowser.nav", url: st.url })), urlInput,
      btn("Aller", () => send({ type: "rbrowser.nav", url: urlInput.value }), "btn-primary"),
      btn("Copier la sélection", copySelection)),
    running ? el("div", { class: "pilot-databar", role: "tablist", "aria-label": "Onglets" },
      (st.tabs || []).map((t) => el("span", { style: "display:inline-flex;gap:2px" },
        el("button", { class: `btn btn-sm ${t.id === st.active ? "btn-primary" : ""}`, type: "button", role: "tab", "aria-selected": String(t.id === st.active), title: t.url, style: "max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", onclick: () => send({ type: "rbrowser.switchTab", id: t.id }) }, t.title || t.url || "Nouvel onglet"),
        (st.tabs || []).length > 1 ? el("button", { class: "btn btn-sm", type: "button", "aria-label": "Fermer l'onglet", onclick: () => send({ type: "rbrowser.closeTab", id: t.id }) }, "×") : null)),
      el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "rbrowser.newTab" }) }, "+ Onglet")) : null,
    running ? buildCanvas() : el("p", { class: "pilot-empty" }, "Démarrez le navigateur pour afficher une page de la machine."),
    running ? el("details", {}, el("summary", {}, "Coller du texte dans la page"),
      el("div", { class: "pilot-databar" }, el("textarea", { rows: 3, placeholder: "Texte à coller à l'endroit du curseur de la page…", style: "flex:1 1 300px", "aria-label": "Texte à coller", oninput: (e) => { draft = e.target.value; } }),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => { if (draft) send({ type: "rbrowser.paste", text: draft }); } }, "Coller"))) : null);
}

const view = {
  id: "navigateur", title: "Navigateur", short: "Web", icon: ICON, order: 19,
  mount(container) {
    root = container;
    root.replaceChildren(el("div", { class: "pilot" }));
    render();
    offs.push(on("rbrowser.state", (m) => { const was = st.state; const prevTabs = st.tabs; const prevActive = st.active; st = m; if (was !== m.state || JSON.stringify(m.tabs) !== JSON.stringify(prevTabs) || m.active !== prevActive) { render(); if (m.state === "running") send({ type: "rbrowser.watch" }); } else if (urlInput && document.activeElement !== urlInput && m.url) urlInput.value = m.url; }));
    offs.push(on("rbrowser.frame", (m) => { if (!ctx2d) return; const img = new Image(); img.onload = () => ctx2d.drawImage(img, 0, 0, W, H); img.src = `data:image/jpeg;base64,${m.data}`; }));
    offs.push(on("rbrowser.selection", (m) => writeClipboard(m.text)));
    offs.push(onConnection((up) => { if (up) { send({ type: "rbrowser.status" }); } }));
    send({ type: "rbrowser.status" });
  },
  unmount() { send({ type: "rbrowser.unwatch" }); for (const off of offs) off(); offs = []; root = null; canvas = null; ctx2d = null; },
};

registerView(view);
export default view;
