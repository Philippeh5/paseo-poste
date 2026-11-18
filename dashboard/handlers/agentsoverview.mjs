// Vue d'ensemble des agents (page « Agents », rail) : « qui fait quoi, où, est-ce bloqué ? ».
// Les vrais agents tournent surtout dans des TERMINAUX (Claude Code, FreeBuff, Pi… lancés par le poste) : ils ne figurent pas dans
// state.agents (agents du daemon). Ce module fusionne les deux sources en une seule liste :
//   1. state.agents (agents du daemon : statut, modèle, permissions en attente) ;
//   2. les terminaux d'agents : coord.json → terms (outil, libellé, dossier, date de lancement) et, à défaut, les terminaux du daemon
//      dont le nom désigne un outil connu (« claude · BlastWin ») ;
//   3. la coordination (ctx.coord) : statut déclaré (coord_set_status), fichiers réservés, tâche liée, questions ouvertes ;
//   4. les tâches (task.list), les quotas (ctx.quota) ;
//   5. la « dernière action » d'un terminal : dernière ligne utile de son écran (windows.scrollback), ÉCHANTILLONNÉE toutes les
//      15 s, pour les seuls terminaux d'agents, avec un cache (jamais une lecture par diffusion) ;
//   6. l'état « en attente » : permission (daemon, ou invite détectée à l'écran), question ouverte à Philippe, ou écran figé > 2 min.
// Messages : agents.overview {} → { type: "agents.overview", agents, counts, at } ; diffusion du même message à chaque changement.
// Pose ctx.agentsOverview = { list(), asAgents() } : asAgents() sert à timeline.mjs pour enregistrer les épisodes des terminaux.
// Les libellés, statuts et lignes d'écran viennent de sessions externes : ce sont des DONNÉES (affichées en texte par l'interface).
import { createHash } from "node:crypto";
import { redact } from "../lib/redact.mjs";

export const SAMPLE_MS = Number(process.env.AGENTS_SAMPLE_MS) || 15000; // échantillonnage des écrans de terminaux
export const ACTIVE_MS = 2 * 60000; // écran qui a bougé il y a moins de 2 min : l'agent travaille
export const WAIT_MS = 60 * 60000; // au-delà d'1 h d'écran figé : « au repos » plutôt que « en attente »
export const STALL_MS = 30 * 60000; // agent du daemon « en cours » sans activité depuis 30 min : semble bloqué
const MAX_SAMPLED = 30;
const LINES = 40;
const TASKS_TTL_MS = 5000;
const TOOL_RE = /\b(claude-openrouter|claude-nvidia|claude-api|claude|codex|freebuff|opencode|gemini|agy|hermes|grok|aider|pi)\b/i;
const TOOL_NAMES = {
  claude: "Claude Code", "claude-openrouter": "Claude (OpenRouter)", "claude-nvidia": "Claude (NVIDIA)", "claude-api": "Claude (API)",
  codex: "Codex", freebuff: "FreeBuff", opencode: "OpenCode", gemini: "Gemini CLI", agy: "Antigravity", hermes: "Hermes", grok: "Grok",
  aider: "Aider", pi: "Pi",
};
// Invites qui attendent Philippe (Claude Code, FreeBuff, Codex, invites y/n…) : cherchées dans les dernières lignes de l'écran.
const PERMISSION_RE = /Do you want to (?:proceed|make this edit|create|run|allow|overwrite|delete|write)|Allow (?:once|always|this)|\(y\/n\)|\[y\/N\]|\[Y\/n\]|Press Enter to (?:confirm|approve)|requires? (?:your )?approval|Permission (?:required|requested)|Voulez-vous (?:continuer|autoriser)/i;
const QUESTION_RE = /Enter to select|↑\/↓ to (?:navigate|select)|take over\?|Type something\.|What would you like (?:me )?to do|Waiting for (?:your )?(?:input|answer|reply)/i;
// Lignes sans information : cadres, invites vides, barres d'état des outils.
const NOISE_RE = [
  /^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║▔▁▏▕\-_=*·•.>❯$#%~]*$/,
  /esc to (?:interrupt|cancel)|\? for shortcuts|shift\+tab|ctrl\+[a-z] to|auto-accept|bypass permissions|accept edits on/i,
  /\b\d+(?:[.,]\d+)?k? tokens?\b|context (?:left|window)|^\s*\[?\d{1,3} ?%\]?\s*$/i,
  /^\s*(?:Tip|Astuce)\s*:/i,
  /[█░▓▒]{2,}|\b5H \d+%|\b7J \d+%|Hors Claude|1: (?:Learn more|Yes|Bad)/, // ligne d'état de Claude Code (modèle, contexte, quotas)
  /^\s*(?:\([\w.-]+\)\s*)?[\w.-]+@[\w.-]+(?::[^\s]*)?\s*[$#%>]\s*$/, // invite du shell (« ubuntu@machine:~/Projets/X$ »)
  /^\s*(?:PS [A-Z]:\\[^>]*>|[A-Z]:\\[^>]*>)\s*$/, // invite PowerShell / cmd
];
const ACTIVE_STATUS = new Set(["running", "initializing", "working"]);

const toolOf = (s) => {
  const m = TOOL_RE.exec(String(s ?? ""));
  return m ? m[1].toLowerCase() : null;
};
export const toolName = (tool) => TOOL_NAMES[tool] || tool || "Agent";
const folderOf = (dir) => String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";
const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const ms = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? null : t;
};

