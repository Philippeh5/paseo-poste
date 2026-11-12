// Cœur serveur du transfert de travail vers Oracle (T10).
// Base SQLite dédiée data/transfers.sqlite (tables transfers + transfer_events), écritures en transaction.
// États : idle → checking → stopping_agents → committing → cloning → reassigning → shutting_down → done,
//         failed(<étape>), partial(shutdown), abandoned.
// Messages : transfer.plan, transfer.run, transfer.status, transfer.cancel, transfer.events (voir README).
// Sécurité : confirm:true toujours exigé ; dryRun n'appelle JAMAIS un exécuteur réel (sauf le contrôle, lecture
// seule) ; extinction réelle = confirmShutdown:true en plus, jamais sous dryRun ni après un échec.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackUrl, withTimeout } from "./fs.mjs";
import { ghState } from "./github.mjs";
import { parseRemote } from "./github.mjs";
import {
  MIN_ORACLE_FREE_REQUIRED, ORACLE_PROJECTS_ROOT, DEFAULT_ORACLE_DISK_FREE,
  assertTransferBranch, buildResumePrompt, estimateDiskNeeded, folderName, formatDateStamp, git, makeBranchName,
  normDir, redact, sensitivePaths, translateProjectPath,
} from "../lib/transfer-steps.mjs";

export const STEPS = ["checking", "stopping_agents", "committing", "cloning", "reassigning", "shutting_down", "done"];
const ACTIVE_STATES = STEPS.slice(0, -1);
export const SHUTDOWN_ARGS = ["/s", "/t", "60", "/c", "Transfert vers Oracle"];
export const SHUTDOWN_COMMAND = `shutdown ${SHUTDOWN_ARGS.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
const OFFLINE_WAIT_MS = 120000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY, state TEXT NOT NULL, step TEXT NOT NULL, dry_run INTEGER NOT NULL DEFAULT 0,
  force INTEGER NOT NULL DEFAULT 0, plan_json TEXT, results_json TEXT, error TEXT,
  started_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id TEXT NOT NULL, step TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, details_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transfer_events_tid ON transfer_events (transfer_id);`;

class TransferError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}
class CancelledError extends Error {}

// ---------- Accès à la base des tâches (brain.sqlite) ----------
const brainPath = (ctx) => process.env.BRAIN_DB || join(ctx.dataDir, "brain.sqlite");

