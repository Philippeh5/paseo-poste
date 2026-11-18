// Vue « Groupes » : une conversation par projet, comme une messagerie. À gauche les projets (avec messages non lus), à droite le fil du projet
// choisi, sa composition (orchestrateur, employés) et la zone d'écriture : Philippe parle au groupe, ce qui réveille les sessions au repos ;
// « Lancer l'orchestrateur » active le Mode Agent sur le projet avec le message comme consigne, l'orchestrateur crée ses employés.
// Tous les textes reçus sont des DONNÉES déclarées par des sessions : affichés en texte brut (nœuds texte), jamais interprétés.
// Fiche projet (T37) : bouton « Fiche projet » → panneau (aperçu, édition, enregistrement avec détection de conflit,
// création, propositions des sessions à accepter ou refuser). Tout passe par les messages brief.* ; le fichier est
// écrit par le poste, jamais par ce code.
import { el, led, icons } from "../core/util.js";
import { registerView } from "./registry.js";
import { send, on } from "../core/socket.js";
import { hostLabel, harnessLabel, modelDisplay } from "../core/names.js";
import { relativeTime } from "../components/agentactivity.js";
import {
  subscribeCoord, getProjects, getThread, requestThread, markSeen, unreadOf, dirKey, projectNameOf,
} from "../components/coordteam.js";

const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
};
const clip = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

let ctx = null;
let profiles = []; // agents de base (handlers/profiles.mjs)
let pendingAgentTask = null; // tâche créée via @agent : démarrée dès que le poste confirme sa création
let renderAgentStrip = () => {};
let stops = [];
let timer = null;
let selected = null; // dir normalisé du groupe ouvert
let showIdle = false;
let showOld = false; // afficher aussi les anciens groupes (projets qui ne sont plus suivis)
let boardsNow = [];
// Fiche projet : état du panneau du groupe ouvert.
let briefOpen = false;
let brief = null; // dernier brief.state reçu pour le groupe ouvert
let briefDirty = false;
let briefConflict = null;
// propositions dont la décision est partie : boutons désactivés en attendant la réponse
const briefDeciding = new Set();
const threadFold = new Map(); // id du message de tête → fil ouvert (true) ou replié (false), choisi par Philippe
let briefPending = false; // une création / un enregistrement est parti : le prochain état remplace le texte affiché


// ---------- Agents de base : @agent dans le message, gestion (créer, modifier, supprimer) ----------
const AGENT_CSS = `
.grp-agents { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 0; }
.grp-agents .label-caps { margin-right: 2px; }
.grp-agent-chip { font-size: var(--t-12); padding: 2px 8px; border-radius: 999px; border: 1px solid var(--trait);
  background: var(--panneau-2); color: var(--texte); cursor: pointer; }
.grp-agent-chip:hover { border-color: var(--accent); color: var(--accent); }
.agents-dlg { width: min(720px, 94vw); }
.agents-list { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px; max-height: 40vh; overflow: auto; }
.agents-list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--trait); border-radius: var(--rayon-controle); }
.agents-list li .grow { flex: 1; min-width: 0; }
.agents-list small { color: var(--texte-doux); display: block; }
.agents-form { display: grid; gap: 8px; }
.agents-form label { display: grid; gap: 2px; font-size: var(--t-12); color: var(--texte-doux); }
.agents-form input, .agents-form textarea, .agents-form select { font: inherit; color: var(--texte); background: var(--sol);
  border: 1px solid var(--trait); border-radius: var(--rayon-controle); padding: 6px 8px; }
.agents-form textarea { min-height: 120px; resize: vertical; }
`;
const slug = (text) => String(text).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function openAgentsDialog() {
  const dialog = el("dialog", { class: "dialog agents-dlg", "aria-label": "Agents de base" });
  const list = el("ul", { class: "agents-list" });
  const field = (label, control) => el("label", {}, label, control);
  const f = {
    name: el("input", { type: "text", maxlength: "60", placeholder: "Ex. Relecteur de sécurité" }),
    description: el("input", { type: "text", maxlength: "200", placeholder: "Une phrase : à quoi il sert" }),
    instructions: el("textarea", { maxlength: "4000", placeholder: "Sa consigne permanente : « Tu es… »" }),
    role: el("select", {}, el("option", { value: "writer" }, "Écrit du code (writer)"),
      el("option", { value: "reader" }, "Lecture seule (reader)"), el("option", { value: "planner" }, "Planificateur (notes seulement)")),
    engine: el("input", { type: "text", maxlength: "200", placeholder: "Facultatif : fournisseur/modèle (ex. claude-openrouter/sonnet)" }),
  };
  let editingId = "";
  const error = el("p", { class: "form-error", role: "alert" });
  const title = el("h3", {}, "Nouvel agent");
  const reset = () => { editingId = ""; title.textContent = "Nouvel agent"; for (const k of Object.keys(f)) f[k].value = k === "role" ? "writer" : ""; error.textContent = ""; };
  const fill = (list) => list.replaceChildren(...profiles.map((p) => el("li", {},
    el("span", { class: "grow" }, el("strong", {}, `${p.name} `), el("code", {}, `@${p.id}`), el("small", {}, p.description || "")),
    el("button", { type: "button", class: "btn btn-sm", onclick: () => {
      editingId = p.id; title.textContent = `Modifier « ${p.name} »`;
      for (const k of Object.keys(f)) f[k].value = p[k] || (k === "role" ? "writer" : "");
    } }, "Modifier"),
    el("button", { type: "button", class: "btn btn-sm btn-danger-ghost", onclick: async () => {
      const ok = await ctx.confirm?.({ title: "Supprimer cet agent ?", message: `« ${p.name} » ne sera plus proposé. Les agents de base peuvent être restaurés.`, confirmLabel: "Supprimer", danger: true });
      if (ok) send({ type: "profile.delete", id: p.id });
    } }, "Supprimer"))));
  const save = el("button", { type: "button", class: "btn btn-primary", onclick: () => {
    const name = f.name.value.trim();
    if (!name || !f.instructions.value.trim()) { error.textContent = "Le nom et la consigne sont obligatoires."; return; }
    error.textContent = "";
    send({ type: "profile.save", profile: { id: editingId || slug(name), name, description: f.description.value, instructions: f.instructions.value,
      role: f.role.value, engine: f.engine.value } });
    reset();
  } }, "Enregistrer");
  dialog.append(el("div", { class: "dialog-body" },
    el("header", { class: "dialog-head" }, el("h2", {}, "Agents de base"),
      el("button", { type: "button", class: "icon-btn", "aria-label": "Fermer", onclick: () => dialog.close() }, "×")),
    el("p", { class: "muted" }, "Écris @nom devant un message du groupe pour lui confier une tâche ; l'orchestrateur les utilise aussi (postectl agents)."),
    list, title,
    el("div", { class: "agents-form" }, field("Nom", f.name), field("À quoi il sert", f.description), field("Consigne", f.instructions),
      el("div", { class: "widget-form-cols" }, field("Rôle", f.role), field("Moteur", f.engine)), error,
      el("div", { class: "dialog-actions" },
        el("button", { type: "button", class: "btn", onclick: () => ctx.confirm?.({ title: "Restaurer les agents de base ?", message: "Les agents de base modifiés ou supprimés reviennent à leur version d'origine ; tes agents restent.", confirmLabel: "Restaurer" }).then((ok) => ok && send({ type: "profile.reset" })) }, "Restaurer les agents de base"),
        el("button", { type: "button", class: "btn", onclick: reset }, "Nouveau"), save))));
  const stop = ctx && on("profile.list", () => fill(list));
  dialog.addEventListener("close", () => { stop?.(); dialog.remove(); });
  fill(list);
  document.body.append(dialog);
  dialog.showModal();
}

