// Boucle de nuit et reprise après redémarrage (T45).
// Boucle de nuit : Philippe donne une liste de missions le soir ; elles s'enchaînent UNE À LA FOIS (chaîne `feature`
// par défaut, ou la chaîne demandée, via `chain.run` de handlers/chains.mjs) et un récapitulatif part UNE fois au matin
// (boîte de réception, `kind:"fin"`, clé `night:<date>`) ; le bot Telegram le relit dans `night.state`.
// État persistant : data/night.json (ctx.store) = { settings, missions, recap, halted, batchId, recaps }.
//   settings : { active, stopOnBlock (défaut vrai), maxMissions (défaut 10), pauseUntilHour (0-23 | null),
//                pauseUntil }.
//   mission  : { id, project, host, dir, mission, chain, status: queued|running|done|blocked|skipped, startedAt,
//                endedAt, runId, outcome, taskIds, tasks[], files[], interrupted? }.
// Messages WS : night.get (→ night.state), night.start {missions:[{project, mission, chain?, host?}], stopOnBlock?,
//   maxMissions?, pauseUntilHour?}, night.stop, night.skip {id} ; diffusion night.state à chaque changement.
//   resume.list (→ resume.list {items}), resume.run {ids|all} (→ resume.done {results}) : relance les tâches « En
//   cours » sans session vivante, les tâches « session perdue » et la nuit en pause ; JAMAIS automatiquement (seulement
//   sur demande) ; au démarrage du serveur, UN élément de boîte « Missions interrompues : N » (clé par ensemble d'ids).
// Règles : jamais deux missions en même temps ; une mission bloquée (tâche « Bloquée » ou en erreur, délai de 90 min
//   dépassé) arrête la nuit si stopOnBlock ; si ctx.quota.pickEngine ne renvoie aucun moteur, on attend la reprise avec
//   UN minuteur (aucune boucle active) ; les interdits par défaut du mode Agent (supprimer, pousser sur GitHub,
//   éteindre une machine) sont ajoutés à la consigne et la boucle ne lance jamais de suppression ni d'arrêt de machine
//   (seulement task.stop / task.move pour arrêter une chaîne qui dépasse son délai ou que Philippe arrête ou ignore).
// Réglages de test (instance isolée seulement : DASHBOARD_PORT défini et différent de 7070) : NIGHT_MISSION_TIMEOUT_MS,
//   NIGHT_POLL_MS, NIGHT_ERROR_GRACE_MS, NIGHT_RESUME_SCAN_MS.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEFAULT_FORBIDDEN } from "./agentmode.mjs";
import { scrub, verdictOf } from "./missionreport.mjs";

import { SELF_HOST, SELF_LABEL, isSelfHost } from "../lib/selfhost.mjs";
const FILE = "night";
export const DEFAULT_CHAIN = "feature";
export const MISSION_TIMEOUT_MS = 90 * 60_000;
const MAX = { missions: 50, mission: 1800, project: 1000, outcome: 300, tasks: 8, files: 20, summary: 200 };
const STATUSES = new Set(["queued", "running", "done", "blocked", "skipped"]);
const TERMINAL = new Set(["done", "blocked", "skipped"]);
const POLL_MS = 5000;
const ERROR_GRACE_MS = 60_000;
const QUOTA_RETRY_MS = 5 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const RESUME_AGE_MS = 48 * 3_600_000;
const RESUME_SCAN_MS = 25_000;
const STOP_WAIT_MS = 130_000;
const LIVE_CHECK_MS = 8000;
const LOST_SESSION = /^session perdue/i;
const ALREADY = /déjà en cours|démarrage déjà en cours/i;
const WAITS_FOR_DEPS = /^Bloquée par/i;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

const clean = (value, max) => String(value ?? "").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, max);
const cleanBlock = (value, max) => String(value ?? "").replace(CTRL, " ").trim().slice(0, max);
const slashes = (path) => String(path ?? "").replace(/\\/g, "/");
const baseName = (dir) => slashes(dir).replace(/\/+$/, "").split("/").pop();
const strip = (message) => String(message ?? "").replace(/^Erreur\s*:\s*/, "");
const pad = (n) => String(n).padStart(2, "0");
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Réglages de test : lus seulement dans une instance isolée (jamais sur le port 7070 du poste réel).
const isolated = () => Boolean(process.env.DASHBOARD_PORT) && Number(process.env.DASHBOARD_PORT) !== 7070;
const knob = (name, fallback) => {
  const value = Number(process.env[name]);
  return isolated() && process.env[name] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};

