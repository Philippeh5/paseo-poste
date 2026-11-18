// API de contrôle pour agents (T17) : routes JSON sous /api/v1/, flux SSE, journal d'audit.
// Aucune logique métier ici : chaque action passe par ctx.invoke(type, payload), qui exécute les mêmes handlers
// WebSocket que l'interface (mêmes validations et garde-fous). Voir dashboard/README.md, « Piloter le poste ».
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostLabel } from "../public/js/core/names.js";
import { redact } from "../lib/redact.mjs";
import { evaluatePermission, POLICY_TEXT } from "../lib/permpolicy.mjs";
import { SELF_HOST } from "../lib/selfhost.mjs";

const PREFIX = "/api/v1/";
const MAX_BODY = 64 * 1024;
const AUDIT_MAX_LINES = 5000;
const LOG_MAX = 1000;
const POLL_MS = 1000;
const HEARTBEAT_MS = 20000;
const ACTIVE = new Set(["running", "initializing"]);

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
// Refus du mandat (403) ; la catégorie interdite figure dans le journal d'activité.
const mandateRefusal = (category) =>
  Object.assign(new ApiError(403, "forbidden_by_mandate", "interdit par le mandat"), { category });
// T34 : tant qu'un mandat est actif, seul Philippe accepte ce que la politique ne juge pas sûr (anti auto-approbation).
const ownerOnly = () => Object.assign(
  new ApiError(403, "owner_only", "Seul Philippe peut accepter cette demande : ouvrez la vue Agent"),
  { category: "accepter une permission (seul Philippe)" },
);
const bad = (message, code = "bad_request") => new ApiError(400, code, message);
const missing = (message) => new ApiError(404, "not_found", message);

const folderOf = (dir) => (dir ? String(dir).replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "");
const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
// Aucun secret dans le journal : voir lib/redact.mjs (partagé avec handlers/permpolicy.mjs).
const cleanActor = (value) => String(value || "").replace(/[^\w.@ -]/g, "").trim().slice(0, 40) || "inconnu";
const strip = (message) => String(message ?? "").replace(/^Erreur\s*:\s*/, "");

function groupOf(status) {
  if (ACTIVE.has(status)) return "active";
  if (status === "waiting-permission") return "waiting";
  if (status === "error") return "error";
  return "idle";
}
const STATUS_ALIASES = { waiting: "waiting", "waiting-permission": "waiting", active: "active", running: "active",
  idle: "idle", closed: "idle", error: "error" };

