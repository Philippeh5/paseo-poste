// Navigateur de dossiers côté serveur (pas de boîte de dialogue système) : machine, racines, fil d'Ariane cliquable,
// sous-dossiers, création de dossier. S'appuie sur les messages fs.roots / fs.list / fs.mkdir.
import { el } from "../core/util.js";
import { send, on } from "../core/socket.js";
import { getState, defaultHost } from "../core/state.js";
import { hostLabel } from "../core/names.js";

const svg = (parts) =>
  '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts}</svg>`;
export const FOLDER_ICON = svg('<path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.8 2h7.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>');
const UP_ICON = svg('<path d="M10 16V5M5.5 9.5L10 5l4.5 4.5"/>');

let sequence = 0;
// Envoie un message et attend la réponse portant la même référence. Ne rejette jamais : { ok:false, error } en cas d'échec.
export function rpc(type, body = {}, responseType = type, timeout = 25000) {
  const ref = `rpc-${Date.now().toString(36)}-${++sequence}`;
  return new Promise((resolve) => {
    let timer = null;
    const off = on(responseType, (message) => {
      if (message.ref !== ref) return;
      clearTimeout(timer);
      off();
      resolve(message);
    });
    timer = setTimeout(() => {
      off();
      resolve({ ok: false, code: "timeout", error: "La machine ne répond pas." });
    }, timeout);
    if (!send({ type, ref, ...body })) {
      clearTimeout(timer);
      off();
      resolve({ ok: false, code: "offline", error: "Connexion au serveur indisponible." });
    }
  });
}

// Segments cliquables d'un chemin absolu : [{ label, path }].
export function breadcrumbs(path, flavor) {
  if (!path) return [];
  const win = flavor === "win32";
  const parts = path.split(win ? /[\\/]+/ : /\/+/).filter(Boolean);
  const out = [];
  if (win) {
    const drive = parts.shift();
    out.push({ label: drive, path: `${drive}\\` });
    let current = `${drive}\\`;
    for (const part of parts) {
      current = current.endsWith("\\") ? current + part : `${current}\\${part}`;
      out.push({ label: part, path: current });
    }
  } else {
    out.push({ label: "/", path: "/" });
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      out.push({ label: part, path: current });
    }
  }
  return out;
}

const joinFlavor = (flavor, base, name) =>
  flavor === "win32" ? `${base.replace(/[\\/]+$/, "")}\\${name}` : `${base.replace(/\/+$/, "")}/${name}`;

