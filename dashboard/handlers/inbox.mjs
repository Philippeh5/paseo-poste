// Boîte de réception : demandes d'approbation, fins de travail, erreurs et alertes machines.
// Stockage : data/inbox.json (écriture atomique via ctx.store).
// Point d'extension : ctx.inbox (voir handlers/README.md).
// Messages : inbox.list {filter?}, inbox.mark {ids, status}, inbox.markAll {status?}, inbox.clear {olderThan?} ;
// diffusion inbox.changed {items, unreadCount}. Les réponses aux permissions passent par le message existant
// perm.respond (handlers/core-agents.mjs) : ce module ne fait que détecter, afficher et marquer « traité ».
import { randomUUID } from "node:crypto";

import { extractQuestions } from "../lib/questions.mjs";
const FILE = "inbox";
export const MAX_ITEMS = 500;
const MAX_KEYS = 3000;
const POLL_MS = 500; // une permission doit apparaître en moins d'une seconde
const POLL_TIMEOUT_MS = 4000;
const KINDS = new Set(["permission", "fin", "erreur", "machine", "système", "plan"]);
const STATUSES = new Set(["nouveau", "lu", "traité"]);
const WORKING = new Set(["running", "waiting-permission"]);

const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const folderName = (dir) => (dir ? String(dir).replace(/[/\\]+$/, "").split(/[/\\]/).pop() : "");
const parseTime = (value) => {
  if (typeof value === "number") return Date.now() - value; // âge en ms
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
};

// Normalisation des tâches d'un plan généré
function sanitizePlanTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, 50).filter((t) => t && typeof t === "object").map((t, idx) => {
    const title = clip(t.title || `Tâche ${idx + 1}`, 200);
    const project = clip(t.project || "", 200);
    const harness = clip(t.harness || t.engine || "", 200);
    const id = t.id ? clip(t.id, 100) : `pt_${idx}_${randomUUID().slice(0, 6)}`;
    const task = { id: String(id), title, project, harness };
    if (t.dependsOn != null) {
      task.dependsOn = (Array.isArray(t.dependsOn) ? t.dependsOn : [t.dependsOn]).slice(0, 20).map((d) => clip(String(d), 100));
    } else {
      task.dependsOn = [];
    }
    return task;
  });
}

// Tri topologique garantissant que les prérequis soient créés avant les dépendants
function sortTasksTopologically(tasks) {
  const result = [];
  const visited = new Set();
  const visiting = new Set();
  const byId = new Map();
  tasks.forEach((t, i) => {
    byId.set(t.id, t);
    byId.set(String(i), t);
    byId.set(t.title, t);
  });

  function visit(t) {
    if (visited.has(t.id) || visiting.has(t.id)) return;
    visiting.add(t.id);
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : (t.dependsOn ? [t.dependsOn] : []);
    for (const d of deps) {
      const depTask = byId.get(String(d));
      if (depTask && depTask.id !== t.id) visit(depTask);
    }
    visiting.delete(t.id);
    visited.add(t.id);
    result.push(t);
  }

  for (const t of tasks) if (!visited.has(t.id)) visit(t);
  return result;
}

// Ce que l'agent veut faire : chemin du fichier ou commande, jamais le contenu (qui peut contenir des secrets).
function describePermission(p) {
  const d = p.detail || {};
  const input = p.input && typeof p.input === "object" ? p.input : {};
  const target = d.filePath || d.command || d.url || input.file_path || input.command || input.path || input.url || "";
  return clip(target, 300);
}
// T34 : cible BRUTE de la demande (commande avec ses retours à la ligne, ou chemin), pour la politique de permissions ;
// la version plafonnée et aplatie du `body` ne suffit pas (un retour à la ligne y devient un espace). Plafonnée à MAX_TARGET.
const MAX_TARGET = 4000;
function rawTarget(p) {
  const d = p.detail || {};
  const input = p.input && typeof p.input === "object" ? p.input : {};
  const v = d.filePath || d.command || d.url || input.file_path || input.command || input.path || input.url ||
    input.notebook_path || "";
  return typeof v === "string" ? v : "";
}
// Seule une signalisation explicite de l'agent rend une permission « dangereuse » (pas de devinette sur le texte).
const isDangerous = (p) =>
  p.dangerous === true || p.risk === "high" || (p.actions || []).some((a) => a.variant === "danger");

