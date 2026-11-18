// Barre de widgets : boutons lanceurs rapides au-dessus de la surface du Bureau.
// Montée par views/desk.js avec le plus petit changement possible. Jamais prompt/confirm/alert.
import { el, icons, iconEl } from "../core/util.js";
import { send, on, onConnection } from "../core/socket.js";
import { getState, allProjects, findHost } from "../core/state.js";
import { toast } from "../core/toast.js";
import { confirmDialog } from "../core/confirm.js";
import { getWindows, noteLaunchTool } from "../core/deskstore.js";
import { hostLabel, toolFromCommand } from "../core/names.js";
import { getSelectedProject } from "../core/selection.js";

const VIEWS = [
  ["bureau", "Bureau"], ["taches", "Tâches"], ["sessions", "Sessions"], ["chronologie", "Chronologie"],
  ["machines", "Machines"], ["reception", "Boîte de réception"],
];
const ICON_NAMES = ["terminal", "agent", "desk", "tasks", "sessions", "timeline", "machines", "inbox", "plus", "send",
  "grid", "group", "save", "menu"];
const ACTION_TYPES = [
  ["terminal", "Terminal"], ["agent", "Agent IA"], ["freebuff", "FreeBuff"], ["view", "Vue"],
  ["url", "Lien web (https)"],
];

// ---------- État local ----------
let widgets = [];
const listeners = new Set();
const sorted = (list) => list.slice().sort((a, b) => a.order - b.order);

