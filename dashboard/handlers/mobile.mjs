// Support de la vue Téléphone : historique d'usage des quotas (graphes) et rangement des anciennes sessions.
// Messages : usage.history -> usage.history {points} ; tidy.get / tidy.set {auto, olderThanHours} -> tidy.settings ;
// tidy.preview {olderThanHours} -> tidy.preview {count, agents} ; tidy.run {olderThanHours} -> tidy.done {archived, failed}.
// « Ranger » = archiver (même appel que agent.close) une session INACTIVE ou en erreur dont la dernière activité date de plus de
// N heures. Jamais une session qui travaille, qui attend une permission ou dont un sous-agent est encore actif.
// Le rangement automatique est désactivé par défaut (data/tidy.json).
const HISTORY_FILE = "usage-history";
const TIDY_FILE = "tidy";
const KEEP_MS = 14 * 24 * 3_600_000;
const SAMPLE_MS = 5 * 60_000;
const TIDY_MS = 10 * 60_000;
export const HOURS = { min: 1, max: 720, default: 24 };
const BUSY = new Set(["running", "working", "initializing", "waiting-permission", "waiting_permission"]);
const TIDYABLE = new Set(["idle", "error"]);

export const cleanHours = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(HOURS.max, Math.max(HOURS.min, Math.round(n))) : HOURS.default;
};

// Sessions à ranger parmi `agents` : inactives/en erreur, sans enfant actif, sans activité depuis `olderThanHours`.
export function tidyCandidates(agents, olderThanHours, now = Date.now()) {
  const limit = cleanHours(olderThanHours) * 3_600_000;
  const busyParents = new Set((agents || []).filter((a) => BUSY.has(a.status)).map((a) => `${a.host}\0${a.parentAgentId}`));
  return (agents || []).filter((a) => {
    if (!TIDYABLE.has(a.status) || busyParents.has(`${a.host}\0${a.agentId}`)) return false;
    const at = Date.parse(a.updatedAt || "");
    return Number.isFinite(at) && now - at >= limit;
  });
}

// Un point d'historique : { t, v: { "fournisseur/fenêtre": pourcentage } }.
export function pointOf(snapshot, t = Date.now()) {
  const v = {};
  for (const p of snapshot?.providers || []) {
    for (const w of p.windows || []) {
      if (Number.isFinite(w.usedPct)) v[`${p.id}/${w.id}`] = w.usedPct;
    }
  }
  return { t, v };
}

export function register(ctx) {
  const { onMessage, send, broadcast, store, log, safeError } = ctx;
  let points = store.read(HISTORY_FILE, { points: [] }).points || [];
  let tidy = { auto: false, olderThanHours: HOURS.default, ...(store.read(TIDY_FILE, {}) || {}) };
  let lastState = null;
  ctx.onStateChange((s) => { lastState = s; });

  function sample() {
    const snap = ctx.quota?.snapshot?.();
    if (!snap) return;
    const point = pointOf(snap);
    if (!Object.keys(point.v).length) return;
    points = [...points, point].filter((p) => point.t - p.t <= KEEP_MS);
    try { store.write(HISTORY_FILE, { points }); } catch (e) { log("mobile", `historique non écrit : ${safeError(e)}`); }
  }

  // `hours` (1 à 336) : seule la période affichée est envoyée, pas les 14 jours.
  onMessage("usage.history", (ws, m) => {
    const hours = Math.min(336, Math.max(1, Math.round(Number(m.hours) || 336)));
    const from = Date.now() - hours * 3_600_000;
    send(ws, { type: "usage.history", points: points.filter((p) => p.t >= from), ref: m.ref ?? null });
  });

  const settings = () => ({ type: "tidy.settings", auto: tidy.auto, olderThanHours: tidy.olderThanHours });
  onMessage("tidy.get", (ws) => send(ws, settings()));
  onMessage("tidy.set", (ws, m) => {
    tidy = { auto: m.auto === true, olderThanHours: cleanHours(m.olderThanHours ?? tidy.olderThanHours) };
    try { store.write(TIDY_FILE, tidy); } catch (e) { log("mobile", `réglage non écrit : ${safeError(e)}`); }
    broadcast(settings());
  });

  // Sessions liées à une tâche non terminée : jamais rangées (la tâche perdrait sa session).
  async function taskAgents() {
    try {
      const { replies } = await ctx.invoke("task.list", {});
      const list = replies?.find((r) => r.type === "tasks")?.tasks || [];
      return new Set(list.filter((t) => t.agentId && ["todo", "doing", "review", "blocked"].includes(t.status)).map((t) => t.agentId));
    } catch {
      return new Set();
    }
  }
  const describe = (a) => ({ host: a.host, agentId: a.agentId, title: a.title || null, cwd: a.cwd || null, updatedAt: a.updatedAt });
  onMessage("tidy.preview", async (ws, m) => {
    const keep = await taskAgents();
    const list = tidyCandidates(lastState?.agents, m.olderThanHours).filter((a) => !keep.has(a.agentId));
    send(ws, { type: "tidy.preview", olderThanHours: cleanHours(m.olderThanHours), count: list.length, agents: list.slice(0, 200).map(describe) });
  });

  async function run(hours) {
    const keep = await taskAgents();
    const list = tidyCandidates(lastState?.agents, hours).filter((a) => !keep.has(a.agentId));
    let archived = 0;
    let failed = 0;
    for (const a of list) {
      const entry = ctx.hosts.get(a.host);
      try {
        await entry.daemon.archiveAgent(a.agentId);
        archived += 1;
      } catch {
        failed += 1;
      }
    }
    if (archived) await ctx.broadcastState();
    return { archived, failed };
  }
  onMessage("tidy.run", async (ws, m) => {
    const result = await run(m.olderThanHours);
    send(ws, { type: "tidy.done", ...result });
  });

  const usageTimer = setInterval(sample, SAMPLE_MS);
  const firstSample = setTimeout(sample, 20_000);
  const tidyTimer = setInterval(async () => {
    if (!tidy.auto) return;
    const { archived, failed } = await run(tidy.olderThanHours).catch(() => ({ archived: 0, failed: 0 }));
    if (archived || failed) log("mobile", `rangement automatique : ${archived} rangée(s), ${failed} échec(s)`);
  }, TIDY_MS);
  for (const t of [usageTimer, firstSample, tidyTimer]) t.unref?.();
  return () => { clearInterval(usageTimer); clearTimeout(firstSample); clearInterval(tidyTimer); };
}
