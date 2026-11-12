// API des fenêtres : permet à un agent IA de voir le bureau et de lire/piloter les terminaux.
// Messages WS : desk.state {windows}, windows.list {}, windows.scrollback {host, terminalId, lines?},
//               windows.send {host, terminalId, text, enter?, confirm: true}.
// HTTP (lecture seule) : GET /api/windows, GET /api/windows/scrollback?host=&terminal=&lines=
// Documentation : dashboard/README.md, section « API des fenêtres ».

const DEFAULT_LINES = 200;
const MAX_LINES = 2000;
const MAX_WINDOWS = 200;
const MAX_TEXT = 10000;
const ID_PATTERN = /^[\w:.-]{1,200}$/;

const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const int = (v, fallback) => (Number.isFinite(v) ? Math.round(v) : fallback);

// Normalise une fenêtre envoyée par le navigateur (jamais de champ inconnu ni de texte long).
function cleanWindowEntry(w) {
  if (!w || typeof w !== "object") return null;
  return {
    id: text(w.id, 80),
    kind: w.kind === "agent" ? "agent" : "terminal",
    host: text(w.host, 60) || "local",
    cwd: text(w.cwd, 1000),
    title: text(w.title, 200),
    terminalId: text(w.terminalId, 200),
    agentId: text(w.agentId, 200),
    minimized: w.minimized === true,
    focused: w.focused === true,
    x: int(w.x, 0),
    y: int(w.y, 0),
    w: int(w.w, 480),
    h: int(w.h, 320),
  };
}

export function register(ctx) {
  const { onMessage, send, sendError, log, safeError, hostOf } = ctx;
  // Dernier état du bureau par connexion navigateur (supprimé à la déconnexion).
  const browserStates = new Map(); // ws._uiId -> { windows, updatedAt }

  // Fenêtres de tous les navigateurs connectés, dédoublonnées (même terminal/agent ouvert deux fois).
  function allWindows() {
    const seen = new Set();
    const result = [];
    for (const [browserId, state] of browserStates) {
      for (const win of state.windows) {
        const key = `${win.host}:${win.kind}:${win.terminalId || win.agentId || win.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ ...win, browserId });
      }
    }
    return result;
  }

  async function terminalExists(entry, terminalId) {
    const known = await entry.api.terminals.list({});
    return (known.entries || []).some((t) => t.id === terminalId);
  }

  // Dernières lignes d'un terminal (texte brut, sans les lignes vides de fin d'écran).
  async function fetchScrollback(host, terminalId, lines) {
    if (!ID_PATTERN.test(String(terminalId || ""))) throw new Error("terminal invalide");
    const { entry } = hostOf({ host });
    if (!entry) throw new Error(`hôte inconnu : ${host}`);
    if (!entry.connected()) throw new Error(`hôte indisponible : ${host}`);
    const count = Math.min(Math.max(1, Math.round(Number(lines) || DEFAULT_LINES)), MAX_LINES);
    if (!(await terminalExists(entry, terminalId))) throw new Error("terminal inconnu");
    const capture = await entry.api.terminals.ref(terminalId).capture({ stripAnsi: true, start: -(count + 200) });
    // Le jeton de coordination tapé au lancement d'un outil ne doit jamais ressortir par cette lecture.
    const all = (capture.lines || []).map((l) => String(l).replace(/(PASEO_COORD_TOKEN=)[^\s"]+/g, "$1[masqué]"));
    while (all.length && !all.at(-1).trim()) all.pop();
    return { host, terminalId, lines: all.slice(-count), totalLines: capture.totalLines ?? all.length };
  }

  onMessage("desk.state", (ws, m) => {
    if (!Array.isArray(m.windows)) return;
    const windows = m.windows.slice(0, MAX_WINDOWS).map(cleanWindowEntry).filter(Boolean);
    browserStates.set(ws._uiId, { windows, updatedAt: new Date().toISOString() });
  });

  ctx.onDisconnect((ws) => browserStates.delete(ws._uiId));

  onMessage("windows.list", (ws) => send(ws, { type: "windows.list", windows: allWindows() }));

  onMessage("windows.scrollback", async (ws, m) => {
    try {
      const result = await fetchScrollback(m.host || "local", m.terminalId, m.lines);
      send(ws, { type: "windows.scrollback", ...result });
    } catch (e) {
      sendError(ws, `scrollback impossible : ${safeError(e)}`);
    }
  });

  // Action sensible : saisie dans un terminal. Exige confirm: true ; le texte n'est jamais journalisé.
  onMessage("windows.send", async (ws, m) => {
    if (m.confirm !== true) return sendError(ws, "action sensible : confirm: true est requis");
    const { label, entry } = hostOf({ host: m.host || "local" });
    const terminalId = text(m.terminalId, 200);
    const input = typeof m.text === "string" ? m.text : "";
    if (!entry || !entry.connected()) return sendError(ws, `hôte indisponible : ${label}`);
    if (!terminalId || !ID_PATTERN.test(terminalId) || !input || input.length > MAX_TEXT) {
      return sendError(ws, "terminalId et texte (10000 caractères max) requis");
    }
    try {
      if (!(await terminalExists(entry, terminalId))) return sendError(ws, "terminal inconnu");
      log("windows", `windows.send host=${label} terminal=${terminalId.slice(0, 8)} longueur=${input.length}`);
      entry.daemon.sendTerminalInput(terminalId, { type: "input", data: m.enter ? `${input}\r` : input });
      send(ws, { type: "windows.sent", host: label, terminalId });
    } catch (e) {
      sendError(ws, `envoi impossible : ${safeError(e)}`);
    }
  });

  // ---- HTTP en lecture seule (authentification : voir server.mjs) ----
  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  ctx.onHttp?.("/api/windows", (_req, res) => json(res, 200, { windows: allWindows() }));
  ctx.onHttp?.("/api/windows/scrollback", async (_req, res, url) => {
    const host = url.searchParams.get("host") || "local";
    const terminal = url.searchParams.get("terminal");
    if (!terminal) return json(res, 400, { error: "paramètre terminal requis" });
    try {
      json(res, 200, await fetchScrollback(host, terminal, url.searchParams.get("lines")));
    } catch (e) {
      json(res, 404, { error: safeError(e) });
    }
  });
}