function emit() { for (const fn of listeners) fn(widgets); }
export function subscribeWidgets(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const getWidgets = () => widgets;

on("widgets.list", (msg) => { widgets = sorted(msg.all || msg.widgets || []); emit(); });
on("widgets.changed", (msg) => { widgets = sorted(msg.all || msg.widgets || []); emit(); });
onConnection((connected) => { if (connected) send({ type: "widgets.list" }); });

// ---------- Lancement d'une action ----------
// Commande à saisir dans le terminal une fois lancé (réponse launch.started portant notre ref).
const pendingCommands = new Map();
on("launch.started", (msg) => {
  const command = pendingCommands.get(msg.ref);
  if (command === undefined) return;
  pendingCommands.delete(msg.ref);
  if (command && msg.terminalId) {
    // Laisse au shell le temps de démarrer ; la saisie est de toute façon mise en file par le terminal.
    const input = { type: "term.input", host: msg.host, terminalId: msg.terminalId, data: `${command}\r` };
    setTimeout(() => send(input), 700);
  }
});

// Dossier qui contient tous les projets, par machine (quand aucun projet n'est sélectionné).
const PROJECT_ROOTS = { oracle: "/home/USERNAME/Projets", local: "D:\\Projets" };

// Machines réellement configurées : sert de valeur par défaut aux nouveaux widgets (avant, « local » était
// codé en dur et l'enregistrement échouait avec « hôte inconnu : local » quand cette machine n'existait plus).
const knownHostLabels = () => (getState().hosts || []).map((h) => h.label).filter(Boolean);
const defaultHostLabel = () => knownHostLabels()[0] || "local";

const quote = (arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

// Dossier de travail : celui du widget, sinon celui de la fenêtre au premier plan sur cette machine,
// sinon le premier projet connu de la machine.
function pickCwd(host, action) {
  // Le projet sélectionné dans le rail passe avant tout (s'il est sur la même machine).
  const sel = getSelectedProject();
  if (sel && sel.host === host && sel.directory) return sel.directory;
  if (action.cwd) return action.cwd;
  if (PROJECT_ROOTS[host]) return PROJECT_ROOTS[host];   // sans projet sélectionné : le dossier des projets
  const top = getWindows().filter((w) => w.host === host && w.cwd && !w.minimized)
    .sort((a, b) => (b.z || 0) - (a.z || 0))[0];
  if (top) return top.cwd;
  return allProjects(getState()).find((p) => p.host === host)?.directory || "";
}

// "fournisseur/modèle" tel quel ; "fournisseur" seul → modèle par défaut annoncé par la machine.
function resolveProvider(host, provider) {
  const slash = provider.indexOf("/");
  if (slash > 0) return Promise.resolve({ provider: provider.slice(0, slash), model: provider.slice(slash + 1) });
  return new Promise((resolve) => {
    const finish = (model) => { off(); clearTimeout(timer); resolve({ provider, model }); };
    const off = on("launch.options", (msg) => {
      if (msg.host !== host) return;
      const models = msg.providers?.find((p) => p.id === provider)?.models || [];
      finish((models.find((m) => m.isDefault) || models[0])?.id || null);
    });
    const timer = setTimeout(() => finish(null), 15000);
    send({ type: "launch.options", host });
  });
}

async function launchAction(action) {
  if (!action) return;
  const { type } = action;
  const host = action.host || "oracle";
  if (type === "url") {
    if (/^https:\/\//i.test(action.url)) window.open(action.url, "_blank", "noopener,noreferrer");
    else toast("Lien refusé : https seulement.", { kind: "error" });
    return;
  }
  if (type === "view") {
    location.hash = `#${action.view}`;
    return;
  }
  const hostInfo = findHost(getState(), host);
  if (!hostInfo || hostInfo.status !== "connected") {
    toast(`La machine « ${hostLabel(host)} » n’est pas connectée.`, { kind: "error" });
    return;
  }
  const cwd = pickCwd(host, action);
  if (!cwd) {
    toast(`Aucun dossier connu sur « ${hostLabel(host)} » : indiquez-en un dans le widget.`, { kind: "error" });
    return;
  }
  const ref = `widget:${Date.now().toString(36)}`;
  if (type === "terminal" || type === "freebuff") {
    const parts = type === "freebuff" ? ["freebuff"] : [action.command, ...(action.args || []).map(quote)];
    const command = parts.filter(Boolean).join(" ");
    if (command) pendingCommands.set(ref, command);
    // Le titre de la fenêtre dira l'outil (« FreeBuff · projet · Mini PC »), pas « terminal 5 ».
    noteLaunchTool(ref, toolFromCommand(command));
    // La fenêtre est ouverte par deskstore à la réponse launch.started (même chemin que le rail).
    send({ type: "launch.start", host, cwd, kind: "terminal", ref, tool: toolFromCommand(command).toLowerCase() });
    return;
  }
  if (type === "agent") {
    // « auto » ou « auto/lecture » : le serveur choisit selon le classement des modèles (writer, reader ou planner après la barre oblique).
    const auto = action.provider === "auto" || String(action.provider).startsWith("auto/");
    const { provider, model } = auto ? { provider: "auto", model: String(action.provider).split("/")[1] || "auto" }
      : await resolveProvider(host, action.provider);
    if (!model) {
      toast(`Aucun modèle disponible pour « ${provider} » sur « ${host} ».`, { kind: "error" });
      return;
    }
    const mode = action.mode ? { mode: action.mode } : {};
    const prompt = action.prompt ? { prompt: action.prompt } : {};
    send({ type: "launch.start", host, cwd, kind: "agent", provider, model, ref, ...mode, ...prompt });
    return;
  }
  toast(`Type d’action inconnu : ${type}`, { kind: "error" });
}

// ---------- Rendu de la barre ----------
const iconByName = (name) => icons[name] || icons.terminal;
let barEl = null;

function updateOverflow() {
  barEl?.classList.toggle("has-overflow", barEl.scrollWidth > barEl.clientWidth);
}

function renderBar() {
  if (!barEl) return;
  const buttons = sorted(widgets).filter((w) => !w.hidden).map(makeButton);
  const editBtn = el("button", {
    class: "widget-bar-edit-btn", type: "button", title: "Modifier la barre de widgets",
    "aria-label": "Modifier la barre de widgets", onclick: openEditor,
  });
  editBtn.innerHTML = icons.menu;
  barEl.replaceChildren(...buttons, editBtn, el("div", { class: "widget-bar-fade-right", "aria-hidden": "true" }));
  updateOverflow();
}

function makeButton(w) {
  const btn = el("button", {
    class: "widget-btn", type: "button", title: `${w.label} (${w.action?.type || "?"})`, draggable: "true",
    dataset: { widgetId: w.id }, onclick: () => launchAction(w.action),
  });
  btn.append(iconEl(iconByName(w.icon)), document.createTextNode(w.label));
  // Glisser-déposer pour réordonner dans la barre.
  btn.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(w.id));
    btn.classList.add("is-dragging-source");
  });
  btn.addEventListener("dragend", () => btn.classList.remove("is-dragging-source"));
  btn.addEventListener("dragover", (e) => { e.preventDefault(); btn.classList.add("is-drag-over"); });
  btn.addEventListener("dragleave", () => btn.classList.remove("is-drag-over"));
  btn.addEventListener("drop", (e) => {
    e.preventDefault();
    btn.classList.remove("is-drag-over");
    const fromId = e.dataTransfer.getData("text/plain");
    if (fromId && fromId !== w.id) reorderWidgets(fromId, w.id);
  });
  // Clavier : Alt + flèches déplace le widget focalisé.
  btn.addEventListener("keydown", (e) => {
    if (!e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const visible = sorted(widgets).filter((x) => !x.hidden);
    const i = visible.findIndex((x) => x.id === w.id);
    const target = visible[i + (e.key === "ArrowLeft" ? -1 : 1)];
    if (target) reorderWidgets(w.id, target.id, w.id);
  });
  return btn;
}

function reorderWidgets(fromId, toId, refocusId = null) {
  const list = sorted(widgets);
  const fromIdx = list.findIndex((w) => w.id === fromId);
  const toIdx = list.findIndex((w) => w.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;
  list.splice(toIdx, 0, list.splice(fromIdx, 1)[0]);
  send({ type: "widgets.save", widgets: list.map((w, i) => ({ ...w, order: (i + 1) * 10 })) });
  if (refocusId) setTimeout(() => barEl?.querySelector(`[data-widget-id="${refocusId}"]`)?.focus(), 250);
}

// ---------- Éditeur de la barre ----------
let editorWidgets = []; // copie locale pendant l'édition

function openEditor() {
  editorWidgets = sorted(widgets).map((w) => ({ ...w, action: { ...w.action } }));
  const dialog = el("dialog", { class: "widget-editor", "aria-label": "Modifier la barre de widgets" });
  const listEl = el("ul", { class: "widget-list", role: "list" });
  const formBox = el("div", {});
  const rebuild = () => listEl.replaceChildren(...editorWidgets.map((w) => editorRow(w, rebuild, formBox)));
  rebuild();

  const addBtn = el("button", { class: "btn btn-sm btn-add", type: "button", onclick: () => {
    const w = { id: `w-${Date.now().toString(36)}`, label: "Nouveau widget", icon: "terminal",
      order: (editorWidgets.length + 1) * 10, hidden: false, action: { type: "terminal", host: defaultHostLabel() } };
    editorWidgets.push(w);
    rebuild();
    widgetForm(w, formBox, rebuild);
  } }, "Ajouter un widget");
  addBtn.prepend(iconEl(icons.plus));
  const resetBtn = el("button", { class: "btn btn-sm", type: "button", onclick: async () => {
    const ok = await confirmDialog({
      title: "Rétablir les widgets par défaut ?",
      message: "Votre configuration actuelle de la barre est remplacée par la liste d’origine.",
      confirmLabel: "Rétablir",
    });
    if (ok) {
      send({ type: "widgets.reset" });
      dialog.close();
    }
  } }, "Rétablir par défaut");
  const closeBtn = el("button", {
    class: "btn btn-sm", type: "button", "aria-label": "Fermer", onclick: () => dialog.close(),
  });
  closeBtn.innerHTML = icons.close;

  dialog.append(
    el("div", { class: "widget-editor-head" }, el("h2", {}, "Modifier la barre de widgets"), closeBtn),
    el("div", { class: "widget-editor-body" }, listEl, formBox),
    el("div", { class: "widget-editor-foot" }, addBtn, resetBtn,
      el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Annuler"),
      el("button", { class: "btn btn-primary", type: "button", onclick: () => {
        send({ type: "widgets.save", widgets: editorWidgets.map((w, i) => ({ ...w, order: (i + 1) * 10 })) });
        dialog.close();
      } }, "Enregistrer")),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function moveInEditor(fromId, toId, rebuild) {
  const from = editorWidgets.findIndex((x) => x.id === fromId);
  const to = editorWidgets.findIndex((x) => x.id === toId);
  if (from < 0 || to < 0 || from === to) return false;
  editorWidgets.splice(to, 0, editorWidgets.splice(from, 1)[0]);
  rebuild();
  return true;
}

function editorRow(w, rebuild, formBox) {
  const row = el("li", { class: `widget-item${w.hidden ? " is-hidden" : ""}`, draggable: "true" });
  const handle = el("span", { class: "widget-item-handle", title: "Glisser, ou flèches haut/bas, pour réordonner",
    tabindex: "0", role: "button", "aria-label": `Déplacer ${w.label}` });
  handle.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" aria-hidden="true"><path d="M7 5h1M7 10h1M7 15h1M12 5h1M12 10h1M12 15h1"/></svg>';
  const iconSpan = el("span", { class: "widget-item-icon" });
  iconSpan.innerHTML = iconByName(w.icon);

  const toggle = el("button", { class: "btn btn-sm", type: "button", "aria-pressed": String(w.hidden),
    onclick: () => { w.hidden = !w.hidden; rebuild(); } }, w.hidden ? "Afficher" : "Masquer");
  const edit = el("button", { class: "btn btn-sm", type: "button", "aria-label": `Modifier ${w.label}`,
    onclick: () => widgetForm(w, formBox, rebuild) }, "Modifier");
  const del = el("button", { class: "btn btn-sm btn-danger-ghost", type: "button", title: "Supprimer",
    "aria-label": `Supprimer ${w.label}`, onclick: async () => {
      const ok = await confirmDialog({
        title: `Supprimer « ${w.label} » ?`, message: "Ce widget sera retiré de la barre.",
        confirmLabel: "Supprimer", danger: true,
      });
      if (ok) {
        editorWidgets = editorWidgets.filter((x) => x.id !== w.id);
        formBox.replaceChildren();
        rebuild();
      }
    } });
  del.innerHTML = icons.trash;

  row.append(handle, iconSpan, el("span", { class: "widget-item-label" }, w.label),
    el("span", { class: "widget-item-type" }, w.action?.type || "?"),
    el("div", { class: "widget-item-actions" }, toggle, edit, del));

  row.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", w.id);
    row.classList.add("is-dragging");
  });
  row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
  row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("is-drag-over"); });
  row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("is-drag-over");
    moveInEditor(e.dataTransfer.getData("text/plain"), w.id, rebuild);
  });
  handle.addEventListener("keydown", (e) => {
    const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = editorWidgets.findIndex((x) => x.id === w.id);
    const target = editorWidgets[i + step];
    if (target && moveInEditor(w.id, target.id, rebuild)) {
      setTimeout(() => document.querySelectorAll(".widget-item-handle")[i + step]?.focus(), 0);
    }
  });
  return row;
}

