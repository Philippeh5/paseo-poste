// Onglet « Orchestrateur » de la page Agents (ex-vue « Agent » T31, ancre #agent → #agents) : que fait l'agent MAINTENANT ? Mandat, orchestrateur, tâches créées par l'agent, sessions et
// terminaux du projet, activité et permissions en attente. Tout est mis à jour en direct, sans recharger.
// Tous les textes dynamiques passent par textContent (el() crée des nœuds texte) : aucun innerHTML.
import { el, icons, led, agentStatus, folderName } from "../core/util.js";
import { subscribeAgentMode, openAgentModeDialog, disableAgentMode } from "../components/agentmode.js";
import { mountActivityList, relativeTime } from "../components/agentactivity.js";
import { watchAgent, coalesce } from "../core/agentfeed.js";
import { allProjects, agentsOfProject, terminalsOfProject, sameDir, findAgent, defaultHost } from "../core/state.js";
import { hostLabel } from "../core/names.js";
import { mountTeam } from "../components/coordteam.js";
import {
  subscribeAlerts, visibleAlerts, minutesSince, waitingText, stalledText, ORPHAN_TEXT, policyBox,
} from "../components/agentalerts.js";

const COLUMN = { todo: "À faire", doing: "En cours", review: "À valider", done: "Terminé", blocked: "Bloquée" };
const TONE = { todo: "inactif", doing: "ok", review: "attention", done: "inactif", blocked: "danger" };
const PREVIEW_LINES = 8;
const MAX_DESK = 12;
const TICK_MS = 2000;

let ctx = null;
let root = null;
let refs = null;
let mode = null;
let tasks = [];
let selected = null; // { kind: "agent" | "terminal", host, id }
let scrollback = null; // { host, terminalId, lines }
let orchestratorFeed = { key: "", stop: null, entries: [] };
let selectedFeed = { key: "", stop: null, entries: [] };
let answered = new Set();
let cleanups = [];
let timer = 0;
let stopAllBox = null; // case « Arrêter aussi les tâches de l'agent » : gardée d'un rendu à l'autre
let backups = { runId: null, list: [], total: 0 }; // sauvegardes de l'exécution active (T34)
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

const one = (text, max = 240) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const when = (iso) => (iso ? relativeTime(iso) : "—");

// Remplace le contenu d'une liste seulement s'il a changé (pas de clignotement, le focus clavier est conservé).
const serializer = new XMLSerializer();
const signature = (nodes) => nodes.map((n) => serializer.serializeToString(n)).join("");
function swap(container, nodes) {
  if (container.dataset.sig === signature(nodes)) return;
  container.dataset.sig = signature(nodes);
  container.replaceChildren(...nodes);
}

// ---------- Données dérivées ----------
function agentTasks() {
  if (!mode?.enabled) return [];
  return tasks.filter((t) => t.origin === "agent" && t.id !== mode.orchestratorTaskId &&
    (mode.runId ? t.agentRun === mode.runId : !mode.since || t.createdAt >= mode.since));
}
const orchestratorTask = () => (mode?.orchestratorTaskId ? tasks.find((t) => t.id === mode.orchestratorTaskId) : null);

function projectInfo(state) {
  if (!mode?.enabled) return null;
  const known = allProjects(state).find((p) =>
    (mode.projectDir && sameDir(p.directory, mode.projectDir) && (!mode.projectHost || p.host === mode.projectHost)) ||
    (!mode.projectDir && (p.name || "").toLowerCase() === String(mode.project || "").toLowerCase()));
  if (known) return known;
  return mode.projectDir
    ? { host: mode.projectHost || defaultHost(), directory: mode.projectDir, name: folderName(mode.projectDir), workspaceIds: [] }
    : null;
}

function projectSessions(state) {
  const project = projectInfo(state);
  const byId = new Map(agentTasks().concat(orchestratorTask() || []).filter((t) => t.agentId)
    .map((t) => [`${t.host}\0${t.agentId}`, t]));
  const agents = (project ? agentsOfProject(state, project) : [])
    .filter((a) => a.status !== "closed");
  for (const t of byId.values()) {
    const agent = findAgent(state, t.host, t.agentId);
    if (agent && agent.status !== "closed" && !agents.includes(agent)) agents.push(agent);
  }
  // Ce qui travaille ou attend en premier, puis les sessions de l'agent, puis le reste.
  const rank = (x) => (x.status === "waiting-permission" ? 0 : ["running", "initializing"].includes(x.status) ? 1 : 2);
  agents.sort((x, y) => rank(x) - rank(y) ||
    Number(byId.has(`${y.host}\u0000${y.agentId}`)) - Number(byId.has(`${x.host}\u0000${x.agentId}`)));
  const terminals = project ? terminalsOfProject(state, project) : [];
  return { project, agents, terminals, byId };
}

