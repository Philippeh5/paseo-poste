// Autonomie par projet + ordonnanceur + idées (PLAN-AUTONOMIE.md, phase 3). Données : data/autonomy.json.
//   { projects: { [dir]: {mode, heartbeatMin, lastBeat, lastCiRun} }, ideas: [...], meta: {}, runs: [...] }
// Messages WS (navigateur) : autonomy.list · autonomy.set {dir, mode, heartbeatMin?} · idea.list · idea.decide {id, decision:"approve"|"refuse", comment?}
//   · brain.wake {dir, kind?} (réveil immédiat) · recap.now. Diffusions : autonomy.state, idea.changed.
// API agent (/api/v1) : GET /autonomy, GET /ideas, POST /ideas {project,title,body}, POST /ideas/:id/done. Le cerveau PROPOSE seulement :
//   décider (valider/refuser) n'existe que côté navigateur, jamais dans l'API des agents (anti auto-approbation).
// Chaque minute : battement de cœur des projets dus, CI rouge des projets Autonome. Un seul réveil du cerveau à la fois.
// Chaque réveil tourne dans sa propre unité systemd (cerveau-<id>) : un redémarrage du poste ne le tue pas. Il écrit son code de sortie
// dans brain-logs/<id>.exit ; au démarrage, le poste réconcilie les runs « en cours » (suivre l'unité, lire .exit, ou « interrompu »).
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES, normalizeProject, isDue, recapText, brainPrompt, findDuplicateIdea, chooseEngine, dayKeyIn, claudeUsageRatio, quotaErrorIn, QUOTA_BLOCK_MS, parseReport, reportMessage, reconcileRun, runStatusFromCode } from "../lib/autonomy.mjs";
import { checkProjectDir, isStopped } from "../lib/guardrails.mjs";
import { telegramSend } from "../lib/notify.mjs";
import { ApiError } from "./agentapi.mjs";
import { ensureSecret, secretMatches } from "../lib/decision-auth.mjs";

const FILE = "autonomy";
const RUNNER = process.env.POSTE_BRAIN_RUNNER || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "oracle", "cerveau", "run.sh");
const MAX_IDEAS = 300, MAX_RUNS = 100, TICK_MS = 60_000, CI_EVERY_MS = 10 * 60_000;
const POLL_MS = Number(process.env.POSTE_BRAIN_POLL_MS) || 5000, RUN_MAX_S = (Number(process.env.BRAIN_TIMEOUT_S) || 1800) + 120;
const bash = (args, opts) => new Promise((res) => execFile(args[0], args.slice(1), { timeout: 15_000, ...opts }, (e, out) => res(e ? null : String(out).trim())));
const unitActive = async (unit) => ["active", "activating"].includes(await bash(["systemctl", "--user", "is-active", unit]));
// systemd-run --user disponible (Oracle) ? POSTE_BRAIN_SYSTEMD=0 force le repli sur un simple spawn (PC, tests).
const useSystemd = () => process.env.POSTE_BRAIN_SYSTEMD !== "0" && existsSync(`/run/user/${process.getuid?.()}/systemd`) && ["/usr/bin", "/bin"].some((d) => existsSync(join(d, "systemd-run")));
const clip = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim().slice(0, n);