// Heure de départ : « pauseUntilHour » = ne rien lancer avant H:00 aujourd'hui ; déjà passée = on y est (null).
export function pauseUntilOf(hour, now = new Date()) {
  if (hour == null) return null;
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  return target.getTime() > now.getTime() ? target.toISOString() : null;
}

const cleanMission = (m) => ({
  id: m.id.slice(0, 40), project: clean(m.project, 200), host: clean(m.host, 100) || "local",
  dir: clean(m.dir, MAX.project), mission: cleanBlock(m.mission, MAX.mission),
  chain: clean(m.chain, 40) || DEFAULT_CHAIN,
  status: STATUSES.has(m.status) ? m.status : "queued",
  startedAt: typeof m.startedAt === "string" ? m.startedAt : null,
  endedAt: typeof m.endedAt === "string" ? m.endedAt : null,
  resumedAt: typeof m.resumedAt === "string" ? m.resumedAt : null, runId: typeof m.runId === "string" ? m.runId : null,
  outcome: clean(m.outcome, MAX.outcome),
  taskIds: (Array.isArray(m.taskIds) ? m.taskIds : []).filter((x) => typeof x === "string").slice(0, 12),
  tasks: Array.isArray(m.tasks) ? m.tasks.filter((t) => t && typeof t === "object").slice(0, MAX.tasks) : [],
  files: Array.isArray(m.files) ? m.files.filter((f) => typeof f === "string").slice(0, MAX.files) : [],
  filesNote: clean(m.filesNote, 120),
  baseline: (Array.isArray(m.baseline) ? m.baseline : []).filter((x) => typeof x === "string").slice(0, 300),
  interrupted: m.interrupted === true,
});

// Lecture sûre de data/night.json (jamais d'exception sur un fichier abîmé).
export function freshData(saved) {
  const raw = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const s = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const hour = inRange(s.pauseUntilHour, 0, 23) ? s.pauseUntilHour : null;
  const max = inRange(s.maxMissions, 1, MAX.missions) ? s.maxMissions : 10;
  const settings = {
    active: s.active === true, stopOnBlock: s.stopOnBlock !== false, maxMissions: max, pauseUntilHour: hour,
    pauseUntil: typeof s.pauseUntil === "string" && Date.parse(s.pauseUntil) ? s.pauseUntil : null,
  };
  const missions = (Array.isArray(raw.missions) ? raw.missions : [])
    .filter((m) => m && typeof m.id === "string").slice(0, MAX.missions).map(cleanMission);
  const recap = raw.recap && typeof raw.recap === "object" && typeof raw.recap.key === "string" ? raw.recap : null;
  const h = raw.halted;
  const halted = h && typeof h === "object" && typeof h.reason === "string" ? h : null;
  const recaps = raw.recaps && typeof raw.recaps === "object" && !Array.isArray(raw.recaps) ? raw.recaps : {};
  return { settings, missions, recap, halted, batchId: typeof raw.batchId === "string" ? raw.batchId : null, recaps };
}

// Verdict d'une mission d'après ses tâches : { status: "done"|"blocked", outcome } ou null (pas fini). Fonction pure.
export function judge(tasks, { errorSince = new Map(), now = Date.now(), graceMs = ERROR_GRACE_MS } = {}) {
  if (!tasks.length) return { status: "blocked", outcome: "les tâches de la chaîne ont disparu (supprimées ?)" };
  const blocked = tasks.find((t) => t.status === "blocked");
  if (blocked) {
    const why = clean(blocked.reason || blocked.error || "bloquée", 160);
    return { status: "blocked", outcome: `${clean(blocked.title, 80)} : ${why}` };
  }
  for (const t of tasks) {
    if (t.status === "doing" && t.error) {
      const since = errorSince.get(t.id) ?? now;
      errorSince.set(t.id, since);
      if (now - since >= graceMs) {
        return { status: "blocked", outcome: `${clean(t.title, 80)} en erreur : ${clean(t.error, 160)}`, halt: true };
      }
    } else errorSince.delete(t.id);
  }
  if (tasks.every((t) => t.status === "done")) return { status: "done", outcome: "Terminé" };
  return null;
}

// Titre du récapitulatif ; fonction pure.
export function recapTitle({ total, done, blocked, skipped, queued }, kind) {
  const parts = [plural(done, "réussie")];
  if (blocked) parts.push(plural(blocked, "bloquée"));
  if (skipped) parts.push(plural(skipped, "ignorée"));
  if (queued) parts.push(plural(queued, "non lancée"));
  return `Nuit ${kind} : ${plural(total, "mission")}, ${parts.join(", ")}`;
}