// ---------- Fils (orchestrateur et session choisie) ----------
function textOf(entries) {
  const lines = [];
  for (const entry of coalesce(entries || [])) {
    const item = entry?.item || entry?.event?.item;
    if (!item) continue;
    if (item.type === "assistant_message" && item.text) lines.push(...String(item.text).split(/\r?\n/));
    else if (item.type === "user_message" && item.text) lines.push(`> ${one(item.text, 160)}`);
    else if (item.type === "tool_call") {
      const input = item.detail?.input || {};
      const detail = input.command || input.description || input.file_path || input.path || "";
      lines.push(`Outil : ${item.name || "outil"}${detail ? ` — ${one(detail, 120)}` : ""}`);
    }
  }
  return lines.map((l) => l.trimEnd()).filter((l) => l.trim());
}
const lastSentence = (entries) => {
  const items = coalesce(entries || []).map((e) => e?.item || e?.event?.item).filter((i) => i?.type === "assistant_message");
  const last = items.at(-1)?.text;
  if (!last) {
    // Pas encore de phrase écrite : on montre au moins sa dernière action (outil lancé).
    const action = textOf(entries).filter((l) => l.startsWith("Outil :")).at(-1);
    if (action) return `Dernière action — ${one(action.replace(/^Outil : /, ""), 200)}`;
    const thinking = (entries || []).some((e) => ["reasoning", "thought", "thinking"].includes((e?.item || e?.event?.item)?.type));
    return thinking ? "Réflexion en cours…" : "";
  }
  const lines = String(last).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return `« ${one(lines.at(-1) || "")} »`;
};

function watchInto(slot, host, agentId, onChange) {
  const key = host && agentId ? `${host}\0${agentId}` : "";
  if (slot.key === key) return;
  slot.stop?.();
  slot.key = key;
  slot.entries = [];
  slot.stop = key ? watchAgent(host, agentId, (entries) => { slot.entries = entries; onChange(); }) : null;
}

// ---------- Rendu ----------
function orchestratorStatus(state) {
  const launch = mode.launch;
  const task = orchestratorTask();
  if (launch?.status === "failed") {
    return { tone: "danger", label: "N'a pas pu démarrer", detail: launch.error || "" };
  }
  if (!mode.orchestratorTaskId) {
    return { tone: "inactif", label: "Pas lancé automatiquement", detail: "Le mandat est posé : un agent peut le lire avec « postectl mandate »." };
  }
  if (!task) return { tone: "attention", label: "En train de démarrer", detail: "" };
  const agent = task.agentId ? findAgent(state, task.host, task.agentId) : null;
  if (task.status === "todo") return { tone: "attention", label: "En train de démarrer", detail: "" };
  if (task.status === "blocked") return { tone: "danger", label: "Arrêté", detail: task.reason || "" };
  if (task.status === "review" || task.status === "done") return { tone: "ok", label: "Terminé", detail: "" };
  if (task.error) return { tone: "danger", label: "Erreur", detail: task.error };
  if (task.permission || agent?.status === "waiting-permission") {
    return { tone: "attention", pulse: true, label: "En attente de permission", detail: "" };
  }
  if (agent?.status === "idle") return { tone: "ok", label: "En attente", detail: "" };
  return { tone: "ok", pulse: true, label: "En train de travailler", detail: "" };
}

