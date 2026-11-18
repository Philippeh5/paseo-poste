// Vue « Aperçu » : ouvrir dans le poste une page servie par un port de la machine (serveur de dev, outil local…) sans se
// connecter ailleurs. Relais en lecture : handlers/preview.mjs. Le cadre est isolé (sandbox sans allow-same-origin) : la page
// aperçue ne peut ni lire le stockage du poste ni appeler son API. Textes via el() : aucun innerHTML dynamique.
import { registerView } from "./registry.js";
import { el } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { toast } from "../core/toast.js";

const ICON = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M2.5 8h15"/></svg>';
let root; let offs = []; let st = null; let current = null; let manual = "";

function render() {
  if (!root) return;
  const host = root.firstChild;
  const open = (port) => { current = { port, path: "" }; render(); };
  const url = current ? `/preview/${current.port}/${current.path}` : null;
  const list = st ? st.ports : [];
  host.replaceChildren(
    el("header", { class: "pilot-head" }, el("h1", {}, "Aperçu"),
      el("span", { class: "pilot-summary" }, "Pages servies par cette machine, affichées dans le poste (lecture seule, sans WebSocket)."),
      el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "preview.ports" }) }, "Actualiser")),
    el("section", { class: "pilot-group" }, el("header", { class: "pilot-group-head" }, el("h2", {}, "Ports à l'écoute"),
      el("div", { class: "pilot-group-actions" },
        el("input", { class: "pilot-search", type: "number", min: 1024, max: 65535, placeholder: "Port…", value: manual, "aria-label": "Numéro de port", style: "max-width:110px", oninput: (e) => { manual = e.target.value; } }),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => { const p = Number(manual); if (p >= 1024 && p <= 65535) open(p); else toast("Port entre 1024 et 65535"); } }, "Ouvrir"))),
    el("ul", { class: "pilot-list" }, list.length ? list.map((p) => el("li", { class: "pilot-row", style: "grid-template-columns:70px 1fr auto" },
      el("strong", {}, String(p.port)), el("span", { class: "pilot-detail" }, `${p.process || "processus inconnu"} · ${p.loopbackOnly ? "local seulement" : `écoute sur ${p.addr}`}`),
      el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => open(p.port) }, "Afficher"))) : [el("li", { class: "pilot-row" }, el("span", { class: "pilot-detail" }, st ? "Aucun port à l'écoute." : "Détection…"))])),
    current ? el("section", { class: "pilot-group" }, el("header", { class: "pilot-group-head" }, el("h2", {}, `Port ${current.port}`),
      el("div", { class: "pilot-group-actions" },
        el("button", { class: "btn btn-sm", type: "button", onclick: () => { const f = root.querySelector("iframe"); if (f) f.src = url; } }, "Recharger"),
        el("a", { class: "btn btn-sm", href: url, target: "_blank", rel: "noopener" }, "Ouvrir dans un onglet"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => { current = null; render(); } }, "Fermer"))),
      el("iframe", { src: url, title: `Aperçu du port ${current.port}`, sandbox: "allow-scripts allow-forms allow-popups allow-modals",
        style: "width:100%;height:70vh;border:0;background:#fff" })) : null);
}

const view = {
  id: "apercu", title: "Aperçu", short: "Aperçu", icon: ICON, order: 18,
  mount(container) {
    root = container;
    root.replaceChildren(el("div", { class: "pilot" }));
    render();
    offs.push(on("preview.state", (m) => { st = m; render(); }));
    offs.push(onConnection((up) => { if (up) send({ type: "preview.ports" }); }));
    send({ type: "preview.ports" });
  },
  unmount() { for (const off of offs) off(); offs = []; root = null; },
};

registerView(view);
export default view;
