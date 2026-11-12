// Journal d'activité par projet (T42) : « ce qui s'est passé aujourd'hui sur <projet> ».
// Agrège pour un jour (fuseau local) : tâches créées / démarrées / à valider / terminées (task.list + transitions
// observées),
// sessions lancées et fermées (data/timeline.json), décisions de permission automatiques (data/agent-activity.json),
// messages de groupe (data/coord.json) et rapports de mission (ctx.missionReports). Lecture seule sur les données des
// autres modules ; seul data/journal.json (transitions de tâches observées, 2000 au plus) est écrit ici.
// Messages WS : journal.get {day?, project?} -> journal.data {day, projects:[{name, dir, host, events:[{at, kind,
// text}]}]}. REST (si ctx.apiRoute) : GET /api/v1/journal?day=AAAA-MM-JJ&project=nom .
// Exposé : ctx.journal.summaryText({day, project, maxChars}) -> Promise<string> (texte compact pour que Jarvis
// réponde à « résume ma journée »).
// Types d'événement : tache (champ state : created|doing|review|done|blocked|todo), session, permission, message,
// rapport.
import { redact } from "../lib/redact.mjs";
import { ApiError } from "./agentapi.mjs";

const FILE = "journal";
const MAX_LOG = 2000;
const MAX_EVENTS = 400; // par projet et par jour
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GENERAL = "Poste (hors projet)";
const RUN_SLACK_MS = 10 * 60_000;
const AUTO_DECISION = /^(Autorisé automatiquement|Refusé par le mandat)/;

