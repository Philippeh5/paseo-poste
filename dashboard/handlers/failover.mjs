// Surveillance de la machine principale et décision de reprise automatique (T10).
// États : monitoring → suspect → unreachable → resuming → resumed → reclaim_available (+ idle, resume_failed, reclaiming).
// Persistance : data/failover.json (écriture atomique via ctx.store), état armé restauré au démarrage.
// Messages : failover.status, failover.arm, failover.disarm, failover.setAutoResume, failover.reclaim.
// L'exécution réelle de la reprise (clone, relance) n'est PAS ici : elle passe par un exécuteur injectable,
// dont l'implémentation par défaut est une simulation qui journalise.
import { withTimeout } from "./fs.mjs";
import { readTasks } from "./transfer.mjs";
import {
  buildResumePrompt, makeBranchName, nextFailoverState, redact, translateProjectPath,
} from "../lib/transfer-steps.mjs";

export const nextState = nextFailoverState; // fonction pure : nextState(state, event, config, now)

const FILE = "failover";
const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_PING_TIMEOUT_MS = 4000;
const MAX_AUTO_RESUME = 500;

export function createSimulationResumeExecutor() {
  return {
    async resume(ctx, plan) {
      ctx.log("failover", `[simulation] reprise de la tâche ${plan.taskId} (${plan.title}) sur ${plan.branch} dans ${plan.targetDir}`);
      return { ok: true, simulated: true };
    },
    async reclaim(ctx, plans) {
      ctx.log("failover", `[simulation] rapatriement de ${plans.length} tâche(s)`);
      return { ok: true, simulated: true };
    },
  };
}

const freshState = (status = "idle") => ({
  status, consecutiveFailures: 0, firstFailureAt: null, lastSuccessAt: null, lastPingAt: null,
  resumedTasks: [], resumeError: null,
});

export class FailoverManager {
  constructor(ctx, { resumeExecutor, intervalMs, pingTimeoutMs } = {}) {
    this.ctx = ctx;
    this.executor = resumeExecutor || createSimulationResumeExecutor();
    this.pingTimeoutMs = pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    const saved = ctx.store.read(FILE, {}) || {};
    this.config = {
      armed: saved.armed === true,
      host: typeof saved.host === "string" && saved.host ? saved.host : "local",
      thresholdMinutes: Number(saved.thresholdMinutes) > 0 ? Number(saved.thresholdMinutes) : 5,
      minPings: Number.isInteger(saved.minPings) && saved.minPings > 0 ? saved.minPings : 3,
      intervalMs: intervalMs ?? (Number(saved.intervalMs) >= 20 ? Number(saved.intervalMs) : DEFAULT_INTERVAL_MS),
      autoResumeTaskIds: Array.isArray(saved.autoResumeTaskIds) ? saved.autoResumeTaskIds.filter((x) => typeof x === "string") : [],
    };
    this.state = { ...freshState(this.config.armed ? "monitoring" : "idle"), ...(saved.state || {}) };
    if (!Array.isArray(this.state.resumedTasks)) this.state.resumedTasks = [];
    if (!this.config.armed) this.state.status = "idle";
    else if (this.state.status === "idle") this.state.status = "monitoring";
    if (this.state.status === "resuming") this.state.status = "unreachable"; // reprise interrompue par un redémarrage
    this.plans = Array.isArray(saved.resumePlans) ? saved.resumePlans : [];
    this.skipped = [];
    this.timer = null;
    this.ticking = false;
    this.resumePromise = null;
    this.reclaiming = false;
    if (this.config.armed) this.startMonitoring();
  }

  // ---------- Persistance et diffusion ----------
  save() {
    this.ctx.store.write(FILE, { ...this.config, state: this.state, resumePlans: this.plans });
  }

