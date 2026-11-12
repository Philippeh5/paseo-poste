// Vue « Tâches » : tableau À faire · En cours · À valider · Terminé (+ Bloquée), glisser-déposer, tiroir de détail,
// modale de création/modification, fenêtre « Lancer une chaîne » (T40). Données et règles : handlers/tasks.mjs
// (messages task.*) et handlers/chains.mjs (messages chain.*).
import { registerView } from "./registry.js";
import { el, escapeHtml, icons, iconEl, led, folderName } from "../core/util.js";
import { updateDrawerHeader } from "../core/drawer.js";
import { hostLabel, harnessLabel, taskName, projectLabel } from "../core/names.js";

const COLUMNS = [
  { id: "todo", label: "À faire" },
  { id: "doing", label: "En cours" },
  { id: "review", label: "À valider" },
  { id: "done", label: "Terminé" },
  { id: "blocked", label: "Bloquée" },
];
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
const STATUS_TONE = { todo: "inactif", doing: "ok", review: "ok", done: "inactif", blocked: "danger" };

let ctx = null;
let root = null;
let board = null;
let subtitle = null;
let tasks = [];
let offs = [];
let dragId = null;
let pendingRender = false;
let selectedId = null;
let drawerRender = null;
let menu = null;
let dialog = null;
let form = null;
let filterSelect = null;
let editing = null;
let awaiting = null;
let optionsByHost = {};
let chains = [];
let profiles = [];
let projects = [];
let chainDialog = null;
let chainForm = null;
let chainWaiting = false;
let hints = new Map(); // taskId -> avis automatique { hint, p, reasons } (T44)

const byId = (id) => tasks.find((t) => t.id === id);
let projectFilter = "";
const projectOf = (t) => t.projectName || "Sans projet";
const inColumn = (status) => tasks.filter((t) => t.status === status && (!projectFilter || projectOf(t) === projectFilter));
const when = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—");

function tone(task) {
  if (task.error) return { tone: "danger", label: "Erreur", pulse: false };
  if (task.permission) return { tone: "attention", label: "Permission requise", pulse: true };
  return { tone: STATUS_TONE[task.status], label: LABEL[task.status], pulse: task.status === "doing" };
}

// ---------- Avis automatique « à vérifier » (T44) ----------
const HINTS = {
  a_verifier: { text: "À vérifier", mark: "▲", cls: "tag-verify" },
  probablement_ok: { text: "Probablement OK", mark: "✓", cls: "tag-probable" },
};
const HINT_NOTE = "Avis automatique indicatif — vérifie toi-même";
function hintOf(task) {
  const found = task.status === "review" && !task.error ? hints.get(task.id) : null;
  return found && HINTS[found.hint] ? { ...HINTS[found.hint], reasons: found.reasons || [] } : null;
}
const hintTip = (h) => `${HINT_NOTE}${h.reasons.length ? ` (${h.reasons.join(" / ")})` : ""}`;

// ---------- Déplacements ----------
const send = (message) => ctx.send(message);
function moveTo(task, status, index) {
  send({ type: "task.move", id: task.id, status, ...(Number.isInteger(index) ? { index } : {}) });
}
function moveWithin(task, delta) {
  const column = inColumn(task.status);
  const next = Math.max(0, Math.min(column.length - 1, column.findIndex((t) => t.id === task.id) + delta));
  moveTo(task, task.status, next);
}
function moveAcross(task, delta) {
  const visible = COLUMNS.filter((c) => c.id !== "blocked" || task.status === "blocked" || inColumn("blocked").length);
  const at = visible.findIndex((c) => c.id === task.status);
  const target = visible[at + delta];
  if (target) moveTo(task, target.id);
}

function closeMenu({ restore = false } = {}) {
  if (!menu) return;
  const anchor = menu.anchor;
  menu.remove();
  document.removeEventListener("pointerdown", menu.outside, true);
  menu = null;
  if (restore) anchor?.focus?.();
}