const slashes = (value) => String(value ?? "").replace(/\\/g, "/");
const folderName = (dir) => slashes(dir).replace(/\/+$/, "").split("/").pop() || "";
const clip = (value, max) => {
  const s = redact(String(value ?? "")).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const pad = (n) => String(n).padStart(2, "0");
export const localDay = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const hhmm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// Bornes locales d'un jour « AAAA-MM-JJ » ; null si la date n'existe pas.
export function dayRange(day) {
  const m = DAY_RE.exec(String(day ?? ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = new Date(y, mo - 1, d);
  if (start.getFullYear() !== y || start.getMonth() !== mo - 1 || start.getDate() !== d) return null;
  return { start: start.getTime(), end: new Date(y, mo - 1, d + 1).getTime() };
}

const TASK_TEXT = {
  created: (t) => `Tâche créée : ${t}`,
  todo: (t) => `Tâche remise à faire : ${t}`,
  doing: (t) => `Tâche démarrée : ${t}`,
  review: (t) => `Tâche à valider : ${t}`,
  done: (t) => `Tâche terminée : ${t}`,
  blocked: (t, reason) => `Tâche bloquée : ${t}${reason ? ` (${reason})` : ""}`,
};
const REPORT_LABEL = { review: "à valider", done: "terminé", error: "en erreur" };
const SESSION_END = { closed: "terminée", error: "terminée en erreur", interrupted: "interrompue" };

export function register(ctx) {
  const { onMessage, send, sendError, store, log } = ctx;

  const saved = store.read(FILE, null);
  const state = {
    taskStatus: saved?.taskStatus && typeof saved.taskStatus === "object" ? saved.taskStatus : {},
    events: Array.isArray(saved?.events) ? saved.events.filter((e) => e && e.taskId && e.at && e.state) : [],
  };
  const persist = () => {
    state.events = state.events.slice(-MAX_LOG);
    try { store.write(FILE, state); } catch (e) { log("journal", `écriture impossible : ${ctx.safeError(e)}`); }
  };

  async function listTasks() {
    try {
      const result = await ctx.invoke("task.list", {});
      return result.replies.find((r) => r.type === "tasks")?.tasks || [];
    } catch {
      return [];
    }
  }

  // ---------- Transitions de tâches observées (la base ne garde que la dernière date de mise à jour) ----------
  let observing = false;
  async function observe() {
    if (observing) return;
    observing = true;
    try {
      const tasks = await listTasks();
      if (!tasks.length && !Object.keys(state.taskStatus).length) return;
      let dirty = false;
      const seen = new Set();
      for (const t of tasks) {
        seen.add(t.id);
        const prev = state.taskStatus[t.id];
        if (prev !== t.status) {
          if (prev !== undefined) {
            const stamp = Date.parse(t.updatedAt);
            const at = Number.isNaN(stamp) || stamp > Date.now() ? new Date().toISOString() : t.updatedAt;
            state.events.push({
              at, taskId: t.id, state: t.status, title: clip(t.title, 120), dir: t.project || "",
              host: t.host || "local",
              reason: clip(t.status === "blocked" ? t.reason : "", 80), agent: t.origin === "agent",
            });
          }
          state.taskStatus[t.id] = t.status;
          dirty = true;
        }
      }
      for (const id of Object.keys(state.taskStatus)) if (!seen.has(id)) { delete state.taskStatus[id]; dirty = true; }
      if (dirty) persist();
    } catch (e) {
      log("journal", `observation : ${ctx.safeError(e)}`);
    } finally {
      observing = false;
    }
  }

  // ---------- Regroupement par projet ----------
  function projectIndex(tasks) {
    const byDir = new Map(); // "hôte|dossier en minuscules" -> { name, dir, host }
    const byName = new Map(); // "hôte|nom en minuscules" -> idem
    const add = (host, dir, name) => {
      if (!dir) return;
      const entry = { host: host || "local", dir, name: name || folderName(dir) };
      const dirKey = `${entry.host}|${slashes(dir).replace(/\/+$/, "").toLowerCase()}`;
      if (!byDir.has(dirKey)) byDir.set(dirKey, entry);
      const nameKey = `${entry.host}|${entry.name.toLowerCase()}`;
      if (!byName.has(nameKey)) byName.set(nameKey, entry);
    };
    const followed = store.read("projects", null);
    for (const p of Array.isArray(followed?.projects) ? followed.projects : []) add(p.host, p.dir, p.name);
    for (const t of tasks) add(t.host, t.project, t.projectName);
    return { byDir, byName };
  }

  function buildGroups(range, tasks) {
    const { byDir, byName } = projectIndex(tasks);
    const groups = new Map();
    const inDay = (at) => { const t = Date.parse(at); return t >= range.start && t < range.end; };
    const groupFor = ({ host = "local", dir, name }) => {
      let entry = null;
      if (dir) {
        entry = byDir.get(`${host}|${slashes(dir).replace(/\/+$/, "").toLowerCase()}`) ||
          { host, dir, name: folderName(dir) };
      } else if (name) {
        entry = byName.get(`${host}|${String(name).toLowerCase()}`) || { host, dir: null, name: String(name) };
      }
      else entry = { host: "", dir: null, name: GENERAL };
      const key = `${entry.host}|${entry.dir ? slashes(entry.dir).toLowerCase() : `nom:${entry.name.toLowerCase()}`}`;
      if (!groups.has(key)) {
        groups.set(key, { name: clip(entry.name, 120), dir: entry.dir, host: entry.host, events: [] });
      }
      return groups.get(key);
    };
    const push = (group, event) => {
      if (inDay(event.at)) group.events.push({ ...event, text: clip(event.text, 220) });
    };

    // Tâches : création exacte (createdAt) ; transitions observées, sinon dernier état daté par updatedAt.
    const recorded = new Set(state.events.map((e) => `${e.taskId}|${e.state}`));
    for (const t of tasks) {
      const group = groupFor({ host: t.host, dir: t.project, name: t.projectName });
      const who = t.origin === "agent" ? " (par Jarvis)" : "";
      push(group, {
        at: t.createdAt, kind: "tache", state: "created", taskId: t.id,
        text: `${TASK_TEXT.created(clip(t.title, 120))}${who}`,
      });
      if (t.status !== "todo" && !recorded.has(`${t.id}|${t.status}`)) {
        push(group, {
          at: t.updatedAt, kind: "tache", state: t.status, taskId: t.id,
          text: TASK_TEXT[t.status](clip(t.title, 120), t.status === "blocked" ? clip(t.reason, 80) : ""),
        });
      }
    }
    for (const e of state.events) {
      push(groupFor({ host: e.host, dir: e.dir }), {
        at: e.at, kind: "tache", state: e.state, taskId: e.taskId,
        text: TASK_TEXT[e.state]?.(e.title, e.reason) || e.title,
      });
    }

    // Sessions : un événement au lancement, un à la fermeture (data/timeline.json, écrit par handlers/timeline.mjs).
    const episodes = store.read("timeline", null)?.episodes;
    for (const ep of Array.isArray(episodes) ? episodes : []) {
      if (!ep || !ep.start) continue;
      const group = groupFor({ host: ep.host || "local", name: ep.project || "" });
      const label = clip(ep.title || [ep.provider, ep.model].filter(Boolean).join("/") || "session", 100);
      push(group, { at: ep.start, kind: "session", state: "start", text: `Session lancée : ${label}` });
      if (ep.end) {
        const how = SESSION_END[ep.status] || "terminée";
        push(group, { at: ep.end, kind: "session", state: "end", text: `Session ${how} : ${label}` });
      }
    }

    // Décisions de permission automatiques : rattachées au mandat (tâches « agent ») actif à cet instant.
    const runs = new Map();
    for (const t of tasks) {
      if (t.origin !== "agent" || !t.agentRun) continue;
      const run = runs.get(t.agentRun) || { from: Infinity, to: 0, host: t.host, dir: t.project };
      run.from = Math.min(run.from, Date.parse(t.createdAt));
      run.to = Math.max(run.to, Date.parse(t.updatedAt));
      runs.set(t.agentRun, run);
    }
    const activity = store.read("agent-activity", null);
    for (const a of Array.isArray(activity) ? activity : []) {
      if (!a || typeof a.summary !== "string" || !AUTO_DECISION.test(a.summary)) continue;
      const at = Date.parse(a.at);
      const run = [...runs.values()]
        .filter((r) => at >= r.from && at <= r.to + RUN_SLACK_MS).sort((x, y) => y.from - x.from)[0];
      const group = run ? groupFor({ host: run.host, dir: run.dir }) : groupFor({});
      push(group, {
        at: a.at, kind: "permission", state: a.summary.startsWith("Refusé") ? "deny" : "allow",
        text: a.summary.replace(/node\s+\S*postectl\.mjs/g, "postectl"),
      });
    }

    // Messages de groupe (data/coord.json) : un seul par envoi « toute l'équipe ».
    const coord = store.read("coord", null);
    const sentGroups = new Set();
    for (const m of Array.isArray(coord?.messages) ? coord.messages : []) {
      if (!m || m.system || !m.text || !(m.group || m.to === "team")) continue;
      const key = m.group || m.id;
      if (sentGroups.has(key)) continue;
      sentGroups.add(key);
      const [host, dir] = String(m.project || "").split("|");
      push(groupFor({ host: host || "local", dir: dir || "" }), {
        at: m.at, kind: "message", state: m.kind || "fyi",
        text: `${m.fromLabel || m.from || "?"} → équipe : ${clip(m.text, 160)}`,
      });
    }

    // Rapports de mission (handlers/missionreport.mjs).
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const r of ctx.missionReports?.list() || []) {
      const t = byId.get(r.orchestrator?.id);
      const group = t ? groupFor({ host: t.host, dir: t.project }) : groupFor({ host: r.host, name: r.project });
      push(group, {
        at: r.at, kind: "rapport", state: r.outcome, runId: r.runId,
        text: `Rapport de mission ${REPORT_LABEL[r.outcome] || r.outcome} : ${clip(r.project, 80)}`,
      });
    }
    return [...groups.values()].filter((g) => g.events.length);
  }

  const matches = (group, wanted) => {
    const w = slashes(wanted).replace(/\/+$/, "").toLowerCase();
    return group.name.toLowerCase() === w || (group.dir && slashes(group.dir).replace(/\/+$/, "").toLowerCase() === w);
  };

  async function journalFor({ day, project } = {}) {
    const wantedDay = day == null || day === "" ? localDay() : String(day);
    const range = dayRange(wantedDay);
    if (!range) return { error: "Jour invalide : écrivez-le AAAA-MM-JJ (par exemple 2026-10-21)." };
    if (project != null && typeof project !== "string") return { error: "Le projet doit être un nom de dossier." };
    await observe();
    const tasks = await listTasks();
    let groups = buildGroups(range, tasks);
    if (project) groups = groups.filter((g) => matches(g, project));
    const projects = groups
      .map((g) => ({
        name: g.name, dir: g.dir, host: g.host,
        events: g.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_EVENTS),
      }))
      .sort((a, b) => (a.name === GENERAL) - (b.name === GENERAL) || a.name.localeCompare(b.name));
    return { day: wantedDay, projects };
  }

  async function summaryText({ day, project, maxChars = 1500 } = {}) {
    const limit = Math.min(Math.max(Number(maxChars) || 1500, 200), 8000);
    const data = await journalFor({ day, project });
    if (data.error) return data.error;
    const [y, m, d] = data.day.split("-");
    if (!data.projects.length) {
      return `Journal du ${d}/${m}/${y} : rien à signaler${project ? ` sur ${project}` : ""}.`;
    }
    const total = data.projects.reduce((n, p) => n + p.events.length, 0);
    const lines = [`Journal du ${d}/${m}/${y} : ${total} événement(s) sur ${data.projects.length} projet(s).`];
    // Chaque projet reçoit une part égale de la place ; rapports de mission d'abord, puis les événements récents.
    const share = Math.floor((limit - lines[0].length - 60) / data.projects.length);
    let dropped = 0;
    for (const p of data.projects) {
      const head = `${p.name}${p.host ? ` (${p.host})` : ""} :`;
      lines.push(head);
      let room = share - head.length - 1;
      const reports = p.events.filter((e) => e.kind === "rapport");
      const ordered = [...reports, ...p.events.filter((e) => e.kind !== "rapport").reverse()];
      for (const e of ordered) {
        const line = `- ${hhmm(e.at)} ${e.text}`;
        if (line.length + 1 > room) { dropped += 1; continue; }
        room -= line.length + 1;
        lines.push(line);
      }
    }
    if (dropped) lines.push(`(… ${dropped} événement(s) de plus non détaillés)`);
    const text = lines.join("\n");
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  ctx.journal = { get: journalFor, summaryText };

  onMessage("journal.get", async (ws, m) => {
    const data = await journalFor({ day: m.day, project: m.project });
    if (data.error) return sendError(ws, data.error);
    send(ws, { type: "journal.data", ...data, ref: m.ref ?? null });
  });

  // ?format=text : le même journal en texte compact (pour « résume ma journée »), plafonné par ?maxChars=.
  ctx.apiRoute?.("GET", "/journal", async ({ query }) => {
    const wanted = { day: query.get("day") || undefined, project: query.get("project") || undefined };
    const data = await journalFor(wanted);
    if (data.error) throw new ApiError(400, "bad_request", data.error);
    if (query.get("format") !== "text") return data;
    return { day: data.day, text: await summaryText({ ...wanted, maxChars: query.get("maxChars") || undefined }) };
  });

  ctx.onStateChange(() => { observe(); });
  setTimeout(observe, 2000).unref();
}
