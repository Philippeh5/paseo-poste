// Corps d'une fenêtre « web » du Bureau : une page servie par un port de la machine du poste, affichée soit par le relais
// rapide (iframe, lecture seule : handlers/preview.mjs), soit par le vrai Chrome distant (core/rbrowserpane.js).
// Le cadre du relais est isolé : sandbox SANS allow-same-origin, la page ne peut ni lire le stockage du poste ni appeler son API.
// Textes via el() : aucun innerHTML dynamique.
import { el } from "./util.js";
import { send, on } from "./socket.js";
import { mountRbrowserPane } from "./rbrowserpane.js";

// Adresse « humaine » de la fenêtre : http://127.0.0.1:<port><chemin> pour un port, l'adresse telle quelle sinon.
export const webAddress = (win) => (win.port ? `http://127.0.0.1:${win.port}${win.path || "/"}` : win.url || "");

// onMode(mode) : demande de bascule Relais / Chrome (gérée par deskstore.setWebMode).
export function mountWebWindow(body, win, { onMode } = {}) {
  const offs = [];
  const view = el("div", { style: "flex:1;min-height:0;display:flex;flex-direction:column" });
  let frame = null; let relayUrl = null; let pane = null; let tabLink = null; let hint = 0;
  const toolbar = el("div", { class: "pilot-databar", style: "padding:4px 6px;border-bottom:1px solid var(--trait);align-items:center;flex:none" });
  const modeBtn = (mode, label) => el("button", { class: `btn btn-sm ${win.mode === mode ? "btn-primary" : ""}`, type: "button", "aria-pressed": String(win.mode === mode),
    disabled: mode === "relay" && !win.port ? true : null, title: mode === "relay" ? "Relais rapide (lecture, sans WebSocket)" : "Vrai Chrome sur la machine (WebSocket, formulaires, connexions)",
    onclick: () => { if (win.mode !== mode) onMode?.(mode); } }, label);
  const reload = el("button", { class: "btn btn-sm", type: "button", "aria-label": "Recharger", title: "Recharger", onclick: () => { if (frame && relayUrl) frame.src = relayUrl; } }, "↻");
  tabLink = el("a", { class: "btn btn-sm", target: "_blank", rel: "noopener", hidden: true, title: "Ouvrir dans un onglet du navigateur" }, "Onglet ↗");
  toolbar.append(modeBtn("relay", "Relais"), modeBtn("chrome", "Chrome"), win.mode === "relay" ? reload : null, win.mode === "relay" ? tabLink : null,
    el("span", { class: "pilot-detail mono", style: "margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, webAddress(win)));
  body.replaceChildren(toolbar, view);

  if (win.mode === "chrome") {
    const holder = el("div", { style: "flex:1;min-height:0" });
    view.append(holder);
    pane = mountRbrowserPane(holder, { url: webAddress(win) });
  } else if (win.port) {
    // Adresse-capacité à jeton, liée au port (8 h) : demandée au serveur, qui vérifie que le port écoute.
    const wait = el("p", { class: "pilot-empty", style: "padding:10px 14px" }, "Ouverture…");
    view.append(wait);
    offs.push(on("preview.opened", (m) => {
      if (m.port !== win.port || frame) return;
      relayUrl = m.url + String(win.path || "/").replace(/^\//, "");
      frame = el("iframe", { src: relayUrl, title: `Aperçu du port ${win.port}`, sandbox: "allow-scripts allow-forms allow-popups allow-modals",
        style: "flex:1;width:100%;min-height:0;border:0;background:#fff" });
      view.replaceChildren(frame);
      tabLink.href = relayUrl; tabLink.hidden = false;
    }));
    send({ type: "preview.open", port: win.port });
    hint = setTimeout(() => { if (!frame) wait.textContent = `Le port ${win.port} n'écoute pas (arrêté ?). Fermez la fenêtre et rouvrez-la quand le serveur tourne.`; }, 6000);
  } else {
    view.append(el("p", { class: "pilot-empty", style: "padding:10px 14px" }, "Cette adresse n'est pas un port de la machine : passez en mode Chrome."));
  }
  return { destroy() { clearTimeout(hint); for (const off of offs) off(); offs.length = 0; pane?.destroy(); pane = null; frame = null; } };
}
