// Projets suivis (choisis par Philippe) : liste serveur, pastille GitHub, menu par projet, ajout par navigateur de dossiers,
// sélection rapide du premier lancement, création de dépôt GitHub et synchronisation (confirmation à deux temps).
// Le rail et le lanceur ne lisent que : followedProjects (dans l'état), visibleWorkspaces(), projectExtras(), projectMenuButton(),
// projectsToolbar(), projectsHint(), projectsSignature().
import { el, icons, iconEl, led, readPref, writePref } from "./util.js";
import { send, on, onConnection } from "./socket.js";
import { setStateExtra, sameDir, getState } from "./state.js";
import { toast } from "./toast.js";
import { openTerminalInFolder } from "./deskstore.js";
import { openFolderPicker, rpc, FOLDER_ICON } from "../components/folderPicker.js";
import { hostLabel } from "./names.js";

const PREF_SHOW_ALL = "paseo-show-all-projects";
const STATUS_EVERY_MS = 60000;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

// ---------- Feuille de style ----------
if (!document.querySelector("link[data-projects-css]")) {
  document.head.append(el("link", { rel: "stylesheet", href: "css/projects.css", "data-projects-css": "" }));
}

// ---------- État ----------
let tracked = [];
let firstRun = false;
let loaded = false;
let showAll = readPref(PREF_SHOW_ALL, "0") === "1";
let version = 0;
const statuses = new Map();
const listeners = new Set();

const trackedFor = (host, dir) => tracked.find((p) => p.host === host && sameDir(p.dir, dir)) || null;

function publish() {
  version += 1;
  const useFilter = loaded && !showAll && tracked.length > 0;
  setStateExtra("followedProjects", useFilter ? tracked.map((p) => ({ host: p.host, directory: p.dir, name: p.name })) : null);
  for (const fn of listeners) fn();
}

export const projectsSignature = () => `${version}`;
export const onProjectsChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const showAllProjects = () => showAll;
export function setShowAllProjects(value) {
  showAll = Boolean(value);
  writePref(PREF_SHOW_ALL, showAll ? "1" : "0");
  publish();
}
export const projectsHint = () =>
  showAll && tracked.length ? "Tous les projets sont affichés." : !tracked.length ? "Tous les projets (aucun choix fait)." : "";

// Pour le lanceur : ne garde que les projets suivis (et ajoute ceux qui n'ont pas encore d'espace de travail).
export function visibleWorkspaces(host, workspaces) {
  if (!loaded || showAll || !tracked.length) return workspaces;
  const wanted = tracked.filter((p) => p.host === host);
  const kept = workspaces.filter((w) => wanted.some((p) => sameDir(p.dir, w.directory)));
  const extra = wanted
    .filter((p) => !kept.some((w) => sameDir(p.dir, w.directory)))
    .map((p) => ({ workspaceId: null, name: p.name, directory: p.dir }));
  return [...kept, ...extra];
}

// ---------- Messages du serveur ----------
on("project.list", (message) => {
  tracked = message.projects || [];
  firstRun = message.firstRun === true;
  loaded = true;
  for (const id of [...statuses.keys()]) if (!tracked.some((p) => p.id === id)) statuses.delete(id);
  publish();
  refreshStatuses();
});
onConnection((connected) => {
  if (connected) send({ type: "project.list" });
});

let refreshing = false;
let retry = null;
async function refreshStatuses({ fresh = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    for (const project of [...tracked]) {
      const result = await rpc("project.status", { host: project.host, dir: project.dir, fresh });
      // Machine pas encore connectée au démarrage : on réessaie une fois peu après.
      if (!result.ok && result.code === "host_unavailable" && !retry) retry = setTimeout(() => { retry = null; refreshStatuses(); }, 5000);
      const next = result.ok ? { ...result, ref: null } : { ok: false, error: result.error };
      if (JSON.stringify(next) !== JSON.stringify(statuses.get(project.id) ?? null)) {
        statuses.set(project.id, next);
        publish();
      }
    }
  } finally {
    refreshing = false;
  }
}
setInterval(() => {
  if (!document.hidden && tracked.length) refreshStatuses();
}, STATUS_EVERY_MS);