  getStatus() {
    const s = this.state;
    return {
      type: "failover.status",
      armed: this.config.armed,
      state: s.status,
      host: this.config.host,
      thresholdMinutes: this.config.thresholdMinutes,
      minPings: this.config.minPings,
      intervalMs: this.config.intervalMs,
      lastPing: s.lastPingAt ? new Date(s.lastPingAt).toISOString() : null,
      lastSuccess: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
      missedPings: s.consecutiveFailures,
      unreachableSince: s.firstFailureAt && ["suspect", "unreachable", "resuming", "resumed", "resume_failed"].includes(s.status)
        ? new Date(s.firstFailureAt).toISOString() : null,
      autoResumeTaskIds: this.config.autoResumeTaskIds,
      resumedTasks: s.resumedTasks,
      resumePlans: this.plans.map(({ prompt, ...rest }) => ({ ...rest, promptChars: prompt?.length ?? 0 })),
      skipped: this.skipped,
      resumeError: s.resumeError ?? null,
      note: s.resumedTasks.length ? "Le travail non commité de la machine principale est perdu : seul l’état GitHub existe." : null,
    };
  }

  broadcastStatus() {
    this.ctx.broadcast(this.getStatus());
  }

  // Nom lisible d'une machine (jamais l'identifiant technique « local » dans les textes affichés).
  hostName(id) {
    return id === "local" ? "Mini PC" : id === "oracle" ? "Oracle" : String(id);
  }

  notifyInbox(title, body, extra = {}) {
    try {
      this.ctx.inbox?.add?.({ kind: "machine", title, body, host: this.config.host, source: "failover", ...extra });
    } catch { /* la boîte de réception ne doit jamais bloquer la surveillance */ }
  }

  // ---------- Commandes ----------
  arm({ host, thresholdMinutes, minPings, intervalMs } = {}) {
    const next = { ...this.config };
    if (host !== undefined) {
      if (typeof host !== "string" || !this.ctx.hosts?.has?.(host)) throw new Error(`Machine inconnue : ${String(host).slice(0, 60)}`);
      next.host = host;
    } else if (!this.ctx.hosts?.has?.(next.host)) throw new Error(`Machine inconnue : ${next.host}`);
    if (thresholdMinutes !== undefined) {
      if (typeof thresholdMinutes !== "number" || !(thresholdMinutes > 0) || thresholdMinutes > 1440) throw new Error("thresholdMinutes doit être entre 0 et 1440.");
      next.thresholdMinutes = thresholdMinutes;
    }
    if (minPings !== undefined) {
      if (!Number.isInteger(minPings) || minPings < 1 || minPings > 100) throw new Error("minPings doit être un entier entre 1 et 100.");
      next.minPings = minPings;
    }
    if (intervalMs !== undefined) {
      if (typeof intervalMs !== "number" || intervalMs < 100 || intervalMs > 3600000) throw new Error("intervalMs doit être entre 100 et 3600000.");
      next.intervalMs = intervalMs;
    }
    this.config = { ...next, armed: true };
    this.state = { ...freshState(this.state.resumedTasks.length ? "resumed" : "monitoring"), resumedTasks: this.state.resumedTasks };
    this.save();
    this.startMonitoring();
    this.broadcastStatus();
    this.notifyInbox("Surveillance armée", `Surveillance de la machine ${this.hostName(this.config.host)} (seuil ${this.config.thresholdMinutes} min).`);
    return this.getStatus();
  }

  disarm() {
    this.stopMonitoring();
    this.config.armed = false;
    this.state = { ...this.state, status: "idle", consecutiveFailures: 0, firstFailureAt: null };
    this.save();
    this.broadcastStatus();
    this.notifyInbox("Surveillance désarmée", `Plus de surveillance sur ${this.hostName(this.config.host)}.`);
    return this.getStatus();
  }