function renderHeader(state) {
  const head = refs.head;
  if (!mode?.enabled) {
    head.replaceChildren(el("div", { class: "agv-empty" },
      el("h2", {}, "Jarvis n'a pas de mission en cours"),
      el("p", {}, "Le Mode Agent est inactif : vous gardez la main. Confiez le poste pour voir ici ce que fait l'agent."),
      el("button", { class: "btn btn-primary", type: "button", id: "agv-entrust", onclick: () => openAgentModeDialog() },
        "Confier le poste à un agent")));
    return;
  }
  const status = orchestratorStatus(state);
  const phrase = lastSentence(orchestratorFeed.entries);
  const task = orchestratorTask();
  const stopAll = stopAllBox;
  head.replaceChildren(
    el("div", { class: "agv-head-top" },
      el("div", { class: "agv-head-state" },
        led("ok", { pulse: true, label: "Mode Agent actif" }),
        el("strong", { id: "agv-mode-state" }, "Mode Agent actif"),
        el("span", { class: "muted" }, `depuis ${when(mode.since)}`)),
      el("div", { class: "agv-head-actions" },
        el("label", { class: "check" }, stopAll, " Arrêter aussi les tâches de l'agent"),
        el("button", {
          class: "btn btn-sm btn-agentmode-takeover", type: "button", id: "agv-takeover",
          onclick: () => disableAgentMode({ stopTasks: stopAll.checked }),
        }, "Reprendre la main"))),
    el("dl", { class: "agv-facts" },
      el("div", {}, el("dt", {}, "Projet"), el("dd", { id: "agv-project" }, mode.project || "—")),
      el("div", {}, el("dt", {}, "Moteur"), el("dd", {}, mode.engine || "non lancé")),
      el("div", {}, el("dt", {}, "Interdictions"),
        el("dd", {}, mode.forbidden.length
          ? el("span", { class: "agv-tags" }, ...mode.forbidden.map((f) => el("span", { class: "tag" }, f)))
          : "aucune")),
      el("div", {}, el("dt", {}, "Permissions"),
        el("dd", { id: "agv-permissions" }, mode.autoPermissions ? "Réponse automatique à ce qui est sûr" : "Tout attend votre réponse")),
      el("div", {}, el("dt", {}, "Peut modifier"),
        el("dd", { id: "agv-writescope" }, mode.writeScope?.length ? mode.writeScope.join(", ") : "tout le dossier du projet")),
      el("div", {}, el("dt", {}, "git commit"), el("dd", {}, mode.allowGit ? "autorisé" : "refusé")),
      el("div", { class: "agv-wide" }, el("dt", {}, "Consigne"),
        el("dd", { class: "agv-brief" }, mode.brief || "(aucune consigne spécifique)"))),
    el("div", { class: `agv-orch is-${status.tone}`, id: "agv-orch" },
      led(status.tone, { pulse: Boolean(status.pulse), label: status.label }),
      el("div", { class: "agv-orch-main" },
        el("strong", {}, `Agent : ${status.label.toLowerCase()}`),
        status.detail && el("span", { class: "muted" }, ` — ${one(status.detail, 200)}`),
        phrase && el("p", { class: "agv-phrase", id: "agv-phrase" }, phrase)),
      task?.agentId && el("button", {
        class: "btn btn-sm", type: "button",
        onclick: () => ctx.drawer.openAgent(task.host, task.agentId),
      }, "Ouvrir la session")),
  );
}

function taskCard(task) {
  const agent = task.agentId ? findAgent(ctx.state, task.host, task.agentId) : null;
  const flag = task.error ? { text: "Erreur", cls: "tag-error" }
    : task.permission ? { text: "Permission requise", cls: "tag-blocked" } : null;
  const open = () => {
    const current = tasks.find((t) => t.id === task.id) || task;
    if (current.agentId) ctx.drawer.openAgent(current.host, current.agentId);
    else ctx.toast("Cette tâche n'a pas encore de session.");
  };
  return el("li", { class: "agv-task", dataset: { id: task.id } },
    el("button", { class: "agv-task-open", type: "button", onclick: open },
      led(TONE[task.status] || "inactif", { pulse: task.status === "doing", label: COLUMN[task.status] }),
      el("span", { class: "agv-task-title" }, task.title)),
    el("div", { class: "agv-task-meta" },
      el("span", { class: "tag" }, COLUMN[task.status] || task.status),
      flag && el("span", { class: `tag ${flag.cls}` }, flag.text),
      el("span", { class: "muted mono" }, task.engine || "moteur ?"),
      el("span", { class: "muted" }, `activité ${when(task.updatedAt)}`),
      agent && el("span", { class: "muted" }, agentStatus(agent.status).label)));
}

function renderTasks() {
  const list = agentTasks();
  refs.tasksCount.textContent = String(list.length);
  swap(refs.tasks, list.length ? list.map(taskCard)
    : [el("li", { class: "agv-none" }, mode?.enabled
      ? "L'agent n'a pas encore créé de tâche."
      : "Aucune tâche d'agent à montrer.")]);
}