const BRIEF_CSS = `
.grp-chat.is-brief > .grp-members, .grp-chat.is-brief > .grp-msgs, .grp-chat.is-brief > .grp-composer { display: none; }
.brief { display: none; flex: 1 1 auto; min-height: 0; flex-direction: column; gap: 10px; overflow: auto; }
.grp-chat.is-brief > .brief { display: flex; }
.brief-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.brief-bar h3 { margin: 0; font-size: var(--t-14); font-family: var(--police-titre); }
.brief-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.brief-cols > * { min-width: 0; }
.brief-md { background: var(--sol); border: 1px solid var(--trait); border-radius: var(--rayon-controle);
  padding: 8px 10px; overflow: auto; max-height: 420px; font-size: var(--t-13); overflow-wrap: anywhere; }
.brief-md h3, .brief-md h4, .brief-md h5 {
  margin: 10px 0 4px; font-family: var(--police-titre); font-size: var(--t-14); }
.brief-md h3 { font-size: var(--t-16); margin-top: 0; }
.brief-md p { margin: 4px 0; }
.brief-md ul { margin: 4px 0; padding-left: 18px; }
.brief-md blockquote {
  margin: 4px 0; padding-left: 8px; border-left: 3px solid var(--trait); color: var(--texte-doux); }
.brief-md code { font-family: var(--police-mono); font-size: var(--t-12); background: var(--panneau-2);
  padding: 0 3px; border-radius: 3px; }
.brief-edit { width: 100%; box-sizing: border-box; min-height: 300px; resize: vertical; font-family: var(--police-mono);
  font-size: var(--t-12); background: var(--sol); color: var(--texte); border: 1px solid var(--trait);
  border-radius: var(--rayon-controle); padding: 8px; }
.brief-edit:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.brief-note { margin: 0; padding: 8px 10px; background: var(--panneau-2); border: 1px solid var(--attention);
  border-radius: var(--rayon-controle); font-size: var(--t-13); overflow-wrap: anywhere; }
.brief-props { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.brief-prop { display: grid; gap: 4px; padding: 8px 10px; background: var(--panneau-2); border: 1px solid var(--trait);
  border-radius: var(--rayon-controle); overflow-wrap: anywhere; font-size: var(--t-13); }
.brief-prop-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.brief-label { margin: 0; font-size: var(--t-13); color: var(--texte-doux); }
@media (max-width: 720px) { .brief-cols { grid-template-columns: minmax(0, 1fr); } .brief-md { max-height: 260px; } }
`;
function ensureBriefStyle() {
  if (!document.getElementById("brief-style")) document.head.append(el("style", { id: "brief-style" }, BRIEF_CSS + AGENT_CSS));
  if (!document.getElementById("thread-style")) document.head.append(el("style", { id: "thread-style" }, THREAD_CSS));
}