const MARK = { done: "✅", blocked: "⛔", skipped: "⏭️", queued: "⏸️", running: "⏳" };
const STATUS_FR = { queued: "non lancée", running: "en cours", skipped: "ignorée", blocked: "bloquée", done: "Terminé" };
export function recapLines(missions) {
  return missions.map((m) => {
    const extra = [];
    if (m.tasks?.length) extra.push(plural(m.tasks.length, "tâche"));
    const n = m.files?.length || 0;
    if (n) extra.push(`${n} ${n > 1 ? "fichiers modifiés" : "fichier modifié"}`);
    const outcome = m.status === "done" ? "Terminé" : m.outcome || STATUS_FR[m.status] || m.status;
    const tail = extra.length ? ` — ${extra.join(", ")}` : "";
    return `${MARK[m.status] || "•"} ${m.project} (${m.chain}) : ${outcome}${tail}`;
  });
}

function gitLines(dir) {
  const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-C", dir,
    "status", "--porcelain"];
  return new Promise((resolve) => {
    execFile("git", args, {
      timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => resolve(error ? null : String(stdout).split(/\r?\n/).filter((l) => l.trim())));
  });
}
// Lecture seule : dossier local existant uniquement (jamais de chemin réseau).
async function statusOf(m) {
  if (!isSelfHost(m.host)) return { lines: null, note: "non disponible pour une machine distante" };
  if (!m.dir || !isAbsolute(m.dir) || /^[\\/]{2}/.test(m.dir) || !existsSync(m.dir)) {
    return { lines: null, note: "dossier introuvable" };
  }
  const lines = await gitLines(m.dir);
  return lines ? { lines: lines.slice(0, 300), note: "" } : { lines: null, note: "pas un dépôt git" };
}

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store, log } = ctx;
  let data = freshData(store.read(FILE, null));

  const persist = () => {
    try { store.write(FILE, data); } catch (error) { log("night", `écriture impossible : ${ctx.safeError(error)}`); }
  };
  const publicMission = ({ baseline, ...m }) => m;
  let waiting = null; // { reason, until } : attente d'un moteur disponible ou de l'heure de départ
  const view = () => ({
    type: "night.state", settings: data.settings, missions: data.missions.map(publicMission),
    running: data.missions.find((m) => m.status === "running")?.id ?? null, waiting, halted: data.halted,
    recap: data.recap, now: new Date().toISOString(),
  });
  const save = () => { persist(); broadcast(view()); };

  // ---------- Outils ----------
  async function resolveProject(name, host) {
    const result = await ctx.invoke("project.list", {});
    const list = result.replies.find((r) => r.type === "project.list")?.projects || [];
    const wanted = slashes(name).replace(/\/+$/, "").toLowerCase();
    const matches = list.filter((p) => (!host || p.host === host) && (
      String(p.name || "").toLowerCase() === wanted || baseName(p.dir).toLowerCase() === wanted ||
      slashes(p.dir).replace(/\/+$/, "").toLowerCase() === wanted));
    return matches.find((p) => isSelfHost(p.host)) || matches[0] || null;
  }
  const taskList = async () => {
    const r = await ctx.invoke("task.list", {}, { timeoutMs: 15000 });
    if (r.error) throw new Error(strip(r.error));
    return r.replies.find((x) => x.type === "tasks")?.tasks || [];
  };
  const chainsOf = () => ctx.chains?.list?.() || [];

  // Consigne envoyée à la chaîne : la mission de Philippe + les interdits par défaut du mode Agent.
  const missionText = (m) =>
    `${m.mission}\n\nMission de nuit — INTERDITS (sans demander à Philippe, ne le fais jamais) : ` +
    `${DEFAULT_FORBIDDEN.join(", ")}.`;

  // ---------- Fin de mission ----------
  const errorSince = new Map();
  // Arrête une chaîne abandonnée : session en cours stoppée, étapes à venir « Bloquée » (rien n'est supprimé).
  async function haltChain(tasks) {
    for (const t of tasks) {
      if (t.status === "doing") await ctx.invoke("task.stop", { id: t.id }, { timeoutMs: 30000 }).catch(() => {});
      else if (t.status === "todo") {
        await ctx.invoke("task.move", { id: t.id, status: "blocked", auto: false }).catch(() => {});
      }
    }
  }

  async function summarize(m, tasks) {
    m.tasks = tasks.slice(0, MAX.tasks).map((t) => {
      const summary = scrub(t.summary || "", m.dir);
      const verdict = verdictOf(summary);
      return {
        title: clean(scrub(t.title, m.dir), 80), status: t.status, ...(verdict ? { verdict } : {}),
        ...(summary ? { summary: clean(summary, MAX.summary) } : {}),
      };
    });
    const now = await statusOf(m);
    if (now.lines) {
      const before = new Set(m.baseline || []);
      m.files = now.lines.filter((l) => !before.has(l)).slice(0, MAX.files)
        .map((l) => clean(scrub(l.trim(), m.dir), 160));
      m.filesNote = "";
    } else {
      m.files = [];
      m.filesNote = now.note;
    }
    m.baseline = [];
  }

  async function conclude(m, verdict, tasks) {
    if (m.status !== "running") return; // déjà conclue ou ignorée entre-temps
    if (verdict.halt) await haltChain(tasks);
    await summarize(m, tasks); // le bilan (tâches, fichiers) est prêt AVANT que l'état ne passe à « fini »
    if (m.status !== "running") return;
    m.status = verdict.status;
    m.outcome = clean(verdict.outcome, MAX.outcome);
    m.endedAt = new Date().toISOString();
    m.interrupted = false;
    errorSince.clear();
    log("night", `mission « ${m.project} » : ${m.status} (${m.outcome})`);
    if (m.status === "blocked" && data.settings.stopOnBlock && !verdict.byUser) {
      data.halted = { reason: `mission « ${m.project} » bloquée : ${m.outcome}`, at: m.endedAt };
      data.settings.active = false;
      persist();
      await finishBatch("arrêtée sur blocage");
      return;
    }
    save();
  }

  // ---------- Récapitulatif ----------
  async function finishBatch(kind) {
    data.settings.active = false;
    waiting = null;
    if (data.recap && data.recap.batchId === data.batchId) return save(); // UNE seule fois par nuit
    const missions = data.missions;
    const count = (s) => missions.filter((m) => m.status === s).length;
    const stats = {
      total: missions.length, done: count("done"), blocked: count("blocked"), skipped: count("skipped"),
      queued: count("queued"),
    };
    const now = new Date();
    const day = localDay(now);
    const n = (data.recaps[day] || 0) + 1;
    const key = n === 1 ? `night:${day}` : `night:${day}#${n}`;
    data.recaps[day] = n;
    const title = recapTitle(stats, kind);
    const lines = recapLines(missions);
    let journal = "";
    try { journal = (await ctx.journal?.summaryText?.({ day, maxChars: 1500 })) || ""; } catch { /* sans journal */ }
    const since = Date.parse(missions.find((m) => m.startedAt)?.startedAt || "") || 0;
    const reports = (ctx.missionReports?.list?.() || []).filter((r) => Date.parse(r.at) >= since).slice(0, 5)
      .map((r) => ({ project: clean(r.project, 80), outcome: clean(r.outcome, 20), runId: r.runId }));
    data.recap = {
      key, batchId: data.batchId, day, at: now.toISOString(), kind, ...stats, title,
      text: [`${title}.`, ...lines].join("\n"),
      inboxed: false, journal: scrub(journal, ""), reports, halted: data.halted?.reason || "",
      missions: missions.map((m) => ({
        id: m.id, project: m.project, host: m.host, chain: m.chain, mission: clean(m.mission, 160), status: m.status,
        outcome: m.outcome, tasks: m.tasks, files: m.files, filesNote: m.filesNote, startedAt: m.startedAt,
        endedAt: m.endedAt,
      })),
    };
    const body = [...lines, data.halted?.reason ? `Arrêt : ${data.halted.reason}` : ""].filter(Boolean).join("\n");
    const item = ctx.inbox?.add?.({ kind: "fin", title: `🌙 ${title}`, body, host: "local", source: "night", key });
    data.recap.inboxed = Boolean(item);
    log("night", `récapitulatif ${key} : ${title}${item ? "" : " (déjà dans la boîte)"}`);
    save();
  }

  // ---------- Boucle ----------
  let timer = null;
  let stepping = false;
  let again = false;
  const wake = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => step(), Math.min(Math.max(Number(ms) || 0, 20), MAX_TIMER_MS));
    timer.unref?.();
  };
  const poll = () => wake(knob("NIGHT_POLL_MS", POLL_MS));
  async function step() {
    if (stepping) { again = true; return; }
    stepping = true;
    try {
      do {
        again = false;
        await stepOnce();
      } while (again);
    } catch (error) {
      log("night", `boucle : ${ctx.safeError(error)}`);
      if (data.settings.active) poll();
    } finally {
      stepping = false;
    }
  }

  async function watch(m) {
    if (!m.runId) { // lancement coupé avant la création de la chaîne : on recommence cette mission
      m.status = "queued";
      m.startedAt = null;
      save();
      again = true;
      return;
    }
    let tasks;
    try {
      tasks = (await taskList()).filter((t) => t.chain === m.runId);
    } catch (error) {
      log("night", `lecture des tâches : ${ctx.safeError(error)}`);
      return poll();
    }
    const verdict = judge(tasks, { errorSince, graceMs: knob("NIGHT_ERROR_GRACE_MS", ERROR_GRACE_MS) });
    if (verdict) {
      await conclude(m, verdict, tasks);
      again = data.settings.active;
      return;
    }
    const limit = knob("NIGHT_MISSION_TIMEOUT_MS", MISSION_TIMEOUT_MS);
    if (Date.now() - (Date.parse(m.resumedAt || m.startedAt) || Date.now()) >= limit) {
      const stuck = tasks.find((t) => t.status !== "done");
      const state = stuck?.permission ? "attend une permission" : clean(stuck?.reason, 80) || "pas fini";
      const detail = stuck ? ` (${clean(stuck.title, 60)} : ${state})` : "";
      const length = limit >= 60_000 ? `${Math.round(limit / 60_000)} min` : `${Math.round(limit / 1000)} s`;
      const outcome = `délai dépassé (${length})${detail}`;
      await conclude(m, { status: "blocked", outcome, halt: true }, tasks);
      again = data.settings.active;
      return;
    }
    poll();
  }

  let launching = false; // chain.run en vol : aucune autre mission ne démarre (ni skip/stop ne laissent d'orpheline)

  async function launch(m) {
    const chain = chainsOf().find((c) => c.id === m.chain);
    const preferred = ctx.profiles?.get?.(chain?.steps?.[0])?.engine || undefined;
    const pick = ctx.quota?.pickEngine?.(preferred);
    if (pick && pick.engine === null) { // aucun moteur : UN minuteur jusqu'à la reprise, aucune boucle active
      const known = Number.isFinite(pick.retryAt) && pick.retryAt > Date.now();
      const retry = known ? pick.retryAt : Date.now() + QUOTA_RETRY_MS;
      waiting = { reason: clean(pick.reason || "aucun moteur disponible", 300), until: new Date(retry).toISOString() };
      log("night", `en attente d'un moteur jusqu'à ${waiting.until}`);
      broadcast(view());
      return wake(retry - Date.now());
    }
    waiting = null;
    launching = true;
    try {
      Object.assign(m, {
        status: "running", startedAt: new Date().toISOString(), resumedAt: null, runId: null, outcome: "",
      });
      m.baseline = (await statusOf(m)).lines || [];
      save();
      let result;
      try {
        result = await ctx.invoke("chain.run", { chain: m.chain, project: m.dir, host: m.host, mission: missionText(m) },
          { timeoutMs: 120000 });
      } catch (error) {
        result = { replies: [], error: ctx.safeError(error) };
      }
      const started = result.replies.find((r) => r.type === "chain.started");
      if (!started) {
        const why = clean(strip(result.error) || "chaîne non créée", 200);
        await conclude(m, { status: "blocked", outcome: `lancement impossible : ${why}` }, []);
        again = data.settings.active;
        return;
      }
      if (m.status !== "running") { // « passée » ou arrêtée pendant le lancement : la chaîne créée entre-temps ne doit pas survivre
        const orphan = (await taskList().catch(() => [])).filter((t) => t.chain === started.runId);
        await haltChain(orphan);
        return;
      }
      m.runId = started.runId;
      m.taskIds = (started.taskIds || []).filter((x) => typeof x === "string");
      save();
      poll();
    } finally {
      launching = false;
    }
  }

  async function stepOnce() {
    clearTimeout(timer);
    timer = null;
    if (!data.settings.active) return;
    if (launching) return wake(300);
    const running = data.missions.find((m) => m.status === "running");
    if (running) return watch(running);
    const next = data.missions.find((m) => m.status === "queued");
    if (!next) return finishBatch("terminée");
    const until = Date.parse(data.settings.pauseUntil || "");
    if (until && until > Date.now()) {
      waiting = { reason: "attente de l'heure de départ", until: new Date(until).toISOString() };
      broadcast(view());
      return wake(until - Date.now());
    }
    return launch(next);
  }

  // ---------- Messages ----------
  onMessage("night.get", (ws) => send(ws, view()));

  const busy = () => data.settings.active || data.missions.some((x) => x.status === "running");
  onMessage("night.start", async (ws, m) => {
    try {
      if (busy()) return sendError(ws, "une nuit est déjà en cours : arrêtez-la d'abord (night.stop)");
      if (!Array.isArray(m.missions) || !m.missions.length) {
        return sendError(ws, "donnez au moins une mission (projet + mission)");
      }
      if (m.stopOnBlock != null && typeof m.stopOnBlock !== "boolean") {
        return sendError(ws, "stopOnBlock doit être vrai ou faux");
      }
      const max = m.maxMissions == null ? 10 : m.maxMissions;
      if (!Number.isInteger(max) || max < 1 || max > MAX.missions) {
        return sendError(ws, `maxMissions doit être un entier de 1 à ${MAX.missions}`);
      }
      const hour = m.pauseUntilHour == null ? null : m.pauseUntilHour;
      if (hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > 23)) {
        return sendError(ws, "pauseUntilHour : une heure de 0 à 23");
      }
      if (m.missions.length > max) return sendError(ws, `au plus ${max} missions par nuit (maxMissions)`);
      const known = new Set(chainsOf().map((c) => c.id));
      const missions = [];
      for (const [i, raw] of m.missions.entries()) {
        const at = `mission ${i + 1}`;
        if (!raw || typeof raw !== "object") return sendError(ws, `${at} : projet et mission obligatoires`);
        const text = cleanBlock(raw.mission, MAX.mission + 1);
        if (!text) return sendError(ws, `${at} : la mission est obligatoire`);
        if (text.length > MAX.mission) {
          return sendError(ws, `${at} : la mission ne doit pas dépasser ${MAX.mission} caractères`);
        }
        const projectName = clean(raw.project, MAX.project);
        if (!projectName) return sendError(ws, `${at} : choisissez le projet`);
        const chain = raw.chain == null || raw.chain === "" ? DEFAULT_CHAIN : clean(raw.chain, 40).toLowerCase();
        if (!known.has(chain)) return sendError(ws, `${at} : chaîne inconnue « ${chain} »`);
        const target = await resolveProject(projectName, raw.host == null ? "" : clean(raw.host, 100));
        if (!target) {
          return sendError(ws, `${at} : le projet « ${projectName} » n'est pas dans les projets suivis. ` +
            "Suivez d'abord ce dossier (vue Projets).");
        }
        missions.push(cleanMission({
          id: randomUUID(), project: target.name || baseName(target.dir), host: target.host, dir: target.dir,
          mission: text, chain, status: "queued",
        }));
      }
      if (busy()) return sendError(ws, "une nuit est déjà en cours : arrêtez-la d'abord (night.stop)");
      data = {
        ...data, missions, recap: null, halted: null, batchId: randomUUID().slice(0, 12),
        settings: {
          active: true, stopOnBlock: m.stopOnBlock !== false, maxMissions: max, pauseUntilHour: hour,
          pauseUntil: pauseUntilOf(hour),
        },
      };
      waiting = null;
      save();
      ctx.inbox?.add?.({
        kind: "système", title: `🌙 Nuit lancée : ${plural(missions.length, "mission")}`, host: "local", source: "night",
        body: recapLines(missions).join("\n"),
      });
      log("night", `nuit lancée : ${missions.length} mission(s)`);
      send(ws, view());
      wake(0);
    } catch (error) {
      sendError(ws, `la nuit n'a pas pu être lancée : ${ctx.safeError(error)}`);
    }
  });

  // night.stop : la nuit s'arrête, la mission en cours est stoppée (jamais supprimée), les suivantes sont ignorées.
  onMessage("night.stop", async (ws) => {
    if (!data.settings.active && !data.missions.some((m) => m.status === "queued" || m.status === "running")) {
      return sendError(ws, "aucune nuit en cours");
    }
    data.settings.active = false;
    clearTimeout(timer);
    waiting = null;
    // l'étape en cours se termine d'abord (elle voit « active » à faux)
    for (let waited = 0; stepping && waited < STOP_WAIT_MS; waited += 50) await sleep(50);
    const running = data.missions.find((m) => m.status === "running");
    if (running) {
      const tasks = running.runId ? (await taskList().catch(() => [])).filter((t) => t.chain === running.runId) : [];
      await conclude(running, { status: "blocked", outcome: "arrêtée par Philippe", halt: true, byUser: true }, tasks);
    }
    for (const x of data.missions) {
      if (x.status !== "queued") continue;
      Object.assign(x, { status: "skipped", outcome: "nuit arrêtée", endedAt: new Date().toISOString() });
    }
    data.halted = null;
    await finishBatch("arrêtée");
    send(ws, view());
  });

  onMessage("night.skip", async (ws, m) => {
    const mission = data.missions.find((x) => x.id === String(m.id ?? ""));
    if (!mission) return sendError(ws, "mission introuvable");
    if (TERMINAL.has(mission.status)) return sendError(ws, "cette mission est déjà finie");
    const wasRunning = mission.status === "running";
    // d'abord le statut : une étape de la boucle qui lit encore les tâches ne peut plus conclure cette mission
    Object.assign(mission, { status: "skipped", outcome: "ignorée par Philippe", endedAt: new Date().toISOString() });
    if (wasRunning) {
      launching = true; // la mission suivante n'est lancée qu'une fois la chaîne ignorée réellement arrêtée
      try {
        const tasks = mission.runId ? (await taskList().catch(() => [])).filter((t) => t.chain === mission.runId) : [];
        await haltChain(tasks);
        await summarize(mission, tasks);
      } finally {
        launching = false;
      }
    }
    save();
    send(ws, view());
    if (data.settings.active) wake(0);
  });

  // ---------- Reprise ----------
  const itemKey = (ids) => `resume:${createHash("sha1").update([...ids].sort().join("|")).digest("hex").slice(0, 16)}`;

  async function isLive(t) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("délai")), LIVE_CHECK_MS); });
    try {
      const entry = ctx.hosts.get(t.host);
      const found = (await Promise.race([entry.api.agents.ref(t.agentId).refresh(), limit]))?.agent;
      return Boolean(found) && !found.archivedAt && found.status !== "closed";
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // À reprendre : nuit en pause / interrompue, tâches « En cours » sans session vivante, tâches « session perdue ».
  async function scan() {
    const connected = (label) => Boolean(ctx.hosts.get?.(label)?.connected?.());
    const tasks = await taskList();
    const cutoff = Date.now() - RESUME_AGE_MS;
    // Comme handlers/tasks.mjs : on interroge l'agent lui-même (jamais un état diffusé qui peut être périmé).
    const live = new Set();
    for (const t of tasks) {
      if (t.status === "doing" && t.agentId && connected(t.host) && await isLive(t)) live.add(t.id);
    }
    const lost = (t) => (t.status === "doing" && connected(t.host) && !live.has(t.id)) ||
      (t.status === "blocked" && LOST_SESSION.test(t.reason || ""));
    const orphan = (t) => (Date.parse(t.updatedAt) || 0) >= cutoff && lost(t);
    const items = [];
    const broken = data.missions.find((m) => m.interrupted && m.status === "blocked");
    const queued = data.missions.filter((m) => m.status === "queued");
    const mine = broken?.runId ? tasks.filter((t) => t.chain === broken.runId && orphan(t)) : [];
    const ofNight = new Set(mine.map((t) => t.id));
    if (!data.settings.active && (queued.length || broken)) {
      const parts = [];
      if (broken) parts.push(`« ${broken.project} » interrompue`);
      if (queued.length) parts.push(`${plural(queued.length, "mission")} en attente`);
      items.push({
        id: "night", kind: "night", title: `Nuit en pause : ${parts.join(", ")}`,
        project: broken?.project || queued[0].project,
        host: broken?.host || queued[0].host, reason: data.halted?.reason || "interrompue", taskIds: [...ofNight],
      });
    }
    for (const t of tasks) {
      if (!orphan(t) || ofNight.has(t.id)) continue;
      items.push({
        id: t.id, kind: "task", title: clean(t.title, 120), project: t.projectName || baseName(t.project), host: t.host,
        chain: t.chain || "", reason: t.status === "doing" ? "session absente" : "session perdue",
      });
    }
    return items;
  }

  // Relance une tâche comme le ferait Philippe : « À faire » puis task.start (un maillon attend ses prédécesseurs).
  async function relaunch(id) {
    const moved = await ctx.invoke("task.move", { id, status: "todo", auto: false });
    if (moved.error) return { ok: false, message: strip(moved.error) };
    const started = await ctx.invoke("task.start", { id }, { timeoutMs: 120000 });
    if (!started.error) return { ok: true, message: "relancée" };
    const why = strip(started.error);
    if (ALREADY.test(why)) return { ok: true, message: "déjà relancée" };
    if (WAITS_FOR_DEPS.test(why)) {
      return { ok: true, message: "remise à faire : elle démarrera après les étapes précédentes" };
    }
    return { ok: false, message: why };
  }

  async function resumeNight(item) {
    const broken = data.missions.find((m) => m.interrupted && m.status === "blocked");
    const failures = [];
    if (broken) {
      const hasTasks = broken.runId && (await taskList()).some((t) => t.chain === broken.runId);
      if (hasTasks) {
        for (const id of item.taskIds || []) {
          const r = await relaunch(id);
          if (!r.ok) failures.push(r.message);
        }
        Object.assign(broken, {
          status: "running", resumedAt: new Date().toISOString(), outcome: "", endedAt: null, interrupted: false,
        });
      } else {
        Object.assign(broken, {
          status: "queued", runId: null, startedAt: null, endedAt: null, outcome: "", interrupted: false, taskIds: [],
        });
      }
    }
    Object.assign(data, { halted: null, recap: null });
    Object.assign(data.settings, { active: true, pauseUntil: null });
    save();
    wake(0);
    return failures.length ? { ok: false, message: failures[0] } : { ok: true, message: "nuit reprise" };
  }

  let resuming = false;
  onMessage("resume.list", async (ws) => {
    try {
      send(ws, { type: "resume.list", items: await scan() });
    } catch (error) {
      sendError(ws, `lecture impossible : ${ctx.safeError(error)}`);
    }
  });
  onMessage("resume.run", async (ws, m) => {
    if (resuming) return sendError(ws, "une reprise est déjà en cours");
    resuming = true;
    try {
      const items = await scan();
      const asked = Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === "string") : [];
      const ids = m.all === true ? items.map((i) => i.id) : asked;
      if (!ids.length) return sendError(ws, "rien à reprendre : choisissez des éléments (ids) ou all:true");
      const results = [];
      for (const id of [...new Set(ids)]) {
        const item = items.find((i) => i.id === id);
        if (!item) {
          results.push({ id, ok: false, message: "n'est plus à reprendre" });
          continue;
        }
        const r = item.kind === "night" ? await resumeNight(item) : await relaunch(item.id);
        results.push({ id, title: item.title, ...r });
      }
      ctx.inbox?.add?.({
        kind: "système", title: `Reprise : ${results.filter((r) => r.ok).length} relancée(s) sur ${results.length}`,
        host: "local", source: "night",
        body: results.map((r) => `${r.ok ? "✅" : "⚠️"} ${r.title || r.id} : ${r.message}`).join("\n"),
      });
      send(ws, { type: "resume.done", results });
    } catch (error) {
      sendError(ws, `la reprise a échoué : ${ctx.safeError(error)}`);
    } finally {
      resuming = false;
    }
  });

  // ---------- Démarrage du serveur ----------
  // Une nuit « active » au démarrage a été coupée (redémarrage de Windows ou du serveur) : jamais de reprise seule.
  if (data.settings.active) {
    data.settings.active = false;
    const running = data.missions.find((m) => m.status === "running");
    if (running) {
      Object.assign(running, {
        status: "blocked", interrupted: true, outcome: "interrompue par un redémarrage",
        endedAt: new Date().toISOString(),
      });
    }
    const open = Boolean(running) || data.missions.some((m) => m.status === "queued");
    data.halted = open
      ? { reason: "nuit interrompue par un redémarrage", at: new Date().toISOString(), interrupted: true } : null;
    persist();
    if (!open) setTimeout(() => finishBatch("terminée").catch(() => {}), 2000).unref?.();
    log("night", "nuit interrompue par un redémarrage : en pause, à reprendre sur demande (resume.run)");
  }

  async function bootScan() {
    try {
      const items = await scan();
      if (!items.length || !ctx.inbox?.add) return;
      const lines = items.slice(0, 6).map((i) => `• ${i.title} (${i.project || "—"}) — ${i.reason}`);
      const added = ctx.inbox.add({
        kind: "système", title: `Missions interrompues : ${items.length}`, host: "local", source: "night",
        key: itemKey(items.map((i) => i.id)),
        body: `${lines.join("\n")}\nDites « reprends les missions interrompues » à Jarvis : ` +
          "rien ne redémarre sans votre accord.",
      });
      if (added) log("night", `${items.length} élément(s) à reprendre signalé(s) dans la boîte de réception`);
    } catch (error) {
      log("night", `recherche des missions interrompues : ${ctx.safeError(error)}`);
    }
  }
  ctx.night = { getState: () => view(), interrupted: () => scan().catch(() => []), notifyInterrupted: bootScan };
  const delay = knob("NIGHT_RESUME_SCAN_MS", RESUME_SCAN_MS);
  setTimeout(bootScan, delay).unref?.();
  setTimeout(bootScan, delay * 4).unref?.();
}