// ---------- Menu contextuel ----------
let openMenuState = null;
function closeMenu({ focus = false } = {}) {
  if (!openMenuState) return;
  const { menu, anchor, dispose } = openMenuState;
  openMenuState = null;
  dispose();
  menu.remove();
  anchor.setAttribute("aria-expanded", "false");
  if (focus) anchor.focus();
}
function openMenu(anchor, items) {
  closeMenu();
  const menu = el("div", { class: "menu", role: "menu" }, items.map((item) =>
    item.separator
      ? el("hr", { role: "separator" })
      : el("button", {
        class: `menu-item${item.danger ? " is-danger" : ""}`, role: "menuitem", type: "button",
        disabled: item.disabled, title: item.hint, onclick: () => { closeMenu(); item.run(); },
      }, item.label)));
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  const below = rect.bottom + 4;
  menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below}px`;
  anchor.setAttribute("aria-expanded", "true");
  const buttons = () => [...menu.querySelectorAll(".menu-item:not(:disabled)")];
  const onKey = (event) => {
    const all = buttons();
    const index = all.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeMenu({ focus: true }); }
    else if (event.key === "ArrowDown") { event.preventDefault(); all[(index + 1) % all.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); all[(index - 1 + all.length) % all.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); all[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); all.at(-1)?.focus(); }
    else if (event.key === "Tab") closeMenu();
  };
  const onPointer = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu();
  };
  menu.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("resize", closeMenu);
  openMenuState = {
    menu, anchor,
    dispose: () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", closeMenu);
    },
  };
  buttons()[0]?.focus();
}

// ---------- Actions ----------
const asProject = (p) => ({ host: p.host, directory: p.directory ?? p.dir, name: p.name });

async function launchAgentHere(project) {
  const { openLauncher } = await import("./launcher.js");
  openLauncher({ host: project.host, cwd: project.directory, kind: "agent" });
}

async function follow(host, dir, extra = {}) {
  const result = await rpc("project.follow", { host, dir, ...extra }, "project.followed");
  if (!result.ok) return { ok: false, error: result.error };
  toast(result.added.length ? "Projet suivi." : "Ce projet était déjà suivi.");
  return { ok: true };
}

async function unfollow(tr) {
  const result = await rpc("project.unfollow", { id: tr.id }, "project.unfollowed");
  toast(result.ok ? `« ${tr.name} » n’est plus suivi.` : result.error, { kind: result.ok ? undefined : "error" });
}

export const isStarred = (project) => Boolean(trackedFor(project.host, project.directory)?.starred);
export async function toggleStar(project) {
  const tr = trackedFor(project.host, project.directory);
  if (!tr) { toast("Suis d'abord ce projet pour le mettre en favori.", { kind: "error" }); return; }
  const result = await rpc("project.update", { id: tr.id, starred: !tr.starred }, "project.updated");
  if (!result.ok) toast(result.error, { kind: "error" });
}

async function move(tr, delta) {
  const ids = tracked.map((p) => p.id);
  const from = ids.indexOf(tr.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const result = await rpc("project.reorder", { ids }, "project.reordered");
  if (!result.ok) toast(result.error, { kind: "error" });
}

function menuFor(project, anchor) {
  const tr = trackedFor(project.host, project.directory);
  const st = tr ? statuses.get(tr.id) : null;
  const index = tr ? tracked.indexOf(tr) : -1;
  openMenu(anchor, [
    { label: "Ouvrir un terminal ici", run: () => openTerminalInFolder({ host: project.host, cwd: project.directory, navigate: true }) },
    { label: "Lancer un agent ici", run: () => launchAgentHere(project) },
    { separator: true },
    {
      label: "Créer le dépôt GitHub", run: () => openGithubDialog(project, "create"),
      disabled: st?.github === "linked", hint: st?.github === "linked" ? "Un dépôt GitHub est déjà lié" : undefined,
    },
    {
      label: "Synchroniser", run: () => openGithubDialog(project, "sync"),
      disabled: st?.github === "unlinked", hint: st?.github === "unlinked" ? "Aucun dépôt GitHub lié : créez-le d’abord" : undefined,
    },
    { separator: true },
    ...(tr
      ? [
        { label: tr.starred ? "☆ Retirer des favoris" : "★ Mettre en favori", run: () => toggleStar(project) },
        { label: "Monter", run: () => move(tr, -1), disabled: index <= 0 },
        { label: "Descendre", run: () => move(tr, 1), disabled: index >= tracked.length - 1 },
        { label: "Ne plus suivre", danger: true, run: () => unfollow(tr) },
      ]
      : [{ label: "Suivre ce projet", run: async () => { const r = await follow(project.host, project.directory); if (!r.ok) toast(r.error, { kind: "error" }); } }]),
  ]);
}

// ---------- Éléments pour le rail ----------
export function projectMenuButton(project) {
  const button = el("button", {
    class: "icon-btn", type: "button", title: "Actions du projet", "aria-haspopup": "menu", "aria-expanded": "false",
    "aria-label": `Actions du projet ${project.name} (${hostLabel(project.host)})`,
  });
  button.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">' +
    '<circle cx="4.5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15.5" cy="10" r="1.5"/></svg>';
  button.addEventListener("click", () => (openMenuState?.anchor === button ? closeMenu() : menuFor(project, button)));
  return button;
}

const GH_LABELS = {
  linked: ["ok", "GitHub lié"],
  unlinked: ["inactif", "GitHub non lié"],
  disconnected: ["attention", "GitHub non connecté"],
  unknown: ["inactif", "GitHub inconnu"],
};
// Explications en langage simple (infobulle de la pastille).
const GH_HELP = {
  linked: "Ce dossier est relié à un dépôt GitHub : vos fichiers peuvent être sauvegardés en ligne.",
  unlinked: "Ce dossier n’est pas encore sur GitHub. Cliquez pour le créer en ligne (une confirmation vous sera demandée).",
  disconnected: "GitHub n’est pas connecté sur cette machine : il faut s’y identifier une fois (commande « gh auth login »).",
  unknown: "L’état de GitHub n’a pas pu être vérifié pour l’instant (panne passagère). Nouvelle tentative automatique.",
};
export function githubPill(status, onclick) {
  const [tone, label] = GH_LABELS[status?.ok ? status.github : "unknown"] || GH_LABELS.unknown;
  return el("button", {
    class: `gh-pill gh-${status?.ok ? status.github : "unknown"}`, type: "button", onclick,
    title: `${label}${status?.repo ? ` · ${status.repo}` : ""}. ${GH_HELP[status?.ok ? status.github : "unknown"] || GH_HELP.unknown}`,
  }, led(tone, { label }), el("span", {}, label.replace("GitHub ", "")));
}

// Ligne d'état sous le nom d'un projet suivi : pastille GitHub, branche, modifications, avance/retard.
export function projectExtras(project) {
  const tr = trackedFor(project.host, project.directory);
  if (!tr) return null;
  const st = statuses.get(tr.id);
  const action = st?.github === "linked" ? "sync" : "create";
  const bits = [];
  if (st?.ok && st.branch) bits.push(el("span", { class: "proj-branch mono", title: "Branche" }, st.branch));
  if (st?.ok && st.dirty) bits.push(el("span", { class: "proj-flag", title: "Fichiers modifiés depuis la dernière sauvegarde (commit)" }, "modifié"));
  if (st?.ok && st.ahead) bits.push(el("span", { class: "proj-flag num", title: "Modifications enregistrées ici, pas encore envoyées sur GitHub" }, `↑${st.ahead}`));
  if (st?.ok && st.behind) bits.push(el("span", { class: "proj-flag num", title: "Modifications présentes sur GitHub, pas encore récupérées ici" }, `↓${st.behind}`));
  return el("div", { class: "proj-meta" },
    tr.color ? el("span", { class: "proj-swatch", style: `background:${tr.color}`, title: "Couleur du projet" }) : null,
    githubPill(st, () => openGithubDialog(project, action)), ...bits);
}

export function projectsToolbar() {
  const box = el("input", { type: "checkbox" });
  box.checked = showAll;
  box.addEventListener("change", () => setShowAllProjects(box.checked));
  const add = el("button", { class: "btn btn-sm", type: "button", onclick: () => openAddProject() }, iconEl(icons.plus), "Ajouter un projet");
  const nodes = [el("div", { class: "proj-toolbar" }, add, el("label", { class: "check" }, box, " Afficher tous les projets"))];
  if (loaded && firstRun) {
    nodes.push(el("div", { class: "proj-cta" },
      el("p", {}, "Aucun projet choisi pour l’instant. Cochez ceux qui vous intéressent, rien n’est suivi automatiquement."),
      el("button", { class: "btn btn-sm btn-primary", type: "button", onclick: () => openQuickStart() }, "Sélection rapide")));
  }
  return nodes;
}

// ---------- Ajouter un projet (navigateur de dossiers) ----------
export function openAddProject(host = "local") {
  openFolderPicker({
    host, title: "Ajouter un projet", actionLabel: "Suivre ce dossier",
    onChoose: (pickedHost, dir) => follow(pickedHost, dir),
  });
}

// ---------- Sélection rapide du premier lancement ----------
export function openQuickStart(host = "local") {
  const previous = document.activeElement;
  const dialog = el("dialog", { class: "dialog fp-dialog", "aria-label": "Choisir vos projets" });
  const list = el("ul", { class: "qs-list" });
  const error = el("p", { class: "form-error", role: "alert" });
  const where = el("p", { class: "muted mono" });
  const submit = el("button", { class: "btn btn-primary", type: "button" }, "Suivre la sélection");
  const hostSelect = el("select", { "aria-label": "Machine" });
  let current = { host, dir: null };
  const boxes = [];

  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    submit.textContent = n ? `Suivre la sélection (${n})` : "Suivre la sélection";
    submit.disabled = n === 0;
  };
  async function load(label) {
    current = { host: label, dir: null };
    boxes.length = 0;
    list.replaceChildren(el("li", { class: "fp-empty muted" }, "Chargement…"));
    error.textContent = "";
    const roots = await rpc("fs.roots", { host: label });
    const base = roots.ok && (roots.roots.find((r) => r.kind === "projects") || roots.roots.find((r) => r.kind === "home"));
    if (!base) {
      list.replaceChildren(el("li", { class: "fp-empty muted" }, "Aucun dossier de projets trouvé sur cette machine."));
      error.textContent = roots.error || "";
      update();
      return;
    }
    const result = await rpc("fs.list", { host: label, path: base.path });
    if (!result.ok) {
      list.replaceChildren();
      error.textContent = result.error;
      return;
    }
    current.dir = result.path;
    where.textContent = result.path;
    const already = new Set(tracked.filter((p) => p.host === label).map((p) => p.dir.toLowerCase()));
    list.replaceChildren(...result.entries.map((entry) => {
      const box = el("input", { type: "checkbox", value: entry.path });
      box.disabled = already.has(entry.path.toLowerCase());
      box.addEventListener("change", update);
      boxes.push(box);
      return el("li", {}, el("label", { class: "qs-item" }, box, el("span", { class: "fp-name" }, entry.name),
        box.disabled ? el("span", { class: "tag" }, "déjà suivi") : entry.git ? el("span", { class: "tag tag-git" }, "git") : null));
    }));
    if (!result.entries.length) list.replaceChildren(el("li", { class: "fp-empty muted" }, "Aucun sous-dossier."));
    update();
  }

  submit.addEventListener("click", async () => {
    const dirs = boxes.filter((b) => b.checked).map((b) => b.value);
    if (!dirs.length) return;
    submit.disabled = true;
    const result = await rpc("project.follow", { host: current.host, dirs }, "project.followed");
    if (!result.ok) {
      error.textContent = result.error;
      update();
      return;
    }
    toast(`${result.added.length} projet(s) suivi(s).`);
    dialog.close();
  });
  hostSelect.addEventListener("change", () => load(hostSelect.value));
  dialog.append(
    el("div", { class: "dialog-body fp-body" },
      el("header", { class: "dialog-head" }, el("h2", {}, "Choisir vos projets"),
        el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: () => dialog.close() }, "×")),
      el("p", { class: "dialog-text" }, "Cochez les dossiers à suivre. Rien n’est suivi automatiquement."),
      el("label", { class: "fp-host" }, el("span", { class: "label-caps" }, "Machine"), hostSelect),
      where, list, error),
    el("footer", { class: "dialog-foot fp-foot" },
      el("button", { class: "btn", type: "button", onclick: () => { dialog.close(); openAddProject(current.host); } }, "Parcourir d’autres dossiers…"),
      el("button", { class: "btn", type: "button", onclick: () => { send({ type: "project.dismissSetup" }); dialog.close(); } }, "Plus tard"),
      submit),
  );
  dialog.addEventListener("close", () => { dialog.remove(); previous?.focus?.(); });
  document.body.append(dialog);
  const hosts = getState().hosts.filter((h) => h.status === "connected");
  hostSelect.replaceChildren(...hosts.map((h) => el("option", { value: h.label }, hostLabel(h))));
  if (hosts.some((h) => h.label === host)) hostSelect.value = host;
  update();
  dialog.showModal();
  load(hostSelect.value || host);
}

// ---------- GitHub : création et synchronisation ----------
const STATUS_WORDS = { added: "ajouté", modified: "modifié", deleted: "supprimé", renamed: "renommé" };

export function openGithubDialog(rawProject, action) {
  const project = asProject(rawProject);
  const previous = document.activeElement;
  const dialog = el("dialog", { class: "dialog gh-dialog", "aria-label": action === "create" ? "Créer le dépôt GitHub" : "Synchroniser avec GitHub" });
  const body = el("div", { class: "dialog-body" });
  const foot = el("footer", { class: "dialog-foot" });
  dialog.append(body, foot);
  const closeButton = () => el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Fermer");
  const title = action === "create" ? "Créer le dépôt GitHub" : "Synchroniser avec GitHub";
  const step = (heading, nodes, buttons) => {
    body.replaceChildren(
      el("header", { class: "dialog-head" }, el("h2", {}, heading),
        el("button", { class: "icon-btn", type: "button", "aria-label": "Fermer", onclick: () => dialog.close() }, "×")),
      el("p", { class: "muted mono wrap" }, `${hostLabel(project.host)} · ${project.directory}`),
      ...nodes);
    foot.replaceChildren(...buttons);
  };
  const message = (text, kind = "") => el("p", { class: `gh-message ${kind}`, role: kind === "error" ? "alert" : null }, text);

  function disconnected() {
    const help = el("div", { class: "gh-help", hidden: true },
      el("p", {}, "Sur cette machine, ouvrez un terminal et lancez :"),
      el("pre", {}, el("code", {}, "gh auth login")),
      el("p", { class: "muted" }, "Choisissez GitHub.com puis HTTPS et suivez les instructions. Ne copiez jamais un jeton d’une machine à l’autre : chaque machine se connecte elle-même."));
    const toggle = el("button", { class: "btn", type: "button", "aria-expanded": "false", onclick: () => {
      help.hidden = !help.hidden;
      toggle.setAttribute("aria-expanded", String(!help.hidden));
    } }, "Comment faire ?");
    step(title, [message("GitHub n’est pas connecté sur cette machine", "warn"), help], [toggle, closeButton()]);
  }

  function confirmStep(plan, payload) {
    const understood = el("input", { type: "checkbox" });
    const error = el("p", { class: "form-error", role: "alert" });
    const go = el("button", { class: "btn btn-primary", type: "button" }, action === "create" ? "Créer le dépôt et pousser" : "Synchroniser maintenant");
    go.disabled = true;
    understood.addEventListener("change", () => { go.disabled = !understood.checked; });
    go.addEventListener("click", async () => {
      go.disabled = true;
      error.textContent = "";
      const result = await rpc(`github.${action}`, { host: project.host, dir: project.directory, ...payload, confirm: true }, "github.result");
      if (!result.ok) {
        error.textContent = result.error || "L’opération a échoué.";
        go.disabled = !understood.checked;
        return;
      }
      toast(action === "create" ? "Dépôt GitHub créé." : "Synchronisation terminée.");
      dialog.close();
      refreshStatuses({ fresh: true });
    });
    step(`${title} · confirmation`, [
      el("p", { class: "gh-sentence" }, plan.summary),
      ...planDetails(plan),
      el("label", { class: "check" }, understood, " J’ai compris : cette action écrit sur GitHub."),
      error,
    ], [el("button", { class: "btn", type: "button", onclick: () => reviewStep(plan, payload) }, "Retour"), go]);
    understood.focus();
  }

  function planDetails(plan) {
    const nodes = [];
    for (const warning of plan.warnings || []) nodes.push(message(warning, "warn"));
    if (plan.push?.available) {
      const files = plan.push.files || [];
      nodes.push(el("p", { class: "label-caps" }, `${plan.push.commits} commit(s) · ${plan.push.filesTotal} fichier(s) à envoyer`));
      if (files.length) {
        nodes.push(el("ul", { class: "gh-files mono" }, files.slice(0, 8).map((f) =>
          el("li", {}, el("span", { class: "wrap" }, f.path), el("small", {}, STATUS_WORDS[f.status] || f.status || ""))),
        files.length > 8 || plan.push.filesTotal > files.length
          ? el("li", { class: "muted" }, `+ ${plan.push.filesTotal - 8} autre(s)`) : null));
      }
    }
    if (plan.action === "sync" && plan.pull) nodes.push(el("p", { class: "muted" }, `À récupérer : ${plan.pull.commits} commit(s).`));
    return nodes;
  }

  // Temps 1 : résumé de ce qui va se passer ; temps 2 : phrase explicite + case à cocher.
  function reviewStep(plan, payload) {
    step(`${title} · résumé`, [
      ...(action === "create"
        ? [el("p", {}, `Dépôt ${plan.visibility === "public" ? "public" : "privé"} « ${plan.name} » sur le compte ${plan.account}, branche ${plan.branch}.`)]
        : [el("p", {}, `Branche ${plan.branch} · à récupérer ${plan.pull.commits} · à envoyer ${plan.ahead}.`)]),
      ...planDetails(plan),
    ], [
      el("button", { class: "btn", type: "button", onclick: () => (action === "create" ? createForm(payload) : dialog.close()) }, action === "create" ? "Modifier" : "Annuler"),
      el("button", { class: "btn btn-primary", type: "button", onclick: () => confirmStep(plan, payload) }, "Continuer"),
    ]);
  }

  function createForm(previousValues = {}, status = null) {
    const name = el("input", { type: "text", value: previousValues.name ?? status?.proposedName ?? "", maxlength: 100, autocomplete: "off", required: true });
    const description = el("input", { type: "text", value: previousValues.description ?? "", maxlength: 350, autocomplete: "off" });
    const visibility = el("select", {}, el("option", { value: "private" }, "Privé (par défaut)"), el("option", { value: "public" }, "Public"));
    visibility.value = previousValues.visibility ?? "private";
    const error = el("p", { class: "form-error", role: "alert" });
    const next = el("button", { class: "btn btn-primary", type: "submit" }, "Examiner");
    const form = el("form", { class: "gh-form" },
      el("label", { class: "field" }, "Nom du dépôt", name),
      el("label", { class: "field" }, "Description (facultative)", description),
      el("label", { class: "field" }, "Visibilité", visibility),
      error);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!REPO_NAME.test(name.value.trim())) {
        error.textContent = "Nom invalide : lettres, chiffres, points, tirets et tirets bas (100 maximum).";
        return;
      }
      next.disabled = true;
      error.textContent = "";
      const payload = { name: name.value.trim(), description: description.value.trim(), visibility: visibility.value };
      const plan = await rpc("github.plan", { host: project.host, dir: project.directory, action: "create", ...payload });
      next.disabled = false;
      if (!plan.ok) {
        error.textContent = plan.error || "Impossible de préparer la création.";
        return;
      }
      reviewStep(plan, payload);
    });
    next.setAttribute("form", "gh-create-form");
    form.id = "gh-create-form";
    step(title, [form], [el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Annuler"), next]);
    name.select();
  }

  async function start() {
    step(title, [message("Vérification de GitHub sur cette machine…")], [closeButton()]);
    const status = await rpc("github.status", { host: project.host, dir: project.directory, fresh: true });
    if (!status.ok) {
      step(title, [message(status.error || "Statut GitHub indisponible.", "error")], [closeButton()]);
      return;
    }
    if (!status.github.connected) return disconnected();
    if (action === "create") {
      if (status.linked) {
        step(title, [message(`Un dépôt GitHub est déjà lié : ${status.git.remote.url}`)], [closeButton()]);
        return;
      }
      if (!status.git.isGit) {
        step(title, [message("Ce dossier n’est pas un dépôt git : initialisez-le (git init) et faites un premier commit.", "warn")], [closeButton()]);
        return;
      }
      createForm({}, status);
      return;
    }
    if (!status.linked) {
      step(title, [message("Aucun dépôt GitHub n’est lié à ce dossier : créez-le d’abord.", "warn")], [closeButton()]);
      return;
    }
    const plan = await rpc("github.plan", { host: project.host, dir: project.directory, action: "sync" });
    if (!plan.ok) {
      step(title, [message(plan.error || "Impossible de préparer la synchronisation.", "error")], [closeButton()]);
      return;
    }
    reviewStep(plan, {});
  }

  dialog.addEventListener("close", () => { dialog.remove(); previous?.focus?.(); });
  document.body.append(dialog);
  dialog.showModal();
  start();
}

export { FOLDER_ICON };