export function register(ctx) {
  const { invoke, safeError } = ctx;
  const SECRET = process.env.DASHBOARD_PASSWORD || "";

  // ---------- Appels aux handlers existants ----------
  async function call(type, payload, opts) {
    const result = await invoke(type, payload, opts);
    if (result.error) throw bad(strip(result.error), "refused");
    return result;
  }
  const replyOf = (result, type) => result.replies.find((r) => r.type === type);
  const listTasks = async () => (replyOf(await call("task.list", {}), "tasks")?.tasks) || [];
  const listInbox = async (filter) => {
    const r = replyOf(await call("inbox.list", { filter }), "inbox.list");
    return { items: r?.items || [], unreadCount: r?.unreadCount ?? 0 };
  };
  const listProjects = async () => replyOf(await call("project.list", {}), "project.list")?.projects || [];

  // ---------- État des machines et sessions (cache alimenté par le cycle de 5 s du serveur) ----------
  let state = null;
  let stateAt = 0;
  ctx.onStateChange((s) => { state = s; stateAt = Date.now(); });
  async function getState(fresh = false) {
    if (!state || fresh) await ctx.broadcastState();
    if (!state) throw new ApiError(503, "unavailable", "état des machines indisponible");
    return state;
  }
  const taskByAgent = (tasks) => new Map(tasks.filter((t) => t.agentId).map((t) => [`${t.host}\0${t.agentId}`, t]));
  function mapSession(agent, byAgent) {
    const task = byAgent.get(`${agent.host}\0${agent.agentId}`);
    return {
      host: agent.host, id: agent.agentId, title: agent.title, status: agent.status, group: groupOf(agent.status),
      provider: agent.provider, model: agent.model, cwd: agent.cwd, project: folderOf(agent.cwd),
      parentId: agent.parentAgentId, durationMs: agent.duration,
      pendingPermissions: (agent.pending || []).map((p) => ({ requestId: p.id, title: p.title, actions: p.actions })),
      taskId: task?.id ?? null,
      origin: task?.origin || null, agentRun: task?.agentRun || null,
    };
  }
  // Sessions du cache d'état (rafraîchi toutes les 5 s) corrigées par la boîte de réception (interrogée toutes les
  // 500 ms) : une permission ouverte y apparaît presque aussitôt, la session passe donc tout de suite en attente.
  function liveSessions(st, tasks, inboxItems) {
    const byAgent = taskByAgent(tasks);
    const open = new Map();
    for (const i of inboxItems) {
      if (i.kind === "permission" && i.status !== "traité" && i.agentId && i.action?.requestId) {
        const key = `${i.host}\0${i.agentId}`;
        open.set(key, [...(open.get(key) || []), i]);
      }
    }
    return st.agents.map((a) => {
      const session = mapSession(a, byAgent);
      const items = open.get(`${a.host}\0${a.agentId}`);
      if (items && !session.pendingPermissions.length) {
        session.status = "waiting-permission";
        session.group = "waiting";
        session.pendingPermissions = items.map((i) => ({
          requestId: i.action.requestId, title: i.title, actions: i.action.actions || [],
        }));
      }
      return session;
    });
  }
  async function listSessions(query = {}) {
    const [st, tasks, inbox] = await Promise.all([getState(), listTasks(), listInbox()]);
    let rows = liveSessions(st, tasks, inbox.items);
    if (query.host) rows = rows.filter((r) => r.host === query.host);
    if (query.project) {
      const wanted = query.project.toLowerCase();
      rows = rows.filter((r) => r.project.toLowerCase() === wanted || (r.cwd || "").toLowerCase().includes(wanted));
    }
    if (query.status) {
      const want = STATUS_ALIASES[query.status] || query.status;
      rows = rows.filter((r) => r.status === query.status || r.group === want);
    }
    return rows;
  }
  async function findSession(host, id) {
    const rows = await listSessions({ host });
    const found = rows.find((r) => r.id === id);
    if (!found) throw missing(`session introuvable : ${host}/${id}`);
    return found;
  }

  // ---------- Résumé ----------
  async function summary(fresh) {
    const [st, tasks, inbox, projects] = await Promise.all([getState(fresh), listTasks(), listInbox(), listProjects()]);
    const sessions = liveSessions(st, tasks, inbox.items);
    const count = (group) => sessions.filter((s) => s.group === group).length;
    const columns = { todo: 0, doing: 0, review: 0, done: 0, blocked: 0 };
    for (const t of tasks) columns[t.status] = (columns[t.status] || 0) + 1;
    return {
      at: new Date().toISOString(),
      stateAgeMs: Date.now() - stateAt,
      machines: st.hosts.map((h) => ({
        name: h.hostname || h.label, label: h.label, status: h.status, reason: h.reason || null,
        os: h.os || null, version: h.version || null, agents: h.agents ?? 0, terminals: h.terminals ?? 0,
      })),
      sessions: {
        total: sessions.length, active: count("active"), waitingPermission: count("waiting"), idle: count("idle"),
        error: count("error"),
      },
      tasks: { total: tasks.length, ...columns, withError: tasks.filter((t) => t.error).length },
      inbox: { unread: inbox.unreadCount, total: inbox.items.length },
      pendingPermissions: sessions.flatMap((s) => s.pendingPermissions.map((p) => ({
        host: s.host, sessionId: s.id, sessionTitle: s.title, taskId: s.taskId, ...p,
      }))),
      projects: projects.map((p) => ({ id: p.id, host: p.host, name: p.name, dir: p.dir })),
    };
  }

  // ---------- Changements (delta + SSE) ----------
  let seq = 0;
  const changeLog = [];
  const sseClients = new Set();
  let previous = null; // { task: Map, session: Map, inbox: Map } id -> { json, data }
  let refreshing = null;

  function emit(kind, op, id, data) {
    seq += 1;
    const change = { seq, t: new Date().toISOString(), kind, op, id, data };
    changeLog.push(change);
    if (changeLog.length > LOG_MAX) changeLog.shift();
    const frame = `id: ${seq}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const res of sseClients) { try { res.write(frame); } catch { /* le client est parti */ } }
  }
  const slimTask = (t) => ({ id: t.id, title: t.title, status: t.status, agentId: t.agentId, host: t.host,
    error: t.error, permission: t.permission, reason: t.reason, updatedAt: t.updatedAt, origin: t.origin || null });
  const slimSession = (s) => ({ host: s.host, id: s.id, title: s.title, status: s.status, group: s.group,
    pending: s.pendingPermissions.length, taskId: s.taskId });
  const slimItem = (i) => ({ id: i.id, kind: i.kind, status: i.status, title: i.title, host: i.host,
    agentId: i.agentId, t: i.t });

  async function computeCurrent() {
    const [tasks, inbox] = await Promise.all([listTasks(), listInbox()]);
    const connected = new Set((state?.hosts || []).filter((h) => h.status === "connected").map((h) => h.label));
    const entries = { task: new Map(), session: new Map(), inbox: new Map() };
    for (const t of tasks) entries.task.set(t.id, slimTask(t));
    for (const s of liveSessions(state || { agents: [] }, tasks, inbox.items)) {
      entries.session.set(`${s.host}/${s.id}`, slimSession(s));
    }
    for (const i of inbox.items) entries.inbox.set(i.id, slimItem(i));
    return { entries, connected };
  }
  async function refreshOnce() {
    const { entries, connected } = await computeCurrent();
    const next = {};
    for (const kind of Object.keys(entries)) {
      const map = new Map();
      for (const [id, data] of entries[kind]) map.set(id, { json: JSON.stringify(data), data });
      // Machine hors ligne : ses sessions ne sont pas déclarées disparues.
      if (kind === "session" && previous) {
        for (const [id, old] of previous.session) {
          if (!map.has(id) && !connected.has(old.data.host)) map.set(id, old);
        }
      }
      next[kind] = map;
    }
    if (previous) {
      for (const kind of Object.keys(next)) {
        for (const [id, now] of next[kind]) {
          const old = previous[kind].get(id);
          if (!old || old.json !== now.json) emit(kind, "upsert", id, now.data);
        }
        for (const [id] of previous[kind]) if (!next[kind].has(id)) emit(kind, "delete", id, null);
      }
    }
    previous = next;
  }
  function refresh() {
    if (!refreshing) refreshing = refreshOnce().catch(() => {}).finally(() => { refreshing = null; });
    return refreshing;
  }
  setInterval(refresh, POLL_MS).unref();
  setTimeout(refresh, 2000).unref();
  setInterval(() => {
    for (const res of sseClients) { try { res.write(": ping\n\n"); } catch { /* ignoré */ } }
  }, HEARTBEAT_MS).unref();

  function changesSince(since) {
    const result = { cursor: seq, reset: false, changes: [] };
    if (since == null || since === "") return { ...result, reset: true };
    if (/^\d+$/.test(since)) {
      const n = Number(since);
      const oldest = changeLog[0]?.seq ?? seq + 1;
      if (n > seq || n < oldest - 1) return { ...result, reset: true };
      return { ...result, changes: changeLog.filter((c) => c.seq > n) };
    }
    const time = Date.parse(since);
    if (Number.isNaN(time)) throw bad("since : curseur numérique ou date ISO attendu");
    return { ...result, changes: changeLog.filter((c) => Date.parse(c.t) > time) };
  }

  // ---------- Journal d'audit ----------
  mkdirSync(ctx.dataDir, { recursive: true });
  const auditFile = join(ctx.dataDir, "agent-audit.jsonl");
  let auditLines = existsSync(auditFile) ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean).length : 0;
  function audit(entry) {
    try {
      if (auditLines >= AUDIT_MAX_LINES) {
        const old = join(ctx.dataDir, "agent-audit.1.jsonl");
        rmSync(old, { force: true });
        renameSync(auditFile, old);
        auditLines = 0;
      }
      const line = JSON.stringify(entry, (_key, value) => (typeof value === "string" ? redact(value) : value));
      appendFileSync(auditFile, `${line}\n`);
      auditLines += 1;
    } catch (e) {
      ctx.log("agentapi", `journal d'audit : ${safeError(e)}`);
    }
  }

  // ---------- Actions ----------
  const need = (value, name) => {
    if (value === undefined || value === null || value === "") throw bad(`${name} requis`);
    return value;
  };
  const isTrue = (value) => value === true || value === "true" || value === "1";
  const confirmed = (body, query) => isTrue(body?.confirm) || isTrue(query.get("confirm"));
  const mustConfirm = (ok, what) => {
    if (!ok) throw new ApiError(400, "confirm_required", `${what} : ajoutez confirm=true pour confirmer`);
  };
  async function taskById(id) {
    const found = (await listTasks()).find((t) => t.id === id);
    if (!found) throw missing(`tâche introuvable : ${id}`);
    return found;
  }
  const TASK_FIELDS = ["title", "description", "project", "host", "engine", "mode", "isolation", "branch", "deps", "role", "profile"];
  const pickFields = (body, onlyPresent) => {
    const out = {};
    for (const key of TASK_FIELDS) if (!onlyPresent || key in body) if (body[key] !== undefined) out[key] = body[key];
    return out;
  };

  async function closeSession(host, id) {
    const session = await findSession(host, id);
    const entry = ctx.hosts.get(host);
    if (!entry?.connected()) throw new ApiError(503, "host_unavailable", `machine indisponible : ${host}`);
    if (ACTIVE.has(session.status) || session.status === "waiting-permission") {
      await invoke("agent.stop", { host, agentId: id });
    }
    await entry.daemon.archiveAgent(id);
    ctx.broadcastState();
    return { host, id, closed: true, taskId: session.taskId };
  }

  // Anti auto-approbation (T34) : sous mandat actif, accepter n'est possible que si la politique répond « allow ».
  function guardApproval(item) {
    const mandate = getMandate();
    if (!mandate?.enabled) return;
    if (!item || evaluatePermission(item, mandate).decision !== "allow") throw ownerOnly();
  }

  async function approveOrRefuse(id, body, allow) {
    const items = (await listInbox()).items;
    const item = items.find((i) => i.id === id);
    if (!item) throw missing(`élément de boîte de réception introuvable : ${id}`);
    const action = item.action;
    const isBlastwinConfirm = item.kind === "permission" && action?.kind === "blastwin-confirm";
    const isBlastwinMerge = item.kind === "permission" && action?.kind === "blastwin-merge";

    const isBlastwin = isBlastwinConfirm || isBlastwinMerge;
    if (!isBlastwin) {
      if (item.kind !== "permission" || action?.type !== "permission" || !action.requestId || !item.agentId) {
        throw bad("seules les demandes de permission s'approuvent ou se refusent ; utilisez /inbox/mark");
      }
    }
    if (item.status === "traité") throw new ApiError(409, "already_handled", "demande déjà traitée");
    if (action.questions?.length) throw bad("c'est une QUESTION de direction d'un agent : réponds avec post_inbox_answer (choice = l'option ou le texte libre de Philippe), pas avec approve/refuse", "use_answer");
    // T48 : l'API agent ne peut JAMAIS autoriser une demande BlastWin (démarrage ou fusion), mandat actif ou non :
    // seule l'interface de Philippe (WebSocket blastwin.decide) le peut. Refuser reste possible.
    if (allow && isBlastwin) throw ownerOnly();
    if (allow) guardApproval(item);
    if (allow && action.danger && body.confirm !== true) {
      throw new ApiError(400, "confirm_required", "permission signalée dangereuse : ajoutez confirm=true");
    }
    const options = action.actions || [];
    const wanted = allow ? "allow" : "deny";
    const named = body.actionId ? options.find((a) => a.id === String(body.actionId)) : null;
    if (body.actionId && !named) throw bad("actionId inconnu pour cette demande");
    // F1 : le comportement vient de la route (approve = allow, refuse = deny), jamais d'actionId. Une action d'un autre
    // comportement est ignorée : « refuse » avec actionId:"allow" ne doit jamais approuver.
    const chosen = named && named.behavior === wanted ? named : options.find((a) => a.behavior === wanted);

    if (isBlastwin) {
      // Refus uniquement (l'autorisation est réservée à Philippe, voir plus haut) : aucune session agent derrière.
      action.decision = "deny";
      await invoke("inbox.mark", { ids: [id], status: "traité" });
      ctx.agentActivity?.record({
        method: "POST", route: "/inbox/refuse", ok: true, status: 200,
        summary: `BlastWin : ${isBlastwinMerge ? "fusion" : "confirmation"} refusée pour ${clip(item.title, 120)}`,
        mandateActive: Boolean(getMandate()?.enabled),
      });
      return { id, decision: "deny", actionId: chosen?.id ?? null, what: clip(item.body, 90), blastwin: true };
    }

    await call("perm.respond", {
      host: item.host, agentId: item.agentId, requestId: action.requestId,
      behavior: wanted, actionId: chosen?.id || undefined,
    });
    await invoke("inbox.mark", { ids: [id], status: "traité" });
    return { id, decision: wanted, actionId: chosen?.id ?? null, what: clip(item.body, 90) };
  }

  // Table de routes : [méthode, motif, gestionnaire(ctx de requête)] ; les motifs captent les segments `:x`.
  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const source = pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return "([^/]+)"; });
    routes.push({ method, regex: new RegExp(`^${source}$`), names, handler });
  };

  // Les autres handlers (coord.mjs, chargé après nous) ajoutent leurs routes /api/v1/... par ctx.apiRoute : mêmes gardes (authentification,
  // Origin, taille du corps, journal d'audit).
  ctx.apiRoute = route;

  route("GET", "/summary", ({ query }) => summary(isTrue(query.get("fresh"))));

  route("GET", "/sessions", ({ query }) => listSessions(Object.fromEntries(query)).then((sessions) => ({ sessions })));
  route("GET", "/sessions/:host/:id", async ({ params, query }) => {
    const session = await findSession(params.host, params.id);
    const limit = Math.min(Math.max(Number(query.get("messages")) || 20, 0), 100);
    let messages = [];
    if (limit) {
      const r = await invoke("agent.watch", { host: params.host, agentId: params.id }, { timeoutMs: 10000 });
      const items = replyOf(r, "agent.history")?.items || [];
      messages = items.map((e) => e.item || e).filter((i) => i && typeof i === "object").slice(-limit).map((i) => ({
        type: i.type, text: clip(i.text ?? i.message ?? "", 1500) || undefined, name: i.name || undefined,
        status: i.status || undefined,
      }));
    }
    return { session, messages };
  });
  route("POST", "/sessions/close", async ({ body, query }) => {
    if (isMandateForbidden("supprimer")) throw mandateRefusal("supprimer");
    const list = Array.isArray(body.sessions) ? body.sessions : [];
    if (!list.length) throw bad("sessions requis : [{host, id}, ...]");
    if (list.length > 100) throw bad("100 sessions au plus par appel");
    mustConfirm(confirmed(body, query), `fermer ${list.length} session(s) en masse`);
    const results = [];
    for (const s of list) {
      try { results.push(await closeSession(String(s.host || SELF_HOST), String(need(s.id, "id")))); } catch (e) {
        results.push({ host: s.host, id: s.id, closed: false, error: strip(e.message) });
      }
    }
    return { results, closed: results.filter((r) => r.closed).length };
  });
  route("POST", "/sessions/:host/:id/close", async ({ params }) => {
    if (isMandateForbidden("supprimer")) {
      // Fermer une session INACTIVE née d'une tâche de CE mandat (doublon après un « task restart », tâche finie) n'est pas
      // supprimer des données : l'agent doit pouvoir ranger derrière lui, sinon des sessions fantômes s'accumulent.
      const mandate = getMandate();
      const row = await findSession(params.host, params.id);
      const own = mandate?.runId && row.agentRun === mandate.runId && row.status !== "running";
      if (!own) throw mandateRefusal("supprimer");
    }
    return closeSession(params.host, params.id);
  });
  route("POST", "/sessions/:host/:id/send", async ({ params, body }) => {
    const text = need(typeof body.text === "string" ? body.text.trim() : "", "text");
    await findSession(params.host, params.id);
    await call("agent.send", { host: params.host, agentId: params.id, text });
    return { sent: true, length: text.length };
  });
  route("POST", "/sessions/:host/:id/permission", async ({ params, body }) => {
    need(body.requestId, "requestId");
    if (typeof body.allow !== "boolean") throw bad("allow (booléen) requis");
    await findSession(params.host, params.id);
    if (body.allow === true && getMandate()?.enabled) {
      const requestId = String(body.requestId);
      const item = (await listInbox()).items.find((i) => i.kind === "permission" && i.host === params.host &&
        i.agentId === params.id && i.action?.requestId === requestId);
      guardApproval(item);
    }
    // F1 : seule une action dont le comportement correspond à allow est utilisable ; sinon l'action par défaut de ce comportement.
    const wanted = body.allow ? "allow" : "deny";
    const pendingActions = (await findSession(params.host, params.id)).pendingPermissions
      .find((x) => x.requestId === String(body.requestId))?.actions || [];
    const named = body.actionId ? pendingActions.find((a) => a.id === String(body.actionId)) : null;
    const chosen = named && named.behavior === wanted ? named : pendingActions.find((a) => a.behavior === wanted);
    await call("perm.respond", {
      host: params.host, agentId: params.id, requestId: String(body.requestId),
      behavior: wanted, actionId: chosen?.id || undefined,
    });
    return { requestId: body.requestId, decision: body.allow ? "allow" : "deny" };
  });

  route("GET", "/tasks", async ({ query }) => {
    let tasks = await listTasks();
    if (query.get("status")) tasks = tasks.filter((t) => t.status === query.get("status"));
    if (query.get("project")) {
      const p = query.get("project").toLowerCase();
      tasks = tasks.filter((t) => t.projectName.toLowerCase() === p || t.project.toLowerCase().includes(p));
    }
    return { tasks };
  });
  // F5 : sous mandat, une tâche ne peut pas avoir un mode de permissions plus permissif que le mandat (« default »).
  const SAFE_TASK_MODES = new Set(["", "default", "plan"]);
  // Orchestrateur Claude lancé en bypass (Mode Agent) : ses employés le sont aussi, sinon ils restent bloqués sur des permissions
  // que personne ne lit (Philippe ne veut aucune demande de permission, seulement des questions de direction).
  const bypassRun = () => { const m = getMandate(); return Boolean(m?.enabled) && /^claude(\/|$)/.test(String(m.engine || "")); };
  function guardTaskMode(body) {
    if (!getMandate()?.enabled || body.mode === undefined) return;
    if (bypassRun() && String(body.mode).trim() === "bypassPermissions") return;
    if (!SAFE_TASK_MODES.has(String(body.mode).trim().toLowerCase())) {
      throw Object.assign(new ApiError(403, "mode_too_permissive", "mode de permissions plus permissif que celui du mandat : seuls « default » et « plan » sont permis"),
        { category: "donner un mode de permissions plus permissif" });
    }
  }
  route("POST", "/tasks", async ({ body, req }) => {
    if (bypassRun() && body.mode === undefined) body = { ...body, mode: "bypassPermissions" };
    guardTaskMode(body);
    const before = new Set((await listTasks()).map((t) => t.id));
    // Sous mandat actif, la tâche porte l'origine « agent » et l'identifiant du mandat (T31).
    const mandate = getMandate();
    const origin = mandate?.enabled ? { origin: "agent", agentRun: mandate.runId || "" } : {};
    await call("task.create", { ...pickFields(body, false), ...origin });
    const created = (await listTasks()).filter((t) => !before.has(t.id));
    const task = created.find((t) => t.title === String(body.title).trim().slice(0, 200)) || created.at(-1);
    // Délégation : la session identifiée qui crée la tâche est prévenue quand elle arrive à valider / terminée / bloquée (handlers/delegate.mjs).
    const who = task ? await Promise.resolve(ctx.coord?.sessionFor?.(req)).catch(() => null) : null;
    const watching = Boolean(who && ctx.delegate?.watch(task.id, who.key));
    return { task, ...(watching ? { notify: "message du poste à la fin de la tâche" } : {}) };
  });
  route("PATCH", "/tasks/:id", async ({ params, body }) => {
    guardTaskMode(body);
    await taskById(params.id);
    await call("task.update", { id: params.id, ...pickFields(body, true) });
    return { task: await taskById(params.id) };
  });
  // T34 : une tâche ne passe « Terminé » que quand sa session est inactive (l'interface humaine garde son comportement).
  async function assertSessionIdle(task, hint) {
    if (!task.agentId) return;
    const session = await findSession(task.host, task.agentId).catch(() => null);
    if (session && (ACTIVE.has(session.status) || session.status === "waiting-permission")) {
      throw new ApiError(409, "session_busy", `la session travaille encore : ${hint}`);
    }
  }
  route("POST", "/tasks/:id/move", async ({ params, body }) => {
    const task = await taskById(params.id);
    // F7 : la valeur est normalisée AVANT la comparaison ({"status":["done"]} ou « DONE » comptent comme done).
    if (String(body.status ?? "").trim().toLowerCase() === "done") {
      await assertSessionIdle(task, "attendez qu'elle soit inactive (idle) avant de terminer la tâche");
    }
    await call("task.move", { id: params.id, status: need(body.status, "status"), index: body.index, auto: false },
      { timeoutMs: 20000 });
    return { task: await taskById(params.id) };
  });
  route("POST", "/tasks/:id/start", async ({ params }) => {
    await taskById(params.id);
    const r = await call("task.start", { id: params.id }, { timeoutMs: 60000 });
    return { task: await taskById(params.id), started: replyOf(r, "task.started") || null };
  });
  route("POST", "/tasks/:id/stop", async ({ params }) => {
    await taskById(params.id);
    await call("task.stop", { id: params.id }, { timeoutMs: 30000 });
    return { task: await taskById(params.id) };
  });
  route("POST", "/tasks/:id/close", async ({ params }) => {
    const task = await taskById(params.id);
    await assertSessionIdle(task, "arrêtez-la d'abord (task stop) puis clôturez la tâche");
    if (task.status === "doing") await invoke("task.stop", { id: params.id }, { timeoutMs: 30000 });
    await call("task.move", { id: params.id, status: "done" }, { timeoutMs: 20000 });
    return { task: await taskById(params.id) };
  });
  route("POST", "/tasks/:id/restart", async ({ params }) => {
    const task = await taskById(params.id);
    if (task.status === "doing") await call("task.stop", { id: params.id }, { timeoutMs: 30000 });
    if ((await taskById(params.id)).status !== "todo") await call("task.move", { id: params.id, status: "todo", auto: false });
    const oldAgent = task.agentId || null;
    const r = await call("task.start", { id: params.id }, { timeoutMs: 60000 });
    const after = await taskById(params.id);
    // L'ancienne session de la tâche resterait ouverte en doublon : le poste la range lui-même.
    let closedOld = false;
    if (oldAgent && after.agentId && oldAgent !== after.agentId) {
      try { await closeSession(task.host, oldAgent); closedOld = true; } catch { /* déjà fermée */ }
    }
    return { task: after, started: replyOf(r, "task.started") || null, closedOldSession: closedOld };
  });
  function getMandate() {
    if (ctx.agentMode?.getState) {
      return ctx.agentMode.getState();
    }
    return ctx.store?.read("agent-mode", { enabled: false, project: null, brief: null, forbidden: [] });
  }

  function isMandateForbidden(category) {
    if (ctx.agentMode?.isForbidden) {
      return ctx.agentMode.isForbidden(category);
    }
    const mode = ctx.store?.read("agent-mode", {});
    if (!mode?.enabled) return false;
    const list = Array.isArray(mode.forbidden) ? mode.forbidden : [];
    return list.some((item) => {
      const s = String(item).toLowerCase();
      if (category === "supprimer") return s.includes("supprim") || s.includes("delete");
      if (category === "pousser sur GitHub") return s.includes("pouss") || s.includes("push") || s.includes("github");
      if (category === "éteindre une machine") return s.includes("éteind") || s.includes("eteind") || s.includes("shutdown");
      return s === String(category).toLowerCase();
    });
  }

  route("GET", "/mandate", async () => {
    const mode = getMandate();
    return {
      enabled: Boolean(mode?.enabled),
      project: mode?.enabled ? (mode.project ?? null) : null,
      brief: mode?.enabled ? (mode.brief ?? null) : null,
      forbidden: mode?.enabled && Array.isArray(mode.forbidden) ? mode.forbidden : [],
      autoPermissions: mode?.enabled ? mode.autoPermissions !== false : true,
      allowGit: Boolean(mode?.enabled && mode.allowGit),
      writeScope: mode?.enabled && Array.isArray(mode.writeScope) ? mode.writeScope : [],
      projectDir: mode?.enabled ? (mode.projectDir ?? null) : null,
      permissionPolicy: mode?.enabled ? POLICY_TEXT : null,
      note: "Interdictions appliquées techniquement par cette API : supprimer (tâches, sessions, projets). « Pousser sur GitHub » et « éteindre une machine » sont des consignes à respecter, non bloquées. Permissions : le poste répond seul à ce qui est sûr dans le dossier du projet ; \"approuver\" une demande n'est accepté que pour ce que la politique juge sûr (sinon 403 : seul Philippe).",
    };
  });

  route("DELETE", "/tasks/:id", async ({ params, body, query }) => {
    if (isMandateForbidden("supprimer")) {
      throw mandateRefusal("supprimer");
    }
    await taskById(params.id);
    mustConfirm(confirmed(body, query), "supprimer une tâche");
    await call("task.delete", { id: params.id });
    return { id: params.id, deleted: true };
  });

  route("GET", "/inbox", async ({ query }) => {
    const filter = {};
    if (isTrue(query.get("unread"))) filter.status = "nouveau";
    else if (query.get("status")) filter.status = query.get("status");
    for (const key of ["kind", "host"]) if (query.get(key)) filter[key] = query.get(key);
    return listInbox(filter);
  });
  route("POST", "/inbox/mark", async ({ body }) => {
    const status = need(body.status || "lu", "status");
    // F11 : sous mandat, une demande de permission en attente ne se marque pas (la cacher à Philippe) : 409.
    if (getMandate()?.enabled) {
      const all = (await listInbox()).items;
      const open = all.filter((i) => i.kind === "permission" && i.status !== "traité");
      const wanted = new Set(Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : []);
      if (body.all === true ? open.length > 0 : open.some((i) => wanted.has(i.id))) {
        throw new ApiError(409, "permission_pending", "une demande de permission en attente ne se marque pas : seul Philippe y répond (vue Agent)");
      }
    }
    if (body.all === true) {
      const r = await call("inbox.markAll", { status });
      return { count: replyOf(r, "inbox.markedAll")?.count ?? 0, status };
    }
    if (!Array.isArray(body.ids) || !body.ids.length) throw bad("ids (liste) ou all:true requis");
    const r = await call("inbox.mark", { ids: body.ids, status });
    return { count: replyOf(r, "inbox.marked")?.count ?? 0, status };
  });
  // Répondre à une question de direction d'un agent (outil AskUserQuestion) : {answers: {"<question>": "<option>"}} ou, pour une
  // question unique, {choice: "<option ou texte libre>"}. Jamais d'approbation d'une permission d'outil par cette route.
  route("POST", "/inbox/:id/answer", async ({ params, body }) => {
    const items = (await listInbox()).items;
    const item = items.find((i) => i.id === params.id);
    if (!item) throw missing(`élément de boîte de réception introuvable : ${params.id}`);
    const action = item.action;
    const qs = action?.questions;
    if (item.kind !== "permission" || action?.type !== "permission" || !action.requestId || !item.agentId || !qs?.length) {
      throw bad("cet élément n'est pas une question d'agent");
    }
    if (item.status === "traité") throw new ApiError(409, "already_handled", "question déjà traitée");
    let answers = body?.answers;
    if (answers === undefined && body?.choice !== undefined) {
      if (qs.length !== 1) throw bad("plusieurs questions : utilisez answers");
      answers = { [qs[0].question]: body.choice };
    }
    if (answers === undefined) throw bad("answers (ou choice) requis");
    await call("perm.respond", { host: item.host, agentId: item.agentId, requestId: action.requestId, behavior: "allow", answers });
    await invoke("inbox.mark", { ids: [params.id], status: "traité" });
    return { id: params.id, answered: true, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [clip(k, 80), clip(Array.isArray(v) ? v.join(", ") : v, 120)])) };
  });
  route("POST", "/inbox/:id/approve", ({ params, body }) => approveOrRefuse(params.id, body, true));
  route("POST", "/inbox/:id/refuse", ({ params, body }) => approveOrRefuse(params.id, body, false));

  route("GET", "/projects", async () => ({ projects: await listProjects() }));
  route("POST", "/projects/follow", async ({ body }) => {
    const r = await call("project.follow", { host: body.host || SELF_HOST, dir: need(body.dir, "dir"), name: body.name });
    const reply = replyOf(r, "project.followed");
    if (reply && reply.ok === false) throw bad(reply.error || "dossier non suivi", reply.code || "refused");
    return { added: reply?.added || [], already: reply?.already || [] };
  });
  route("POST", "/projects/unfollow", async ({ body }) => {
    if (isMandateForbidden("supprimer")) throw mandateRefusal("supprimer");
    const payload = body.id ? { id: body.id } : { host: body.host || SELF_HOST, dir: need(body.dir, "dir ou id") };
    const reply = replyOf(await call("project.unfollow", payload), "project.unfollowed");
    if (reply && reply.ok === false) throw bad(reply.error || "projet non retiré", reply.code || "refused");
    return { unfollowed: true, id: reply?.id ?? null };
  });

  // Outil « décider » pour les autres modèles (T29) : relaie vers Laya via handlers/decide.mjs.
  route("POST", "/decide", async ({ body }) => {
    if (!ctx.decide) throw new ApiError(503, "decide_unavailable", "l'outil décider n'est pas chargé");
    try {
      return await ctx.decide.run(body);
    } catch (e) {
      if (e?.status) throw new ApiError(e.status, e.code || "decide_failed", e.message);
      throw e;
    }
  });

  route("GET", "/windows", async () => {
    const windows = replyOf(await call("windows.list", {}), "windows.list")?.windows || [];
    return { windows };
  });
  route("GET", "/terminals/:host/:id/scrollback", async ({ params, query }) => {
    const r = await call("windows.scrollback", { host: params.host, terminalId: params.id, lines: query.get("lines") });
    const { type, ...rest } = replyOf(r, "windows.scrollback") || {};
    return rest;
  });

  route("GET", "/changes", async ({ query }) => {
    await refresh();
    return changesSince(query.get("since"));
  });

  // ---------- HTTP ----------
  const localHostName = /^(localhost|127(\.\d+){3}|\[::1\])$/i;
  function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolveBody, rejectBody) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) tooBig = true;
        else chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooBig) return rejectBody(new ApiError(413, "too_large", "corps trop volumineux"));
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return resolveBody({});
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("objet attendu");
          resolveBody(parsed);
        } catch {
          rejectBody(bad("corps JSON invalide"));
        }
      });
      req.on("error", rejectBody);
    });
  }
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* origine illisible */ }
      if (host !== req.headers.host) throw new ApiError(403, "foreign_origin", "origine refusée");
    }
    // Sans mot de passe, l'API n'est servie que sous un nom local (contre le « DNS rebinding »).
    // `req.paseoAuthenticated` n'est posé que par server.mjs, pour l'écouteur Tailscale (mot de passe obligatoire, Host contrôlé).
    if (!SECRET && !req.paseoAuthenticated) {
      const hostName = String(req.headers.host || "").replace(/:\d+$/, "");
      if (!localHostName.test(hostName)) throw new ApiError(403, "foreign_host", "nom d'hôte refusé");
    }
  }
  function serveEvents(req, res, url) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ cursor: seq })}\n\n`);
    const last = req.headers["last-event-id"] || url.searchParams.get("since");
    if (last && /^\d+$/.test(last)) {
      for (const c of changeLog.filter((x) => x.seq > Number(last))) {
        res.write(`id: ${c.seq}\nevent: change\ndata: ${JSON.stringify(c)}\n\n`);
      }
    }
    sseClients.add(res);
    refresh();
    req.on("close", () => sseClients.delete(res));
  }

  ctx.onHttpPrefix(PREFIX, async (req, res, url) => {
    const path = url.pathname.slice(PREFIX.length - 1).replace(/\/+$/, "") || "/";
    const method = req.method;
    const actor = cleanActor(req.headers["x-agent-name"]);
    const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const query = url.searchParams;
    let status = 200;
    let payload;
    let body = {};
    let refusal = null;
    let journal = false; // seules les requêtes autorisées vers une route connue sont journalisées
    try {
      checkOrigin(req);
      if (method === "OPTIONS") throw new ApiError(405, "method_not_allowed", "méthode non autorisée");
      if (method === "GET" && path === "/events") return serveEvents(req, res, url);
      let matched = null;
      let pathKnown = false;
      for (const r of routes) {
        const m = r.regex.exec(path);
        if (!m) continue;
        pathKnown = true;
        if (r.method !== method) continue;
        const params = {};
        r.names.forEach((n, i) => {
          try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; }
        });
        matched = { r, params };
        break;
      }
      if (!matched) {
        throw pathKnown ? new ApiError(405, "method_not_allowed", "méthode non autorisée")
          : missing(`route inconnue : ${method} ${path}`);
      }
      journal = true;
      if (write) body = await readBody(req);
      const data = await matched.r.handler({ params: matched.params, query, body, req });
      payload = { ok: true, data };
    } catch (e) {
      const known = e instanceof ApiError;
      refusal = e?.category ?? null;
      status = known ? e.status : 500;
      payload = { ok: false, error: { code: known ? e.code : "internal", message: known ? e.message : safeError(e) } };
    }
    if (write && journal) {
      audit({
        t: new Date().toISOString(), actor, method, route: path, status, ok: payload.ok,
        summary: payload.ok ? summarize(method, path, body, payload.data) : clip(payload.error.message, 160),
      });
      if (!path.startsWith("/coord/") || !payload.ok || /^\/coord\/(claim|release|send|hello)$/.test(path)) ctx.agentActivity?.record({
        method, route: redact(clip(path, 160)), ok: payload.ok, status,
        summary: redact(activityText(method, path, body, payload, status, refusal)),
        mandateActive: Boolean(getMandate()?.enabled),
      });
    }
    json(res, status, payload);
  });

  // Résumé de journal : identifiants et noms de champs uniquement, jamais de texte libre envoyé aux agents.
  function summarize(method, path, body, data) {
    const out = { fields: Object.keys(body).filter((k) => k !== "confirm") };
    if (typeof body.text === "string") out.textLength = body.text.length;
    if (data?.task) out.task = { id: data.task.id, title: clip(data.task.title, 80), status: data.task.status };
    if (data?.count !== undefined) out.count = data.count;
    if (data?.closed !== undefined) out.closed = data.closed;
    if (data?.decision) out.decision = data.decision;
    return out;
  }

  // Phrase française courte pour l'historique d'activité de l'agent (T29). Jamais de corps brut : titres plafonnés,
  // identifiants abrégés, machines nommées « Mini PC » / « Oracle ». Les secrets sont masqués par redact() à l'appel.
  const TASK_COLUMN = { todo: "À faire", doing: "En cours", review: "À valider", done: "Terminé", blocked: "Bloquée" };
  const TASK_VERB = {
    start: ["Tâche démarrée", "Démarrage de tâche impossible"], stop: ["Tâche arrêtée", "Arrêt de tâche impossible"],
    close: ["Tâche clôturée", "Clôture de tâche impossible"], restart: ["Tâche relancée", "Relance de tâche impossible"],
  };
  // Les messages d'erreur citent parfois l'identifiant technique de la machine : on y met son nom lisible.
  const hostNames = (text) =>
    String(text).replace(/(^|[\s:/(])(local|oracle)(?=$|[\s:/,.)])/gi, (_, lead, id) => lead + hostLabel(id));
  const idOf = (value) => String(value ?? "").slice(0, 8);
  const decoded = (value) => { try { return decodeURIComponent(value); } catch { return String(value); } };
  // [libellé si réussi, libellé si échec, détail]
  function describe(method, path, body, data) {
    const seg = path.split("/").filter(Boolean).map(decoded);
    const title = data?.task?.title;
    if (seg[0] === "tasks") {
      if (method === "POST" && seg.length === 1) return ["Tâche créée", "Création de tâche impossible", title ?? body.title];
      if (method === "PATCH") return ["Tâche modifiée", "Modification de tâche impossible", title ?? idOf(seg[1])];
      if (method === "DELETE") return ["Tâche supprimée", "Suppression de tâche impossible", idOf(seg[1])];
      if (seg[2] === "move") {
        return ["Tâche déplacée", "Déplacement de tâche impossible",
          `${title ?? idOf(seg[1])} → ${TASK_COLUMN[body.status] ?? clip(body.status, 20)}`];
      }
      if (TASK_VERB[seg[2]]) return [...TASK_VERB[seg[2]], title ?? idOf(seg[1])];
    }
    if (seg[0] === "sessions") {
      if (seg.length === 2 && seg[1] === "close") {
        const n = data?.closed ?? (Array.isArray(body.sessions) ? body.sessions.length : 0);
        return ["Sessions fermées", "Fermeture de sessions impossible", `${n} session(s)`];
      }
      const where = `${hostLabel(seg[1])} / ${idOf(seg[2])}`;
      if (seg[3] === "close") return ["Session fermée", "Fermeture de session impossible", where];
      if (seg[3] === "send") return ["Message envoyé à la session", "Envoi à la session impossible", where];
      if (seg[3] === "permission") {
        return [body.allow === true ? "Permission accordée" : "Permission refusée", "Réponse à la permission impossible", where];
      }
    }
    if (seg[0] === "inbox") {
      if (seg[1] === "mark") {
        return ["Boîte de réception mise à jour", "Marquage de la boîte de réception impossible",
          data?.count !== undefined ? `${data.count} élément(s) « ${clip(data.status, 20)} »` : ""];
      }
      if (seg[2] === "approve") return ["Permission accordée", "Accord de permission impossible", data?.what || idOf(seg[1])];
      if (seg[2] === "refuse") return ["Permission refusée", "Refus de permission impossible", data?.what || idOf(seg[1])];
    }
    if (seg[0] === "projects" && (seg[1] === "follow" || seg[1] === "unfollow")) {
      const follow = seg[1] === "follow";
      return [follow ? "Projet suivi" : "Projet retiré", follow ? "Suivi de projet impossible" : "Retrait de projet impossible",
        clip(folderOf(body.dir) || idOf(body.id), 60)];
    }
    if (seg[0] === "coord") {
      const names = { claim: ["Fichiers réservés", "Réservation refusée"], release: ["Réservations libérées", "Libération impossible"],
        send: ["Message envoyé à une session", "Message refusé"], hello: ["Session identifiée", "Identification refusée"],
        status: ["Statut déclaré", "Statut refusé"] };
      const [okText, koText] = names[seg[1]] || ["Coordination", "Coordination refusée"];
      const n = Array.isArray(body.paths) ? body.paths.length : 0;
      return [okText, koText, seg[1] === "claim" ? `${n} chemin(s) en ${body.mode === "read" ? "lecture" : "écriture"}` : ""];
    }
    if (seg[0] === "decide") {
      const names = Object.keys(body.questions && typeof body.questions === "object" ? body.questions : {});
      return ["Décision demandée", "Décision impossible", `${names.length} question(s)${names.length ? ` : ${clip(names.join(", "), 80)}` : ""}`];
    }
    return [`Appel ${method} ${clip(path, 60)}`, `Appel ${method} ${clip(path, 60)} impossible`, ""];
  }
  function activityText(method, path, body, payload, status, refusal) {
    if (refusal) return `Refusé par le mandat : ${refusal}`;
    const [done, failed, detail] = describe(method, path, body, payload.data);
    const tail = clip(redact(detail), 100);
    if (payload.ok) return tail ? `${done} : ${tail}` : done;
    return `${failed}${tail ? ` : ${tail}` : ""} — ${clip(redact(hostNames(payload.error.message)), 100)}`;
  }

  ctx.log("agentapi", `API de contrôle prête : ${PREFIX}`);
}