// Dernière ligne « utile » d'un écran : on saute cadres, invites vides et barres d'état, puis on retire les puces de début.
export function usefulLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = String(lines[i] ?? "");
    if (NOISE_RE.some((re) => re.test(raw))) continue;
    const line = raw.replace(/^[\s│┃╭╰├└>❯⏺●○◆◇✻✶✳✢✽·*•⎿-]+/u, "").replace(/[\s│┃╮╯┤]+$/u, "").trim();
    if (line.length < 3 || NOISE_RE.some((re) => re.test(line))) continue;
    return clip(redact(line), 160);
  }
  return "";
}
// Ligne de l'écran à montrer : la dernière ligne utile, ou, devant une invite, « action demandée → question » (sinon on lirait « 2. No »).
export function screenLine(lines) {
  const tail = lines.length - 12;
  for (let i = lines.length - 1; i >= Math.max(0, tail); i--) {
    if (!PERMISSION_RE.test(lines[i]) && !QUESTION_RE.test(lines[i])) continue;
    const before = usefulLine(lines.slice(0, i));
    const question = usefulLine([lines[i]]);
    return clip([before, question].filter(Boolean).join(" → "), 160);
  }
  return usefulLine(lines);
}
// Invite en attente à l'écran : « permission », « question » ou null (10 dernières lignes non vides).
export function promptOf(lines) {
  const tail = lines.filter((l) => String(l).trim()).slice(-10).join("\n");
  if (PERMISSION_RE.test(tail)) return "permission";
  if (QUESTION_RE.test(tail)) return "question";
  return null;
}

// État affiché, d'après les signaux. `now` en ms. Renvoie { state, reason, text }.
// state : active | waiting | blocked | idle | unknown ; reason : permission | question | inactivite | erreur | quota | bloque | null.
export function stateOf(sig, now = Date.now()) {
  const minutes = (t) => Math.max(0, Math.floor((now - t) / 60000));
  const since = (t, approx) => `${approx && minutes(t) >= 1 ? "au moins " : ""}${durationText(minutes(t))}`;
  if (sig.offline) return { state: "unknown", reason: null, text: "Machine injoignable" };
  if (sig.status === "error") return { state: "blocked", reason: "erreur", text: "En erreur" };
  if (sig.status === "waiting-permission" || sig.prompt === "permission") return { state: "waiting", reason: "permission", text: "En attente : permission demandée" };
  if (sig.blocker) return { state: "blocked", reason: "bloque", text: "Bloqué : a signalé un blocage" };
  if (sig.question || sig.prompt === "question") return { state: "waiting", reason: "question", text: "En attente : question posée" };
  const last = sig.lastActivityAt;
  if (sig.kind === "agent") {
    if (ACTIVE_STATUS.has(sig.status)) {
      if (last && now - last > STALL_MS) return { state: "blocked", reason: "bloque", text: `Semble bloqué : rien depuis ${since(last)}` };
      return { state: "active", reason: null, text: "Travaille" };
    }
    if (sig.quotaExhausted) return { state: "blocked", reason: "quota", text: `Bloqué : ${sig.quotaDetail || "quota épuisé"}` };
    return { state: "idle", reason: null, text: last ? `Au repos depuis ${since(last)}` : "Au repos" };
  }
  // Terminal d'agent : seul l'écran dit s'il travaille (un agent qui travaille fait bouger son écran : spinner, sortie).
  if (last == null) {
    // Jamais vu bouger depuis le début de l'observation (redémarrage du poste) : on ne sait que « immobile depuis au moins… ».
    if (sig.stillSince == null) return { state: "unknown", reason: null, text: "Écran pas encore lu" };
    if ((sig.samples || 0) < 2) return { state: "unknown", reason: null, text: "Écran lu, activité à confirmer" };
    if (sig.quotaExhausted) return { state: "blocked", reason: "quota", text: `Bloqué : ${sig.quotaDetail || "quota épuisé"}` };
    if (now - sig.stillSince < WAIT_MS) return { state: "waiting", reason: "inactivite", text: `En attente : aucune activité vue depuis ${since(sig.stillSince, true)}` };
    return { state: "idle", reason: null, text: `Au repos depuis ${since(sig.stillSince, true)}` };
  }
  if (now - last < ACTIVE_MS) return { state: "active", reason: null, text: "Travaille" };
  if (sig.quotaExhausted) return { state: "blocked", reason: "quota", text: `Bloqué : ${sig.quotaDetail || "quota épuisé"}` };
  if (now - last < WAIT_MS) return { state: "waiting", reason: "inactivite", text: `En attente : écran figé depuis ${since(last)}` };
  return { state: "idle", reason: null, text: `Au repos depuis ${since(last)}` };
}
export function durationText(min) {
  if (min < 1) return "moins d'1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
  return `${Math.floor(h / 24)} j`;
}
export function countsOf(agents) {
  const counts = { active: 0, waiting: 0, blocked: 0, idle: 0, unknown: 0, total: agents.length };
  for (const a of agents) counts[a.state] = (counts[a.state] || 0) + 1;
  return counts;
}