// Fil intelligent (T38) : messages typés (pastilles), fils repliables (réponses sous leur question), question sans réponse en évidence,
// « Marquer résolu ». Le texte des messages reste du texte (nœuds texte) : jamais interprété.
const KIND_LABEL = {
  question: "Question", answer: "Réponse", decision: "Décision", handoff: "Passation", blocker: "Blocage", status: "Statut", fyi: "Info",
};
const THREAD_CSS = `
.grp-kind { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: var(--t-12); line-height: 18px;
  border: 1px solid var(--trait); background: var(--panneau); color: var(--texte-doux); vertical-align: middle; }
.grp-kind.kind-question { border-color: var(--accent); color: var(--accent); }
.grp-kind.kind-answer, .grp-kind.kind-decision { border-color: var(--ok); color: var(--ok); }
.grp-kind.kind-blocker { border-color: var(--danger); color: var(--danger); }
.grp-kind.kind-handoff { border-color: var(--attention); color: var(--attention); }
.grp-kind.kind-decision { font-weight: 600; }
.grp-from .grp-kind, .grp-from .grp-state { margin-left: 6px; }
.grp-state { display: inline-block; padding: 0 6px; border-radius: 999px; font-size: var(--t-12); line-height: 18px;
  border: 1px solid var(--trait); color: var(--texte-doux); vertical-align: middle; }
.grp-state.is-open { border-color: var(--attention); background: var(--attention); color: var(--sol); font-weight: 600; }
.grp-state.is-done { border-color: var(--ok); color: var(--ok); }
.grp-bubble.is-open { border-color: var(--attention); box-shadow: 0 0 0 1px var(--attention); }
.grp-thread { list-style: none; align-self: stretch; max-width: 100%; }
.grp-thread > details { border: 1px solid var(--trait); border-radius: var(--rayon-controle); background: var(--panneau);
  padding: 4px 8px; }
.grp-thread.is-open > details { border-color: var(--attention); box-shadow: 0 0 0 1px var(--attention); }
.grp-thread summary { cursor: pointer; font-size: var(--t-13); overflow-wrap: anywhere; display: flex; flex-wrap: wrap; gap: 6px;
  align-items: center; padding: 2px 0; }
.grp-thread summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.grp-replies { list-style: none; margin: 6px 0 2px; padding: 0 0 0 10px; border-left: 3px solid var(--trait); display: flex;
  flex-direction: column; gap: 6px; }
.grp-replies .grp-bubble { max-width: 100%; align-self: stretch; }
.grp-resolve { justify-self: start; }
@media (prefers-reduced-motion: reduce) { .grp-thread, .grp-bubble { transition: none; } }
`;
const kindChip = (kind) => (kind && kind !== "fyi" && KIND_LABEL[kind]
  ? el("span", { class: `grp-kind kind-${kind}`, dataset: { kind } }, KIND_LABEL[kind]) : null);
// État d'un fil : « Question sans réponse » en évidence tant que personne n'a répondu (ni marqué résolu).
const stateLabel = (m) => {
  if (m.status === "open") return m.kind === "blocker" ? "Blocage ouvert" : m.kind === "question" ? "Question sans réponse" : "Réponse attendue";
  return m.status === "answered" ? "Répondu" : m.status === "resolved" ? "Résolu" : null;
};
const stateChip = (m) => {
  const label = stateLabel(m);
  return label ? el("span", { class: `grp-state ${m.status === "open" ? "is-open" : "is-done"}`, dataset: { state: m.status } }, label) : null;
};
// Fils : une réponse (replyTo) se range sous le message de tête ; un message dont le parent n'est pas dans la liste reste en tête.
function buildThreads(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const rootOf = (m) => {
    let cur = m;
    for (let n = 0; n < 20 && cur.replyTo && byId.has(cur.replyTo); n++) cur = byId.get(cur.replyTo);
    return cur;
  };
  const groupsMap = new Map();
  for (const m of messages) {
    const r = rootOf(m);
    if (!groupsMap.has(r.id)) groupsMap.set(r.id, { root: r, replies: [] });
    if (r !== m) groupsMap.get(r.id).replies.push(m);
  }
  return [...groupsMap.values()];
}