// Formulaire d'édition : travaille sur un brouillon, appliqué seulement par « Valider ».
function widgetForm(w, formBox, rebuild) {
  const draft = { label: w.label, icon: w.icon || "terminal", action: { ...w.action } };
  const field = (text, control) => el("label", { class: "widget-form-row" }, text, control);
  const input = (props) => el("input", { type: "text", autocomplete: "off", ...props });
  const labelInput = input({ value: draft.label, maxlength: "80" });
  const iconSelect = el("select", {}, ...ICON_NAMES.map((n) =>
    el("option", { value: n, selected: n === draft.icon }, n)));
  const typeSelect = el("select", {}, ...ACTION_TYPES.map(([v, t]) =>
    el("option", { value: v, selected: v === draft.action.type }, t)));
  const dyn = el("div", { class: "widget-form-dyn" });

  const hostNames = () => {
    const names = knownHostLabels();
    return names.length ? names : ["local"];
  };
  function renderDyn() {
    const a = draft.action;
    dyn.replaceChildren();
    if (a.type === "url") {
      const url = input({ value: a.url || "https://", maxlength: "2000", placeholder: "https://…" });
      url.addEventListener("input", () => { a.url = url.value.trim(); });
      dyn.append(field("Adresse (https seulement)", url));
    } else if (a.type === "view") {
      a.view = a.view || VIEWS[0][0];
      const sel = el("select", {}, ...VIEWS.map(([v, t]) => el("option", { value: v, selected: v === a.view }, t)));
      sel.addEventListener("change", () => { a.view = sel.value; });
      dyn.append(field("Vue", sel));
    } else {
      const names = hostNames();
      a.host = a.host || names[0];
      // Garde l'hôte mémorisé visible même s'il n'est plus configuré : sinon la liste affichait « Oracle »
      // alors que la valeur enregistrée restait « local », et l'enregistrement échouait sans que ça se voie.
      const configured = knownHostLabels();
      const options = names.includes(a.host) ? names : [a.host, ...names];
      const host = el("select", {}, ...options.map((n) => el("option", { value: n, selected: n === a.host },
        configured.includes(n) ? hostLabel(n) : `${hostLabel(n)} (indisponible)`)));
      host.addEventListener("change", () => { a.host = host.value; });
      const cwd = input({ value: a.cwd || "", maxlength: "1000", placeholder: "Dossier (sinon : fenêtre active)" });
      cwd.addEventListener("input", () => { a.cwd = cwd.value.trim() || undefined; });
      dyn.append(el("div", { class: "widget-form-cols" }, field("Machine", host), field("Dossier", cwd)));
      if (a.type === "terminal") {
        const cmd = input({ value: a.command || "", maxlength: "500", placeholder: "Commande saisie au lancement" });
        cmd.addEventListener("input", () => { a.command = cmd.value || undefined; });
        dyn.append(field("Commande (optionnelle, une seule ligne)", cmd));
      } else if (a.type === "agent") {
        const prov = input({ value: a.provider || "claude-openrouter/sonnet", maxlength: "200" });
        prov.addEventListener("input", () => { a.provider = prov.value.trim(); });
        const prompt = input({ value: a.prompt || "", maxlength: "2000", placeholder: "Invite (optionnelle)" });
        prompt.addEventListener("input", () => { a.prompt = prompt.value || undefined; });
        dyn.append(field("Fournisseur/modèle", prov), field("Invite", prompt));
      }
    }
  }
  renderDyn();
  typeSelect.addEventListener("change", () => {
    draft.action = { type: typeSelect.value };
    renderDyn();
  });

  const apply = () => {
    w.label = labelInput.value.trim() || "Widget";
    w.icon = iconSelect.value;
    w.action = draft.action;
    formBox.replaceChildren();
    rebuild();
  };
  formBox.replaceChildren(el("div", { class: "widget-form" },
    el("div", { class: "widget-form-cols" }, field("Libellé", labelInput), field("Icône", iconSelect)),
    field("Type d’action", typeSelect),
    dyn,
    el("div", { class: "widget-form-foot" },
      el("button", { class: "btn btn-sm", type: "button", onclick: () => formBox.replaceChildren() }, "Annuler"),
      el("button", { class: "btn btn-primary btn-sm", type: "button", onclick: apply }, "Valider")),
  ));
  labelInput.focus();
}

// ---------- Montage / démontage ----------
export function mountWidgetBar(container) {
  barEl = el("div", { class: "widget-bar", role: "toolbar", "aria-label": "Lanceurs rapides" });
  const surface = container.querySelector(".desk-surface");
  if (surface) surface.before(barEl);
  else container.append(barEl);
  const unsubscribe = subscribeWidgets(renderBar);
  barEl.addEventListener("scroll", updateOverflow);
  window.addEventListener("resize", updateOverflow);
  renderBar();
  return () => {
    unsubscribe();
    window.removeEventListener("resize", updateOverflow);
    barEl?.remove();
    barEl = null;
  };
}