function selectRow(next) {
  selected = next;
  if (next?.kind === "agent") watchInto(selectedFeed, next.host, next.id, renderPreview);
  else watchInto(selectedFeed, null, null, renderPreview);
  scrollback = null;
  renderSessions();
  renderPreview();
  pollScrollback();
}

function sessionRow({ kind, host, id, title, tone, label, pulse, sub, onOpen, isAgent }) {
  const active = selected && selected.kind === kind && selected.host === host && selected.id === id;
  return el("li", { class: `agv-row${active ? " is-selected" : ""}`, dataset: { kind, id } },
    el("button", {
      class: "agv-row-main", type: "button", "aria-pressed": String(Boolean(active)),
      onclick: () => selectRow({ kind, host, id }),
    },
    led(tone, { pulse, label }),
    el("span", { class: "agv-row-text" },
      el("strong", {}, title),
      el("span", { class: "muted" }, sub)),
    isAgent && el("span", { class: "tag" }, "agent"),
    el("span", { class: "muted agv-row-state" }, label)),
    el("button", { class: "btn btn-sm", type: "button", onclick: onOpen }, "Ouvrir"));
}

function renderSessions() {
  const state = ctx.state;
  if (!mode?.enabled) {
    swap(refs.sessions, [el("li", { class: "agv-none" }, "Aucun projet suivi tant que le mode est inactif.")]);
    refs.deskBtn.disabled = true;
    return;
  }
  const { project, agents, terminals, byId } = projectSessions(state);
  const rows = [];
  for (const a of agents) {
    const st = agentStatus(a.status);
    rows.push(sessionRow({
      kind: "agent", host: a.host, id: a.agentId, title: a.title || `Session ${a.agentId.slice(0, 6)}`,
      tone: st.tone, label: st.label, pulse: st.tone === "ok" || a.status === "waiting-permission",
      sub: `session · ${hostLabel(a.host)}`, isAgent: byId.has(`${a.host}\0${a.agentId}`),
      onOpen: () => ctx.drawer.openAgent(a.host, a.agentId),
    }));
  }
  for (const t of terminals) {
    rows.push(sessionRow({
      kind: "terminal", host: t.host, id: t.terminalId, title: t.name || `Terminal ${t.terminalId.slice(0, 6)}`,
      tone: "ok", label: "ouvert", pulse: false, sub: `terminal · ${hostLabel(t.host)}`,
      onOpen: () => { ctx.desk.openTerminal(t.host, t.terminalId, { cwd: t.cwd, workspaceId: t.workspaceId }); ctx.navigate("bureau"); },
    }));
  }
  refs.sessionsTitle.textContent = project ? `Sessions et terminaux — ${project.name || folderName(project.directory)}` : "Sessions et terminaux";
  swap(refs.sessions, rows.length ? rows
    : [el("li", { class: "agv-none" }, "Aucune session ni terminal ouvert sur ce dossier.")]);
  refs.deskBtn.disabled = rows.length === 0;
}

function renderPreview() {
  if (!selected) {
    refs.previewTitle.textContent = "Aperçu";
    refs.preview.textContent = "Choisissez une session ou un terminal pour voir ses dernières lignes.";
    return;
  }
  refs.previewTitle.textContent = selected.kind === "terminal" ? "Aperçu du terminal" : "Aperçu de la session";
  let lines = [];
  if (selected.kind === "terminal") {
    lines = scrollback && scrollback.terminalId === selected.id ? scrollback.lines : [];
  } else {
    lines = textOf(selectedFeed.entries);
  }
  const tail = lines.slice(-PREVIEW_LINES).map((l) => String(l).slice(0, 400));
  refs.preview.textContent = tail.length ? tail.join("\n") : "(rien à afficher pour l'instant)";
}

function pollScrollback() {
  if (selected?.kind !== "terminal") return;
  const exists = (ctx.state.terminals || []).some((t) => t.host === selected.host && t.terminalId === selected.id);
  if (!exists) { selected = null; renderSessions(); renderPreview(); return; }
  ctx.send({ type: "windows.scrollback", host: selected.host, terminalId: selected.id, lines: PREVIEW_LINES });
}