// Menu accessible « Déplacer vers… » (clavier et tactile).
function openMenu(task, anchor) {
  closeMenu();
  const column = inColumn(task.status);
  const at = column.findIndex((t) => t.id === task.id);
  const items = [];
  if (at > 0) items.push(["Monter dans la colonne", () => moveWithin(task, -1)]);
  if (at < column.length - 1) items.push(["Descendre dans la colonne", () => moveWithin(task, 1)]);
  for (const col of COLUMNS) {
    if (col.id === task.status) continue;
    items.push([`Déplacer vers « ${col.label} »`, () => moveTo(task, col.id)]);
  }
  const node = el("div", { class: "task-menu", role: "menu", "aria-label": `Déplacer « ${task.title} »` },
    el("div", { class: "label-caps" }, "Déplacer vers…"),
    items.map(([label, run]) => el("button", {
      type: "button", role: "menuitem", onclick: () => { closeMenu({ restore: true }); run(); },
    }, label)));
  node.anchor = anchor;
  node.outside = (event) => { if (!node.contains(event.target)) closeMenu(); };
  node.addEventListener("keydown", (event) => {
    const buttons = [...node.querySelectorAll("button")];
    const at2 = buttons.indexOf(document.activeElement);
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu({ restore: true }); }
    else if (event.key === "ArrowDown") { event.preventDefault(); buttons[(at2 + 1) % buttons.length].focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); buttons[(at2 - 1 + buttons.length) % buttons.length].focus(); }
    else if (event.key === "Tab") closeMenu();
  });
  document.body.append(node);
  const rect = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  node.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
  const below = rect.bottom + 4;
  node.style.top = `${below + node.offsetHeight > window.innerHeight ? Math.max(8, rect.top - node.offsetHeight - 4) : below}px`;
  menu = node;
  document.addEventListener("pointerdown", node.outside, true);
  node.querySelector("button")?.focus();
}

// ---------- Cartes et colonnes ----------
function cardEl(task) {
  const t = tone(task);
  const attention = task.permission;
  const dependsOn = task.deps.map((id) => byId(id)?.title).filter(Boolean);
  // Une tâche de chaîne dont la raison est affichée (chaîne arrêtée, machine absente) n'a pas besoin du repère d'attente.
  const chainNote = Boolean(task.chain && task.status === "todo" && task.reason);
  const showBlocked = task.blockedBy.length && ["todo", "blocked"].includes(task.status) && !chainNote;
  const hint = hintOf(task);
  const tags = [
    hint && el("span", {
      class: `tag ${hint.cls}`, tabindex: "0", title: hintTip(hint), "aria-label": `${hint.text}. ${hintTip(hint)}`,
    }, el("span", { "aria-hidden": "true" }, hint.mark), hint.text),
    task.status === "doing" && /^(Relance automatique|Moteur remplacé)/.test(task.reason) &&
      el("span", { class: "tag tag-chain", title: task.reason }, "Moteur remplacé"),
    task.chain && el("span", { class: "tag tag-chain", title: "Cette tâche fait partie d’une chaîne d’agents" }, "Chaîne"),
    showBlocked && el("span", { class: "tag tag-blocked" },
      `${task.chain ? "En attente de" : "Bloquée par"}: ${task.blockedBy.map((d) => d.title).join(", ")}`),
    !showBlocked && !chainNote && dependsOn.length > 0 && el("span", { class: "tag" }, `Dépend de: ${dependsOn.join(", ")}`),
    task.permission && el("span", { class: "pastille" }, "Permission requise"),
    task.error && el("span", { class: "tag tag-error", title: task.error }, "Erreur"),
    ["blocked", "todo"].includes(task.status) && task.reason && el("span", { class: "tag tag-blocked" }, task.reason),
  ].filter(Boolean);
  const card = el("li", {
    class: `card${attention ? " is-attention" : ""}${task.error ? " is-error" : ""}${task.id === selectedId ? " is-selected" : ""}`,
    draggable: "true", dataset: { id: task.id },
  },
    el("div", { class: "card-top" },
      led(t.tone, { pulse: t.pulse, label: t.label }),
      el("button", {
        class: "card-open", type: "button", title: task.title, onclick: () => openTaskDrawer(task.id),
        onkeydown: (event) => {
          if (!event.altKey) return;
          const step = { ArrowUp: () => moveWithin(task, -1), ArrowDown: () => moveWithin(task, 1),
            ArrowLeft: () => moveAcross(task, -1), ArrowRight: () => moveAcross(task, 1) }[event.key];
          if (step) { event.preventDefault(); step(); }
        },
      }, task.title),
      el("button", {
        class: "icon-btn card-menu", type: "button", "aria-haspopup": "menu", title: "Déplacer vers…",
        "aria-label": `Déplacer « ${task.title} » vers…`,
        onclick: (event) => openMenu(task, event.currentTarget),
      }, "⋯")),
    el("div", { class: "card-meta" },
      el("span", {}, `${task.projectName || "Sans projet"} · ${hostLabel(task.host)}`),
      el("span", { class: "mono", title: task.engine }, (task.engine === "auto" ? "Auto (classement)" : harnessLabel(task.engine)) || "moteur à choisir")),
    tags.length > 0 && el("div", { class: "card-tags" }, tags),
    (task.error || task.summary) && ["doing", "review", "done"].includes(task.status) &&
      el("p", { class: "card-summary" }, task.error || task.summary),
  );
  card.addEventListener("dragstart", (event) => {
    dragId = task.id;
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
    setTimeout(() => card.classList.add("is-dragging"), 0);
  });
  card.addEventListener("dragend", () => {
    dragId = null;
    clearDropMarks();
    card.classList.remove("is-dragging");
    if (pendingRender) { pendingRender = false; render(); }
  });
  return card;
}

