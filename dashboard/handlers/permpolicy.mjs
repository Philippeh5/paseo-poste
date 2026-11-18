// Politique de permissions du mandat (T34) : l'agent autonome ne dépend plus d'un humain pour chaque commande sûre,
// et ne peut pas s'auto-approuver. Règles pures dans lib/permpolicy.mjs ; ce module les APPLIQUE.
//  - Application automatique : pour une demande de permission (boîte de réception) d'une session du mandat, `allow` →
//    perm.respond allow, `deny` → perm.respond deny (message lisible), `ask` → rien (Philippe répond, vue Agent).
//    Chaque décision est journalisée dans l'historique d'activité (sans secret). Désactivable : mandat `autoPermissions:false`.
//  - Sauvegardes : AVANT toute autorisation de modification (Edit/Write/MultiEdit) d'une session du mandat, qu'elle vienne
//    de la politique ou d'un humain (hook `ctx.permGuard.beforeAllow`, appelé par perm.respond), le fichier existant est
//    copié vers data/agent-backups/<runId>/<chemin>.<horodatage>.bak. Messages agentbackup.list / agentbackup.restore.
//  - Alertes : demande en attente > 2 min, session de l'exécution muette > 30 min, session « orpheline » (tâche terminée,
//    permission en attente > 10 min) avec « Refuser et fermer » (permpolicy.closeOrphan). Diffusion permpolicy.alerts.
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { evaluatePermission, insideDir, isWriteTool, projectRelative, targetOf, toolOf } from "../lib/permpolicy.mjs";
import { redact } from "../lib/redact.mjs";
import { SELF_HOST } from "../lib/selfhost.mjs";

export const WAIT_ALERT_MS = 2 * 60 * 1000;
export const ORPHAN_MS = 10 * 60 * 1000;
export const STALL_MS = 30 * 60 * 1000;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
export const MAX_BACKUPS = 500;
export const MAX_RUN_BYTES = 200 * 1024 * 1024; // plafond TOTAL des sauvegardes d'une exécution
const SWEEP_MS = 1500;
const TICK_MS = 5000;
const TASKS_TTL_MS = 800;
const MAX_ATTEMPTS = 3;
const RUN_ID = /^[A-Za-z0-9-]{8,80}$/;
const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DONE_STATES = new Set(["done", "review"]);