// openFolderPicker({ host, path, title, actionLabel, onChoose(host, path) -> Promise<{ok,error}|void> })
export function openFolderPicker({ host = defaultHost(), path = null, title = "Ajouter un projet", actionLabel = "Suivre ce dossier", onChoose } = {}) {
  const previous = document.activeElement;
  const dialog = el("dialog", { class: "dialog fp-dialog", "aria-label": title });
  const view = { host, path: null, parent: null, flavor: "win32", entries: [], roots: [], recents: [], isGit: false, isProject: false };
  let showHidden = false;
  let busy = false;

  const hostSelect = el("select", { "aria-label": "Machine" });
  const rootsBar = el("div", { class: "fp-roots", role: "group", "aria-label": "Emplacements" });
  const crumbs = el("nav", { class: "fp-crumbs", "aria-label": "Fil d’Ariane" });
  const pathInput = el("input", { type: "text", class: "mono", autocomplete: "off", spellcheck: "false", "aria-label": "Chemin du dossier" });
  const list = el("ul", { class: "fp-list", "aria-label": "Sous-dossiers" });
  const error = el("p", { class: "form-error", role: "alert" });
  const info = el("p", { class: "fp-info muted" });
  const hiddenBox = el("input", { type: "checkbox" });
  const newName = el("input", { type: "text", autocomplete: "off", maxlength: 100, "aria-label": "Nom du nouveau dossier", placeholder: "Nom du nouveau dossier" });
  const newRow = el("form", { class: "fp-new", hidden: true }, newName,
    el("button", { class: "btn btn-sm btn-primary", type: "submit" }, "Créer"),
    el("button", { class: "btn btn-sm", type: "button", onclick: () => toggleNew(false) }, "Annuler"));
  const newButton = el("button", { class: "btn", type: "button", onclick: () => toggleNew(true) }, "Créer un dossier");
  const choose = el("button", { class: "btn btn-primary", type: "button" }, actionLabel);
  choose.disabled = true;

  const close = () => dialog.close();

  function toggleNew(open) {
    newRow.hidden = !open;
    newButton.hidden = open;
    if (open) {
      newName.value = "";
      newName.focus();
    }
  }

  function renderHosts() {
    const hosts = (getState().hosts || []).filter((h) => h.status === "connected");
    hostSelect.replaceChildren(...hosts.map((h) => el("option", { value: h.label }, hostLabel(h))));
    if (hosts.some((h) => h.label === view.host)) hostSelect.value = view.host;
  }

  function renderRoots() {
    const items = [
      ...view.roots.map((r) => ({ label: r.kind === "projects" ? "Projets" : r.label, path: r.path, title: r.path })),
      ...view.recents.map((r) => ({ label: `Récent · ${r.name}`, path: r.path, title: r.path })),
    ];
    rootsBar.replaceChildren(...items.map((item) =>
      el("button", { class: "chip", type: "button", title: item.title, onclick: () => go(item.path) }, item.label)));
  }

  function renderCrumbs() {
    const segments = breadcrumbs(view.path, view.flavor);
    crumbs.replaceChildren(el("ol", {}, segments.map((segment, index) =>
      el("li", {}, el("button", {
        class: "crumb", type: "button", title: segment.path,
        "aria-current": index === segments.length - 1 ? "location" : null,
        onclick: () => go(segment.path),
      }, segment.label)))));
  }

  function renderList() {
    const rows = [];
    if (view.parent) {
      rows.push(el("li", {}, el("button", { class: "fp-item", type: "button", onclick: () => go(view.parent) },
        iconSpan(UP_ICON), el("span", { class: "fp-name" }, "Dossier parent"))));
    }
    for (const entry of view.entries) {
      rows.push(el("li", {}, el("button", { class: "fp-item", type: "button", title: entry.path, onclick: () => go(entry.path) },
        iconSpan(FOLDER_ICON), el("span", { class: "fp-name" }, entry.name),
        entry.git ? el("span", { class: "tag tag-git" }, "git") : entry.project ? el("span", { class: "tag" }, "projet") : null)));
    }
    if (!view.entries.length) rows.push(el("li", { class: "fp-empty muted" }, "Aucun sous-dossier."));
    list.replaceChildren(...rows);
    const here = view.isGit ? "Ce dossier est un dépôt git." : view.isProject ? "Ce dossier ressemble à un projet." : "";
    info.textContent = [here, view.truncated ? "Liste tronquée (trop de dossiers)." : ""].filter(Boolean).join(" ");
  }

  const iconSpan = (markup) => {
    const span = el("span", { class: "fp-icon" });
    span.innerHTML = markup;
    return span;
  };

  async function go(target) {
    if (busy) return;
    busy = true;
    dialog.setAttribute("aria-busy", "true");
    error.textContent = "";
    const result = await rpc("fs.list", { host: view.host, path: target, showHidden });
    busy = false;
    dialog.removeAttribute("aria-busy");
    if (!result.ok) {
      error.textContent = result.error || "Lecture impossible.";
      return;
    }
    Object.assign(view, {
      path: result.path, parent: result.parent, flavor: result.flavor, entries: result.entries,
      isGit: result.isGit, isProject: result.isProject, truncated: result.truncated,
    });
    pathInput.value = result.path;
    choose.disabled = false;
    renderCrumbs();
    renderList();
    list.scrollTop = 0;
  }

  async function loadHost(label, preferred = null) {
    view.host = label;
    view.path = null;
    choose.disabled = true;
    list.replaceChildren(el("li", { class: "fp-empty muted" }, "Chargement…"));
    crumbs.replaceChildren();
    error.textContent = "";
    const roots = await rpc("fs.roots", { host: label });
    if (!roots.ok) {
      list.replaceChildren(el("li", { class: "fp-empty muted" }, "Machine indisponible."));
      error.textContent = roots.error || "Impossible de lire les emplacements de cette machine.";
      return;
    }
    Object.assign(view, { roots: roots.roots, recents: roots.recents || [], flavor: roots.platform });
    renderRoots();
    const start = preferred
      || roots.roots.find((r) => r.kind === "projects")?.path
      || roots.roots.find((r) => r.kind === "home")?.path
      || roots.roots[0]?.path;
    if (start) await go(start);
  }

  hostSelect.addEventListener("change", () => loadHost(hostSelect.value));
  hiddenBox.addEventListener("change", () => {
    showHidden = hiddenBox.checked;
    if (view.path) go(view.path);
  });
  const pathForm = el("form", { class: "fp-path" }, pathInput, el("button", { class: "btn btn-sm", type: "submit" }, "Aller"));
  pathForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pathInput.value.trim()) go(pathInput.value.trim());
  });
  newRow.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = newName.value.trim();
    if (!name || !view.path) return;
    error.textContent = "";
    const result = await rpc("fs.mkdir", { host: view.host, path: joinFlavor(view.flavor, view.path, name) });
    if (!result.ok) {
      error.textContent = result.error;
      return;
    }
    toggleNew(false);
    await go(result.path);
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...list.querySelectorAll(".fp-item")];
    const index = items.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))].focus();
  });
  choose.addEventListener("click", async () => {
    if (!view.path || !onChoose) return;
    choose.disabled = true;
    const result = await onChoose(view.host, view.path);
    choose.disabled = false;
    if (result && result.ok === false) {
      error.textContent = result.error || "Action impossible.";
      return;
    }
    close();
  });

  dialog.append(
    el("div", { class: "dialog-body fp-body" },
      el("header", { class: "dialog-head" }, el("h2", {}, title),
        el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: close }, "×")),
      el("div", { class: "fp-top" }, el("label", { class: "fp-host" }, el("span", { class: "label-caps" }, "Machine"), hostSelect), rootsBar),
      crumbs,
      pathForm,
      list,
      info,
      el("label", { class: "check" }, hiddenBox, " Afficher les dossiers cachés"),
      error,
      newRow,
    ),
    el("footer", { class: "dialog-foot fp-foot" }, newButton, el("button", { class: "btn", type: "button", onclick: close }, "Annuler"), choose),
  );
  dialog.addEventListener("close", () => {
    dialog.remove();
    previous?.focus?.();
  });
  document.body.append(dialog);
  renderHosts();
  dialog.showModal();
  loadHost(view.host, path);
  return { close };
}