export function register(ctx) {
  const { onMessage, send, broadcast, log, safeError } = ctx;
  const screens = new Map(); // "host|terminalId" → { hash, line, prompt, changedAt|null, stillSince, samples, sampledAt }
  let latestState = null;
  let agents = [];
  let lastSig = "";
  let tasksCache = [];
  let tasksAt = 0;
  let sampling = false;

  async function getTasks() {
    if (Date.now() - tasksAt < TASKS_TTL_MS) return tasksCache;
    tasksAt = Date.now();
    try {
      const r = await ctx.invoke("task.list", {}, { timeoutMs: 5000 });
      tasksCache = r.replies.find((x) => x.type === "tasks")?.tasks || tasksCache;
    } catch { /* dernière liste connue */ }
    return tasksCache;
  }

  // Terminaux d'agents vivants : enregistrés par le poste (coord terms) ou nommés d'après un outil connu.
  function terminalAgents(state) {
    const terms = ctx.coord?._state?.data?.terms || {};
    const out = [];
    for (const t of state.terminals || []) {
      const key = `${t.host}:term-${t.terminalId}`;
      const rec = terms[key];
      const tool = rec?.tool || toolOf(t.name);
      if (!tool) continue;
      out.push({ t, rec: rec || null, key, tool });
    }
    return out;
  }

  // Lecture des écrans (toutes les SAMPLE_MS, jamais pendant une diffusion) : 3 lectures en parallèle au plus.
  async function sample() {
    if (sampling || !latestState) return;
    sampling = true;
    try {
      const connected = new Set((latestState.hosts || []).filter((h) => h.status === "connected").map((h) => h.label));
      const list = terminalAgents(latestState).filter((x) => connected.has(x.t.host)).slice(0, MAX_SAMPLED);
      const live = new Set(list.map((x) => `${x.t.host}|${x.t.terminalId}`));
      for (const k of [...screens.keys()]) if (!live.has(k)) screens.delete(k);
      const queue = [...list];
      const worker = async () => {
        for (let x = queue.shift(); x; x = queue.shift()) {
          const id = `${x.t.host}|${x.t.terminalId}`;
          try {
            const r = await ctx.invoke("windows.scrollback", { host: x.t.host, terminalId: x.t.terminalId, lines: LINES }, { timeoutMs: 6000 });
            const reply = r.replies.find((m) => m.type === "windows.scrollback");
            if (!reply) continue;
            const lines = Array.isArray(reply.lines) ? reply.lines.map(String) : [];
            const hash = createHash("sha1").update(lines.join("\n")).digest("hex");
            const now = Date.now();
            const prev = screens.get(id);
            const changed = !prev || prev.hash !== hash;
            // Premier échantillon : on ne sait pas depuis quand l'écran est figé (changedAt inconnu, « immobile depuis au moins… »).
            screens.set(id, {
              hash, line: screenLine(lines), prompt: promptOf(lines), sampledAt: now, samples: (prev?.samples || 0) + 1,
              changedAt: !prev ? null : changed ? now : prev.changedAt,
              stillSince: !prev || changed ? now : prev.stillSince,
            });
          } catch (e) { log("agents", `écran illisible (${x.t.terminalId.slice(0, 8)}) : ${safeError(e)}`); }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } finally { sampling = false; }
    await rebuild();
  }

  function quotaFor(tool) {
    const providers = ctx.quota?.snapshot?.().providers || [];
    if (!tool) return null;
    const id = String(tool).toLowerCase().split("/")[0];
    const p = providers.find((x) => x.id === id) || (id === "pi" ? providers.find((x) => String(x.id).startsWith("pi/")) : null);
    if (!p) return null;
    const used = Math.max(-1, ...(p.windows || []).map((w) => Number(w.usedPct ?? -1)));
    return { provider: p.id, name: p.name, state: p.state, detail: p.detail, usedPct: used >= 0 ? used : null };
  }

  async function rebuild() {
    const state = latestState;
    if (!state) return;
    const now = Date.now();
    const coordState = ctx.coord?._state;
    const sessions = coordState?.sessions;
    const reservations = (coordState?.data?.reservations || []).filter((r) => ms(r.expiresAt) > now);
    const messages = (coordState?.data?.messages || []).slice(-300);
    const tasks = await getTasks();
    const connected = new Set((state.hosts || []).filter((h) => h.status === "connected").map((h) => h.label));
    const answered = new Set(messages.filter((m) => m.replyTo).map((m) => m.replyTo));
    const openFrom = (key, kinds) => messages.some((m) => m.from === key && kinds.includes(m.kind) && !m.resolved && !answered.has(m.id) &&
      (m.to === "human" || m.to === "team" || m.group) && now - (ms(m.at) || 0) < 24 * 3600000);
    const projectOf = (host, cwd, s) => {
      const p = s?.project || (cwd && ctx.coord?.projectOf ? ctx.coord.projectOf(host, cwd) : null);
      return p ? { key: p.key, name: p.name, dir: p.dir } : { key: `${host}|${cwd || ""}`, name: folderOf(cwd) || "Sans projet", dir: cwd || "" };
    };
    const coordOf = (key) => {
      const s = sessions?.get?.(key) || null;
      const d = coordState?.declared?.get?.(key) || null;
      return {
        s,
        statusText: clip(d?.statusText || "", 200),
        files: [...new Set([...reservations.filter((r) => r.session === key).map((r) => r.rel), ...(d?.files || [])])].slice(0, 12),
        task: s?.taskId ? { id: s.taskId, title: s.taskTitle, status: s.taskStatus } : null,
        unread: 0,
      };
    };
    const taskFor = (host, agentId) => {
      const t = tasks.find((x) => x.host === host && x.agentId && x.agentId === agentId);
      return t ? { id: t.id, title: clip(t.title, 80), status: t.status } : null;
    };
    const out = [];
    for (const a of state.agents || []) {
      if (!a?.agentId || a.status === "closed") continue;
      const key = `${a.host}:${a.agentId}`;
      const c = coordOf(key);
      const quota = quotaFor(a.provider);
      const last = ms(a.updatedAt);
      const st = stateOf({
        kind: "agent", offline: !connected.has(a.host), status: a.status, lastActivityAt: last,
        question: openFrom(key, ["question"]), blocker: openFrom(key, ["blocker"]),
        quotaExhausted: quota?.state === "exhausted", quotaDetail: quota?.detail,
      }, now);
      out.push({
        key, kind: "agent", host: a.host, agentId: a.agentId, terminalId: null, parentAgentId: a.parentAgentId ?? null,
        tool: a.provider || "inconnu", toolName: toolName(a.provider), model: a.model || null,
        label: clip(c.s?.label || a.title || "", 80), title: clip(a.title || "", 120), cwd: a.cwd || null, project: projectOf(a.host, a.cwd, c.s),
        state: st.state, reason: st.reason, stateText: st.text,
        lastAction: c.statusText || clip(a.title || "", 160), lastActionSource: c.statusText ? "statut" : a.title ? "titre" : null,
        lastActivityAt: a.updatedAt || null, approx: false, startedAt: a.duration ? new Date(now - a.duration).toISOString() : null,
        files: c.files, task: c.task || taskFor(a.host, a.agentId), quota,
        pending: (a.pending || []).slice(0, 5).map((p) => ({ id: p.id, title: clip(p.title, 120) })),
      });
    }
    for (const { t, rec, key, tool } of terminalAgents(state)) {
      const screen = screens.get(`${t.host}|${t.terminalId}`) || null;
      const c = coordOf(key);
      const quota = quotaFor(tool);
      const st = stateOf({
        kind: "terminal", offline: !connected.has(t.host), lastActivityAt: screen?.changedAt ?? null,
        stillSince: screen?.stillSince ?? null, samples: screen?.samples || 0,
        prompt: screen?.prompt || null, question: openFrom(key, ["question"]), blocker: openFrom(key, ["blocker"]),
        quotaExhausted: quota?.state === "exhausted", quotaDetail: quota?.detail,
      }, now);
      const cwd = t.cwd || rec?.cwd || null;
      out.push({
        key, kind: "terminal", host: t.host, agentId: null, terminalId: t.terminalId, parentAgentId: null,
        tool, toolName: toolName(tool), model: c.s?.model || null,
        label: clip(rec?.label || t.name || `${toolName(tool)} · ${folderOf(cwd)}`, 80), title: clip(t.name || "", 120), cwd,
        project: projectOf(t.host, cwd, c.s), registered: Boolean(rec),
        state: st.state, reason: st.reason, stateText: st.text,
        lastAction: c.statusText || screen?.line || "", lastActionSource: c.statusText ? "statut" : screen?.line ? "terminal" : null,
        // Dernier signe de vie : dernier changement d'écran vu ; à défaut, début de l'observation (« au moins »).
        lastActivityAt: screen ? new Date(screen.changedAt ?? screen.stillSince).toISOString() : null, approx: Boolean(screen && screen.changedAt == null),
        startedAt: rec?.at || null, sampledAt: screen?.sampledAt ? new Date(screen.sampledAt).toISOString() : null,
        files: c.files, task: c.task, quota, pending: [],
      });
    }
    const rank = { waiting: 0, blocked: 1, active: 2, unknown: 3, idle: 4 };
    out.sort((x, y) => x.project.name.localeCompare(y.project.name) || rank[x.state] - rank[y.state] || x.label.localeCompare(y.label));
    agents = out;
    // Diffusion seulement si quelque chose d'affiché a changé (les minutes écoulées sont recalculées par l'interface).
    const sig = JSON.stringify(out.map((a) => [a.key, a.state, a.reason, a.stateText.replace(/\d+/g, ""), a.lastAction, a.lastActivityAt, a.files, a.task, a.quota?.state, a.label, a.model, a.project.key]));
    if (sig === lastSig) return;
    lastSig = sig;
    broadcast(payload());
  }
  const payload = () => ({ type: "agents.overview", agents, counts: countsOf(agents), at: new Date().toISOString() });

  ctx.onStateChange((state) => {
    latestState = state;
    rebuild().catch((e) => log("agents", `vue d'ensemble : ${safeError(e)}`));
  });
  const timer = setInterval(() => { sample().catch((e) => log("agents", `échantillonnage : ${safeError(e)}`)); }, SAMPLE_MS);
  timer.unref?.();
  // Premier échantillon peu après le démarrage (le premier état arrive en quelques secondes).
  setTimeout(() => { sample().catch(() => {}); }, 3000).unref?.();

  onMessage("agents.overview", async (ws) => {
    if (latestState && !agents.length) await rebuild().catch(() => {});
    send(ws, payload());
  });

  ctx.agentsOverview = {
    list: () => agents,
    sampleNow: () => sample(), // tests : lecture immédiate des écrans
    rebuild: () => rebuild(),
    // Terminaux d'agents vus comme des agents du daemon (pour timeline.mjs) : « running » tant que l'écran bouge.
    asAgents: () => agents.filter((a) => a.kind === "terminal").map((a) => ({
      host: a.host, agentId: `term-${a.terminalId}`, title: a.label, provider: a.tool, model: a.model, cwd: a.cwd,
      status: a.state === "active" ? "running" : a.reason === "permission" ? "waiting-permission" : "idle",
    })),
  };
  ctx.apiRoute?.("GET", "/agents", () => ({ agents, counts: countsOf(agents) }));
}
