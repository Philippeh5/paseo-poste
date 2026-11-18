// Corps de fenêtre « Chrome distant » : un vrai Chrome (sans écran) tourne SUR la machine ; on voit son image et on le pilote
// d'ici (souris, clavier, molette), avec copie de la sélection vers le presse-papiers local et collage de texte. Repris de
// l'ancienne vue « Navigateur », maintenant hébergé dans une fenêtre web du Bureau (voir core/webwindow.js).
// Serveur : handlers/rbrowser.mjs (UN SEUL Chrome pour tout le poste : une seule fenêtre en mode Chrome à la fois, voir deskstore.js).
// Textes via el() : aucun innerHTML dynamique.
import { el } from "./util.js";
import { send, on, onConnection } from "./socket.js";
import { confirmDialog } from "./confirm.js";
import { toast } from "./toast.js";

const W = 1280; const H = 800;
const keyMsg = (e) => ({ type: "rbrowser.input", kind: "key", key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
const mods = (e) => ({ ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); toast(text ? `Copié (${text.length} caractères)` : "Aucune sélection dans la page"); }
  catch { toast(text ? "Copie bloquée par le navigateur : sélectionnez le texte dans la page" : "Aucune sélection"); }
}

// Monte le panneau dans `container`. `url` : adresse à ouvrir dès que Chrome tourne. Renvoie { destroy }.
export function mountRbrowserPane(container, { url = "" } = {}) {
  let st = { state: "stopped", url: "", chrome: true };
  let canvas = null; let ctx2d = null; let urlInput = null; let lastMove = 0; let draft = "";
  let pending = url || null;
  const offs = [];
  const root = el("div", { class: "rbpane", style: "display:flex;flex-direction:column;gap:6px;padding:6px;height:100%;min-height:0;overflow:auto" });
  container.replaceChildren(root);

  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * (W / r.width)), y: Math.round((e.clientY - r.top) * (H / r.height)) }; };
  function buildCanvas() {
    canvas = el("canvas", { width: W, height: H, tabindex: "0", "aria-label": "Chrome distant (cliquez puis tapez)", style: "width:100%;height:auto;max-height:100%;min-height:0;object-fit:contain;background:#fff;border:1px solid var(--trait);border-radius:8px;outline-offset:2px;cursor:default;align-self:center" });
    ctx2d = canvas.getContext("2d");
    const down = (action) => (e) => { e.preventDefault(); canvas.focus(); send({ type: "rbrowser.input", kind: "mouse", action, button: e.button, ...pos(e), ...mods(e) }); };
    canvas.addEventListener("mousedown", down("down"));
    canvas.addEventListener("mouseup", down("up"));
    canvas.addEventListener("mousemove", (e) => { const t = Date.now(); if (t - lastMove < 60) return; lastMove = t; send({ type: "rbrowser.input", kind: "mouse", action: "move", button: -1, ...pos(e) }); });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); send({ type: "rbrowser.input", kind: "wheel", dx: e.deltaX, dy: e.deltaY, ...pos(e) }); }, { passive: false });
    canvas.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") { e.preventDefault(); send({ type: "rbrowser.copy" }); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // laissé à l'évènement « paste » (texte du presse-papiers local)
      if (e.key.length === 1 || /^(Enter|Backspace|Tab|Escape|Delete|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown)$/.test(e.key)) { e.preventDefault(); send(keyMsg(e)); }
    });
    canvas.addEventListener("paste", (e) => { e.preventDefault(); const text = e.clipboardData?.getData("text/plain"); if (text) send({ type: "rbrowser.paste", text }); });
    return canvas;
  }

  function render() {
    const running = st.state === "running";
    urlInput = el("input", { class: "pilot-search", type: "text", placeholder: "Adresse (ex. http://127.0.0.1:3000 ou example.com)", value: st.url && st.url !== "about:blank" ? st.url : "", "aria-label": "Adresse", style: "flex:1 1 200px;min-width:0",
      onkeydown: (e) => { if (e.key === "Enter") send({ type: "rbrowser.nav", url: e.target.value }); } });
    const btn = (label, fn, cls = "") => el("button", { class: `btn btn-sm ${cls}`, type: "button", disabled: !running, onclick: fn }, label);
    root.replaceChildren(
      el("div", { class: "pilot-databar" },
        running ? el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "rbrowser.stop" }) }, "Arrêter Chrome")
          : el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: !st.chrome || st.state === "starting", onclick: async () => {
            if (await confirmDialog({ title: "Démarrer le Chrome distant ?", message: "Lance un Chrome sans écran sur la machine (profil persistant ~/.paseo-browser-profile : les connexions aux sites restent).", confirmLabel: "Démarrer" })) {
              send({ type: "rbrowser.start", confirm: true }); } } }, st.state === "starting" ? "Démarrage…" : "Démarrer Chrome"),
        btn("←", () => send({ type: "rbrowser.back" })), btn("→", () => send({ type: "rbrowser.forward" })),
        btn("↻", () => send({ type: "rbrowser.nav", url: st.url })), urlInput,
        btn("Aller", () => send({ type: "rbrowser.nav", url: urlInput.value }), "btn-primary"),
        btn("Copier la sélection", () => send({ type: "rbrowser.copy" }))),
      running ? el("div", { class: "pilot-databar", role: "tablist", "aria-label": "Onglets" },
        (st.tabs || []).map((t) => el("span", { style: "display:inline-flex;gap:2px" },
          el("button", { class: `btn btn-sm ${t.id === st.active ? "btn-primary" : ""}`, type: "button", role: "tab", "aria-selected": String(t.id === st.active), title: t.url, style: "max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", onclick: () => send({ type: "rbrowser.switchTab", id: t.id }) }, t.title || t.url || "Nouvel onglet"),
          (st.tabs || []).length > 1 ? el("button", { class: "btn btn-sm", type: "button", "aria-label": "Fermer l'onglet", onclick: () => send({ type: "rbrowser.closeTab", id: t.id }) }, "×") : null)),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "rbrowser.newTab" }) }, "+ Onglet")) : null,
      running ? buildCanvas() : el("p", { class: "pilot-empty" }, st.chrome ? "Démarrez Chrome pour afficher la page." : "Aucun Chrome/Chromium trouvé sur cette machine."),
      running ? el("details", {}, el("summary", {}, "Coller du texte dans la page"),
        el("div", { class: "pilot-databar" }, el("textarea", { rows: 2, placeholder: "Texte à coller à l'endroit du curseur de la page…", style: "flex:1 1 220px", "aria-label": "Texte à coller", oninput: (e) => { draft = e.target.value; } }),
          el("button", { class: "btn btn-sm", type: "button", onclick: () => { if (draft) send({ type: "rbrowser.paste", text: draft }); } }, "Coller"))) : null);
  }

  render();
  offs.push(on("rbrowser.state", (m) => {
    if (m.state === "running" && pending) { send({ type: "rbrowser.nav", url: pending }); pending = null; }
    const was = st.state; const prevTabs = st.tabs; const prevActive = st.active; st = m;
    if (was !== m.state || JSON.stringify(m.tabs) !== JSON.stringify(prevTabs) || m.active !== prevActive) { render(); if (m.state === "running") send({ type: "rbrowser.watch" }); }
    else if (urlInput && document.activeElement !== urlInput && m.url) urlInput.value = m.url;
  }));
  offs.push(on("rbrowser.frame", (m) => { if (!ctx2d) return; const img = new Image(); img.onload = () => ctx2d?.drawImage(img, 0, 0, W, H); img.src = `data:image/jpeg;base64,${m.data}`; }));
  offs.push(on("rbrowser.selection", (m) => writeClipboard(m.text)));
  offs.push(onConnection((up) => { if (up) send({ type: "rbrowser.status" }); }));
  send({ type: "rbrowser.status" });
  return {
    destroy() { send({ type: "rbrowser.unwatch" }); for (const off of offs) off(); offs.length = 0; canvas = null; ctx2d = null; root.remove(); },
  };
}