export function register(ctx) {
  const { onMessage, send, broadcast, store, log } = ctx;

  const loaded = store.read(FILE, {});
  const cache = {
    items: Array.isArray(loaded?.items) ? loaded.items : [],
    seenKeys: Array.isArray(loaded?.seenKeys) ? loaded.seenKeys : [],
  };
  const seen = new Set(cache.seenKeys);
  const addedListeners = new Set(); // T34 : crochets appelés avec chaque élément créé (politique de permissions)

  const unreadCount = () => cache.items.filter((i) => i.status === "nouveau").length;
  function save() {
    while (cache.items.length > MAX_ITEMS) {
      // On sacrifie d'abord les éléments traités les plus anciens (items est trié du plus récent au plus ancien).
      const oldestTreated = cache.items.findLastIndex((item) => item.status === "traité");
      cache.items.splice(oldestTreated >= 0 ? oldestTreated : cache.items.length - 1, 1);
    }
    if (cache.seenKeys.length > MAX_KEYS) cache.seenKeys = cache.seenKeys.slice(-MAX_KEYS);
    store.write(FILE, cache);
  }
  const changed = () => {
    save();
    broadcast({ type: "inbox.changed", items: cache.items, unreadCount: unreadCount() });
  };

  // ---------- API commune (aussi exposée aux autres modules via ctx.inbox) ----------
  function add(raw) {
    if (!raw || typeof raw !== "object") return null;
    const key = raw.key ? String(raw.key).slice(0, 300) : null;
    if (key) {
      if (seen.has(key)) return null;
      seen.add(key);
      cache.seenKeys.push(key);
    }
    const item = {
      id: `inb_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      t: new Date().toISOString(),
      kind: KINDS.has(raw.kind) ? raw.kind : "système",
      host: clip(raw.host || "local", 60),
      title: clip(raw.title || "Notification", 200),
      body: clip(raw.body, 600),
      status: STATUSES.has(raw.status) ? raw.status : "nouveau",
      source: clip(raw.source || "agent", 30),
    };
    for (const field of ["agentId", "taskId", "project", "agentTitle"]) {
      if (raw[field]) item[field] = clip(raw[field], 200);
    }
    if (raw.action && typeof raw.action === "object") item.action = raw.action;
    if (raw.kind === "plan" && Array.isArray(raw.tasks)) {
      item.tasks = sanitizePlanTasks(raw.tasks);
    }
    cache.items.unshift(item);
    changed();
    for (const fn of addedListeners) { try { fn(item); } catch { /* un crochet ne doit jamais gêner la boîte */ } }
    return item;
  }

  function mark(ids, status) {
    if (!STATUSES.has(status)) return 0;
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).filter((x) => typeof x === "string"));
    let count = 0;
    for (const item of cache.items) {
      if (wanted.has(item.id) && item.status !== status) {
        item.status = status;
        count += 1;
      }
    }
    if (count) changed();
    return count;
  }
  function markAll(status = "lu") {
    if (!STATUSES.has(status)) return 0;
    let count = 0;
    for (const item of cache.items) {
      if (item.status === "nouveau") {
        item.status = status;
        count += 1;
      }
    }
    if (count) changed();
    return count;
  }
  // Supprime les éléments traités (plus vieux que `olderThan` : durée en ms ou date ISO ; tous si omis).
  function clear(olderThan) {
    const cutoff = olderThan == null ? Infinity : parseTime(olderThan);
    if (cutoff === null) return 0;
    const before = cache.items.length;
    cache.items = cache.items.filter((item) => item.status !== "traité" || new Date(item.t).getTime() >= cutoff);
    if (cache.items.length !== before) changed();
    return before - cache.items.length;
  }
  function list(filter) {
    const f = filter && typeof filter === "object" ? filter : {};
    return cache.items.filter((i) => {
      const skip = (field) => f[field] && f[field] !== "all" && i[field] !== f[field];
      return !(skip("status") || skip("kind") || skip("host"));
    });
  }
  ctx.inbox = {
    add, list, mark, markAll, clear, getUnreadCount: unreadCount,
    onAdded: (fn) => { addedListeners.add(fn); return () => addedListeners.delete(fn); },
  };

  // ---------- Messages du navigateur ----------
  onMessage("inbox.list", (ws, m) => {
    send(ws, { type: "inbox.list", items: list(m.filter), unreadCount: unreadCount() });
  });
  onMessage("inbox.mark", (ws, m) => {
    if (!STATUSES.has(m.status)) return ctx.sendError(ws, "statut inconnu");
    send(ws, { type: "inbox.marked", count: mark(m.ids, m.status), status: m.status });
  });
  onMessage("inbox.markAll", (ws, m) => {
    send(ws, { type: "inbox.markedAll", count: markAll(m.status === "traité" ? "traité" : "lu") });
  });
  onMessage("inbox.clear", (ws, m) => send(ws, { type: "inbox.cleared", removed: clear(m.olderThan) }));

  // ---------- Plans générés ----------
  onMessage("inbox.plan.create", (ws, m) => {
    if (!m || typeof m !== "object") return ctx.sendError(ws, "données du plan manquantes");
    const tasks = sanitizePlanTasks(m.tasks);
    if (!tasks.length) return ctx.sendError(ws, "le plan doit contenir au moins une tâche");
    const title = clip(m.title || "Plan d'action proposé", 200);
    const item = add({
      kind: "plan",
      title,
      body: clip(m.body || `${tasks.length} tâche(s) proposée(s) à valider.`, 600),
      tasks,
      host: clip(m.host || "local", 60),
      project: clip(m.project || (tasks[0]?.project ?? ""), 200),
      source: clip(m.source || "agent", 30),
      action: { type: "plan" },
      key: m.key,
    });
    if (!item) return ctx.sendError(ws, "plan déjà existant ou invalide");
    send(ws, { type: "inbox.plan.created", item });
  });

  onMessage("inbox.plan.update", (ws, m) => {
    if (!m?.id) return ctx.sendError(ws, "identifiant du plan requis");
    const item = cache.items.find((i) => i.id === m.id);
    if (!item) return ctx.sendError(ws, "plan introuvable");
    if (item.kind !== "plan") return ctx.sendError(ws, "cet élément n'est pas un plan");
    if (item.status === "traité") return ctx.sendError(ws, "ce plan est déjà traité");
    item.tasks = sanitizePlanTasks(m.tasks);
    changed();
    send(ws, { type: "inbox.plan.updated", item });
  });

  onMessage("inbox.plan.apply", async (ws, m) => {
    if (!m?.id) return ctx.sendError(ws, "identifiant du plan requis");
    const item = cache.items.find((i) => i.id === m.id);
    if (!item) return ctx.sendError(ws, "plan introuvable");
    if (item.kind !== "plan") return ctx.sendError(ws, "cet élément n'est pas un plan");
    if (item.status === "traité") return ctx.sendError(ws, "ce plan est déjà traité");
    const tasksToApply = Array.isArray(m.tasks) ? sanitizePlanTasks(m.tasks) : (item.tasks || []);
    if (!tasksToApply.length) {
      item.status = "traité";
      changed();
      return send(ws, { type: "inbox.plan.applied", id: item.id, createdTasks: [] });
    }

    try {
      const listRes = ctx.invoke ? await ctx.invoke("task.list", {}) : { replies: [] };
      const existing = listRes.replies?.[0]?.tasks || [];
      const knownIds = new Set(existing.map((t) => t.id));
      const taskMap = new Map();
      const createdTaskIds = [];

      const ordered = sortTasksTopologically(tasksToApply);

      for (let i = 0; i < ordered.length; i++) {
        const task = ordered[i];
        const resolvedDeps = [];
        const declaredDeps = Array.isArray(task.dependsOn) ? task.dependsOn : (task.dependsOn ? [task.dependsOn] : []);
        for (const d of declaredDeps) {
          const mappedId = taskMap.get(String(d)) || taskMap.get(Number(d));
          if (mappedId && knownIds.has(mappedId)) {
            resolvedDeps.push(mappedId);
          } else if (knownIds.has(String(d))) {
            resolvedDeps.push(String(d));
          }
        }

        const engine = (task.harness && /^[A-Za-z0-9][\w.-]*\/[\w.:@/-]+$/.test(task.harness))
          ? task.harness
          : (task.engine && /^[A-Za-z0-9][\w.-]*\/[\w.:@/-]+$/.test(task.engine) ? task.engine : "");

        if (ctx.invoke) {
          const res = await ctx.invoke("task.create", {
            title: task.title,
            project: task.project || item.project || "",
            host: task.host || item.host || "local",
            engine,
            deps: resolvedDeps,
          });
          if (res.error) throw new Error(res.error);

          const updatedList = await ctx.invoke("task.list", {});
          const all = updatedList.replies?.[0]?.tasks || [];
          const created = all.findLast((t) => t.title === task.title && !knownIds.has(t.id));
          if (created) {
            knownIds.add(created.id);
            createdTaskIds.push(created.id);
            taskMap.set(task.id, created.id);
            taskMap.set(task.title, created.id);
            const origIndex = tasksToApply.findIndex((x) => x.id === task.id);
            if (origIndex >= 0) taskMap.set(String(origIndex), created.id);
          }
        }
      }

      item.status = "traité";
      item.tasks = tasksToApply;
      item.action = { ...item.action, createdTasks: createdTaskIds, appliedAt: new Date().toISOString() };
      changed();
      send(ws, { type: "inbox.plan.applied", id: item.id, createdTasks: createdTaskIds });
    } catch (err) {
      ctx.sendError(ws, err.message || "Erreur lors de la création des tâches");
    }
  });

  onMessage("inbox.plan.refuse", (ws, m) => {
    if (!m?.id) return ctx.sendError(ws, "identifiant du plan requis");
    const item = cache.items.find((i) => i.id === m.id);
    if (!item) return ctx.sendError(ws, "plan introuvable");
    if (item.kind !== "plan") return ctx.sendError(ws, "cet élément n'est pas un plan");
    item.status = "traité";
    item.action = { ...item.action, refused: true, refusedAt: new Date().toISOString() };
    changed();
    send(ws, { type: "inbox.plan.refused", id: item.id });
  });

  // ---------- Détection : interrogation rapide des agents de chaque machine ----------
  const lastStatus = new Map(); // "host\0agentId" → dernier statut observé (base : pas d'élément au démarrage)
  const busy = new Set(); // machines en cours d'interrogation

  async function lastAssistantMessage(entry, agentId) {
    try {
      const page = await entry.api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 30 });
      const texts = (page.entries || []).map((e) => e.item).filter((i) => i?.type === "assistant_message" && i.text);
      return clip(texts.at(-1)?.text, 300);
    } catch {
      return "";
    }
  }

  function permissionItems(host, agent, pending) {
    for (const p of pending) {
      const questions = extractQuestions(p);
      const tool = p.title || p.name || "Outil";
      const target = rawTarget(p);
      add({
        kind: "permission", host, agentId: agent.id, project: folderName(agent.cwd), agentTitle: agent.title,
        key: `permission:${host}:${agent.id}:${p.id}`,
        title: questions ? `Question de l'agent : ${clip(questions[0].question, 140)}` : `Permission requise : ${tool}`,
        body: questions
          ? questions.map((q) => `${q.question} — ${q.options.map((o) => o.label).join(" / ") || "réponse libre"}`).join(String.fromCharCode(10)).slice(0, 600)
          : describePermission(p) || "L'agent attend votre approbation pour continuer.",
        action: {
          type: "permission", requestId: p.id, danger: isDangerous(p),
          tool: clip(p.name || p.title || "", 60), kind: typeof p.kind === "string" ? p.kind : "tool",
          // T36 : nature de l'action vue par le daemon (edit, write, shell, read…) : indépendante du nom d'outil choisi par chaque moteur.
          detailType: typeof p.detail?.type === "string" ? p.detail.type.slice(0, 20) : undefined,
          target: target.slice(0, MAX_TARGET), targetTruncated: target.length > MAX_TARGET, cwd: agent.cwd || null,
          pattern: typeof p.input?.pattern === "string" ? p.input.pattern.slice(0, 500) : undefined,
          actions: (p.actions || []).map((a) => ({ id: a.id, label: a.label, behavior: a.behavior })),
          questions: questions || undefined,
        },
      });
    }
  }

  async function onTransition(host, entry, agent, from, to) {
    const base = { host, agentId: agent.id, project: folderName(agent.cwd), agentTitle: agent.title };
    const stamp = Date.now();
    if (to === "error") {
      const message = agent.error?.message || agent.lastError || "L'agent s'est arrêté sur une erreur.";
      add({ ...base, kind: "erreur", key: `erreur:${host}:${agent.id}:${stamp}`, title: "Agent en erreur",
        body: message, action: { type: "session" } });
    } else if (WORKING.has(from) && (to === "idle" || to === "closed")) {
      const summary = (await lastAssistantMessage(entry, agent.id)) || "L'agent a terminé son travail.";
      add({ ...base, kind: "fin", key: `fin:${host}:${agent.id}:${stamp}`,
        title: `${agent.title || "Agent"} : terminé`, body: summary, action: { type: "session" } });
    }
  }

  async function pollHost(host) {
    const entry = ctx.hosts.get(host);
    if (!entry?.connected() || busy.has(host)) return;
    busy.add(host);
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("délai")), POLL_TIMEOUT_MS);
      });
      const result = await Promise.race([entry.api.agents.list({}), timeout]);
      const pendingIds = new Set();
      const transitions = [];
      for (const row of result.entries || []) {
        const agent = row.agent || row;
        const pending = agent.pendingPermissions || [];
        pending.forEach((p) => pendingIds.add(p.id));
        permissionItems(host, agent, pending);
        const key = `${host}\0${agent.id}`;
        const status = pending.length ? "waiting-permission" : agent.status || "idle";
        const from = lastStatus.get(key);
        lastStatus.set(key, status);
        if (from && from !== status) transitions.push([agent, from, status]);
      }
      // Demandes disparues (traitées ailleurs, agent arrêté ou supprimé) → « traité ».
      let resolved = 0;
      for (const item of cache.items) {
        const id = item.action?.requestId;
        // Les demandes BlastWin (confirmation / fusion) ne viennent pas du daemon : elles n'y sont jamais « en attente ».
        const own = item.action?.kind === "blastwin-confirm" || item.action?.kind === "blastwin-merge";
        const open = item.kind === "permission" && item.host === host && item.status !== "traité" && !own;
        if (open && id && !pendingIds.has(id)) {
          item.status = "traité";
          resolved += 1;
        }
      }
      if (resolved) changed();
      for (const [agent, from, to] of transitions) await onTransition(host, entry, agent, from, to);
    } catch {
      // l'interrogation suivante réessaiera
    } finally {
      clearTimeout(timer);
      busy.delete(host);
    }
  }
  const pollAll = () => Promise.all(ctx.hosts.labels().map(pollHost));
  const timer = setInterval(pollAll, POLL_MS);
  timer.unref?.();

  // Après une réponse de permission, on revérifie tout de suite plutôt que d'attendre le cycle suivant.
  onMessage("perm.respond", (_ws, m) => {
    if (typeof m.host === "string" || m.host === undefined) setTimeout(() => pollHost(m.host || "local"), 300);
  });

  // ---------- Machines injoignables / reconnectées (état complet, toutes les 5 s) ----------
  const hostStatus = new Map(); // host → { stable, pending, count }
  const bootAt = Date.now();
  const SETTLE_MS = 90_000; // juste après un (re)démarrage du tableau de bord, les liaisons se rétablissent : pas d'alerte « reconnectée »
  ctx.onStateChange((state) => {
    const settling = Date.now() - bootAt < SETTLE_MS;
    for (const h of state.hosts || []) {
      const entry = hostStatus.get(h.label) || { stable: h.status, pending: h.status, count: 0 };
      hostStatus.set(h.label, entry);
      if (settling) { entry.stable = h.status; entry.pending = h.status; entry.count = 0; continue; }
      if (h.status === entry.stable) {
        entry.pending = h.status;
        entry.count = 0;
        continue;
      }
      // Même nouvel état deux fois de suite (≈10 s) avant d'alerter : évite les faux positifs ponctuels.
      entry.count = h.status === entry.pending ? entry.count + 1 : 1;
      entry.pending = h.status;
      if (entry.count < 2) continue;
      const wasUp = entry.stable === "connected";
      entry.stable = h.status;
      entry.count = 0;
      const stamp = Date.now();
      const nice = h.label === "local" ? "Mini PC" : h.label === "oracle" ? "Oracle" : h.label;
      add({
        kind: "machine", host: h.label, source: "host", action: { type: "machine" },
        key: `machine:${h.label}:${wasUp ? "down" : "up"}:${stamp}`,
        title: wasUp ? `Machine ${nice} injoignable` : `Machine ${nice} reconnectée`,
        body: wasUp ? `La liaison avec « ${nice} » est interrompue (${clip(h.reason || h.status, 120)}).`
          : `La liaison avec « ${nice} » est rétablie.`,
      });
    }
  });

  log("inbox", `${cache.items.length} élément(s), ${unreadCount()} nouveau(x)`);
  return () => clearInterval(timer); // arrêt propre (utilisé par scripts/verify-inbox.mjs)
}