export function register(ctx) {
  const { onMessage, send, sendError, broadcast, store, log } = ctx;
  const load = () => {
    const d = store.read(FILE, {});
    return { projects: d.projects || {}, ideas: Array.isArray(d.ideas) ? d.ideas : [], meta: d.meta || {}, runs: Array.isArray(d.runs) ? d.runs : [] };
  };
  const save = (d) => store.write(FILE, { ...d, ideas: d.ideas.slice(-MAX_IDEAS), runs: d.runs.slice(-MAX_RUNS) });
  const publicState = () => { const d = load(); return { projects: Object.fromEntries(Object.entries(d.projects).map(([k, v]) => [k, normalizeProject(v)])), runs: d.runs.slice(-10), running: current ? { dir: current.dir, kind: current.kind, since: current.since } : null, stopped: isStopped() }; };
  let current = null; // réveil du cerveau en cours

  const objectivesOf = (dir) => { try { return readFileSync(join(dir, "HEARTBEAT.md"), "utf8"); } catch { return ""; } };

  // État de Claude : bloqué après une erreur de quota (60 min), « épuisé » selon le daemon, sinon part d'usage (daemon ou estimation propre).
  function claudeState(d) {
    const claude = ctx.quota?.snapshot?.().providers?.find((p) => p.id === "claude");
    const daemonPct = claude?.windows?.length ? Math.max(...claude.windows.map((w) => w.usedPct ?? 0)) : null;
    const blocked = (d.meta.claudeBlockedUntil || 0) > Date.now() || claude?.state === "exhausted";
    return { ratio: claudeUsageRatio({ daemonPct, runs: d.runs }), available: !blocked };
  }
  const logTail = (runId) => {
    try {
      const dir = join(ctx.dataDir, "brain-logs"); const f = readdirSync(dir).filter((n) => n.endsWith(`-${runId}.log`)).sort().pop();
      return f ? readFileSync(join(dir, f), "utf8").slice(-3000) : "";
    } catch { return ""; }
  };

  const gh = (dir, args) => new Promise((res) => execFile("gh", args, { cwd: dir, timeout: 20_000 }, (e, out) => res(e ? null : out.trim())));
  // Ce qui attend dans le projet : tâches « À valider » / « En cours », PR agent/* ouvertes, worktrees (A3, A5). Chaque lecture échoue en silence.
  const git = (dir, args) => new Promise((res) => execFile("git", ["-C", dir, ...args], { timeout: 15_000 }, (e, out) => res(e ? null : out.trim())));
  const norm = (p) => String(p || "").replace(/\/+$/, "");
  async function worktreesOf(dir) {
    const raw = await git(dir, ["worktree", "list", "--porcelain"]); if (!raw) return [];
    const base = (await git(dir, ["rev-parse", "--verify", "-q", "main"])) ? "main" : "master";
    const out = [];
    for (const blk of raw.split("\n\n")) {
      const f = Object.fromEntries(blk.split("\n").map((l) => { const i = l.indexOf(" "); return i < 0 ? [l, true] : [l.slice(0, i), l.slice(i + 1)]; }));
      const path = f.worktree; if (!path || norm(path) === norm(dir)) continue;
      const branch = String(f.branch || "").replace("refs/heads/", "");
      const dirty = await git(path, ["status", "--porcelain"]);
      const ct = await git(path, ["log", "-1", "--format=%ct"]);
      const merged = branch ? (await git(dir, ["merge-base", "--is-ancestor", branch, base])) !== null : false;
      out.push({ path, branch, merged, dirtyFiles: dirty ? dirty.split("\n").length : 0, lastCommitMs: ct ? Number(ct) * 1000 : 0, locked: "locked" in f });
    }
    return out.slice(0, 20);
  }
  async function gatherContext(dir, ideas) {
    const [r, prsOut, worktrees] = await Promise.all([
      ctx.invoke("task.list", {}, { timeoutMs: 8000 }).catch(() => ({ replies: [] })),
      gh(dir, ["pr", "list", "--state", "open", "--limit", "20", "--json", "number,title,headRefName,updatedAt"]),
      worktreesOf(dir),
    ]);
    const all = r.replies?.find((x) => x.type === "tasks")?.tasks || [];
    const tasks = all.filter((t) => norm(t.project) === norm(dir));
    let prs = []; try { prs = JSON.parse(prsOut || "[]"); } catch {}
    return { tasks, prs, worktrees };
  }
  const exitFile = (runId) => join(ctx.dataDir, "brain-logs", `${runId}.exit`);
  const readExit = (runId) => { try { const n = parseInt(readFileSync(exitFile(runId), "utf8"), 10); return Number.isInteger(n) ? n : null; } catch { return null; } };
  const watchers = new Map();
  // Suit un run jusqu'à sa fin : fichier .exit (écrit par run.sh) ou unité disparue sans .exit (= interrompu).
  function watchRun(runId, unit) {
    if (watchers.has(runId)) return;
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const exit = readExit(runId);
        if (exit != null) return finish(runId, runStatusFromCode(exit));
        if (unit && !(await unitActive(unit)) && readExit(runId) == null) finish(runId, "interrompu (unité arrêtée sans code de sortie)");
      } finally { busy = false; }
    }, POLL_MS);
    t.unref?.(); watchers.set(runId, t);
  }

  function launch(run, prompt, sd) {
    const { dir } = run;
    const base = { ...process.env, POSTE_AUTONOMOUS: "1", POSTE_RUN_ID: run.id, DASHBOARD_DATA_DIR: ctx.dataDir };
    if (sd) {
      // Unité systemd propre au réveil, hors du cgroup du poste. Pas d'entrée standard : la consigne passe par un fichier (supprimé par run.sh).
      const promptFile = join(ctx.dataDir, "brain-logs", `${run.id}.prompt`);
      const unit = run.unit;
      try { mkdirSync(dirname(promptFile), { recursive: true }); writeFileSync(promptFile, prompt, { mode: 0o600 }); } catch (e) { setImmediate(() => finish(run.id, `échec du lancement : ${e.message}`)); return; }
      const env = Object.entries({ ...base, POSTE_PROMPT_FILE: promptFile }).filter(([k]) => /^(PATH|DASHBOARD_DATA_DIR|POSTE_|POSTECTL_|BRAIN_|GUARD_|NOTIFY_)/.test(k)).map(([k, v]) => `--setenv=${k}=${v}`);
      execFile("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--quiet", `--property=RuntimeMaxSec=${RUN_MAX_S}`, `--working-directory=${dir}`, ...env, "bash", RUNNER, dir, run.engine], { timeout: 20_000 }, (e) => { if (e) finish(run.id, `échec du lancement : ${e.message}`); });
      watchRun(run.id, unit);
    } else {
      const child = spawn("bash", [RUNNER, dir, run.engine], { cwd: dir, detached: true, stdio: ["pipe", "ignore", "ignore"], env: base });
      child.on("error", (e) => finish(run.id, `échec du lancement : ${e.message}`));
      child.stdin.on("error", () => {}); child.stdin.end(prompt);
      child.on("exit", (code) => finish(run.id, runStatusFromCode(code)));
      child.unref();
    }
  }

  // --- réveil du cerveau -------------------------------------------------------------------------------------------
  function wake(dir, kind = "heartbeat", extra = {}) {
    if (isStopped()) return { ok: false, error: "arrêt d'urgence actif" };
    const g = checkProjectDir(dir); if (!g.allow) return { ok: false, error: g.reason };
    if (current) return { ok: false, error: `le cerveau travaille déjà (${current.dir.split("/").pop()})` };
    const d = load(); const cfg = normalizeProject(d.projects[dir]);
    if (cfg.mode === "off" && kind !== "manual") return { ok: false, error: "projet en mode Arrêt" };
    const { ratio, available } = claudeState(d);
    const eng = chooseEngine(new Date(), { usageRatio: ratio, claudeOk: available });
    const mode = cfg.mode === "off" ? "ideas" : cfg.mode;
    const sd = useSystemd();
    const run = { id: randomUUID().slice(0, 8), dir, kind, engine: eng.engine, why: eng.why, at: Date.now(), status: "running", ...(extra.retryOf ? { retryOf: extra.retryOf } : {}), ...(extra.ci ? { ci: extra.ci } : {}) };
    if (sd) run.unit = `cerveau-${run.id}`;
    d.projects[dir] = { ...d.projects[dir], ...cfg, lastBeat: Date.now(), ...(extra.ci ? { lastCiRun: extra.ci.id } : {}) };
    d.runs.push(run); save(d);
    current = { dir, kind, since: run.at, runId: run.id };
    // Le contexte (tâches, PR, worktrees) se lit avant le lancement ; wake répond tout de suite, le run est déjà « en cours ».
    gatherContext(dir, d.ideas).then((c) => brainPrompt({ kind: kind === "ci-fix" ? "ci-fix" : "heartbeat", mode, dir, objectives: objectivesOf(dir), ideas: d.ideas.filter((i) => i.project === dir), ci: extra.ci, ...c }))
      .catch(() => brainPrompt({ kind: kind === "ci-fix" ? "ci-fix" : "heartbeat", mode, dir, objectives: objectivesOf(dir), ideas: d.ideas.filter((i) => i.project === dir), ci: extra.ci }))
      .then((prompt) => launch(run, prompt, sd));
    log("autonomy", `réveil du cerveau : ${dir} (${kind}, ${eng.engine} — ${eng.why})`);
    broadcast({ type: "autonomy.state", ...publicState() });
    return { ok: true, runId: run.id, engine: eng.engine };
  }
  function finish(runId, status) {
    const d = load(); const r = d.runs.find((x) => x.id === runId);
    if (r && r.status !== "running") return; // déjà clos (sortie du processus, fichier .exit et poste qui redémarre peuvent arriver tous les trois)
    clearInterval(watchers.get(runId)); watchers.delete(runId);
    const name = r?.dir?.split("/").pop() || "?";
    let report = null;
    if (r) {
      r.status = status; r.endedAt = Date.now();
      const tail = logTail(runId); report = parseReport(tail); if (report.fait || report.bloque || report.suite) r.report = report;
      // Un run Claude arrêté par une limite d'usage : on bascule sur les modèles gratuits pendant 60 min.
      if (r.engine === "claude" && status !== "done" && quotaErrorIn(tail)) {
        d.meta.claudeBlockedUntil = Date.now() + QUOTA_BLOCK_MS; r.quotaHit = true;
        telegramSend("⚠️ Quota Claude atteint : le cerveau passe sur les modèles gratuits pendant 1 h.");
      }
      save(d);
    }
    if (current?.runId === runId) current = null;
    // Un seul message par réveil : « bloqué » (⛔) l'emporte, puis « fini » (✅) ; un échec sans compte rendu reste un ⚠️ ; « rien d'utile » ne dit rien.
    const msg = reportMessage(name, report);
    if (report?.bloque) telegramSend(msg);
    else if (status !== "done") telegramSend(`⚠️ Le cerveau a échoué sur ${name} : ${status}`);
    else if (msg) telegramSend(msg);
    broadcast({ type: "autonomy.state", ...publicState() });
  }
  // Au démarrage du poste : que sont devenus les réveils « en cours » ? Unité encore active → on la suit ; .exit présent → on clôt avec son code ;
  // sinon « interrompu », avec UNE relance automatique en mode Autonome.
  async function reconcile() {
    const d = load(); const running = d.runs.filter((r) => r.status === "running");
    for (const r of running) {
      const rec = reconcileRun({ unitActive: r.unit ? await unitActive(r.unit) : false, exit: readExit(r.id) });
      if (rec.action === "follow") { if (!current) current = { dir: r.dir, kind: r.kind, since: r.at, runId: r.id }; watchRun(r.id, r.unit); log("autonomy", `réveil ${r.id} toujours en cours (${r.unit}) : suivi repris`); }
      else if (rec.action === "close") { finish(r.id, runStatusFromCode(rec.code)); }
      else {
        finish(r.id, "interrompu (le poste a redémarré pendant le réveil)");
        if (!r.retryOf && normalizeProject(load().projects[r.dir]).mode === "auto") { const w = wake(r.dir, r.kind, { retryOf: r.id, ...(r.ci ? { ci: r.ci } : {}) }); log("autonomy", `relance de ${r.id} : ${w.ok ? w.runId : w.error}`); }
      }
    }
  }

  // --- récap, CI rouge, battement -------------------------------------------------------------------------------
  // Récap à la demande uniquement (commande /recap sur Telegram, GET /recap, message WS recap.now) : plus d'envoi automatique le matin.
  async function buildRecap() {
    const d = load();
    const r = await ctx.invoke("task.list", {}, { timeoutMs: 8000 }).catch(() => ({ replies: [] }));
    const tasks = r.replies.find((x) => x.type === "tasks")?.tasks || [];
    let refusals = 0;
    try { const f = join(ctx.dataDir, "guard-audit.jsonl"); if (existsSync(f)) refusals = readFileSync(f, "utf8").split("\n").filter((l) => l && Date.parse(JSON.parse(l).at) > Date.now() - 864e5).length; } catch {}
    const text = recapText({ tasks, ideas: d.ideas, guardRefusals: refusals, projects: d.projects, since: Date.now() - 864e5 });
    const after = load(); after.meta.lastRecap = text; save(after); // relecture : n'écrase aucune autre mise à jour
    return text;
  }
  async function sendRecap() { const text = await buildRecap(); await telegramSend(text); return text; }
  async function checkCi(dir) {
    const out = await gh(dir, ["run", "list", "--branch", "main", "--limit", "1", "--json", "databaseId,conclusion,status,displayTitle"]);
    let row; try { row = JSON.parse(out)[0]; } catch { return null; }
    return row && row.status === "completed" && row.conclusion === "failure" ? { id: row.databaseId, title: row.displayTitle } : null;
  }
  let lastCi = 0;
  async function tick() {
    try {
      if (isStopped()) return;
      const d = load(); const now = Date.now();
      if (!current && now - lastCi >= CI_EVERY_MS) {
        lastCi = now;
        for (const [dir, p] of Object.entries(d.projects)) {
          if (normalizeProject(p).mode !== "auto" || !checkProjectDir(dir).allow) continue;
          const ci = await checkCi(dir);
          if (ci && ci.id !== p.lastCiRun) { const r = wake(dir, "ci-fix", { ci }); if (r.ok) { telegramSend(`🔴 CI rouge sur ${dir.split("/").pop()} (« ${ci.title} ») : correction lancée.`); return; } }
        }
      }
      if (current) return;
      const due = Object.entries(d.projects).filter(([dir, p]) => isDue(p, now) && checkProjectDir(dir).allow).sort((a, b) => (a[1].lastBeat || 0) - (b[1].lastBeat || 0))[0];
      if (due) wake(due[0], "heartbeat");
    } catch (e) { log("autonomy", `tick : ${ctx.safeError?.(e) ?? e.message}`); }
  }
  const timer = setInterval(tick, TICK_MS); timer.unref?.();
  reconcile().catch((e) => log("autonomy", `réconciliation : ${e.message}`));
  setTimeout(tick, 15_000).unref?.();

  // --- idées -----------------------------------------------------------------------------------------------------
  function addIdea({ project, title, body }) {
    const d = load();
    if (!project || !checkProjectDir(project).allow) throw new Error("projet invalide ou intouchable");
    const t = clip(title, 120); if (!t) throw new Error("titre requis");
    const dup = findDuplicateIdea(d.ideas, project, t);
    if (dup) return { ...dup, duplicate: true }; // on renvoie l'idée existante : rien de créé, Telegram pas renotifié
    const idea = { id: randomUUID().slice(0, 8), project, title: t, body: clip(body, 4000), status: "pending", createdAt: Date.now() };
    d.ideas.push(idea); save(d);
    telegramSend(`💡 Nouvelle idée pour ${project.split("/").pop()} : ${t}${idea.body ? `\n\n${clip(idea.body, 600)}` : ""}`, [[{ text: "✅ Valider", callback_data: `pi:${idea.id}:a` }, { text: "❌ Refuser", callback_data: `pi:${idea.id}:r` }], [{ text: "⛔ Tout arrêter", callback_data: "ps:x" }]]);
    broadcast({ type: "idea.changed", idea }); return idea;
  }
  onMessage("autonomy.list", (ws) => send(ws, { type: "autonomy.state", ...publicState() }));
  onMessage("autonomy.set", (ws, m) => {
    const dir = clip(m.dir, 500); if (!dir.startsWith("/")) return sendError(ws, "dossier de projet invalide");
    if (!MODES.includes(m.mode)) return sendError(ws, "mode : off, ideas ou auto");
    if (m.mode !== "off") { const g = checkProjectDir(dir); if (!g.allow) return sendError(ws, g.reason); }
    const d = load(); const cur = normalizeProject(d.projects[dir]);
    d.projects[dir] = { ...cur, mode: m.mode, ...(Number.isInteger(m.heartbeatMin) ? { heartbeatMin: normalizeProject({ heartbeatMin: m.heartbeatMin }).heartbeatMin } : {}) };
    save(d); log("autonomy", `${dir} → ${m.mode}`); broadcast({ type: "autonomy.state", ...publicState() });
  });
  onMessage("idea.list", (ws) => send(ws, { type: "idea.list", ideas: load().ideas }));
  function decideIdea(id, decision, comment) {
    const d = load(); const idea = d.ideas.find((i) => i.id === id);
    if (!idea) throw new Error("idée introuvable");
    if (idea.status !== "pending") throw new Error("idée déjà traitée");
    if (decision !== "approve" && decision !== "refuse") throw new Error("décision : approve ou refuse");
    Object.assign(idea, { status: decision === "approve" ? "approved" : "refused", decidedAt: Date.now(), comment: clip(comment, 500) });
    save(d); broadcast({ type: "idea.changed", idea });
    if (idea.status === "approved") { const cfg = normalizeProject(d.projects[idea.project]); if (cfg.mode !== "off") setTimeout(() => wake(idea.project, "heartbeat"), 1000).unref?.(); }
    return idea;
  }
  onMessage("idea.decide", (ws, m) => { try { decideIdea(m.id, m.decision, m.comment); } catch (e) { sendError(ws, e.message); } });
  onMessage("brain.wake", (ws, m) => { const r = wake(clip(m.dir, 500), "manual"); if (!r.ok) sendError(ws, r.error); });
  onMessage("recap.now", async (ws) => { const t = await sendRecap(); send(ws, { type: "recap.sent", text: t }); });

  const route = ctx.apiRoute;
  if (route) {
    route("GET", "/autonomy", () => publicState());
    route("GET", "/recap", async () => ({ text: await buildRecap() })); // lu par la commande Telegram /recap (le bot répond lui-même)
    route("GET", "/ideas", ({ query }) => ({ ideas: load().ideas.filter((i) => !query.get("status") || i.status === query.get("status")) }));
    route("POST", "/ideas", ({ body }) => { try { const idea = addIdea({ project: body.project, title: body.title, body: body.body }); return idea.duplicate ? { idea, duplicate: true } : { idea }; } catch (e) { throw new ApiError(400, "bad_idea", e.message); } });
    // Validation depuis Telegram (plugin Hermes) : exige le secret partagé, que les agents ne peuvent pas lire.
    route("POST", "/ideas/:id/decide", ({ params, body, req }) => {
      if (!secretMatches(ctx.dataDir, req?.headers?.["x-decide-secret"])) throw new ApiError(403, "forbidden", "seul Philippe peut valider ou refuser une idée");
      try { return { idea: decideIdea(params.id, body.decision, body.comment) }; } catch (e) { throw new ApiError(400, "bad_decision", e.message); }
    });
    route("POST", "/ideas/:id/done", ({ params }) => {
      const d = load(); const i = d.ideas.find((x) => x.id === params.id);
      if (!i) throw new ApiError(404, "not_found", "idée introuvable");
      if (i.status !== "approved") throw new ApiError(403, "not_approved", "seule une idée validée par Philippe peut être marquée faite");
      i.status = "done"; i.doneAt = Date.now(); save(d); broadcast({ type: "idea.changed", idea: i }); return { idea: i };
    });
    // Le cerveau retire SA PROPRE proposition quand elle est déjà faite : seulement une idée en attente (jamais une décision de Philippe).
    route("POST", "/ideas/:id/obsolete", ({ params, body }) => {
      const d = load(); const i = d.ideas.find((x) => x.id === params.id);
      if (!i) throw new ApiError(404, "not_found", "idée introuvable");
      if (i.status !== "pending") throw new ApiError(403, "not_pending", "seule une idée EN ATTENTE peut être déclarée obsolète");
      const why = clip(body?.why, 300); if (!why) throw new ApiError(400, "why_required", "raison requise (--why)");
      Object.assign(i, { status: "obsolete", obsoleteAt: Date.now(), obsoleteWhy: why }); save(d); broadcast({ type: "idea.changed", idea: i }); return { idea: i };
    });
    // Lien idée → tâche : une idée validée n'a qu'une tâche active.
    route("GET", "/ideas/:id", ({ params }) => { const i = load().ideas.find((x) => x.id === params.id); if (!i) throw new ApiError(404, "not_found", "idée introuvable"); return { idea: i }; });
    route("POST", "/ideas/:id/task", async ({ params, body }) => {
      const d = load(); const i = d.ideas.find((x) => x.id === params.id);
      if (!i) throw new ApiError(404, "not_found", "idée introuvable");
      if (i.status !== "approved") throw new ApiError(403, "not_approved", "seule une idée validée peut avoir une tâche");
      const taskId = clip(body?.task, 80); if (!taskId) throw new ApiError(400, "task_required", "identifiant de tâche requis");
      i.taskId = taskId; save(d); broadcast({ type: "idea.changed", idea: i }); return { idea: i };
    });
  }
  ensureSecret(ctx.dataDir);
  ctx.autonomy = { wake, addIdea, sendRecap, buildRecap, reconcile, state: publicState };
}