export function readTasks(ctx, host, statuses = ["todo", "doing"]) {
  if (!existsSync(brainPath(ctx))) return [];
  let db = null;
  try {
    db = new DatabaseSync(brainPath(ctx), { readOnly: true });
    db.exec("PRAGMA busy_timeout = 4000");
    const marks = statuses.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM tasks WHERE host = ? AND status IN (${marks}) ORDER BY position, created_at`)
      .all(host, ...statuses).map((r) => ({ ...r }));
  } catch {
    return []; // base ou table absente : aucune tâche
  } finally {
    db?.close();
  }
}

// Ligne de tâche à jour (description et erreurs comprises), quel que soit son statut.
function taskRow(ctx, id) {
  if (!existsSync(brainPath(ctx))) return null;
  const db = new DatabaseSync(brainPath(ctx), { readOnly: true });
  try {
    return { ...db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function updateTask(ctx, id, fields) {
  const db = new DatabaseSync(brainPath(ctx));
  try {
    db.exec("PRAGMA busy_timeout = 4000");
    const keys = Object.keys(fields);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.close();
  }
}

// ---------- Aides ----------
const hostOf = (ctx, label) => {
  const e = ctx.hosts?.get?.(label);
  return e ? { ...e, local: isLoopbackUrl(e.url) } : null;
};
const lines = (out) => (out ? out.split("\n").filter(Boolean) : []);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function dirExists(host, dir) {
  try {
    await withTimeout(host.daemon.listDirectory(dir, "."), 8000, "dossier Oracle");
    return true;
  } catch {
    return false;
  }
}

// Lance une commande dans un terminal du daemon. Le daemon exige un espace de travail : on réutilise celui du dossier
// préféré s'il existe, sinon le premier disponible (le terminal est un simple processus transitoire).
async function spawnCommand(host, { name, command, args, preferDir }) {
  const res = await withTimeout(host.api.workspaces.list({}), 15000, "espaces de travail");
  const spaces = (res.entries || []).filter((w) => w.workspaceDirectory && !w.archivingAt);
  const ws = spaces.find((w) => preferDir && normDir(w.workspaceDirectory) === normDir(preferDir)) || spaces[0];
  if (!ws) throw new Error("Aucun espace de travail sur cette machine pour y lancer une commande.");
  const out = await host.daemon.createTerminal(ws.workspaceDirectory, name, undefined, { command, args, workspaceId: ws.id });
  if (out?.error || !out?.terminal) throw new Error(`Commande refusée par le daemon : ${redact(String(out?.error || "terminal absent"))}`);
  return out.terminal;
}

// Lit l'espace libre d'Oracle : variable ORACLE_DISK_FREE (octets) si définie, sinon `df` lancé dans un terminal
// jetable de la machine Oracle (lecture du résultat dans le flux du terminal), sinon valeur de repli signalée.
export async function probeOracleDisk(ctx, oracle) {
  const fixed = Number(process.env.ORACLE_DISK_FREE);
  if (Number.isFinite(fixed) && fixed > 0) return { freeBytes: fixed, source: "variable ORACLE_DISK_FREE" };
  let terminalId = null;
  let subscription = null;
  try {
    const marker = `DF${Date.now().toString(36)}`;
    const home = ORACLE_PROJECTS_ROOT.replace(/\/projets$/, "");
    const created = await withTimeout(spawnCommand(oracle, {
      name: "df-transfert", command: "sh", preferDir: ORACLE_PROJECTS_ROOT,
      args: ["-c", `printf '${marker}:%s\\n' "$(df -B1 --output=avail ${home} | tail -1 | tr -d ' ')"; sleep 4`],
    }), 20000, "terminal Oracle");
    terminalId = created?.id || null;
    if (!terminalId) throw new Error("terminal non créé");
    let text = "";
    subscription = oracle.daemon.observeTerminal(terminalId, (event) => {
      if (event.type === "output" || event.type === "restore") text += Buffer.from(event.data).toString("utf8");
    }, { restore: { mode: "visible-snapshot", size: { rows: 24, cols: 200 } } });
    const end = Date.now() + 8000;
    let m;
    while (Date.now() < end && !(m = text.match(new RegExp(`${marker}:(\\d{6,})`)))) await new Promise((r) => setTimeout(r, 150));
    if (!m) throw new Error("mesure illisible");
    return { freeBytes: Number(m[1]), source: "mesuré (df sur Oracle)" };
  } catch {
    return { freeBytes: DEFAULT_ORACLE_DISK_FREE, source: "estimation (mesure impossible)" };
  } finally {
    try { await subscription?.release?.(); } catch { /* ignoré */ }
    try { if (terminalId) await oracle.daemon.killTerminal?.(terminalId); } catch { /* ignoré */ }
  }
}

// ---------- Contrôle (lecture seule, toujours réel) ----------
export async function buildPlan(ctx, options = {}, deps = {}) {
  const ghStateFn = deps.ghState || ghState;
  const probeDisk = deps.probeOracleDisk || probeOracleDisk;
  const blockers = [];
  const warnings = [];
  const block = (code, message, project = null) => blockers.push({ code, message, project });
  const warn = (code, message, forceRequired = false) => warnings.push({ code, message, forceRequired });

  const tasks = readTasks(ctx, "local");
  const followed = (ctx.store.read("projects", {}) || {}).projects || [];
  const byKey = new Map();
  const add = (dir, name, concerned) => {
    const key = normDir(dir);
    if (!key) return;
    const prev = byKey.get(key);
    if (prev) prev.concerned = prev.concerned || concerned;
    else byKey.set(key, { dir, name: name || folderName(dir), concerned });
  };
  for (const p of followed) if (p?.host === "local" && p.dir) add(p.dir, p.name, false);
  for (const t of tasks) if (t.project) add(t.project, null, true);
  for (const dir of Array.isArray(options.projects) ? options.projects : []) add(String(dir), null, true);
  const candidates = [...byKey.values()];

  const local = hostOf(ctx, "local");
  const oracle = hostOf(ctx, "oracle");
  const oracleUp = Boolean(oracle && oracle.connected());
  if (!oracleUp) block("oracle_unreachable", "La machine Oracle n’est pas connectée : transfert impossible.");

  const [ghLocal, ghOracle] = await Promise.all([
    local ? ghStateFn(local, { fresh: true }).catch(() => ({ connected: false })) : { connected: false },
    oracleUp ? ghStateFn(oracle, { fresh: true }).catch(() => ({ connected: false })) : { connected: false },
  ]);
  if (oracleUp && !ghOracle.connected) {
    block("github_oracle_disconnected", "GitHub n’est pas connecté sur la machine Oracle (lancez gh auth login sur Oracle).");
  }

  const projects = await mapLimit(candidates, 4, async (c) => {
    const info = {
      name: c.name, host: "local", dir: c.dir, concerned: c.concerned, isGit: false, branch: null,
      dirty: [], dirtyCount: 0, remoteUrl: null, githubRepo: null, oracleDir: translateProjectPath(c.dir),
      oracleExists: false, diskNeeded: null, sensitive: [],
    };
    try {
      const top = await git(c.dir, ["rev-parse", "--show-toplevel"], { timeout: 8000 });
      info.isGit = normDir(top) === normDir(c.dir);
      info.nestedIn = info.isGit ? null : top;
    } catch { /* pas un dépôt git */ }
    if (!info.isGit) return info;
    try { info.branch = await git(c.dir, ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 8000 }); } catch { /* dépôt vide */ }
    try {
      const status = lines(await git(c.dir, ["status", "--porcelain"], { timeout: 20000 }));
      info.dirtyCount = status.length;
      info.dirty = status.slice(0, 60);
      info.sensitive = sensitivePaths(status);
    } catch { /* ignoré : statut illisible */ }
    try {
      const remote = parseRemote(await git(c.dir, ["config", "--get", "remote.origin.url"], { timeout: 8000 }));
      info.remoteUrl = remote?.url ?? null;
      if (remote?.github) info.githubRepo = { owner: remote.owner, repo: remote.repo };
    } catch { /* aucun remote origin */ }
    if (info.githubRepo) info.oracleDir = `${ORACLE_PROJECTS_ROOT}/${info.githubRepo.repo}`;
    if (c.concerned) {
      info.diskNeeded = estimateDiskNeeded(c.dir);
      if (oracleUp) info.oracleExists = await dirExists(oracle, info.oracleDir);
    }
    return info;
  });

  const concerned = projects.filter((p) => p.concerned);
  const seenNames = new Map();
  for (const p of concerned) {
    if (!p.isGit) {
      block("not_git", p.nestedIn
        ? `${p.name} est un sous-dossier du dépôt ${p.nestedIn} : transférez le dépôt entier ou initialisez ${p.name}.`
        : `${p.name} n’est pas un dépôt git.`, p.dir);
      continue;
    }
    if (!p.remoteUrl) block("no_remote", `Le projet ${p.name} n’a pas de dépôt distant lié.`, p.dir);
    else if (!p.githubRepo) block("non_github_remote", `Le dépôt distant de ${p.name} n’est pas sur GitHub (${p.remoteUrl}).`, p.dir);
    if (p.sensitive.length) block("sensitive_file", `${p.name} contient des fichiers sensibles non ignorés : ${p.sensitive.join(", ")}.`, p.dir);
    if (!p.branch) block("no_commit", `${p.name} n’a aucun commit.`, p.dir);
    else if (p.branch === "HEAD") warn("detached_head", `${p.name} est en HEAD détachée.`, true);
    if (p.dirtyCount) warn("dirty", `${p.name} : ${p.dirtyCount} modification(s) non enregistrée(s), elles seront committées sur la branche de transfert.`);
    const prior = seenNames.get(p.oracleDir);
    if (prior) block("name_collision", `${p.name} et ${prior} auraient le même dossier sur Oracle (${p.oracleDir}).`, p.dir);
    seenNames.set(p.oracleDir, p.name);
  }
  for (const p of projects.filter((x) => !x.concerned && x.isGit && !x.remoteUrl)) {
    warn("not_concerned_no_remote", `${p.name} (suivi) n’a pas de dépôt distant ; ignoré, aucune tâche active.`);
  }

  // Disque d'Oracle
  const disk = oracleUp ? await probeDisk(ctx, oracle) : { freeBytes: null, source: "Oracle injoignable" };
  const diskNeeded = concerned.filter((p) => !p.oracleExists).reduce((n, p) => n + (p.diskNeeded || 0), 0);
  if (disk.freeBytes != null && disk.freeBytes - diskNeeded < MIN_ORACLE_FREE_REQUIRED) {
    block("disk_low", `Espace insuffisant sur Oracle : ${Math.round((disk.freeBytes - diskNeeded) / 1e6)} Mo restants après le clone estimé (minimum 2 Go).`);
  }

  // Agents concernés : ceux liés à une tâche à transférer ; les autres seront coupés par l'extinction
  const agentTask = new Map(tasks.filter((t) => t.agent_id).map((t) => [t.agent_id, t.title]));
  const agents = [];
  let otherActive = 0;
  if (local?.connected()) {
    try {
      const list = await withTimeout(local.api.agents.list({}), 15000, "liste des agents");
      for (const row of list.entries || list.agents || []) {
        const a = row.agent || row;
        if (a.archivedAt || a.status === "closed") continue;
        if (agentTask.has(a.id)) agents.push({ id: a.id, task: agentTask.get(a.id), status: a.status });
        else otherActive += 1;
      }
    } catch { warn("agents_unreadable", "La liste des agents du mini-PC est illisible."); }
  }
  if (otherActive) warn("other_agents", `${otherActive} autre(s) agent(s) actif(s) sans tâche seront coupés par l’extinction.`, true);
  if (!concerned.length) warn("nothing_to_transfer", "Aucune tâche En cours ou À faire ne désigne un projet : rien à copier sur Oracle.");

  const forceBlocked = warnings.filter((w) => w.forceRequired);
  return {
    projects,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, project: t.project, status: t.status, agent_id: t.agent_id })),
    agents,
    oracleDiskFree: disk.freeBytes,
    oracleDiskSource: disk.source,
    ghConnected: { local: Boolean(ghLocal.connected), oracle: Boolean(ghOracle.connected) },
    errors: blockers.map((b) => b.message),
    blockers,
    warnings,
    forceRequired: forceBlocked.length > 0,
    ok: blockers.length === 0,
  };
}

// ---------- Exécuteurs réels ----------
export function createRealExecutors(deps = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mustLocal = (c) => {
    const l = c.hosts?.get?.("local");
    if (!l || !l.connected()) throw new Error("Le daemon du mini-PC n’est pas connecté.");
    return l;
  };
  const sendWindows = (c, args, name) => spawnCommand(mustLocal(c), { name, command: "shutdown", args });

  return {
    check: (c, options) => buildPlan(c, options, deps),

    async stopAgents(c, agent) {
      const l = mustLocal(c);
      await withTimeout(l.daemon.cancelAgent(agent.id), 20000, "arrêt de l’agent");
      return { agent: agent.id, stopped: true };
    },

    async commit(c, project, run) {
      const branch = assertTransferBranch(run.branch);
      const dir = project.dir;
      const top = await git(dir, ["rev-parse", "--show-toplevel"]);
      if (normDir(top) !== normDir(dir)) throw new Error(`${project.name} n’est pas la racine d’un dépôt git.`);
      const previousBranch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      await git(dir, ["checkout", "-B", branch]); // crée la branche depuis HEAD ; les modifications suivent
      if ((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])) !== branch) throw new Error(`Bascule vers ${branch} non confirmée.`);
      const status = lines(await git(dir, ["status", "--porcelain"]));
      const bad = sensitivePaths(status);
      if (bad.length) throw new Error(`Fichiers sensibles refusés : ${bad.join(", ")}.`);
      let committed = false;
      if (status.length) {
        await git(dir, ["add", "-A"]);
        const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        await git(dir, ["commit", "-m", `Transfert vers Oracle ${stamp}`]);
        committed = true;
      }
      return { dir, branch, previousBranch, committed, sha: await git(dir, ["rev-parse", "HEAD"]) };
    },

    async push(c, project, run) {
      const branch = assertTransferBranch(run.branch);
      const ref = `refs/heads/${branch}`;
      await git(project.dir, ["push", "origin", `${ref}:${ref}`], { timeout: 180000 });
      const remote = (await git(project.dir, ["ls-remote", "origin", ref])).split(/\s+/)[0];
      const local = await git(project.dir, ["rev-parse", "HEAD"]);
      if (remote !== local) throw new Error(`Le dépôt distant n’a pas reçu ${branch} (${remote || "absent"} ≠ ${local}).`);
      return { dir: project.dir, branch, sha: local, pushed: true };
    },

    async clone(c, project, run) {
      const branch = assertTransferBranch(run.branch);
      const oracle = c.hosts?.get?.("oracle");
      if (!oracle || !oracle.connected()) throw new Error("Machine Oracle non connectée pour le clone.");
      if (!project.githubRepo) throw new Error(`${project.name} : dépôt GitHub inconnu.`);
      let targetDir = project.oracleDir;
      const existed = await dirExists(oracle, targetDir);
      if (existed) {
        const pull = await withTimeout(oracle.daemon.checkoutPull(targetDir), 120000, "pull Oracle");
        if (pull?.error) throw new Error(`Pull Oracle refusé : ${redact(String(pull.error.message || pull.error))}`);
      } else {
        const res = await withTimeout(oracle.daemon.cloneGithubProject({
          repo: `${project.githubRepo.owner}/${project.githubRepo.repo}`, targetDirectory: ORACLE_PROJECTS_ROOT,
        }), 330000, "clone Oracle");
        if (res.error) throw new Error(`Clone Oracle refusé : ${redact(String(res.error))}`);
        targetDir = res.checkoutPath || targetDir;
      }
      let autocrlf = false;
      try {
        await spawnCommand(oracle, { name: "autocrlf", command: "git", args: ["-C", targetDir, "config", "core.autocrlf", "input"], preferDir: targetDir });
        autocrlf = true;
      } catch { /* la configuration globale d'Oracle s'applique */ }
      const sw = await withTimeout(oracle.daemon.checkoutSwitchBranch(targetDir, branch), 60000, "bascule de branche Oracle");
      if (!sw?.success) throw new Error(`Bascule vers ${branch} impossible sur Oracle : ${redact(String(sw?.error?.message || sw?.error || "inconnue"))}`);
      const st = await withTimeout(oracle.daemon.getCheckoutStatus(targetDir), 20000, "statut Oracle");
      if (st.currentBranch !== branch) throw new Error(`Oracle est sur ${st.currentBranch}, pas sur ${branch}.`);
      return { dir: project.dir, targetDir, branch, existed, autocrlf: "input", autocrlfApplied: autocrlf };
    },

    async reassign(c, planTask, run) {
      const task = taskRow(c, planTask.id) || planTask; // description et erreurs actuelles, pas celles du plan
      if (task.host && task.host !== "local") return { taskId: task.id, host: task.host, alreadyReassigned: true };
      const project = run.plan.projects.find((p) => normDir(p.dir) === normDir(task.project));
      const cloned = project && run.results.clone?.[project.dir];
      const targetDir = cloned?.targetDir || project?.oracleDir || translateProjectPath(task.project);
      let lastCommit = null;
      if (project) {
        try { lastCommit = await git(project.dir, ["log", "-1", "--format=%h %s"]); } catch { /* aucun commit */ }
      }
      const prompt = buildResumePrompt({
        task, branch: run.branch, lastCommit, targetDir, modifiedFiles: project?.dirty || [], errors: task.error || "",
      });
      updateTask(c, task.id, {
        host: "oracle", project: project ? targetDir : task.project, description: prompt, branch: run.branch,
        agent_id: null, status: "todo", reason: "Transfert vers Oracle", updated_at: new Date().toISOString(),
      });
      return { taskId: task.id, host: "oracle", targetDir, lastCommit, promptChars: prompt.length };
    },

    // Commande Windows annulable (60 s) lancée via le daemon du mini-PC.
    async shutdown(c, run) {
      if (run.dryRun === true || run.confirmShutdown !== true) throw new Error("Extinction réelle refusée : confirmShutdown:true obligatoire hors simulation.");
      await sendWindows(c, SHUTDOWN_ARGS, "extinction");
      return { ordered: true, command: SHUTDOWN_COMMAND, delaySeconds: 60 };
    },
    async abortShutdown(c) {
      await sendWindows(c, ["/a"], "annulation-extinction");
      return { aborted: true, command: "shutdown /a" };
    },
    // Attend que le mini-PC disparaisse (déconnexion du daemon) ; false s'il répond encore après le délai.
    async waitOffline(c, run, signal) {
      const wait = run.shutdownWaitMs ?? OFFLINE_WAIT_MS;
      const poll = Math.min(1000, Math.max(50, wait / 20));
      const end = Date.now() + wait;
      while (Date.now() < end && !signal?.aborted) {
        const l = c.hosts?.get?.("local");
        if (!l || !l.connected()) return true;
        await sleep(poll);
      }
      return false;
    },
  };
}

// ---------- Simulation (dryRun) : décrit sans rien exécuter ----------
export function createSimulationExecutors() {
  return {
    async stopAgents(c, agent) { return { agent: agent.id, simulated: true, wouldDo: "daemon.cancelAgent" }; },
    async commit(c, project, run) {
      return {
        dir: project.dir, branch: run.branch, simulated: true,
        wouldRun: [`git checkout -B ${run.branch}`, "git add -A", 'git commit -m "Transfert vers Oracle <date>"'],
      };
    },
    async push(c, project, run) {
      return { dir: project.dir, branch: run.branch, simulated: true, wouldRun: [`git push origin ${run.branch}`] };
    },
    async clone(c, project, run) {
      return {
        dir: project.dir, targetDir: project.oracleDir, branch: run.branch, simulated: true, autocrlf: "input",
        wouldDo: project.oracleExists ? "pull puis bascule de branche" : "clone puis bascule de branche",
      };
    },
    async reassign(c, planTask, run) {
      const task = taskRow(c, planTask.id) || planTask;
      const project = run.plan.projects.find((p) => normDir(p.dir) === normDir(task.project));
      const targetDir = project?.oracleDir || translateProjectPath(task.project);
      const prompt = buildResumePrompt({ task, branch: run.branch, targetDir, modifiedFiles: project?.dirty || [] });
      return { taskId: task.id, host: "oracle", targetDir, simulated: true, promptChars: prompt.length };
    },
    async shutdown() {
      return { simulated: true, command: SHUTDOWN_COMMAND, abortCommand: "shutdown /a", delaySeconds: 60 };
    },
    async abortShutdown() { return { simulated: true, command: "shutdown /a" }; },
    async waitOffline() { return true; },
  };
}

// ---------- Gestionnaire ----------
export class TransferManager {
  constructor(ctx, { dbPath, executors, simulation } = {}) {
    this.ctx = ctx;
    this.dbPath = dbPath || process.env.TRANSFERS_DB || join(ctx.dataDir, "transfers.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA busy_timeout = 4000");
    this.db.exec(SCHEMA);
    this.real = executors || createRealExecutors();
    this.sim = simulation || createSimulationExecutors();
    this.current = null; // { id, step, abort, cancelRequested }
    this.recoverInterrupted();
  }

  close() {
    try { this.db.close(); } catch { /* déjà fermée */ }
  }

  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignoré */ }
      throw e;
    }
  }

  // Au démarrage : un transfert resté dans un état intermédiaire devient failed(<étape>), raison « interrompu ».
  recoverInterrupted() {
    this.tx(() => {
      const marks = ACTIVE_STATES.map(() => "?").join(",");
      for (const t of this.db.prepare(`SELECT * FROM transfers WHERE state IN (${marks})`).all(...ACTIVE_STATES)) {
        this.db.prepare("UPDATE transfers SET state = ?, error = 'interrompu', updated_at = ? WHERE id = ?")
          .run(`failed(${t.step})`, new Date().toISOString(), t.id);
        this.log(t.id, t.step, "warn", `Transfert interrompu à l’étape ${t.step} (arrêt du processus).`);
      }
    });
  }

  log(id, step, level, message, details = null) {
    try {
      this.db.prepare("INSERT INTO transfer_events (transfer_id, step, level, message, details_json, created_at) VALUES (?,?,?,?,?,?)")
        .run(id, step, level, redact(String(message)), details ? JSON.stringify(redact(details)) : null, new Date().toISOString());
    } catch { /* le journal ne doit jamais faire échouer un transfert */ }
  }

  row(id) { return this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) || null; }
  last() { return this.db.prepare("SELECT * FROM transfers ORDER BY rowid DESC LIMIT 1").get() || null; }
  events(id) { return this.db.prepare("SELECT * FROM transfer_events WHERE transfer_id = ? ORDER BY id").all(id).map((r) => ({ ...r })); }

  plan(options = {}) { return this.real.check(this.ctx, options); }

  status() {
    const t = this.last();
    if (!t) return { state: "idle", step: "idle", startedAt: null, error: null };
    return { id: t.id, state: t.state, step: t.step, startedAt: t.started_at, updatedAt: t.updated_at, error: t.error, dryRun: Boolean(t.dry_run) };
  }

  async run(opts = {}) {
    if (opts.confirm !== true) throw new TransferError("Confirmation requise : transfer.run doit être envoyé avec confirm:true.", { code: "confirm_required" });
    if (typeof opts.dryRun !== "boolean") throw new TransferError("dryRun doit être précisé (true ou false).", { code: "dryrun_required" });
    const dryRun = opts.dryRun;
    const force = opts.force === true;
    const confirmShutdown = opts.confirmShutdown === true;
    const ctx = this.ctx;

    // Verrou en transaction + choix : reprise du dernier transfert du même mode, ou nouveau transfert.
    let id;
    let startStep = "checking";
    let plan = null;
    let results = {};
    this.tx(() => {
      const marks = ACTIVE_STATES.map(() => "?").join(",");
      if (this.db.prepare(`SELECT id FROM transfers WHERE state IN (${marks})`).get(...ACTIVE_STATES)) {
        throw new TransferError("Un transfert est déjà en cours.", { code: "locked" });
      }
      const prev = this.db.prepare("SELECT * FROM transfers WHERE dry_run = ? ORDER BY rowid DESC LIMIT 1").get(dryRun ? 1 : 0);
      const resumable = prev && /^(failed|partial)\(/.test(prev.state);
      const now = new Date().toISOString();
      if (resumable && opts.fresh === true) {
        this.db.prepare("UPDATE transfers SET state = 'abandoned', updated_at = ? WHERE id = ?").run(now, prev.id);
      }
      if (resumable && opts.fresh !== true) {
        id = prev.id;
        startStep = STEPS.includes(prev.step) && prev.step !== "done" ? prev.step : "checking";
        try {
          plan = prev.plan_json ? JSON.parse(prev.plan_json) : null;
          results = prev.results_json ? JSON.parse(prev.results_json) : {};
        } catch { plan = null; results = {}; }
        if (!plan) startStep = "checking";
        this.db.prepare("UPDATE transfers SET state = ?, force = ?, error = NULL, updated_at = ? WHERE id = ?")
          .run(startStep, force ? 1 : 0, now, id);
        this.log(id, startStep, "info", `Reprise du transfert depuis l’étape ${startStep}.`);
      } else {
        id = `tr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        this.db.prepare("INSERT INTO transfers (id, state, step, dry_run, force, started_at, updated_at) VALUES (?,?,?,?,?,?,?)")
          .run(id, "checking", "checking", dryRun ? 1 : 0, force ? 1 : 0, now, now);
        this.log(id, "checking", "info", `Nouveau transfert (dryRun=${dryRun}, force=${force}).`);
      }
    });

    results.meta = { ...(results.meta || {}), branch: results.meta?.branch || makeBranchName("transfert") };
    const abort = new AbortController();
    const cur = (this.current = { id, step: startStep, abort, cancelRequested: false });
    const state = {
      id, dryRun, force, confirmShutdown, branch: results.meta.branch, plan, results,
      shutdownWaitMs: opts.shutdownWaitMs,
    };
    const exec = (name) => (dryRun && name !== "check" ? this.sim : this.real)[name];
    const save = (stateName, step, error = null) => {
      this.db.prepare("UPDATE transfers SET state = ?, step = ?, plan_json = ?, results_json = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(stateName, step, state.plan ? JSON.stringify(redact(state.plan)) : null, JSON.stringify(redact(state.results)), error, new Date().toISOString(), id);
    };
    const announce = (type, extra = {}) => ctx.broadcast({ type, id, dryRun, ...extra });
    const checkCancel = () => {
      if (cur.cancelRequested) throw new CancelledError("Transfert annulé par l’utilisateur.");
    };
    // Exécute un exécuteur pour chaque élément, en sautant ceux déjà faits (reprise idempotente).
    const each = async (bucket, items, keyOf, fn, label) => {
      state.results[bucket] ||= {};
      for (const item of items) {
        checkCancel();
        const key = keyOf(item);
        if (state.results[bucket][key]) continue;
        try {
          state.results[bucket][key] = await fn(item);
        } catch (e) {
          this.log(id, cur.step, "error", `${label} ${key} : ${e.message}`);
          throw new TransferError(redact(`${label} ${key} : ${e.message}`), { project: key });
        }
        save(cur.step, cur.step);
        this.log(id, cur.step, "info", `${label} ${key}`, state.results[bucket][key]);
      }
    };

    try {
      const from = STEPS.indexOf(startStep);
      for (let i = from; i < STEPS.length; i++) {
        const step = STEPS[i];
        checkCancel(); // avant de changer cur.step : l’annulation est rattachée à l’étape en cours
        cur.step = step;
        save(step === "done" ? "shutting_down" : step, step === "done" ? "shutting_down" : step);
        announce("transfer.status", { state: step, step, progress: `${i + 1}/${STEPS.length}`, detail: `Étape ${step}` });
        this.log(id, step, "info", `Début de l’étape ${step}`);
        const concerned = () => (state.plan?.projects || []).filter((p) => p.concerned);

        if (step === "checking") {
          state.plan = await exec("check")(ctx, { projects: opts.projects });
          state.results.check = { ok: state.plan.ok, blockers: state.plan.blockers, warnings: state.plan.warnings };
          const hard = state.plan.blockers[0];
          if (hard) throw new TransferError(hard.message, { code: hard.code });
          if (state.plan.forceRequired && !force) {
            throw new TransferError(`${state.plan.warnings.find((w) => w.forceRequired).message} Relancez avec force pour passer cet avertissement.`, { code: "force_required" });
          }
        } else if (step === "stopping_agents") {
          await each("stopAgents", state.plan.agents, (a) => a.id, (a) => exec("stopAgents")(ctx, a, state), "Arrêt de l’agent");
        } else if (step === "committing") {
          await each("commit", concerned(), (p) => p.dir, (p) => exec("commit")(ctx, p, state), "Commit");
          await each("push", concerned(), (p) => p.dir, (p) => exec("push")(ctx, p, state), "Push");
        } else if (step === "cloning") {
          await each("clone", concerned(), (p) => p.dir, (p) => exec("clone")(ctx, p, state), "Clone");
        } else if (step === "reassigning") {
          await each("reassign", state.plan.tasks, (t) => t.id, (t) => exec("reassign")(ctx, t, state), "Réaffectation");
        } else if (step === "shutting_down") {
          if (!dryRun && !confirmShutdown) {
            state.results.shutdown = { skipped: true, reason: "confirmShutdown absent : aucune extinction demandée" };
            this.log(id, step, "warn", "Extinction non demandée (confirmShutdown absent).");
          } else {
            const order = await exec("shutdown")(ctx, state);
            state.results.shutdown = order;
            save("shutting_down", "shutting_down");
            const offline = await exec("waitOffline")(ctx, state, abort.signal);
            checkCancel();
            state.results.shutdown = { ...order, offline };
            if (!offline) throw new TransferError("Le mini-PC répond encore après l’ordre d’extinction.", { code: "partial_shutdown" });
          }
        } else {
          save("done", "done");
          const started = new Date(this.row(id).started_at).getTime();
          const summary = {
            projects: concerned().length, agents: state.plan.agents.length, tasks: state.plan.tasks.length,
            duration: Date.now() - started, shutdown: state.results.shutdown?.skipped ? "non demandée" : dryRun ? "simulée" : "ordonnée",
          };
          this.log(id, "done", "info", "Transfert terminé.", summary);
          announce("transfer.done", { summary });
          return { status: "done", id, dryRun, summary };
        }
      }
      return { status: "done", id, dryRun };
    } catch (err) {
      const step = cur.step;
      if (err instanceof CancelledError) {
        const stateName = step === "shutting_down" ? "partial(shutdown)" : `failed(${step})`;
        save(stateName, step, "annulé");
        this.log(id, step, "warn", "Transfert annulé.");
        announce("transfer.status", { state: stateName, step, detail: "annulé" });
        return { status: "cancelled", id, step, state: stateName };
      }
      const stateName = err.code === "partial_shutdown" ? "partial(shutdown)" : `failed(${step})`;
      save(stateName, step, redact(err.message));
      this.log(id, step, "error", `Échec à l’étape ${step} : ${err.message}`);
      announce("transfer.error", { state: stateName, step, message: redact(err.message), project: err.project ?? null });
      err.step = step;
      err.transferId = id;
      throw err;
    } finally {
      this.current = null;
    }
  }

  // Annule le transfert actif : s'arrête avant l'élément suivant ; pendant l'extinction, lance `shutdown /a`.
  async cancel() {
    const cur = this.current;
    if (!cur) throw new TransferError("Aucun transfert en cours à annuler.", { code: "none_active" });
    cur.cancelRequested = true;
    cur.abort.abort();
    const stoppedAt = cur.step;
    let aborted = null;
    const row = this.row(cur.id);
    if (stoppedAt === "shutting_down") {
      const exec = row?.dry_run ? this.sim : this.real;
      try { aborted = await exec.abortShutdown(this.ctx); } catch (e) { aborted = { error: e.message }; }
      this.log(cur.id, stoppedAt, "warn", "Annulation de l’extinction (shutdown /a).", aborted);
    }
    return { id: cur.id, stoppedAt, shutdownAborted: aborted, rollback: "aucun retour arrière automatique : les branches de transfert déjà créées sont conservées" };
  }
}