function clearDropMarks() {
  for (const node of board?.querySelectorAll(".drop-before, .drop-end, .is-drop") || []) {
    node.classList.remove("drop-before", "drop-end", "is-drop");
  }
}
function dropSpot(list, y) {
  const cards = [...list.querySelectorAll(".card")].filter((c) => c.dataset.id !== dragId);
  for (let i = 0; i < cards.length; i++) {
    const box = cards[i].getBoundingClientRect();
    if (y < box.top + box.height / 2) return { index: i, before: cards[i] };
  }
  return { index: cards.length, before: null };
}

function columnEl(col) {
  const items = inColumn(col.id);
  const list = el("ul", { class: "col-list", dataset: { status: col.id }, "aria-label": col.label },
    items.map(cardEl),
    !items.length && el("li", { class: "col-empty" },
      col.id === "todo" && !tasks.length ? "Aucune tâche : créez-en une avec « Nouvelle tâche »." : "Vide"));
  const section = el("section", { class: "col", dataset: { status: col.id }, "aria-label": col.label },
    el("header", { class: "col-head" }, el("h2", {}, col.label), el("span", { class: "col-count num" }, String(items.length))),
    list);
  section.addEventListener("dragover", (event) => {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropMarks();
    list.classList.add("is-drop");
    const { before } = dropSpot(list, event.clientY);
    if (before) before.classList.add("drop-before");
    else list.classList.add("drop-end");
  });
  section.addEventListener("dragleave", (event) => {
    if (!section.contains(event.relatedTarget)) clearDropMarks();
  });
  section.addEventListener("drop", (event) => {
    if (!dragId) return;
    event.preventDefault();
    const task = byId(dragId);
    const { index } = dropSpot(list, event.clientY);
    clearDropMarks();
    if (task) moveTo(task, col.id, index);
  });
  return section;
}

function render() {
  if (!root) return;
  if (dragId) { pendingRender = true; return; }
  closeMenu();
  const active = document.activeElement;
  const keep = active && board.contains(active) && active.closest(".card")
    ? { id: active.closest(".card").dataset.id, cls: active.classList.contains("card-menu") ? ".card-menu" : ".card-open" }
    : null;
  const visible = COLUMNS.filter((c) => c.id !== "blocked" || inColumn("blocked").length);
  board.replaceChildren(...visible.map(columnEl));
  const running = inColumn("doing").length;
  const shown = tasks.filter((t) => !projectFilter || projectOf(t) === projectFilter).length;
  subtitle.textContent = `${shown} tâche${shown > 1 ? "s" : ""} · ${running} en cours`;
  if (filterSelect) {
    const names = [...new Set(tasks.map(projectOf))].sort((a, b) => a.localeCompare(b));
    if (projectFilter && !names.includes(projectFilter)) projectFilter = "";
    filterSelect.replaceChildren(el("option", { value: "" }, "Tous les projets"),
      ...names.map((n) => el("option", { value: n, selected: n === projectFilter }, n)));
    filterSelect.value = projectFilter;
  }
  if (keep) board.querySelector(`.card[data-id="${keep.id}"] ${keep.cls}`)?.focus({ preventScroll: true });
  drawerRender?.();
}

function markSelected() {
  for (const card of board?.querySelectorAll(".card") || []) card.classList.toggle("is-selected", card.dataset.id === selectedId);
}

// ---------- Tiroir de détail ----------
function openTaskDrawer(id) {
  const task = byId(id);
  if (!task) return;
  ctx.drawer.open({
    title: task.title,
    subtitle: LABEL[task.status],
    build(body) {
      selectedId = id;
      markSelected();
      const wrap = el("div", { class: "task-detail" });
      body.append(wrap);
      drawerRender = () => fillDetail(wrap, id);
      fillDetail(wrap, id);
      return () => { drawerRender = null; selectedId = null; markSelected(); };
    },
  });
}