function pendingPermissions(state) {
  if (!mode?.enabled) return [];
  const { agents } = projectSessions(state);
  return agents.flatMap((a) => (a.pending || []).filter((p) => !answered.has(p.id)).map((p) => ({ agent: a, request: p })));
}

// Détail lisible de la demande (commande ou fichier), texte brut plafonné.
function detailOf(request) {
  const raw = request.description || request.detail || request.command || request.body || request.subtitle || "";
  return typeof raw === "string" ? one(raw, 220) : "";
}

function renderPermissions() {
  const state = ctx.state;
  const items = pendingPermissions(state);
  refs.permCount.textContent = String(items.length);
  swap(refs.perms, (items.length ? items.map(({ agent, request }) => {
    const respond = (allow) => {
      const behavior = allow ? "allow" : "deny";
      const actionId = (request.actions || []).find((x) => x.behavior === behavior)?.id;
      answered.add(request.id);
      // Si la réponse n'a pas abouti (la demande reste en attente), elle réapparaît au bout de 6 s.
      setTimeout(() => { answered.delete(request.id); renderPermissions(); }, 6000);
      ctx.send({
        type: "perm.respond", host: agent.host, agentId: agent.agentId, requestId: request.id, behavior,
        ...(actionId ? { actionId } : {}),
      });
      renderPermissions();
    };
    return el("li", { class: "agv-perm", dataset: { id: request.id } },
      el("div", { class: "agv-perm-text" },
        el("strong", {}, one(request.title, 160)),
        detailOf(request) ? el("code", { class: "agv-perm-detail" }, detailOf(request)) : null,
        request.danger ? el("span", { class: "agv-perm-danger" }, "⚠ Demande signalée dangereuse") : null,
        el("span", { class: "muted" }, `${agent.title || "Session"} · ${hostLabel(agent.host)}`)),
      el("div", { class: "agv-perm-actions" },
        el("button", {
          class: "btn btn-sm btn-primary", type: "button",
          onclick: (event) => {
            // Une demande dangereuse exige un second clic explicite.
            if (request.danger && event.currentTarget.dataset.armed !== "1") {
              event.currentTarget.dataset.armed = "1";
              event.currentTarget.textContent = "Confirmer l'autorisation ?";
              return;
            }
            respond(true);
          },
        }, "Accepter"),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => respond(false) }, "Refuser")));
  }) : [el("li", { class: "agv-none" }, "Aucune permission en attente.")]));
}

// ---------- Alertes : agent bloqué, session muette, session orpheline (T34) ----------
function renderAlerts() {
  if (!refs?.alerts) return;
  const nodes = [];
  if (mode?.enabled) {
    const v = visibleAlerts();
    for (const w of v.waiting) {
      const min = minutesSince(w.since);
      nodes.push(el("li", { class: "agv-alert is-waiting", dataset: { kind: "waiting" } },
        el("strong", {}, waitingText(min)),
        el("span", { class: "muted" }, ` — ${one(w.taskTitle || w.title || "session", 80)} : ${w.requests.length} demande${w.requests.length > 1 ? "s" : ""} en attente (voir « Permissions en attente »)`)));
    }
    for (const s of v.stalled) {
      nodes.push(el("li", { class: "agv-alert is-stalled", dataset: { kind: "stalled" } },
        el("strong", {}, stalledText(minutesSince(s.since))),
        el("span", { class: "muted" }, ` — ${one(s.title, 80)}`),
        el("button", { class: "btn btn-sm", type: "button", onclick: () => ctx.drawer.openAgent(s.host, s.agentId) }, "Ouvrir la session")));
    }
    for (const o of v.orphans) {
      nodes.push(el("li", { class: "agv-alert is-orphan", dataset: { kind: "orphan" } },
        el("strong", {}, ORPHAN_TEXT),
        el("span", { class: "muted" }, ` — ${one(o.taskTitle || o.title || "session", 80)} (attente depuis ${minutesSince(o.since)} min)`),
        el("button", {
          class: "btn btn-sm btn-danger", type: "button", dataset: { action: "orphan-close" },
          onclick: () => ctx.send({ type: "permpolicy.closeOrphan", host: o.host, agentId: o.agentId }),
        }, "Refuser et fermer")));
    }
  }
  refs.alerts.hidden = nodes.length === 0;
  swap(refs.alerts, nodes);
}