// ---------- Enregistrement ----------
export function register(ctx, options = {}) {
  const manager = new TransferManager(ctx, options.transfer || {});
  const fail = (ws, source, error, extra = {}) =>
    ctx.send(ws, { type: "error", source, message: redact(ctx.safeError(error)), ...extra });

  ctx.onMessage("transfer.plan", async (ws, m) => {
    try {
      ctx.send(ws, { type: "transfer.plan", ...(await manager.plan({ projects: m.projects })), ref: m.ref ?? null });
    } catch (e) { fail(ws, "transfer.plan", e); }
  });
  ctx.onMessage("transfer.run", async (ws, m) => {
    try {
      const res = await manager.run(m);
      ctx.send(ws, { type: "transfer.result", ok: res.status !== "cancelled", ...res, ref: m.ref ?? null });
    } catch (e) {
      fail(ws, "transfer.run", e, { step: e.step ?? null, code: e.code ?? null });
    }
  });
  ctx.onMessage("transfer.status", (ws, m) => ctx.send(ws, { type: "transfer.status", ...manager.status(), ref: m.ref ?? null }));
  ctx.onMessage("transfer.events", (ws, m) => {
    const id = typeof m.id === "string" ? m.id : manager.last()?.id;
    ctx.send(ws, { type: "transfer.events", id: id ?? null, events: id ? manager.events(id) : [], ref: m.ref ?? null });
  });
  ctx.onMessage("transfer.cancel", async (ws, m) => {
    try {
      ctx.send(ws, { type: "transfer.cancelled", ...(await manager.cancel()), ref: m.ref ?? null });
    } catch (e) { fail(ws, "transfer.cancel", e); }
  });
  return manager;
}