function fact(label, value, { mono = false } = {}) {
  return [el("dt", {}, label), el("dd", { class: mono ? "mono wrap" : "wrap" }, value)];
}

async function confirmDelete(task) {
  const ok = await ctx.confirm({
    title: "Supprimer cette tâche ?",
    message: `« ${task.title} » sera supprimée définitivement du tableau.` +
      (task.agentId ? " La session associée n’est pas arrêtée." : ""),
    confirmLabel: "Supprimer", danger: true,
  });
  if (!ok) return;
  send({ type: "task.delete", id: task.id });
  ctx.drawer.close();
}

function fillDetail(wrap, id) {
  const task = byId(id);
  if (!task) { ctx.drawer.close(); return; }
  const t = tone(task);
  updateDrawerHeader({ title: task.title, subtitle: LABEL[task.status], meta: task.project });
  const startable = ["todo", "blocked", "review"].includes(task.status);
  const blocked = task.blockedBy.length > 0;
  const move = el("select", { class: "select-sm", "aria-label": "Déplacer vers…", onchange: (event) => {
    const value = event.target.value;
    event.target.value = "";
    if (value) moveTo(task, value);
  } },
    el("option", { value: "" }, "Déplacer vers…"),
    COLUMNS.filter((c) => c.id !== task.status)
      .map((c) => el("option", { value: c.id }, c.label)));
  wrap.replaceChildren(...[
    el("div", { class: "task-state" },
      led(t.tone, { pulse: t.pulse, label: t.label }),
      el("strong", {}, LABEL[task.status]),
      task.permission && el("span", { class: "pastille" }, "Permission requise"),
      task.error && el("span", { class: "tag tag-error" }, "Erreur")),
    blocked && ["todo", "blocked"].includes(task.status) &&
      el("p", { class: "tag tag-blocked" }, `Bloquée par: ${task.blockedBy.map((d) => `${d.title} (${LABEL[d.status]})`).join(", ")}`),
    task.reason && el("p", { class: "muted" }, `Raison : ${task.reason}`),
    hintOf(task) && el("p", { class: "task-hint" },
      `${hintOf(task).mark} ${hintOf(task).text} : ${hintTip(hintOf(task))}`),
    el("div", { class: "task-buttons" },
      task.status === "doing"
        ? el("button", { class: "btn btn-sm", type: "button", onclick: () => send({ type: "task.stop", id }) },
          iconEl(icons.stop), "Arrêter")
        : startable && el("button", {
          class: "btn btn-sm btn-primary", type: "button", disabled: blocked,
          title: blocked ? "Des dépendances ne sont pas terminées" : "", onclick: () => send({ type: "task.start", id }),
        }, task.status === "todo" ? "Démarrer" : "Relancer"),
      task.agentId && el("button", {
        class: "btn btn-sm", type: "button",
        onclick: () => ctx.drawer.openAgent(task.host, task.agentId, {
          actions: [{ label: "Retour à la tâche", onClick: () => openTaskDrawer(id) }],
        }),
      }, iconEl(icons.agent), "Voir la session"),
      el("button", { class: "btn btn-sm", type: "button", onclick: () => openDialog(task) }, "Modifier"),
      el("button", { class: "btn btn-sm btn-danger-ghost", type: "button", onclick: () => confirmDelete(task) },
        iconEl(icons.trash), "Supprimer")),
    el("label", { class: "task-move" }, "Colonne", move),
    el("dl", { class: "facts" },
      fact("Projet", task.project || "—", { mono: true }),
      fact("Machine", hostLabel(task.host)),
      fact("Moteur", (task.engine === "auto" ? "Auto (classement)" : harnessLabel(task.engine)) || "à choisir", { mono: true }),
      fact("Mode", task.mode || "par défaut"),
      fact("Rôle", ROLE_TEXT[task.role] || ROLE_TEXT.writer),
      task.chain && fact("Chaîne", `exécution ${task.chain.slice(0, 8)}${task.autostart ? " · démarrage automatique" : ""}`),
      fact("Isolation", task.isolation === "worktree" ? `worktree · ${task.branch || "branche automatique"}` : "locale"),
      fact("Session", task.agentId ? task.agentId.slice(0, 8) : "—", { mono: true }),
      fact("Créée", when(task.createdAt)),
      fact("Modifiée", when(task.updatedAt))),
    task.deps.length > 0 && el("div", {}, el("h3", {}, "Dépendances"),
      el("ul", { class: "dep-list" }, task.deps.map((dep) => {
        const found = byId(dep);
        return el("li", {}, `${found?.title || "(supprimée)"} — ${found ? LABEL[found.status] : ""}`);
      }))),
    el("div", {}, el("h3", {}, "Description (invite de l’agent)"),
      el("div", { class: "task-text" }, task.description || "—")),
    task.summary && el("div", {}, el("h3", {}, "Résumé du résultat"), el("div", { class: "task-text" }, task.summary)),
    task.error && el("div", {}, el("h3", {}, "Erreur"), el("div", { class: "task-text is-error" }, task.error)),
  ].filter(Boolean));
}

