// Point d'entrée : coque, routeur par ancre, chargement automatique des vues (js/views/) et extensions (js/ext/).
import { initTheme } from "./core/theme.js";
import { connect, send, on, onConnection } from "./core/socket.js";
import { getState, subscribe, setStateExtra } from "./core/state.js";
import { initDrawer, openDrawer, openAgentDrawer, closeDrawer } from "./core/drawer.js";
import { initTopbar } from "./core/topbar.js";
import { initRail } from "./core/rail.js";
import { openLauncher, showLauncherError } from "./core/launcher.js";
import { pruneTerminals } from "./core/terminals.js";
import { toast } from "./core/toast.js";
import { confirmDialog, promptDialog } from "./core/confirm.js";
import { el, escapeHtml, icons, iconEl, led, folderName } from "./core/util.js";
import * as deskstore from "./core/deskstore.js";
import { registerView, getView, getViews } from "./views/registry.js";

initTheme();

const viewRoot = document.getElementById("view");
let current = null;
let topbar;
let rail;

// Contexte donné à chaque vue et à chaque extension.
const ctx = {
  get state() {
    return getState();
  },
  send,
  on,
  onConnection,
  onState: (fn) => subscribe(fn),
  setStateExtra,
  toast,
  confirm: confirmDialog,
  prompt: promptDialog,
  navigate: (id) => {
    location.hash = `#${id}`;
  },
  drawer: { open: openDrawer, openAgent: openAgentDrawer, close: closeDrawer },
  launcher: { open: openLauncher },
  desk: {
    openAgent: (host, agentId, opts) => deskstore.openAgentWindow(host, agentId, opts),
    openTerminal: (host, terminalId, opts) => deskstore.openTerminalWindow(host, terminalId, opts),
    openTerminalInFolder: (opts) => deskstore.openTerminalInFolder(opts),
  },
  registerView,
  topbar: { addAction: (action) => topbar.addAction(action) },
  rail: { addSection: (section) => rail.addSection(section) },
  util: { el, escapeHtml, icons, iconEl, led, folderName },
};

// ---------- Routeur ----------
function route() {
  // Téléphone : sans ancre, on arrive sur l'accueil Téléphone plutôt que sur le Bureau à fenêtres flottantes.
  if (!location.hash && window.matchMedia("(max-width: 720px)").matches && getView("mobile")) history.replaceState(null, "", "#mobile");
  const id = decodeURIComponent(location.hash.slice(1));
  const target = getView(id) || getView("bureau") || getViews()[0];
  if (!target) return;
  if (!getView(id) && id) history.replaceState(null, "", `#${target.id}`);
  if (current?.id === target.id) return;
  try {
    current?.unmount();
  } catch (error) {
    console.error("unmount", current?.id, error);
  }
  viewRoot.replaceChildren();
  current = target;
  viewRoot.setAttribute("aria-labelledby", `tab-${target.id}`);
  document.title = `${target.title} · Poste de commande Paseo`;
  topbar?.setActive(target.id);
  try {
    target.mount(viewRoot, ctx);
  } catch (error) {
    console.error("mount", target.id, error);
    viewRoot.replaceChildren(el("div", { class: "empty-state" },
      el("h2", {}, "Cette vue ne s’est pas chargée"),
      el("p", {}, "Rechargez la page ; si le problème persiste, consultez la console du navigateur."),
    ));
  }
  document.body.classList.remove("rail-open");
}
window.addEventListener("hashchange", route);

// ---------- Chargement automatique ----------
async function loadFolder(folder) {
  let names = [];
  try {
    const response = await fetch(`js/${folder}/index.json`, { cache: "no-store" });
    names = response.ok ? await response.json() : [];
  } catch {
    names = [];
  }
  for (const name of names) {
    try {
      const mod = await import(`./${folder}/${name}`);
      if (folder === "ext" && typeof mod.default === "function") await mod.default(ctx);
    } catch (error) {
      console.error(`${folder}/${name}`, error);
      toast(`Le module ${folder}/${name} n’a pas pu être chargé.`, { kind: "error" });
    }
  }
}

// ---------- Messages du serveur ----------
on("error", (msg) => {
  showLauncherError(msg.message);
  toast(msg.message, { kind: "error" });
});
subscribe((state) => pruneTerminals(state));

// ---------- Démarrage ----------
initDrawer(document.getElementById("drawer"));
topbar = initTopbar(document.getElementById("topbar"));
rail = initRail(document.getElementById("rail"));
connect();
await loadFolder("views");
route();
await loadFolder("ext");
