
import { extractQuestions, cleanAnswers } from "../lib/questions.mjs";// Messages de base des agents : fil en direct, envoi, arrêt, permissions. Fournis avec le poste de commande (v2).
import { SELF_HOST } from "../lib/selfhost.mjs";
export function register(ctx) {
  const { onMessage, send, sendError, safeError, broadcastState, hostOf } = ctx;
  const streams = new Map();

  const release = (key) => {
    const stream = streams.get(key);
    (stream?.subscription?.release?.() || Promise.resolve()).catch(() => {});
    streams.delete(key);
  };
  ctx.onDisconnect((ws) => {
    for (const [key, stream] of streams) if (stream.ws === ws) release(key);
  });
  ctx.onHostRemoved((label) => {
    for (const [key, stream] of streams) if (stream.host === label) release(key);
  });

  onMessage("agent.watch", async (ws, m) => {
    const { label, entry } = hostOf(m);
    if (!entry || !m.agentId) return sendError(ws, "hôte ou agent inconnu");
    const key = `${ws._uiId}:${label}:${m.agentId}`;
    if (streams.has(key)) return;
    try {
      const ref = entry.api.agents.ref(m.agentId);
      const history = await ref.timeline.refetch({ direction: "tail", limit: 100 });
      const items = history.entries || history.items || history.timeline || [];
      send(ws, { type: "agent.history", host: label, agentId: m.agentId, items, payload: history });
      const subscription = ref.timeline.subscribe((event) => {
        send(ws, { type: "agent.event", host: label, agentId: m.agentId, event });
      });
      streams.set(key, { host: label, ws, subscription });
      await subscription.ready;
    } catch (e) {
      streams.delete(key);
      sendError(ws, `fil d'activité indisponible : ${safeError(e)}`);
    }
  });

  onMessage("agent.unwatch", (ws, m) => release(`${ws._uiId}:${hostOf(m).label}:${m.agentId}`));

  onMessage("agent.send", async (ws, m) => {
    const { entry } = hostOf(m);
    if (!entry || !m.agentId || !m.text?.trim()) return sendError(ws, "agent et message requis");
    try {
      await entry.api.agents.ref(m.agentId).send(m.text);
    } catch (e) {
      sendError(ws, `envoi impossible : ${safeError(e)}`);
    }
  });

  onMessage("agent.stop", async (ws, m) => {
    const { entry } = hostOf(m);
    if (!entry || !m.agentId) return sendError(ws, "agent inconnu");
    try {
      await entry.daemon.cancelAgent(m.agentId);
      await broadcastState();
    } catch (e) {
      sendError(ws, `arrêt impossible : ${safeError(e)}`);
    }
  });

  // Ferme une session : l'arrête si elle travaille encore, puis l'archive (elle disparaît du rail).
  onMessage("agent.close", async (ws, m) => {
    const { entry } = hostOf(m);
    if (!entry || !m.agentId) return sendError(ws, "agent inconnu");
    try {
      if (m.stop) await entry.daemon.cancelAgent(m.agentId).catch(() => {});
      await entry.daemon.archiveAgent(m.agentId);
      await broadcastState();
    } catch (e) {
      sendError(ws, `fermeture impossible : ${safeError(e)}`);
    }
  });

  onMessage("perm.respond", async (ws, m) => {
    const { entry } = hostOf(m);
    if (!entry || !m.agentId || !m.requestId) return sendError(ws, "demande de permission inconnue");
    const behavior = m.behavior === "allow" ? "allow" : "deny";
    const response = m.actionId ? { behavior, selectedActionId: String(m.actionId) } : { behavior };
    // Question de direction d'un agent : la réponse (choix de l'option ou texte libre) part dans updatedInput.answers.
    if (behavior === "allow" && m.answers !== undefined) {
      let questions = null;
      try {
        const listed = await entry.api.agents.list({});
        const row = (listed.entries || []).map((r) => r.agent || r).find((a) => a.id === m.agentId);
        const pend = (row?.pendingPermissions || []).find((x) => x.id === m.requestId);
        questions = pend ? extractQuestions(pend) : null;
      } catch { /* demande introuvable : refusée ci-dessous */ }
      if (!questions) return sendError(ws, "cette demande n'est pas une question");
      try { response.updatedInput = { answers: cleanAnswers(m.answers, questions) }; } catch (e) { return sendError(ws, e.message); }
      if (!String(ws?._uiId ?? "").startsWith("invoke:")) ctx.questionRelay?.answeredOnPoste?.(response.updatedInput.answers);
    }
    // T34 : refus lisible pour l'agent (message du mandat) ; sauvegarde du fichier AVANT toute autorisation de modification.
    if (behavior === "deny" && typeof m.message === "string" && m.message.trim()) response.message = m.message.trim().slice(0, 300);
    // T36 : jamais d'accord (humain ou automatique) sur un fichier réservé par une autre session, ni d'écriture d'une session en lecture seule.
    if (behavior === "allow" && ctx.coordGuard) {
      let coordGuard;
      try {
        coordGuard = await ctx.coordGuard.beforeAllow({ host: m.host || SELF_HOST, agentId: m.agentId, requestId: m.requestId });
      } catch {
        coordGuard = { ok: true };
      }
      if (coordGuard && coordGuard.ok === false) return sendError(ws, coordGuard.message || "autorisation refusée par la coordination");
    }
    // Fail closed : si la sauvegarde avant une modification échoue, l'autorisation est refusée (rien n'est envoyé à l'agent).
    if (behavior === "allow" && ctx.permGuard) {
      let guard;
      try {
        guard = await ctx.permGuard.beforeAllow({ host: m.host || SELF_HOST, agentId: m.agentId, requestId: m.requestId });
      } catch {
        guard = { ok: false, error: "vérification impossible" };
      }
      if (guard && guard.ok === false) {
        return sendError(ws, `autorisation refusée : sauvegarde impossible avant la modification (${guard.error || "erreur"}). Refusez la demande ou libérez de la place.`);
      }
    }
    try {
      await entry.api.agents.ref(m.agentId).respondToPermission({ requestId: m.requestId, response });
      await broadcastState();
    } catch (e) {
      sendError(ws, `réponse impossible : ${safeError(e)}`);
    }
  });
}