// ---------- Modale de création / modification ----------
const TEMPLATE = `
<form class="dialog-body" method="dialog" novalidate>
  <header class="dialog-head">
    <h2 data-heading>Nouvelle tâche</h2>
    <button type="button" class="icon-btn" data-close aria-label="Fermer">&times;</button>
  </header>
  <label class="field">Titre<input name="title" maxlength="200" autocomplete="off" required></label>
  <label class="field">Stratégie (FreqTrade)<select name="strategy" disabled></select></label>
  <label class="field">Config<select name="config" disabled></select></label>
  <label class="field">Description (invite donnée à l’agent)<textarea name="description" rows="3"></textarea></label>
  <label class="field">Projet (dossier sur la machine)
    <input name="project" class="mono" list="task-projects" placeholder="Choisir un projet connu ou saisir un chemin" autocomplete="off">
    <datalist id="task-projects"></datalist></label>
  <div class="field-row">
    <label class="field">Machine<select name="host"></select></label>
    <label class="field">Moteur<select name="engine"></select></label>
  </div>
  <div class="field-row">
    <label class="field">Mode et permissions<select name="mode"></select></label>
    <label class="field">Isolation
      <select name="isolation"><option value="local">Locale</option><option value="worktree">Arbre de travail (worktree)</option></select></label>
  </div>
  <label class="field">Rôle de la session
    <select name="role"><option value="writer">Rédacteur (peut modifier les fichiers qu'il réserve)</option><option value="reader">Lecture seule (le poste refuse toute modification)</option><option value="planner">Planificateur (écrit seulement dans le dossier de notes)</option></select></label>
  <label class="field" data-branch>Branche<input name="branch" class="mono" placeholder="paseo-task" autocomplete="off"></label>
  <fieldset class="field" style="border:0;padding:0;margin:8px 0"><legend>Dépendances (doivent être terminées avant le démarrage)</legend>
    <div class="dep-box" data-deps></div></fieldset>
  <p class="form-error" role="alert"></p>
  <footer class="dialog-foot">
    <button type="button" class="btn" data-close>Annuler</button>
    <button type="submit" class="btn btn-primary" data-submit>Créer</button>
  </footer>
</form>`;

