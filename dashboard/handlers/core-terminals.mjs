// Messages de base des terminaux. Fournis avec le poste de commande (v2).
export function register(ctx) {
  const { onMessage, send, sendError, safeError, broadcastState, hostOf } = ctx;
  const streams = new Map();

  const release = (key) => {
    streams.get(key)?.subscription.release().catch(() => {});
    streams.delete(key);
  };
  ctx.onDisconnect((ws) => {
    for (const [key, stream] of streams) if (stream.ws === ws) release(key);
  });
  ctx.onHostRemoved((label) => {
    for (const [key, stream] of streams) if (stream.host === label) release(key);
  });

  onMessage("term.open", (ws, m) => {
    const { label, entry } = hostOf(m);
    if (!entry || !m.terminalId) return sendError(ws, "hôte ou terminal inconnu");
    const key = `${ws._uiId}:${label}:${m.terminalId}`;
    if (streams.has(key)) return;
    const rows = Math.max(2, Math.floor(Number(m.rows) || 24));
    const cols = Math.max(10, Math.floor(Number(m.cols) || 80));
    entry.daemon.sendTerminalInput(m.terminalId, { type: "resize", rows, cols, intent: "claim" });
    const subscription = entry.daemon.observeTerminal(
      m.terminalId,
      (event) => {
        if (event.type === "output" || event.type === "restore") {
          const type = event.type === "restore" ? "term.snapshot" : "term.output";
          send(ws, { type, host: label, terminalId: m.terminalId, data: Buffer.from(event.data).toString("base64") });
        } else {
          send(ws, { type: "term.snapshot", host: label, terminalId: m.terminalId, state: event.state });
        }
      },
      { restore: { mode: "visible-snapshot", size: { rows, cols } } },
    );
    streams.set(key, { host: label, terminalId: m.terminalId, ws, subscription });
    subscription.ready
      .then((r) => {
        if (r.error) sendError(ws, `terminal non observable : ${r.error}`);
      })
      .catch((e) => sendError(ws, `abonnement terminal impossible : ${safeError(e)}`));
  });

  onMessage("term.input", (ws, m) => {
    const { entry } = hostOf(m);
    if (!entry || !m.terminalId) return sendError(ws, "hôte ou terminal inconnu");
    entry.daemon.sendTerminalInput(m.terminalId, { type: "input", data: String(m.data || "") });
  });

  onMessage("term.resize", (_ws, m) => {
    const { entry } = hostOf(m);
    if (!entry || !m.terminalId) return;
    const rows = Math.max(2, Math.floor(Number(m.rows) || 24));
    const cols = Math.max(10, Math.floor(Number(m.cols) || 80));
    entry.daemon.sendTerminalInput(m.terminalId, { type: "resize", rows, cols, intent: "claim" });
  });

  onMessage("term.create", async (ws, m) => {
    const { label, entry } = hostOf(m);
    if (!entry || !m.workspaceId) return sendError(ws, "hôte ou workspace inconnu");
    try {
      const t = await entry.api.terminals.create({ workspaceId: m.workspaceId });
      send(ws, { type: "term.created", host: label, terminalId: t.id, workspaceId: m.workspaceId });
      await broadcastState();
    } catch (e) {
      sendError(ws, `création du terminal impossible : ${safeError(e)}`);
    }
  });

  onMessage("term.kill", async (ws, m) => {
    const { label, entry } = hostOf(m);
    if (!entry || !m.terminalId) return sendError(ws, "terminal inconnu");
    try {
      const res = await entry.daemon.killTerminal(m.terminalId);
      if (res && res.success === false) return sendError(ws, `fermeture impossible : ${safeError(res.error || "terminal introuvable")}`);
      for (const [key, s] of streams) if (s.host === label && s.terminalId === m.terminalId) release(key);
      await broadcastState();
      send(ws, { type: "term.killed", host: label, terminalId: m.terminalId });
    } catch (e) {
      sendError(ws, `fermeture impossible : ${safeError(e)}`);
    }
  });

  onMessage("term.rename", async (ws, m) => {
    const { entry } = hostOf(m);
    if (!entry || !m.terminalId || !m.name?.trim()) return sendError(ws, "terminal et nom requis");
    try {
      await entry.daemon.renameTerminal({ terminalId: m.terminalId, title: m.name.trim() });
      await broadcastState();
    } catch (e) {
      sendError(ws, `renommage impossible : ${safeError(e)}`);
    }
  });
}