// ---------- Sauvegardes (T34) ----------
function renderBackups() {
  if (!refs?.backups) return;
  const list = mode?.enabled ? backups.list : [];
  refs.backupsCount.textContent = String(list.length);
  refs.backupsTitle.textContent = `Sauvegardes de cette exécution (${list.length})`;
  swap(refs.backups, list.length ? list.slice(0, 60).map((b) => el("li", { class: "agv-backup", dataset: { id: b.id } },
    el("div", { class: "agv-backup-text" },
      el("strong", { class: "mono" }, b.rel),
      el("span", { class: "muted" }, `${when(b.at)} · ${sizeText(b.size)}${b.source === "avant-restauration" ? " · avant une restauration" : ""}`)),
    el("button", {
      class: "btn btn-sm", type: "button", dataset: { action: "restore" },
      onclick: async () => {
        const okay = await ctx.confirm({
          title: "Restaurer cette sauvegarde ?",
          message: `Le fichier « ${b.rel} » sera remplacé par la version du ${new Date(b.at).toLocaleString("fr-FR")}. ` +
            "La version actuelle est d'abord sauvegardée.",
          confirmLabel: "Restaurer", danger: true,
        });
        if (okay) ctx.send({ type: "agentbackup.restore", id: b.id, confirm: true });
      },
    }, "Restaurer")))
    : [el("li", { class: "agv-none" }, "Aucune sauvegarde : elles sont faites avant chaque modification de fichier.")]);
}

function deskAll() {
  const { agents, terminals } = projectSessions(ctx.state);
  let count = 0;
  for (const a of agents.slice(0, MAX_DESK)) {
    ctx.desk.openAgent(a.host, a.agentId, { cwd: a.cwd, title: a.title });
    count += 1;
  }
  for (const t of terminals.slice(0, Math.max(0, MAX_DESK - count))) {
    ctx.desk.openTerminal(t.host, t.terminalId, { cwd: t.cwd, workspaceId: t.workspaceId });
    count += 1;
  }
  ctx.toast(`${count} fenêtre${count > 1 ? "s" : ""} posée${count > 1 ? "s" : ""} sur le Bureau.`);
  ctx.navigate("bureau");
}

function renderAll() {
  if (!root) return;
  const task = orchestratorTask();
  watchInto(orchestratorFeed, task?.host, task?.agentId, renderHeaderOnly);
  renderHeader(ctx.state);
  renderTasks();
  renderSessions();
  renderPermissions();
  renderPreview();
  renderAlerts();
  renderBackups();
}
function renderHeaderOnly() {
  if (root) renderHeader(ctx.state);
}

function build() {
  const sessionsTitle = el("h2", {}, "Sessions et terminaux");
  const deskBtn = el("button", { class: "btn btn-sm", type: "button", id: "agv-desk", onclick: deskAll }, "Voir sur le Bureau");
  const tasksCount = el("span", { class: "col-count" }, "0");
  const permCount = el("span", { class: "col-count" }, "0");
  const previewTitle = el("h3", {}, "Aperçu");
  const preview = el("pre", { class: "agv-preview", id: "agv-preview", "aria-live": "polite" });
  const head = el("section", { class: "agv-head", "aria-label": "État du mode Agent" });
  const tasksList = el("ul", { class: "agv-list", id: "agv-tasks" });
  const sessionsList = el("ul", { class: "agv-list", id: "agv-sessions" });
  const permList = el("ul", { class: "agv-list", id: "agv-perms" });
  const activity = el("ol", { class: "agentactivity-list agv-activity", id: "agv-activity", "aria-live": "polite" });
  const alertsList = el("ul", { class: "agv-alerts", id: "agv-alerts", "aria-live": "polite", hidden: true });
  const backupsCount = el("span", { class: "col-count" }, "0");
  const backupsTitle = el("h2", {}, "Sauvegardes de cette exécution (0)");
  const backupsList = el("ul", { class: "agv-list", id: "agv-backups" });
  const teamPanel = el("section", { class: "agv-panel agv-team", id: "agv-team", "aria-label": "Équipe : qui travaille sur quoi" });
  cleanups.push(mountTeam(teamPanel, ctx));
  refs = {
    head, tasks: tasksList, tasksCount, sessions: sessionsList, sessionsTitle, deskBtn, preview, previewTitle,
    perms: permList, permCount, alerts: alertsList, backups: backupsList, backupsCount, backupsTitle,
  };
  cleanups.push(mountActivityList(activity, { limit: 40 }));
  return el("div", { class: "view-page agentview" },
    el("div", { class: "view-toolbar" }, el("h1", { class: "view-title" }, "Agent")),
    head,
    alertsList,
    teamPanel,
    el("div", { class: "agv-grid" },
      el("section", { class: "agv-panel", "aria-label": "Tâches créées par l'agent" },
        el("header", { class: "agv-panel-head" }, el("h2", {}, "Tâches créées par l'agent"), tasksCount), tasksList),
      el("section", { class: "agv-panel", "aria-label": "Sessions et terminaux" },
        el("header", { class: "agv-panel-head" }, sessionsTitle, deskBtn), sessionsList,
        el("div", { class: "agv-preview-box" }, previewTitle, preview))),
    el("div", { class: "agv-grid" },
      el("section", { class: "agv-panel", "aria-label": "Activité de l'agent" },
        el("header", { class: "agv-panel-head" }, el("h2", {}, "Activité de l'agent")), activity),
      el("section", { class: "agv-panel", "aria-label": "Permissions en attente" },
        el("header", { class: "agv-panel-head" }, el("h2", {}, "Permissions en attente"), permCount), permList)),
    el("div", { class: "agv-grid" },
      el("section", { class: "agv-panel", "aria-label": "Sauvegardes de cette exécution" },
        el("header", { class: "agv-panel-head" }, backupsTitle, backupsCount), backupsList),
      el("section", { class: "agv-panel", "aria-label": "Règles de permission" },
        el("header", { class: "agv-panel-head" }, el("h2", {}, "Règles de permission du mandat")),
        el("div", { class: "agv-policy" }, policyBox({ id: "agv-policy-box" })))),
  );
}