const option = (value, label, disabled = false, selected = false) =>
  `<option value="${escapeHtml(value)}"${disabled ? " disabled" : ""}${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;

function providers() {
  return optionsByHost[form.elements.host.value]?.providers || [];
}
function fillProjects() {
  const list = optionsByHost[form.elements.host.value]?.workspaces || [];
  form.querySelector("#task-projects").innerHTML =
    list.map((w) => `<option value="${escapeHtml(w.directory || "")}" label="${escapeHtml(w.name)}"></option>`).join("");
}
function fillEngines(selected = form.elements.engine.value) {
  const groups = providers().map((p) => {
    const hLabel = harnessLabel(p.id || p.label);
    return `<optgroup label="${escapeHtml(`${hLabel}${p.available ? "" : " (indisponible)"}`)}">` +
      (p.models || []).map((m) => option(`${p.id}/${m.id}`, m.label || m.id, !p.available)).join("") + "</optgroup>";
  }).join("");
  const known = selected === "auto" || providers().some((p) => (p.models || []).some((m) => `${p.id}/${m.id}` === selected));
  form.elements.engine.innerHTML = option("", "Choisir plus tard") + option("auto", "Auto : suit le classement des modèles (vue Modèles)") +
    (selected && !known ? option(selected, selected) : "") + groups;
  form.elements.engine.value = selected || "";
  fillModes();
}
function fillModes(selected = form.elements.mode.value) {
  const provider = providers().find((p) => p.id === form.elements.engine.value.split("/")[0]);
  const modes = provider?.modes || [];
  form.elements.mode.innerHTML = option("", "Mode par défaut") +
    (selected && !modes.some((m) => m.id === selected) ? option(selected, selected) : "") +
    modes.map((m) => option(m.id, m.label || m.id)).join("");
  form.elements.mode.value = selected || "";
  // Afficher les options FreqTrade si dispo
  const ftOptions = optionsByHost[form.elements.host.value]?.freqtradeOptions;
  if (ftOptions) {
    const strategySelect = form.elements.strategy;
    const configSelect = form.elements.config;
    if (strategySelect) {
      strategySelect.innerHTML = ``;
      ftOptions.strategy.options.forEach((opt, i) => {
        const selectedOpt = i === 0 ? " selected" : "";
        const optHtml = `<option value="${opt.id}"${selectedOpt}>${opt.label}</option>`;
        strategySelect.innerHTML += optHtml;
      });
    }
    if (configSelect) {
      configSelect.innerHTML = ``;
      ftOptions.config.options.forEach((opt, i) => {
        const selectedOpt = i === 0 ? " selected" : "";
        const optHtml = `<option value="${opt.id}"${selectedOpt}>${opt.label}</option>`;
        configSelect.innerHTML += optHtml;
      });
    }
  }
}
function fillDeps(selected = []) {
  const others = tasks.filter((t) => t.id !== editing);
  form.querySelector("[data-deps]").replaceChildren(...(others.length
    ? others.map((t) => el("label", { class: "check" },
      el("input", { type: "checkbox", name: "dep", value: t.id, checked: selected.includes(t.id) }),
      ` ${t.title} · ${LABEL[t.status]}`))
    : [el("span", { class: "dep-none" }, "Aucune autre tâche.")]));
}
function requestOptions() {
  const host = form.elements.host.value;
  if (host && ctx.state.hosts.find((h) => h.label === host)?.status === "connected") send({ type: "launch.options", host });
}

function openDialog(task = null) {
  editing = task?.id ?? null;
  awaiting = null;
  const hosts = ctx.state.hosts;
  const preferred = task?.host || hosts.find((h) => h.status === "connected")?.label || hosts[0]?.label || "local";
  form.reset();
  form.querySelector("[data-heading]").textContent = task ? "Modifier la tâche" : "Nouvelle tâche";
  form.querySelector("[data-submit]").textContent = task ? "Enregistrer" : "Créer";
  form.querySelector(".form-error").textContent = "";
  form.elements.host.innerHTML = (hosts.length ? hosts : [{ label: "local", status: "connected" }])
    .map((h) => option(h.label, h.status === "connected" ? hostLabel(h) : `${hostLabel(h)} (hors ligne)`)).join("");
  form.elements.host.value = preferred;
  form.elements.title.value = task?.title ?? "";
  form.elements.description.value = task?.description ?? "";
  form.elements.project.value = task?.project ?? "";
  form.elements.isolation.value = task?.isolation ?? "local";
  form.elements.branch.value = task?.branch ?? "";
  form.elements.role.value = task?.role ?? "writer";
  form.querySelector("[data-branch]").hidden = form.elements.isolation.value !== "worktree";
  fillProjects();
  fillEngines(task?.engine ?? "");
  fillModes(task?.mode ?? "");
  fillDeps(task?.deps ?? []);
  requestOptions();
  dialog.showModal();
  form.elements.title.focus();
}

function buildDialog() {
  dialog = el("dialog", { class: "dialog task-dialog", "aria-label": "Tâche" });
  dialog.innerHTML = TEMPLATE;
  form = dialog.querySelector("form");
  document.body.append(dialog);
  dialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));
  form.elements.host.addEventListener("change", () => { fillProjects(); fillEngines(""); requestOptions(); });
  form.elements.engine.addEventListener("change", () => fillModes(""));
  form.elements.isolation.addEventListener("change", () => {
    form.querySelector("[data-branch]").hidden = form.elements.isolation.value !== "worktree";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = form.elements;
    const error = form.querySelector(".form-error");
    error.textContent = "";
    if (!f.title.value.trim()) { error.textContent = "Le titre est obligatoire."; f.title.focus(); return; }
    const deps = [...form.querySelectorAll('input[name="dep"]:checked')].map((box) => box.value);
    awaiting = { id: editing, title: f.title.value.trim(), known: new Set(tasks.map((t) => t.id)) };
    send({
      type: editing ? "task.update" : "task.create", ...(editing ? { id: editing } : {}),
      title: f.title.value, description: f.description.value, project: f.project.value, host: f.host.value,
      engine: f.engine.value, mode: f.mode.value, isolation: f.isolation.value, branch: f.branch.value, role: f.role.value, deps,
    });
  });
}

function onChanged(message) {
  if (!awaiting || !dialog?.open || !message.task) return;
  const mine = awaiting.id ? message.task.id === awaiting.id
    : !awaiting.known.has(message.task.id) && message.task.title === awaiting.title;
  if (mine) { awaiting = null; dialog.close(); }
}

// ---------- Fenêtre « Lancer une chaîne » (T40) ----------
const CHAIN_TEMPLATE = `
<form class="dialog-body" method="dialog" novalidate>
  <header class="dialog-head">
    <h2>Lancer une chaîne</h2>
    <button type="button" class="icon-btn" data-close aria-label="Fermer">&times;</button>
  </header>
  <p class="dialog-text">Les agents travaillent l’un après l’autre : quand une tâche est terminée, la suivante démarre
    toute seule. Une erreur ou un blocage arrête la chaîne.</p>
  <fieldset class="field chain-fieldset"><legend>Chaîne</legend><div class="chain-choices" data-chains></div></fieldset>
  <label class="field">Projet (dossier suivi)<select name="project"></select></label>
  <label class="field">Mission<textarea name="mission" rows="4" maxlength="2000"
    placeholder="Ce que la chaîne doit accomplir, en une ou deux phrases"></textarea></label>
  <p class="form-error" role="alert"></p>
  <footer class="dialog-foot">
    <button type="button" class="btn" data-close>Annuler</button>
    <button type="submit" class="btn btn-primary" data-submit>Lancer la chaîne</button>
  </footer>