// Aperçu Markdown simple, construit avec des nœuds DOM (aucun innerHTML : le texte reste du texte).
function renderMarkdown(text) {
  const root = el("div", { class: "brief-md", id: "brief-preview", "aria-label": "Aperçu de la fiche" });
  const inline = (line) => {
    const out = [];
    let last = 0;
    for (const m of line.matchAll(/\*\*[^*]+\*\*|`[^`]+`/g)) {
      if (m.index > last) out.push(line.slice(last, m.index));
      out.push(m[0][0] === "`" ? el("code", {}, m[0].slice(1, -1)) : el("strong", {}, m[0].slice(2, -2)));
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  let list = null;
  let quote = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (/^\s*<!--.*-->\s*$/.test(raw)) continue; // repères de blocs automatiques : masqués dans l'aperçu
    const item = /^\s*[-*]\s+(.*)$/.exec(raw);
    const head = /^(#{1,3})\s+(.*)$/.exec(raw);
    const q = /^>\s?(.*)$/.exec(raw);
    if (!item) list = null;
    if (!q) quote = null;
    if (head) root.append(el(`h${2 + head[1].length}`, {}, head[2]));
    else if (item) {
      if (!list) { list = el("ul"); root.append(list); }
      list.append(el("li", {}, inline(item[1])));
    } else if (q) {
      // lignes citées consécutives = un seul paragraphe ; une ligne « > » vide en commence un autre
      if (!quote) { quote = el("blockquote"); root.append(quote); }
      if (!q[1].trim() || !quote.lastChild) quote.append(el("div"));
      else quote.lastChild.append(" ");
      if (q[1].trim()) quote.lastChild.append(...inline(q[1]));
    }
    else if (raw.trim()) root.append(el("p", {}, inline(raw.trim())));
  }
  return root;
}

// Groupes = les MÊMES projets que le rail et les autres pages (suivis, Oracle d'abord, favoris en tête, même ordre).
// Les anciens groupes (projets qui ne sont plus suivis) n'apparaissent que si on coche « Afficher les anciens groupes »,
// ou s'ils ont une session active.
const ROLE_TXT = { writer: "Rédacteur", reader: "Lecteur", planner: "Planificateur" };
// Carte d'un agent du groupe : qui il est, quel modèle, sa mission, ce qu'il dit faire, depuis quand il est actif.
function agentCard(s) {
  const role = s.orchestrator ? "Orchestrateur" : s.observer ? "Observateur" : ROLE_TXT[s.role] || "Agent";
  const model = s.engine ? `${harnessLabel(s.engine)}${s.model ? ` · ${modelDisplay(s.engine, s.model)}` : ""}` : "";
  const mission = s.task?.title || s.title || "";
  const doing = s.statusText ? clip(s.statusText, 140) : "";
  const initial = String(s.label || "?").replace(/^[^\p{L}\p{N}]+/u, "").charAt(0).toUpperCase() || "?";
  return el("article", { class: `grp-agent${s.active ? "" : " is-idle"}${s.orchestrator ? " is-orch" : ""}`, dataset: { agent: s.label } },
    el("div", { class: "grp-agent-head" },
      el("span", { class: "grp-avatar", "aria-hidden": "true" }, initial),
      el("div", { class: "grp-agent-id" }, el("strong", {}, s.label), el("span", { class: "muted" }, [role, model].filter(Boolean).join(" · "))),
      led(s.active ? "ok" : s.status === "error" ? "danger" : "inactif", { pulse: s.active, label: s.active ? "travaille" : "inactif" })),
    mission ? el("p", { class: "grp-agent-mission" }, el("span", { class: "muted" }, "Mission : "), clip(mission, 160)) : null,
    doing ? el("p", { class: "grp-agent-doing" }, `« ${doing} »`) : null,
    el("div", { class: "grp-agent-foot muted" },
      s.lastActivityAt ? `actif ${relativeTime(s.lastActivityAt)}` : "",
      s.task?.status ? ` · tâche ${s.task.status}` : "",
      s.reservations ? ` · ${s.reservations} fichier${s.reservations > 1 ? "s" : ""} réservé${s.reservations > 1 ? "s" : ""}` : ""));
}

function groups() {
  const boardOf = new Map();
  for (const b of boardsNow) boardOf.set(dirKey(b.project.dir), b);
  const out = [];
  const seenKeys = new Set();
  for (const p of getProjects()) {
    const k = dirKey(p.dir);
    seenKeys.add(k);
    out.push({ k, dir: p.dir, host: p.host || "local", name: p.name || projectNameOf(p.dir), board: boardOf.get(k) ?? null });
  }
  const old = [];
  for (const b of boardsNow) {
    const k = dirKey(b.project.dir);
    if (seenKeys.has(k) || (!b.sessions.length && !(b.messages || []).length)) continue;
    const active = b.sessions.some((s) => s.active);
    if (showOld || active) old.push({ k, dir: b.project.dir, host: b.project.host, name: `${b.project.name} (ancien)`, board: b });
  }
  old.sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...old];
}

let tgLinks = null; // liens des groupes Telegram (tg.links), absents sur une instance de test
function mount(container, context) {
  ctx = context;
  const list = el("ul", { class: "grp-list", id: "grp-list", "aria-label": "Groupes de projets" });
  const pane = el("section", { class: "grp-chat", id: "grp-chat", "aria-label": "Conversation du groupe" });
  const root = el("div", { class: "view-page grp", id: "grp" },
    el("aside", { class: "grp-side" }, el("h1", { class: "view-title" }, "Groupes"),
      el("label", { class: "check grp-old" }, el("input", { type: "checkbox", id: "grp-old", checked: showOld,
        onchange: (e) => { showOld = e.target.checked; list.dataset.sig = ""; renderAll(); } }), " Afficher les anciens groupes"),
      list), pane);
  container.replaceChildren(root);
  ensureBriefStyle();

  // ---------- Fiche projet (T37) ----------
  const briefEdit = el("textarea", {
    class: "brief-edit", id: "brief-edit", spellcheck: "false", rows: "16",
    "aria-label": "Contenu de la fiche projet (Markdown)",
  });
  const currentGroup = () => groups().find((x) => x.k === selected);
  const sameDir = (m) => Boolean(m.dir) && dirKey(m.dir) === dirKey(currentGroup()?.dir);
  const briefTarget = () => {
    const g = currentGroup();
    return g ? { host: g.host || "local", dir: g.dir } : null;
  };
  const saveWith = (rev) => {
    briefPending = true;
    send({ type: "brief.save", ...briefTarget(), text: briefEdit.value, rev });
  };
  // Boutons d'action persistants (jamais reconstruits à la frappe : le curseur du champ de texte reste en place).
  const saveBtn = el("button", {
    type: "button", class: "btn btn-sm btn-primary", dataset: { action: "brief-save" },
    onclick: () => saveWith(brief.rev),
  }, "Enregistrer");
  const revertBtn = el("button", {
    type: "button", class: "btn btn-sm", dataset: { action: "brief-revert" },
    onclick: () => { briefEdit.value = brief.text; briefDirty = false; syncBrief(); },
  }, "Annuler mes modifications");
  const dirtyNote = el("span", { class: "muted", role: "status" });
  function syncBrief() {
    saveBtn.disabled = !briefDirty;
    revertBtn.hidden = !briefDirty;
    dirtyNote.textContent = briefDirty ? "Modifications non enregistrées." : "À jour.";
    pane.querySelector("#brief-preview")?.replaceWith(renderMarkdown(briefEdit.value));
  }
  briefEdit.addEventListener("input", () => {
    briefDirty = briefEdit.value !== (brief?.text ?? "");
    syncBrief();
  });

  function renderBriefButton() {
    const btn = pane.querySelector("#grp-brief-btn");
    if (!btn) return;
    const n = brief?.proposals?.length || 0;
    const badge = n ? el("span", { class: "tab-badge", title: "Propositions en attente" }, String(n)) : null;
    btn.replaceChildren(...["Fiche projet", badge].filter(Boolean)); // (replaceChildren écrirait « null » pour un enfant nul)
    btn.setAttribute("aria-expanded", briefOpen ? "true" : "false");
  }
  function toggleBrief(g) {
    briefOpen = !briefOpen;
    pane.classList.toggle("is-brief", briefOpen);
    if (briefOpen) send({ type: "brief.get", host: g.host || "local", dir: g.dir });
    renderBrief();
  }
  const decide = (id, approve) => {
    briefDeciding.add(id);
    renderBrief();
    send({ type: "brief.proposal.decide", id, approve });
  };
  const button = (label, action, onclick, cls = "", extra = {}) => el("button", {
    type: "button", class: `btn btn-sm ${cls}`.trim(), dataset: { action }, onclick, ...extra,
  }, label);

  function conflictBox() {
    const reload = () => {
      brief = { ...brief, text: briefConflict.text, rev: briefConflict.rev, updatedAt: briefConflict.updatedAt };
      briefEdit.value = briefConflict.text;
      briefDirty = false;
      briefConflict = null;
      renderBrief();
    };
    const overwrite = () => {
      const { rev } = briefConflict;
      briefConflict = null;
      saveWith(rev);
      renderBrief();
    };
    return el("div", { class: "brief-note", role: "alert", id: "brief-conflict" },
      el("p", {}, "La fiche a changé sur le poste depuis que tu l'as ouverte (autre éditeur, proposition acceptée…). "
        + "Rien n'a été enregistré."),
      el("div", { class: "brief-prop-actions" },
        button("Charger la version du poste", "brief-reload", reload),
        button("Écraser avec mon texte", "brief-overwrite", overwrite, "btn-danger-ghost")));
  }
  const proposalItem = (p) => el("li", { class: "brief-prop", dataset: { proposal: p.id } },
    el("span", {}, el("strong", {}, p.section), ` : ${p.text}`),
    p.why ? el("span", { class: "muted" }, `Pourquoi : ${p.why}`) : null,
    el("span", { class: "muted" }, `Proposé par ${p.sessionLabel} · ${clock(p.at)}`),
    el("div", { class: "brief-prop-actions" },
      button("Accepter", "brief-accept", () => decide(p.id, true), "btn-primary",
        { disabled: !brief.exists || briefDeciding.has(p.id) }),
      button("Refuser", "brief-refuse", () => decide(p.id, false), "", { disabled: briefDeciding.has(p.id) })));

  function renderBrief() {
    renderBriefButton();
    const panel = pane.querySelector("#grp-brief");
    if (!panel || !briefOpen) return;
    const t = briefTarget();
    const kids = [el("div", { class: "brief-bar" },
      el("h3", {}, `Fiche projet — ${currentGroup()?.name || ""}`),
      brief?.updatedAt
        ? el("span", { class: "muted" }, `PASEO-PROJECT.md · mise à jour ${clock(brief.updatedAt)}`) : null,
      button("Fermer", "brief-close", () => toggleBrief(currentGroup())))];
    if (!brief) kids.push(el("p", { class: "muted", role: "status" }, "Chargement de la fiche…"));
    else {
      if (brief.problem) kids.push(el("p", { class: "brief-note", role: "alert" }, brief.problem));
      if (briefConflict) kids.push(conflictBox());
      if (brief.external) {
        const ack = () => send({ type: "brief.ack", ...t });
        kids.push(el("div", { class: "brief-note", role: "alert", id: "brief-external" },
          el("p", {}, "La fiche a été modifiée (ou supprimée) hors du poste : agent sans permissions, script "
            + `ou édition manuelle. Une copie de la dernière version connue est dans ${brief.bak || ".PASEO-PROJECT.md.bak"} ; `
            + "rien n'a été restauré ni écrasé."),
          el("div", { class: "brief-prop-actions" }, button("Reconnaître cette version", "brief-ack", ack))));
      }
      if (!brief.exists) {
        if (!brief.problem) {
          kids.push(el("p", {}, "Ce projet n'a pas encore de fiche. Elle est remplie sans modèle d'après README.md, "
            + "package.json, CLAUDE.md, AGENTS.md et le premier niveau du dossier (secrets masqués) ; "
            + "une fiche existante n'est jamais écrasée."));
          const create = () => { briefPending = true; send({ type: "brief.create", ...t }); };
          kids.push(el("div", { class: "brief-prop-actions" },
            button("Créer la fiche", "brief-create", create, "btn-primary")));
        }
      } else {
        kids.push(el("div", { class: "brief-cols" },
          el("div", {}, el("h4", { class: "brief-label" }, "Aperçu"), renderMarkdown(briefEdit.value)),
          el("div", {}, el("label", { for: "brief-edit" }, el("h4", { class: "brief-label" }, "Modifier (Markdown)")),
            briefEdit)));
        kids.push(el("div", { class: "brief-prop-actions" }, saveBtn, revertBtn, dirtyNote));
      }
      kids.push(el("h4", { class: "brief-label" }, "Propositions des sessions"));
      kids.push(el("ul", { class: "brief-props", id: "brief-props" }, ...(brief.proposals?.length
        ? brief.proposals.map(proposalItem) : [el("li", { class: "muted" }, "Aucune proposition en attente.")])));
    }
    const focused = document.activeElement === briefEdit;
    const sel = [briefEdit.selectionStart, briefEdit.selectionEnd, briefEdit.scrollTop];
    panel.replaceChildren(...kids);
    syncBrief();
    if (focused) { briefEdit.focus({ preventScroll: true }); briefEdit.setSelectionRange(sel[0], sel[1]); }
    briefEdit.scrollTop = sel[2];
  }
  function onBriefState(m) {
    if (!sameDir(m)) return;
    const ids = new Set((m.proposals || []).map((x) => x.id));
    for (const id of briefDeciding) if (!ids.has(id)) briefDeciding.delete(id);
    if (!briefDirty || briefPending || !m.exists) {
      briefConflict = null;
      brief = m;
      briefEdit.value = m.text;
      briefDirty = false;
      briefPending = false;
    } else {
      // texte en cours d'édition : on garde la version d'origine, le conflit sera signalé à l'enregistrement
      brief = { ...m, text: brief.text, rev: brief.rev };
    }
    renderBrief();
  }

  function renderList() {
    const all = groups();
    if (!selected && all.length && window.matchMedia("(min-width: 721px)").matches) selected = all[0].k;
    // Ne reconstruit la liste que si quelque chose a changé : un clic en cours ne tombe jamais sur un élément remplacé.
    const sig = JSON.stringify([selected, all.map((g) => [g.k, g.name, g.board ? unreadOf(g.board) : 0, g.board?.sessions.filter((s) => s.active).length || 0, g.board?.messages?.filter((m) => !m.system).at(-1)?.at || ""])]);
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.replaceChildren(...all.map((g) => {
      const unread = g.board ? unreadOf(g.board) : 0;
      const last = g.board?.messages?.filter((m) => !m.system).at(-1);
      const active = g.board ? g.board.sessions.filter((s) => s.active).length : 0;
      return el("li", {},
        el("button", {
          type: "button", class: `grp-item${g.k === selected ? " is-selected" : ""}`, dataset: { group: g.name },
          onclick: () => { selected = g.k; renderAll(); },
        },
        el("span", { class: "grp-item-top" },
          el("strong", { class: "grp-item-name" }, g.name),
          unread ? el("span", { class: "tab-badge", title: "Messages non lus" }, String(unread)) : null),
        el("span", { class: "muted grp-item-sub" },
          active ? `${active} session${active > 1 ? "s" : ""} active${active > 1 ? "s" : ""}` : g.board?.sessions.length ? `${g.board.sessions.length} inactive${g.board.sessions.length > 1 ? "s" : ""}` : "personne pour l'instant",
          last ? ` · ${last.from} : ${clip(last.text, 40)}` : "")));
    }), ...(all.length ? [] : [el("li", { class: "agv-none" }, "Aucun projet suivi : ajoute un projet dans la barre de gauche.")]));
  }

  // Squelette (en-tête, zone de saisie) construit une fois par groupe ; ensuite seuls le fil et les membres sont remplacés : la saisie n'est jamais perdue.
  function buildPane(g) {
    const input = el("input", { type: "text", id: "grp-input", class: "team-input", maxlength: "1000", "aria-label": `Message au groupe ${g.name}` });
    const post = (launch) => {
      const text = input.value.trim();
      if (!text) return;
      // « @review regarde le dernier changement » : confie la tâche à cet agent de base, dans ce projet.
      const at = /^@([a-z0-9-]+)\s+([\s\S]+)$/i.exec(text);
      const profile = at && profiles.find((p) => p.id === at[1].toLowerCase());
      if (profile) {
        pendingAgentTask = { name: profile.name };
        send({ type: "task.create", title: `${profile.name} — ${clip(at[2], 60)}`, description: at[2], project: g.dir,
          host: g.host || "local", profile: profile.id });
        input.value = "";
        ctx.toast?.(`${profile.name} : création de la tâche…`);
        return;
      }
      send({ type: "coord.group", host: g.host || "local", dir: g.dir, text, launch });
      input.value = "";
      ctx.toast?.(launch ? "Orchestrateur en cours de lancement…" : "Message envoyé au groupe.");
      setTimeout(() => requestThread(g), 700);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); post(false); } });
    const launchBtn = el("button", { type: "button", class: "btn btn-sm", id: "grp-launch", dataset: { action: "grp-launch" },
      title: "Active le Mode Agent sur ce projet avec ce message comme consigne : l'orchestrateur crée ses employés, qui rejoignent ce groupe",
      onclick: () => post(true) }, "Lancer l'orchestrateur");
    const strip = el("div", { class: "grp-agents", id: "grp-agents" });
    renderAgentStrip = () => strip.replaceChildren(
      el("span", { class: "label-caps" }, "Agents"),
      ...profiles.map((p) => el("button", { type: "button", class: "grp-agent-chip", title: p.description || p.name,
        onclick: () => { input.value = `@${p.id} ${input.value.replace(/^@[a-z0-9-]+\s*/i, "")}`; input.focus(); } }, `@${p.id}`)),
      el("button", { type: "button", class: "btn btn-sm", onclick: openAgentsDialog }, "Gérer les agents"));
    renderAgentStrip();
    pane.dataset.group = g.k;
    briefOpen = false; brief = null; briefDirty = false; briefConflict = null; briefPending = false;
    briefEdit.value = "";
    pane.classList.remove("is-brief");
    pane.replaceChildren(
      el("header", { class: "grp-head" },
        el("button", { type: "button", class: "btn btn-sm grp-back", dataset: { action: "grp-back" }, onclick: () => { selected = null; document.getElementById("grp")?.classList.remove("is-chat"); renderList(); renderChat(); } }, "← Groupes"),
        el("h2", {}, g.name),
        el("span", { class: "muted" }, hostLabel(g.host)),
        tgLinks ? el("a", { class: "btn btn-sm", href: tgLinks[{ "paseo-poste": "paseo-poste", blastwin: "blastwin" }[String(g.name).toLowerCase()] || "general"] || "#", target: "_blank", rel: "noopener noreferrer",
          title: "Ouvrir la discussion de ce projet dans Telegram" }, "Telegram") : null,
        el("button", { type: "button", class: "btn btn-sm", id: "grp-brief-btn", dataset: { action: "brief-open" },
          title: "Fiche du projet (PASEO-PROJECT.md), lue par toutes les sessions", onclick: () => toggleBrief(g) },
        "Fiche projet")),
      el("section", { class: "brief", id: "grp-brief", "aria-label": "Fiche projet" }),
      el("div", { class: "grp-members", id: "grp-members" }),
      el("ol", { class: "grp-msgs", id: "grp-msgs", "aria-live": "polite" }),
      strip,
      el("div", { class: "grp-composer" }, input,
        el("button", { type: "button", class: "btn btn-sm btn-primary", dataset: { action: "grp-send" }, onclick: () => post(false) }, "Envoyer"),
        launchBtn));
  }

  // ---------- Fil intelligent (T38) ----------
  const resolveThread = (id) => send({ type: "coord.thread.resolve", id });
  function bubble(m) {
    if (m.system) return el("li", { class: "grp-sys muted", dataset: { system: "1" } }, `${clock(m.at)} · ${m.text}`);
    const mine = m.from === "Philippe";
    return el("li", { class: `grp-bubble${mine ? " is-me" : ""}${m.status === "open" ? " is-open" : ""}`,
      dataset: { from: m.from, kind: m.kind || "fyi", id: m.id || "", status: m.status || "" } },
    el("span", { class: "grp-from" }, mine ? "Toi" : m.from, m.to && m.to !== "toute l'équipe" ? ` → ${m.to}` : "",
      kindChip(m.kind), stateChip(m)),
    el("span", { class: "grp-text" }, m.text),
    el("span", { class: "grp-meta muted" }, clock(m.at), mine ? (m.read ? " · lu" : " · envoyé") : "",
      m.mentions?.length ? ` · @${m.mentions.join(", @")}` : "", m.acks?.length ? ` · reçu par ${m.acks.join(", ")}` : "",
      m.reminded ? " · relancé" : ""),
    m.status === "open" ? button("Marquer résolu", "thread-resolve", () => resolveThread(m.id), "grp-resolve") : null);
  }
  // Un message avec réponses devient un fil repliable : ouvert tant qu'il attend quelque chose, replié une fois répondu ou résolu
  // (le choix de Philippe est mémorisé pour la session de la page).
  function threadNode({ root, replies }) {
    if (!replies.length) return bubble(root);
    const waiting = root.status === "open" || replies.some((r) => r.status === "open");
    const wanted = threadFold.get(root.id);
    const summary = el("summary", { dataset: { action: "thread-toggle" } }, kindChip(root.kind), stateChip(root),
      el("strong", {}, root.from === "Philippe" ? "Toi" : root.from), ` : ${clip(root.text, 80)}`,
      el("span", { class: "muted" }, ` · ${replies.length} réponse${replies.length > 1 ? "s" : ""}`));
    const details = el("details", {}, summary, el("ol", { class: "grp-replies" }, bubble(root), ...replies.map(bubble)));
    details.open = wanted ?? waiting;
    summary.addEventListener("click", () => threadFold.set(root.id, !details.open));
    return el("li", { class: `grp-thread${waiting ? " is-open" : ""}`, dataset: { thread: root.id, replies: String(replies.length) } }, details);
  }

  function renderChat() {
    const g = groups().find((x) => x.k === selected);
    document.getElementById("grp")?.classList.toggle("is-chat", Boolean(g));
    if (!g) {
      delete pane.dataset.group;
      pane.replaceChildren(el("p", { class: "agv-none" }, "Choisis un groupe à gauche."));
      return;
    }
    if (pane.dataset.group !== g.k) buildPane(g);
    const board = g.board;
    const sessions = board?.sessions || [];
    const shown = sessions.filter((s) => s.active || s.orchestrator || showIdle);
    const idleCount = sessions.filter((s) => !s.active && !s.orchestrator).length;
    const hasOrchestrator = sessions.some((s) => s.orchestrator);
    const key = board?.project.key;
    const messages = getThread(g) || board?.messages || [];
    const box = pane.querySelector("#grp-msgs");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80 || !box.children.length;

    const chatSig = JSON.stringify([showIdle, shown.map((x) => [x.key, x.active, x.orchestrator, x.observer, x.statusText, x.task?.status, x.model, x.reservations]), idleCount,
      messages.map((m) => [m.id, m.at, m.text, m.read, m.kind, m.status, m.replyTo, (m.acks || []).length])]);
    if (box.dataset.sig === chatSig) { pane.querySelector("#grp-launch").hidden = hasOrchestrator; if (key) markSeen(key, messages.filter((m) => !m.system).at(-1)?.at); return; }
    box.dataset.sig = chatSig;
    // « Mission en cours » : la dernière demande de Philippe (ou d'Hermes en son nom) et qui l'a faite.
    const order = [...messages].reverse().find((m) => !m.system && /^Philippe/.test(m.from));
    const missionBox = order ? el("div", { class: "grp-mission" },
      el("strong", {}, "Mission en cours"),
      el("span", { class: "muted" }, ` — demandée par ${order.from === "Philippe" ? "toi" : order.from} · ${clock(order.at)}`),
      el("p", {}, clip(order.text, 240))) : null;
    pane.querySelector("#grp-members").replaceChildren(
      ...(missionBox ? [missionBox] : []),
      ...(shown.length ? [el("div", { class: "grp-agents" }, ...shown.map(agentCard))] : [el("span", { class: "muted" }, "Aucun agent dans ce groupe pour l'instant.")]),
      idleCount ? el("button", { type: "button", class: "btn btn-sm", dataset: { action: "grp-idle" }, onclick: () => { showIdle = !showIdle; renderChat(); } },
        showIdle ? "Masquer les inactives" : `+ ${idleCount} inactive${idleCount > 1 ? "s" : ""}`) : "");
    box.replaceChildren(...(messages.length ? buildThreads(messages).map(threadNode)
      : [el("li", { class: "agv-none" }, "Aucun message. Écris ci-dessous : les sessions du projet te répondront, ou lance l'orchestrateur pour qu'il crée son équipe.")]));
    pane.querySelector("#grp-input").placeholder = hasOrchestrator ? "Écris au groupe (réveille les sessions au repos)…" : "Écris au groupe, ou lance l'orchestrateur avec ta consigne…";
    pane.querySelector("#grp-launch").hidden = hasOrchestrator;
    if (stick) box.scrollTop = box.scrollHeight;
    if (key) markSeen(key, messages.filter((m) => !m.system).at(-1)?.at);
  }

  function renderAll() {
    renderList();
    renderChat();
    const g = groups().find((x) => x.k === selected);
    if (g) requestThread(g);
    if (g && (!brief || dirKey(brief.dir) !== dirKey(g.dir))) {
      send({ type: "brief.get", host: g.host || "local", dir: g.dir });
    }
  }

  stops = [
    on("tg.links", (m) => { tgLinks = m.links || null; if (selected) renderChat(); }),
    subscribeCoord((boards) => { boardsNow = boards; renderList(); renderChat(); }),
    on("coord.thread", () => renderChat()),
    on("brief.state", onBriefState),
    on("brief.conflict", (m) => { if (!sameDir(m)) return; briefPending = false; briefConflict = m; renderBrief(); }),
    on("brief.changed", (m) => { const t = briefTarget(); if (t && sameDir(m)) send({ type: "brief.get", ...t }); }),
    on("error", () => { if (briefDeciding.size) { briefDeciding.clear(); renderBrief(); } }),
    on("brief.proposal.decided", (m) => {
      briefDeciding.delete(m.id);
      ctx.toast?.(m.approved ? "Proposition acceptée : la ligne a été ajoutée à la fiche." : "Proposition refusée.");
    }),
    on("coord.thread.resolved", (m) => {
      ctx.toast?.(m.resolved ? "Fil marqué résolu." : "Fil rouvert.");
      const g = currentGroup();
      if (g) requestThread(g);
    }),
    on("coord.groupSent", (m) => { ctx.toast?.(m.launched ? "Orchestrateur lancé : ses employés rejoindront le groupe." : `Message envoyé (${m.recipients} session${m.recipients > 1 ? "s" : ""}).`); }),
  ];
  stops.push(on("profile.list", (m) => { profiles = m.profiles || []; renderAgentStrip(); }),
    on("task.created", (m) => {
      if (!pendingAgentTask) return;
      const { name } = pendingAgentTask;
      pendingAgentTask = null;
      send({ type: "task.start", id: m.id });
      ctx.toast?.(`${name} lancé sur ce projet (voir l'onglet Tâches).`);
    }));
  send({ type: "profile.list" });
  send({ type: "coord.get" });
  send({ type: "project.list" });
  send({ type: "tg.links" });
  boardsNow = [];
  renderAll();
  timer = setInterval(() => { const g = groups().find((x) => x.k === selected); if (g) requestThread(g); }, 6000);
}

function unmount() {
  briefDeciding.clear();
  briefOpen = false; brief = null; briefDirty = false; briefConflict = null; briefPending = false;
  clearInterval(timer);
  stops.forEach((fn) => fn());
  stops = [];
  ctx = null;
}

const view = { id: "groupes", title: "Groupes", short: "Groupes", icon: icons.group, order: 26, mount, unmount };
registerView(view);
export default view;