const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const slashes = (p) => String(p ?? "").replace(/\\/g, "/");
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, log } = ctx;
  const mandate = () => ctx.agentMode?.getState?.() ?? { enabled: false };
  const journal = (summary, ok = true, status = 200) => ctx.agentActivity?.record({
    method: "POST", route: "/permission", ok, status, summary: clip(redact(summary), 190), mandateActive: true, // secrets masqués AVANT la troncature
  });

  // ---------- Tâches (appartenance d'une session au mandat) ----------
  let tasksAt = 0;
  let tasksCache = [];
  async function getTasks(ttl = TASKS_TTL_MS) {
    if (Date.now() - tasksAt < ttl) return tasksCache;
    try {
      const r = await ctx.invoke("task.list", {});
      tasksCache = r.replies.find((x) => x.type === "tasks")?.tasks || tasksCache;
      tasksAt = Date.now();
    } catch { /* on garde la dernière liste */ }
    return tasksCache;
  }
  const taskOf = (tasks, host, agentId) => tasks.find((t) => t.agentId === agentId && t.host === host) || null;
  // Une session appartient au mandat si sa tâche vient de l'agent de CE mandat, ou si elle travaille dans le dossier du projet.
  function belongs(item, m, tasks) {
    if (!m?.enabled) return false;
    const task = taskOf(tasks, item.host, item.agentId);
    if (task && task.origin === "agent" && m.runId && task.agentRun === m.runId) return true;
    const cwd = item.action?.cwd;
    return Boolean(cwd && m.projectDir && (!m.projectHost || item.host === m.projectHost) && insideDir(cwd, m.projectDir));
  }
  const openItems = () => (ctx.inbox?.list({ kind: "permission" }) || [])
    .filter((i) => i.status !== "traité" && i.agentId && i.action?.requestId);
  const keyOf = (i) => `${i.host}\0${i.agentId}\0${i.action.requestId}`;

  // ---------- Sauvegardes ----------
  const backupsRoot = join(ctx.dataDir, "agent-backups");
  const indexes = new Map();
  function runDir(runId) {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("identifiant d'exécution invalide");
    const dir = resolve(backupsRoot, runId);
    if (!dir.startsWith(resolve(backupsRoot) + sep)) throw new Error("identifiant d'exécution invalide");
    return dir;
  }
  function loadIndex(runId, projectDir) {
    let ix = indexes.get(runId);
    if (ix) return ix;
    ix = { runId, projectDir: projectDir || null, entries: [] };
    try {
      const raw = JSON.parse(readFileSync(join(runDir(runId), "_index.json"), "utf8"));
      if (raw && typeof raw === "object") {
        ix.projectDir = typeof raw.projectDir === "string" ? raw.projectDir : ix.projectDir;
        ix.entries = (Array.isArray(raw.entries) ? raw.entries : []).filter((e) => e && BACKUP_ID.test(e.id) &&
          typeof e.rel === "string" && typeof e.bak === "string" && typeof e.at === "string").slice(-MAX_BACKUPS - 100);
      }
    } catch { /* pas encore d'index */ }
    indexes.set(runId, ix);
    return ix;
  }
  function saveIndex(ix) {
    const dir = runDir(ix.runId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "_index.json");
    writeFileSync(`${file}.tmp`, JSON.stringify({ projectDir: ix.projectDir, entries: ix.entries }));
    renameSync(`${file}.tmp`, file);
  }
  // Sauvegarde le fichier `target` (s'il existe, dans le projet) : { ok, entry? | skipped? | error? }.
  function backupFile({ runId, projectDir, target, cwd, source = "auto" }) {
    try {
      const rel = projectRelative(target, cwd || projectDir, projectDir);
      if (!rel) return { ok: true, skipped: "hors du dossier du projet" };
      const parts = rel.split("/");
      if (parts.some((p) => !p || p === ".." || p === ".")) return { ok: true, skipped: "chemin refusé" };
      const abs = join(projectDir, ...parts);
      let st;
      try { st = statSync(abs); } catch { return { ok: true, skipped: "nouveau fichier" }; }
      if (!st.isFile()) return { ok: true, skipped: "pas un fichier" };
      if (st.size > MAX_BACKUP_BYTES) return { ok: false, error: `fichier trop gros pour être sauvegardé (${mb(st.size)} Mo, maximum ${mb(MAX_BACKUP_BYTES)} Mo)` };
      const ix = loadIndex(runId, projectDir);
      if (ix.entries.length >= MAX_BACKUPS && source !== "avant-restauration") {
        return { ok: false, error: `limite de ${MAX_BACKUPS} sauvegardes atteinte pour cette exécution` };
      }
      if (ix.entries.length >= MAX_BACKUPS + 50) return { ok: false, error: "limite de sauvegardes atteinte" };
      const used = ix.entries.reduce((n, e) => n + (Number(e.size) || 0), 0);
      if (used + st.size > MAX_RUN_BYTES) {
        return { ok: false, error: `plafond de ${mb(MAX_RUN_BYTES)} Mo de sauvegardes atteint pour cette exécution` };
      }
      const dir = runDir(runId);
      const stamp = new Date().toISOString().replace(/[-:.]/g, "");
      let dest = null;
      for (let n = 0; n < 50 && !dest; n++) {
        const candidate = join(dir, ...parts.slice(0, -1), `${parts.at(-1)}.${stamp}${n ? `-${n}` : ""}.bak`);
        if (!resolve(candidate).startsWith(dir + sep)) return { ok: false, error: "chemin de sauvegarde refusé" };
        mkdirSync(dirname(candidate), { recursive: true });
        try { copyFileSync(abs, candidate, constants.COPYFILE_EXCL); dest = candidate; } catch (e) { if (e.code !== "EEXIST") throw e; }
      }
      if (!dest) return { ok: false, error: "sauvegarde impossible (nom déjà pris)" };
      const entry = {
        id: randomUUID(), rel, bak: slashes(relative(dir, dest)), at: new Date().toISOString(), size: st.size, source,
      };
      ix.entries.push(entry);
      saveIndex(ix);
      log("permpolicy", `sauvegarde ${redact(clip(rel, 120))} (${st.size} octets)`);
      broadcast({ type: "agentbackup.changed", runId, count: ix.entries.length });
      return { ok: true, entry };
    } catch (e) {
      return { ok: false, error: clip(ctx.safeError ? ctx.safeError(e) : e.message, 160) };
    }
  }
  const backedUp = new Set(); // éléments de boîte déjà sauvegardés (la sauvegarde n'est faite qu'une fois par demande)
  function ensureBackup(item, m) {
    if (!isWriteTool(toolOf(item))) return { ok: true };
    if (backedUp.has(item.id)) return { ok: true };
    if (!m.runId || !m.projectDir) return { ok: true };
    const r = backupFile({ runId: m.runId, projectDir: m.projectDir, target: targetOf(item), cwd: item.action?.cwd });
    if (r.ok) backedUp.add(item.id);
    return r;
  }

  // Crochet appelé par perm.respond (core-agents.mjs) AVANT chaque autorisation, quelle que soit son origine.
  ctx.permGuard = {
    async beforeAllow({ host, agentId, requestId }) {
      const m = mandate();
      if (!m.enabled || !m.runId || !m.projectDir) return { ok: true };
      const item = (ctx.inbox?.list({ kind: "permission" }) || [])
        .find((i) => i.host === host && i.agentId === agentId && i.action?.requestId === requestId);
      if (!item || !isWriteTool(toolOf(item))) return { ok: true };
      if (!belongs(item, m, await getTasks())) return { ok: true };
      const r = ensureBackup(item, m);
      if (!r.ok) journal(`Sauvegarde impossible avant modification : ${clip(targetOf(item), 80)} — ${r.error}`, false, 409);
      return r;
    },
  };

  // Limite connue (README) : une réponse de l'interface web ne se distingue pas d'un agent local. Atténuation : elle est visible.
  onMessage("perm.respond", (ws, m) => {
    const mand = mandate();
    if (!mand.enabled || m.behavior !== "allow" || String(ws?._uiId ?? "").startsWith("invoke:")) return;
    const item = (ctx.inbox?.list({ kind: "permission" }) || [])
      .find((i) => i.host === (m.host || SELF_HOST) && i.agentId === m.agentId && i.action?.requestId === m.requestId);
    const what = item ? `${toolOf(item)} ${clip(redact(targetOf(item)), 80)}`.trim() : `demande ${String(m.requestId ?? "").slice(-8)}`;
    journal(`Autorisé depuis l'interface : ${what}`);
  });

  onMessage("agentbackup.list", (ws, m) => {
    const runId = typeof m.runId === "string" && m.runId ? m.runId : mandate().runId;
    if (!runId) return send(ws, { type: "agentbackup.list", runId: null, backups: [], total: 0, limit: MAX_BACKUPS, ref: m.ref ?? null });
    try { runDir(runId); } catch (e) { return sendError(ws, e.message); }
    const ix = loadIndex(runId, mandate().projectDir);
    const backups = ix.entries.slice(-MAX_BACKUPS).reverse()
      .map((e) => ({ id: e.id, rel: e.rel, at: e.at, size: e.size, source: e.source || "auto" }));
    send(ws, { type: "agentbackup.list", runId, backups, total: ix.entries.length, limit: MAX_BACKUPS, ref: m.ref ?? null });
  });

  onMessage("agentbackup.restore", (ws, m) => {
    if (typeof m.id !== "string" || !BACKUP_ID.test(m.id)) return sendError(ws, "sauvegarde inconnue");
    if (m.confirm !== true) return sendError(ws, "Confirmez la restauration (confirm: true).");
    const runId = typeof m.runId === "string" && m.runId ? m.runId : mandate().runId;
    if (!runId) return sendError(ws, "aucune exécution de l'agent en cours : choisissez une sauvegarde de l'exécution active");
    try { runDir(runId); } catch (e) { return sendError(ws, e.message); }
    const ix = loadIndex(runId, mandate().projectDir);
    const entry = ix.entries.find((e) => e.id === m.id);
    if (!entry || !ix.projectDir) return sendError(ws, "sauvegarde inconnue");
    const parts = entry.rel.split("/");
    if (parts.some((p) => !p || p === ".." || p === ".")) return sendError(ws, "chemin de sauvegarde refusé");
    const dir = runDir(runId);
    const bak = resolve(dir, entry.bak);
    const target = join(ix.projectDir, ...parts);
    if (!bak.startsWith(dir + sep) || !existsSync(bak)) return sendError(ws, "le fichier de sauvegarde n'existe plus");
    if (projectRelative(target, null, ix.projectDir) !== entry.rel) return sendError(ws, "ce chemin n'est plus dans le dossier du projet");
    // Toujours garder l'état actuel avant d'écraser.
    const before = backupFile({ runId, projectDir: ix.projectDir, target, source: "avant-restauration" });
    if (!before.ok) return sendError(ws, `restauration annulée : ${before.error}`);
    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.restore-${randomUUID().slice(0, 8)}.tmp`;
      copyFileSync(bak, tmp);
      try { renameSync(tmp, target); } catch (e) { rmSync(tmp, { force: true }); throw e; }
    } catch (e) {
      return sendError(ws, `restauration impossible : ${clip(ctx.safeError ? ctx.safeError(e) : e.message, 160)}`);
    }
    journal(`Fichier restauré depuis une sauvegarde : ${clip(entry.rel, 120)}`);
    log("permpolicy", `restauration ${redact(clip(entry.rel, 120))}`);
    send(ws, { type: "agentbackup.restored", id: entry.id, rel: entry.rel, savedCurrent: Boolean(before.entry), ref: m.ref ?? null });
  });

  // ---------- Application automatique de la politique ----------
  const inflight = new Set();
  const attempts = new Map();
  const decided = new Set();
  const choose = (item, behavior) => (item.action.actions || []).find((a) => a.behavior === behavior)?.id;

  async function respond(item, behavior, message) {
    const actionId = choose(item, behavior);
    const r = await ctx.invoke("perm.respond", {
      host: item.host, agentId: item.agentId, requestId: item.action.requestId, behavior,
      ...(actionId ? { actionId } : {}), ...(message ? { message } : {}),
    }, { timeoutMs: 20000 });
    if (r.error) throw new Error(String(r.error).replace(/^Erreur\s*:\s*/, ""));
  }

  async function applyPolicy(item) {
    const k = keyOf(item);
    if (decided.has(k) || inflight.has(k)) return;
    const m = mandate();
    if (!m.enabled || m.autoPermissions === false) return;
    if (!belongs(item, m, await getTasks())) return;
    // T36 : la coordination entre sessions (fichier réservé par une autre, session en lecture seule) passe AVANT la politique du mandat.
    const coord = await ctx.coord?.apply?.(item);
    if (coord?.handled) { decided.add(k); return; }
    const verdict = evaluatePermission(item, m);
    if (verdict.decision === "ask") return;
    inflight.add(k);
    try {
      if (verdict.decision === "allow") {
        const saved = ensureBackup(item, m);
        if (!saved.ok) {
          if (!attempts.has(`${k}:backup`)) {
            attempts.set(`${k}:backup`, 1);
            journal(`Laissé à Philippe : ${verdict.what} — sauvegarde impossible (${saved.error})`, false, 409);
          }
          return;
        }
        await respond(item, "allow");
        journal(`Autorisé automatiquement : ${verdict.what}`);
      } else {
        await respond(item, "deny",
          `Refusé par le mandat de Philippe : ${verdict.what} — ${verdict.reason}. Ne le contourne pas : explique-le dans ton compte-rendu.`);
        journal(`Refusé par le mandat : ${verdict.what} — ${verdict.reason}`, false, 403);
      }
      decided.add(k);
      ctx.inbox.mark([item.id], "traité");
    } catch (e) {
      const n = (attempts.get(k) || 0) + 1;
      attempts.set(k, n);
      log("permpolicy", `réponse automatique impossible (${n}/${MAX_ATTEMPTS}) : ${clip(e.message, 120)}`);
      if (n >= MAX_ATTEMPTS) {
        decided.add(k);
        journal(`Réponse automatique impossible : ${verdict.what} — à traiter par Philippe`, false, 500);
      }
    } finally {
      inflight.delete(k);
    }
  }

  async function sweep() {
    const m = mandate();
    if (!m.enabled || m.autoPermissions === false) return;
    for (const item of openItems().slice(0, 30)) await applyPolicy(item);
  }
  ctx.inbox?.onAdded((item) => {
    if (item.kind === "permission") applyPolicy(item).catch(() => {});
  });
  setInterval(() => { sweep().catch(() => {}); }, SWEEP_MS).unref();

  // ---------- Alertes : attente prolongée, session muette, sessions orphelines ----------
  let latestState = null;
  ctx.onStateChange((s) => { latestState = s; });

  async function computeAlerts(fresh = false) {
    const m = mandate();
    const empty = { waiting: [], stalled: [], orphans: [] };
    if (!m.enabled) return empty;
    const tasks = await getTasks(fresh ? 0 : 1500);
    const now = Date.now();
    const byAgent = new Map();
    for (const it of openItems()) {
      if (!belongs(it, m, tasks)) continue;
      const key = `${it.host}\0${it.agentId}`;
      const e = byAgent.get(key) || { host: it.host, agentId: it.agentId, title: it.agentTitle || null, since: it.t, requests: [] };
      if (Date.parse(it.t) < Date.parse(e.since)) e.since = it.t;
      e.requests.push({ requestId: it.action.requestId, title: clip(it.title, 120), detail: clip(redact(it.body), 160) });
      byAgent.set(key, e);
    }
    const waiting = [];
    const orphans = [];
    for (const e of byAgent.values()) {
      const age = now - Date.parse(e.since);
      const task = taskOf(tasks, e.host, e.agentId);
      const row = { ...e, taskId: task?.id ?? null, taskTitle: task ? clip(task.title, 120) : null };
      if (age > WAIT_ALERT_MS) waiting.push(row);
      if (task && DONE_STATES.has(task.status) && age > ORPHAN_MS) orphans.push({ ...row, taskStatus: task.status });
    }
    const stalled = [];
    for (const t of tasks) {
      if (t.origin !== "agent" || t.agentRun !== m.runId || t.status !== "doing" || !t.agentId) continue;
      const agent = (latestState?.agents || []).find((a) => a.host === t.host && a.agentId === t.agentId);
      if (!agent || !["running", "initializing"].includes(agent.status) || !agent.updatedAt) continue;
      if (now - Date.parse(agent.updatedAt) > STALL_MS) {
        stalled.push({ host: t.host, agentId: t.agentId, taskId: t.id, title: clip(t.title, 120), since: agent.updatedAt });
      }
    }
    return { waiting, stalled, orphans };
  }

  let lastAlerts = "";
  async function tick() {
    let alerts;
    try { alerts = await computeAlerts(); } catch { return; }
    const json = JSON.stringify(alerts);
    if (json === lastAlerts) return;
    lastAlerts = json;
    broadcast({ type: "permpolicy.alerts", ...alerts, at: new Date().toISOString() });
  }
  setInterval(() => { tick(); }, TICK_MS).unref();
  ctx.permPolicy = { computeAlerts, tick };
  // Un mandat qui commence ou finit change aussitôt les alertes (pas d'attente du cycle de 5 s).
  for (const type of ["agentmode.enable", "agentmode.disable"]) onMessage(type, () => { setTimeout(() => { tick(); }, 50); });

  onMessage("permpolicy.alerts.get", async (ws, m) => {
    send(ws, { type: "permpolicy.alerts", ...(await computeAlerts(true)), at: new Date().toISOString(), ref: m.ref ?? null });
  });

  // « Refuser et fermer » : refuse chaque demande restée sans réponse, arrête puis archive la session (jamais automatique).
  onMessage("permpolicy.closeOrphan", async (ws, m) => {
    if (typeof m.host !== "string" || !m.host || m.host.length > 60 || typeof m.agentId !== "string" || !m.agentId || m.agentId.length > 200) {
      return sendError(ws, "session inconnue");
    }
    const orphan = (await computeAlerts(true)).orphans.find((o) => o.host === m.host && o.agentId === m.agentId);
    if (!orphan) return sendError(ws, "Cette session n'attend plus de permission depuis assez longtemps, ou sa tâche n'est pas terminée.");
    const errors = [];
    for (const r of orphan.requests) {
      try {
        const item = openItems().find((i) => i.host === m.host && i.agentId === m.agentId && i.action.requestId === r.requestId);
        if (item) await respond(item, "deny", "Refusé par Philippe : la tâche est terminée.");
        if (item) ctx.inbox.mark([item.id], "traité");
      } catch (e) { errors.push(clip(e.message, 100)); }
    }
    try {
      const stop = await ctx.invoke("agent.stop", { host: m.host, agentId: m.agentId }, { timeoutMs: 20000 });
      if (stop.error) errors.push(clip(String(stop.error).replace(/^Erreur\s*:\s*/, ""), 100));
      await ctx.hosts.get(m.host)?.daemon?.archiveAgent?.(m.agentId);
    } catch (e) { errors.push(clip(ctx.safeError ? ctx.safeError(e) : e.message, 100)); }
    journal(`Session orpheline refusée et fermée : ${clip(orphan.taskTitle || orphan.title || m.agentId, 80)}`, errors.length === 0, errors.length ? 500 : 200);
    ctx.broadcastState?.();
    await tick();
    if (errors.length) return sendError(ws, `fermeture incomplète : ${errors.join(" ; ")}`);
    send(ws, { type: "permpolicy.orphanClosed", host: m.host, agentId: m.agentId, denied: orphan.requests.length, ref: m.ref ?? null });
  });
}