</form>`;

const stepName = (id) => profiles.find((p) => p.id === id)?.name || id;

function fillChains() {
  const keep = chainForm.querySelector('input[name="chain"]:checked')?.value || chains[0]?.id;
  const box = chainForm.querySelector("[data-chains]");
  box.replaceChildren(...(chains.length ? chains.map((chain) => el("label", { class: "chain-choice" },
    el("input", { type: "radio", name: "chain", value: chain.id, checked: chain.id === keep }),
    el("span", { class: "chain-choice-body" },
      el("strong", {}, chain.name),
      chain.description && el("span", { class: "chain-desc" }, chain.description),
      el("ol", { class: "chain-steps", "aria-label": "Étapes" }, chain.steps.map((id) => el("li", {}, stepName(id))))),
  )) : [el("span", { class: "dep-none" }, "Aucune chaîne disponible.")]));
}
function fillChainProjects() {
  const select = chainForm.elements.project;
  const keep = select.value;
  select.replaceChildren(...(projects.length
    ? projects.map((p, i) => el("option", { value: String(i) }, `${p.name || folderName(p.dir)} · ${hostLabel(p.host)}`))
    : [el("option", { value: "", disabled: true }, "Aucun projet suivi (vue Projets)")]));
  if (keep && Number(keep) < projects.length) select.value = keep;
}
function openChainDialog() {
  chainWaiting = false;
  chainForm.querySelector(".form-error").textContent = "";
  chainForm.querySelector("[data-submit]").disabled = false;
  send({ type: "chain.list" });
  send({ type: "profile.list" });
  send({ type: "project.list" });
  fillChains();
  fillChainProjects();
  chainDialog.showModal();
  chainForm.querySelector('input[name="chain"]:checked')?.focus();
}
function buildChainDialog() {
  chainDialog = el("dialog", { class: "dialog chain-dialog", "aria-label": "Lancer une chaîne" });
  chainDialog.innerHTML = CHAIN_TEMPLATE;
  chainForm = chainDialog.querySelector("form");
  document.body.append(chainDialog);
  chainDialog.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => chainDialog.close()));
  chainForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const error = chainForm.querySelector(".form-error");
    const chain = chainForm.querySelector('input[name="chain"]:checked')?.value;
    const project = projects[Number(chainForm.elements.project.value)];
    const mission = chainForm.elements.mission.value.trim();
    error.textContent = "";
    if (!chain) { error.textContent = "Choisissez une chaîne."; return; }
    if (!project) { error.textContent = "Choisissez un projet suivi (vue Projets pour en ajouter)."; return; }
    if (!mission) { error.textContent = "La mission est obligatoire."; chainForm.elements.mission.focus(); return; }
    chainWaiting = true;
    chainForm.querySelector("[data-submit]").disabled = true;
    send({ type: "chain.run", chain, project: project.dir, host: project.host, mission });
  });
}
function onChainStarted(message) {
  if (!chainWaiting) return;
  chainWaiting = false;
  chainDialog?.close();
  chainForm?.reset();
  const n = message.taskIds?.length || 0;
  ctx.toast(`Chaîne lancée : ${n} tâche${n > 1 ? "s" : ""} créée${n > 1 ? "s" : ""}, la première démarre.`);
}
function onChainError(message) {
  if (!chainWaiting || !chainDialog?.open) return;
  chainWaiting = false;
  chainForm.querySelector(".form-error").textContent = message.message;
  chainForm.querySelector("[data-submit]").disabled = false;
}

const ROLE_TEXT = { writer: "rédacteur", reader: "lecture seule", planner: "planificateur (notes)" };

// ---------- Vue ----------
function ensureStyles(done) {
  let link = document.getElementById("tasks-css");
  if (!link) {
    link = el("link", { id: "tasks-css", rel: "stylesheet", href: "css/tasks.css" });
    document.head.append(link);
  }
  if (link.sheet) { done(); return; }
  link.addEventListener("load", done, { once: true });
  link.addEventListener("error", done, { once: true });
  setTimeout(done, 2000);
}

const view = {
  id: "taches",
  title: "Tâches",
  short: "Tâches",
  icon: icons.tasks,
  order: 20,
  mount(container, context) {
    ctx = context;
    subtitle = el("span", { class: "tasks-sub num" });
    filterSelect = el("select", { class: "task-filter", "aria-label": "Filtrer par projet",
      onchange: () => { projectFilter = filterSelect.value; render(); } });
    board = el("div", { class: "board" });
    root = el("div", { class: "tasks-view", hidden: true },
      el("div", { class: "view-toolbar" },
        el("h1", { class: "view-title" }, "Tâches"), subtitle, filterSelect,
        el("button", { class: "btn", type: "button", onclick: () => openChainDialog() },
          iconEl(icons.agent), "Lancer une chaîne"),
        el("button", { class: "btn btn-primary", type: "button", onclick: () => openDialog() },
          iconEl(icons.plus), "Nouvelle tâche")),
      board);
    container.replaceChildren(root);
    ensureStyles(() => { if (root) root.hidden = false; });
    buildDialog();
    buildChainDialog();
    offs = [
      ctx.on("tasks", (message) => { tasks = message.tasks || []; render(); }),
      ctx.on("task.changed", onChanged),
      ctx.on("reviewhint.list", (message) => {
        hints = new Map((message.hints || []).map((h) => [h.taskId, h]));
        render();
      }),
      ctx.on("reviewhint.update", (message) => {
        if (message.hint) hints.set(message.taskId, message);
        else hints.delete(message.taskId);
        render();
      }),
      ctx.on("task.started", (message) => ctx.toast(`Session démarrée sur ${message.host}.`)),
      ctx.on("launch.options", (message) => {
        optionsByHost[message.host] = message;
        // Extraire les options FreqTrade si présentes
        if (message.freqtradeOptions && form.elements.host.value.includes("freqtrade")) {
          optionsByHost[message.host].freqtradeOptions = message.freqtradeOptions;
        }
        if (dialog?.open && form.elements.host.value === message.host) { fillProjects(); fillEngines(); }
      }),
      ctx.on("error", (message) => {
        if (awaiting && dialog?.open) { form.querySelector(".form-error").textContent = message.message; awaiting = null; }
        onChainError(message);
      }),
      ctx.on("chain.list", (message) => {
        chains = message.chains || [];
        if (chainDialog?.open) fillChains();
      }),
      ctx.on("profile.list", (message) => {
        profiles = message.profiles || [];
        if (chainDialog?.open) fillChains();
      }),
      ctx.on("project.list", (message) => {
        projects = (message.projects || []).filter((p) => p && p.dir);
        if (chainDialog?.open) fillChainProjects();
      }),
      ctx.on("chain.started", onChainStarted),
      ctx.onConnection((up) => {
        if (!up) return;
        send({ type: "task.list" });
        send({ type: "reviewhint.get" });
        send({ type: "chain.list" });
        send({ type: "profile.list" });
        send({ type: "project.list" });
      }),
    ];
    render();
  },
  unmount() {
    offs.forEach((off) => off());
    offs = [];
    closeMenu();
    drawerRender = null;
    dialog?.remove();
    dialog = null;
    chainDialog?.remove();
    chainDialog = null;
    chainForm = null;
    chainWaiting = false;
    form = null;
    root = null;
    filterSelect = null;
    board = null;
    dragId = null;
    selectedId = null;
  },
};

registerView(view);
export default view;