  setAutoResume(taskId, on) {
    if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 200) throw new Error("taskId requis.");
    if (typeof on !== "boolean") throw new Error("on doit être true ou false.");
    const set = new Set(this.config.autoResumeTaskIds);
    if (on) {
      if (!set.has(taskId) && set.size >= MAX_AUTO_RESUME) throw new Error("Trop de tâches en reprise automatique.");
      set.add(taskId);
    } else set.delete(taskId);
    this.config.autoResumeTaskIds = [...set];
    this.save();
    this.broadcastStatus();
    return { taskId, on };
  }

  // ---------- Surveillance ----------
  startMonitoring() {
    this.stopMonitoring();
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.ctx.log("failover", `erreur de surveillance : ${redact(String(e.message))}`));
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  stopMonitoring() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close() {
    this.stopMonitoring();
  }

  // Test de vie : connexion du client + appel léger au daemon avec délai.
  async pingHost() {
    const entry = this.ctx.hosts?.get?.(this.config.host);
    if (!entry || !entry.connected()) return false;
    try {
      await withTimeout(entry.daemon.ping({ timeoutMs: this.pingTimeoutMs }), this.pingTimeoutMs + 200, "ping");
      return true;
    } catch {
      return false;
    }
  }

  async tick() {
    if (!this.config.armed || this.ticking) return;
    this.ticking = true;
    try {
      const alive = await this.pingHost();
      if (!this.config.armed) return; // désarmé pendant le ping
      const before = this.state.status;
      this.state = nextFailoverState(this.state, { type: alive ? "ping_success" : "ping_failure" }, this.config, Date.now());
      const after = this.state.status;
      if (after !== before) this.onTransition(before, after);
      if (this.state.status === "unreachable") this.evaluateResume();
    } finally {
      this.ticking = false;
    }
  }

  onTransition(before, after) {
    this.ctx.log("failover", `${before} -> ${after}`);
    this.save();
    this.broadcastStatus();
    const h = this.config.host === "local" ? "Mini PC" : this.config.host === "oracle" ? "Oracle" : (this.config.host ? this.config.host.charAt(0).toUpperCase() + this.config.host.slice(1) : "");
    if (after === "suspect") {
      this.notifyInbox(`Machine ${this.hostName(h)} suspecte`, `${this.state.consecutiveFailures} tests de vie consécutifs sans réponse.`);
    } else if (after === "unreachable") {
      this.notifyInbox(`Machine ${this.hostName(h)} injoignable`, "Seuil dépassé : la reprise automatique des tâches cochées est évaluée.");
    } else if (after === "reclaim_available") {
      this.notifyInbox(`Machine ${this.hostName(h)} de retour`, "Elle répond de nouveau. Rapatriement disponible, aucun retour automatique.");
    } else if (after === "monitoring" && before === "suspect") {
      this.notifyInbox(`Machine ${this.hostName(h)} de nouveau joignable`, "Fausse alerte : la surveillance continue.");
    }
  }

  // Qui possède la tâche ? L'hôte de son agent, cherché sur les machines autres que la principale.
  async ownerOf(task) {
    if (!task.agent_id) return null;
    for (const label of this.ctx.hosts?.labels?.() ?? []) {
      if (label === this.config.host) continue;
      const entry = this.ctx.hosts.get(label);
      if (!entry?.connected()) continue;
      try {
        const list = await withTimeout(entry.api.agents.list({}), 5000, "agents");
        for (const row of list.entries || list.agents || []) {
          const a = row.agent || row;
          if (a.id === task.agent_id && !a.archivedAt && a.status !== "closed") return label;
        }
      } catch { /* machine illisible : pas de propriétaire prouvé */ }
    }
    return null;
  }

  evaluateResume() {
    if (!this.resumePromise) {
      this.resumePromise = this.doEvaluateResume()
        .catch((e) => this.ctx.log("failover", `erreur de reprise : ${redact(String(e.message))}`))
        .finally(() => { this.resumePromise = null; });
    }
    return this.resumePromise;
  }

  async doEvaluateResume() {
    if (this.state.status !== "unreachable") return; // un seul plan de reprise à la fois
    const already = new Set(this.state.resumedTasks.map((t) => t.id));
    const wanted = readTasks(this.ctx, this.config.host, ["doing"])
      .filter((t) => this.config.autoResumeTaskIds.includes(t.id) && !already.has(t.id));
    if (!wanted.length) return;

    const eligible = [];
    const skippedBefore = JSON.stringify(this.skipped);
    this.skipped = [];
    for (const task of wanted) {
      const owner = await this.ownerOf(task);
      if (owner) {
        this.skipped.push({ id: task.id, title: task.title, reason: `déjà pris en charge par ${owner}` });
        this.ctx.log("failover", `tâche ${task.id} ignorée : propriétaire ${owner}`);
      } else eligible.push(task);
    }
    if (!eligible.length) {
      if (JSON.stringify(this.skipped) !== skippedBefore) this.broadcastStatus();
      return;
    }
    if (this.state.status !== "unreachable") return; // la machine est revenue pendant les vérifications

    this.state = nextFailoverState(this.state, { type: "resume_start" }, this.config);
    this.save();
    this.broadcastStatus();

    const branch = makeBranchName("reprise");
    const done = [];
    let lastError = null;
    for (const task of eligible) {
      const plan = {
        id: `rp_${task.id.slice(0, 8)}_${Date.now().toString(36)}`,
        taskId: task.id, title: task.title, project: task.project,
        targetDir: translateProjectPath(task.project), branch, createdAt: new Date().toISOString(), status: "planned",
        prompt: buildResumePrompt({
          task, branch, targetDir: translateProjectPath(task.project) || undefined,
          errors: `${task.error || ""}\nTravail non commité de la machine principale potentiellement perdu : repartez de la branche GitHub la plus récente.`.trim(),
        }),
      };
      this.plans.push(plan);
      try {
        const res = await this.executor.resume(this.ctx, plan);
        if (!res?.ok) throw new Error("exécuteur de reprise : échec");
        plan.status = "resumed";
        done.push({ id: task.id, title: task.title, branch });
      } catch (e) {
        plan.status = "failed";
        plan.error = redact(String(e.message));
        lastError = plan.error;
      }
    }
    this.state = done.length || !lastError
      ? nextFailoverState(this.state, { type: "resume_done", tasks: done }, this.config)
      : nextFailoverState(this.state, { type: "resume_failed", error: lastError }, this.config);
    this.save();
    this.broadcastStatus();
    if (done.length) {
      this.notifyInbox(`Reprise automatique : ${done.length} tâche(s)`, `Plan de reprise sur ${branch} : ${done.map((t) => t.title).join(", ")}.`);
    } else {
      this.notifyInbox("Reprise automatique en échec", lastError || "aucune tâche reprise");
    }
  }

  // Rapatriement : simulation seulement dans ce ticket.
  async reclaim({ confirm } = {}) {
    if (confirm !== true) throw new Error("Confirmation requise : failover.reclaim doit être envoyé avec confirm:true.");
    if (this.state.status !== "reclaim_available") throw new Error(`Rapatriement indisponible dans l’état ${this.state.status}.`);
    if (this.reclaiming) throw new Error("Un rapatriement est déjà en cours.");
    if (!(await this.pingHost())) throw new Error("La machine principale est hors ligne : rapatriement impossible.");
    this.reclaiming = true;
    try {
      this.state = nextFailoverState(this.state, { type: "reclaim_start" }, this.config);
      this.broadcastStatus();
      const steps = ["stopping_oracle_agents", "pushing", "pulling_local", "reassigning", "done"];
      const res = await this.executor.reclaim(this.ctx, this.plans.filter((p) => p.status === "resumed"));
      for (const step of steps) this.ctx.broadcast({ type: "failover.reclaim.status", step, simulated: res?.simulated === true });
      this.state = nextFailoverState(this.state, { type: "reclaim_done" }, this.config, Date.now());
      this.plans = [];
      this.save();
      this.broadcastStatus();
      this.notifyInbox("Rapatriement terminé (simulation)", "Les tâches reprises sont de nouveau suivies sur la machine principale.");
      return { ok: true, state: this.state.status, simulated: res?.simulated === true };
    } finally {
      this.reclaiming = false;
    }
  }
}

export function register(ctx, options = {}) {
  const manager = new FailoverManager(ctx, options.failover || {});
  const reply = (ws, type, m, body) => ctx.send(ws, { ...body, type, ref: m.ref ?? null });
  const guard = (source, fn) => async (ws, m) => {
    try {
      await fn(ws, m);
    } catch (e) {
      ctx.send(ws, { type: "error", source, message: redact(ctx.safeError(e)) });
    }
  };
  ctx.onMessage("failover.status", (ws, m) => reply(ws, "failover.status", m, manager.getStatus()));
  ctx.onMessage("failover.arm", guard("failover.arm", (ws, m) => reply(ws, "failover.armed", m, manager.arm(m))));
  ctx.onMessage("failover.disarm", guard("failover.disarm", (ws, m) => reply(ws, "failover.disarmed", m, manager.disarm())));
  ctx.onMessage("failover.setAutoResume", guard("failover.setAutoResume", (ws, m) =>
    reply(ws, "failover.autoResumeSet", m, manager.setAutoResume(m.taskId, m.on))));
  ctx.onMessage("failover.reclaim", guard("failover.reclaim", async (ws, m) =>
    reply(ws, "failover.reclaim.result", m, await manager.reclaim(m))));
  return manager;
}