const view = {
  id: "agent",
  title: "Agent",
  short: "Agent",
  icon: icons.agent,
  order: 25,
  mount(container, context) {
    ctx = context;
    mode = null;
    tasks = [];
    selected = null;
    scrollback = null;
    answered = new Set();
    stopAllBox = el("input", { type: "checkbox", id: "agv-stop-tasks" });
    orchestratorFeed = { key: "", stop: null, entries: [] };
    selectedFeed = { key: "", stop: null, entries: [] };
    root = el("div", { class: "view-host" });
    container.replaceChildren(root);
    root.append(build());
    cleanups.push(
      subscribeAgentMode((m) => { mode = m; renderAll(); }),
      ctx.on("tasks", (m) => { tasks = Array.isArray(m.tasks) ? m.tasks : []; renderAll(); }),
      ctx.on("windows.scrollback", (m) => {
        if (selected?.kind === "terminal" && m.terminalId === selected.id) {
          scrollback = { terminalId: m.terminalId, lines: Array.isArray(m.lines) ? m.lines : [] };
          renderPreview();
        }
      }),
      ctx.onState(() => { renderAll(); }),
      ctx.onConnection((up) => { if (up) { ctx.send({ type: "task.list" }); ctx.send({ type: "agentbackup.list" }); } }),
      subscribeAlerts(() => renderAlerts()),
      ctx.on("agentbackup.list", (m) => {
        backups = { runId: m.runId || null, list: Array.isArray(m.backups) ? m.backups : [], total: m.total || 0 };
        renderBackups();
      }),
      ctx.on("agentbackup.changed", () => ctx.send({ type: "agentbackup.list" })),
      ctx.on("agentbackup.restored", (m) => {
        ctx.toast(`Fichier restauré : ${m.rel}${m.savedCurrent ? " (la version précédente est sauvegardée)" : ""}`);
        ctx.send({ type: "agentbackup.list" });
      }),
      ctx.on("permpolicy.orphanClosed", () => ctx.toast("Session refusée et fermée.")),
    );
    ctx.send({ type: "task.list" });
    ctx.send({ type: "agentbackup.list" });
    ctx.send({ type: "permpolicy.alerts.get" });
    backups = { runId: null, list: [], total: 0 };
    timer = setInterval(() => { pollScrollback(); renderHeaderOnly(); renderTasks(); renderAlerts(); renderBackups(); }, TICK_MS);
    renderAll();
  },
  unmount() {
    clearInterval(timer);
    cleanups.forEach((fn) => fn());
    cleanups = [];
    orchestratorFeed.stop?.();
    selectedFeed.stop?.();
    root = null;
    refs = null;
  },
};

export default view;
