// Le « cerveau » v1 : tâches persistantes (SQLite intégré à Node), dépendances, démarrage de sessions et
// synchronisation avec l'état des agents. Fichier : data/brain.sqlite (variable BRAIN_DB pour un autre chemin).
// Messages : task.list, task.create, task.update, task.move, task.delete, task.start, task.stop.
// Réponses : tasks (liste complète), task.changed ({ task } ou { id, deleted }), task.started, error.
// T40 : chaînes d'agents (colonnes `chain` / `autostart`, posées seulement par un appel interne, voir chains.mjs).
// Règle de workflow `advance()` : une tâche `autostart` « À faire » dont toutes les dépendances sont « Terminé »
// démarre seule ; une tâche de chaîne qui arrive « À valider » (session au repos, sans erreur ni permission) passe
// « Terminé » ; une tâche de chaîne en erreur ou bloquée arrête la chaîne (les suivantes restent « À faire » avec la
// raison).
// T44 : repli automatique de moteur (ctx.quota, handlers/quota.mjs) et avis « à vérifier » (ctx.reviewbadge).
// Colonnes `run_engine` (moteur réellement utilisé, le moteur voulu `engine` ne change jamais), `fb_tries` (relances
// automatiques après 402/429 : une seule) et `retry_at` (reprise prévue quand tous les moteurs sont au repos).
// Sans ctx.quota, rien ne change.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { statSync, copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { SELF_HOST, isSelfHost } from "../lib/selfhost.mjs";
import { checkProjectDir } from "../lib/guardrails.mjs";
import { plainReply } from "./freebuff.mjs";

const STATUSES = ["todo", "doing", "review", "done", "blocked"];
const LABELS = { todo: "À faire", doing: "En cours", review: "À valider", done: "Terminé", blocked: "Bloquée" };
const LIMITS = { title: 200, description: 20000, project: 1000, host: 100, engine: 200, mode: 100, branch: 100 };

const normPath = (d) => String(d ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const MAX_TASKS = 2000;
const POLL_MS = 2500;
const ENGINE = /^[A-Za-z0-9][\w.-]*\/[\w.:@/-]+$/;
// Moteur « auto » : le poste choisit le premier moteur disponible du classement des modèles pour le rôle de la tâche (vue Modèles).
const AUTO = "auto";
const FREEBUFF = "freebuff/code"; // moteur du classement qui n'est pas un agent : la tâche est confiée à FreeBuff (handlers/freebuff.mjs)
const plain = plainReply; // la pub de FreeBuff est une boîte ╭…╰
const wanted = (row) => (row.engine === AUTO ? undefined : row.engine);
const BRANCH = /^[\w./-]*$/;
const MODE = /^[\w.-]*$/;
const ROLES = ["writer", "reader", "planner"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  project      TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL DEFAULT 'local',
  engine       TEXT NOT NULL DEFAULT '',
  mode         TEXT NOT NULL DEFAULT '',
  isolation    TEXT NOT NULL DEFAULT 'local' CHECK (isolation IN ('local','worktree')),
  branch       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done','blocked')),
  deps         TEXT NOT NULL DEFAULT '[]',
  agent_id     TEXT,
  summary      TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  permission   INTEGER NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  origin       TEXT NOT NULL DEFAULT '',
  agent_run    TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'writer',
  chain        TEXT NOT NULL DEFAULT '',
  autostart    INTEGER NOT NULL DEFAULT 0,
  run_engine   TEXT NOT NULL DEFAULT '',
  fb_tries     INTEGER NOT NULL DEFAULT 0,
  retry_at     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tasks_status_position ON tasks (status, position);`;

class UserError extends Error {}
// Tous les moteurs sont au repos : la tâche attend sa reprise, ce n'est pas un échec de démarrage.
class Resting extends UserError {}
// Un appel au daemon qui ne répond pas ne doit jamais figer la synchronisation.
function within(promise, ms = 8000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("délai dépassé")), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
const fail = (message) => {
  throw new UserError(message);
};

const clean = (value, max) =>
  String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").trim().slice(0, max);
const folderName = (dir) => (dir ? dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "");
const shorten = (text, max = 500) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const clip = (text, max) => String(text ?? "").slice(0, max);

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, safeError, hosts } = ctx;
  // Machine du projet suivi qui porte ce dossier (lu dans data/projects.json), ou null.
  const hostOfProject = (dir) => {
    try {
      const wanted = normPath(dir);
      if (!wanted) return null;
      return (ctx.store.read("projects", {}).projects || []).find((p) => p && p.host && normPath(p.dir) === wanted)?.host ?? null;
    } catch { return null; }
  };
  const db = new DatabaseSync(process.env.BRAIN_DB || join(ctx.dataDir, "brain.sqlite"));
  db.exec("PRAGMA busy_timeout = 4000");
  db.exec(SCHEMA);
  // Migration douce (T31) : bases créées avant les colonnes d'origine (tâche créée par un agent sous mandat).
  const known = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  for (const col of ["origin", "agent_run"]) {
    if (!known.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
  // Migration douce (T36) : rôle de la session de la tâche (writer par défaut, reader = lecture seule, planner = notes seulement).
  if (!known.includes("role")) db.exec("ALTER TABLE tasks ADD COLUMN role TEXT NOT NULL DEFAULT 'writer'");
  // Migration douce (T40) : identifiant de l'exécution de chaîne et démarrage automatique.
  if (!known.includes("chain")) db.exec("ALTER TABLE tasks ADD COLUMN chain TEXT NOT NULL DEFAULT ''");
  if (!known.includes("autostart")) db.exec("ALTER TABLE tasks ADD COLUMN autostart INTEGER NOT NULL DEFAULT 0");
  // Migration douce (T44) : moteur réellement utilisé, relances automatiques déjà faites, reprise prévue.
  if (!known.includes("run_engine")) db.exec("ALTER TABLE tasks ADD COLUMN run_engine TEXT NOT NULL DEFAULT ''");
  if (!known.includes("fb_tries")) db.exec("ALTER TABLE tasks ADD COLUMN fb_tries INTEGER NOT NULL DEFAULT 0");
  if (!known.includes("retry_at")) db.exec("ALTER TABLE tasks ADD COLUMN retry_at TEXT NOT NULL DEFAULT ''");

  // ---------- Accès aux données ----------
  const now = () => new Date().toISOString();
  const rowsOf = () => db.prepare("SELECT * FROM tasks").all();
  const rowById = (id) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(id ?? ""));
  const depsOf = (row) => {
    try {
      const list = JSON.parse(row.deps);
      return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function patch(id, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), now(), id);
  }
  const column = (status) =>
    rowsOf().filter((r) => r.status === status).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  function renumber(status, ids) {
    const stmt = db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
    ids.forEach((id, index) => stmt.run(index, id));
  }

  function snapshot() {
    const rows = rowsOf();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows
      .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.position - b.position)
      .map((r) => {
        const deps = depsOf(r).filter((id) => byId.has(id));
        return {
          id: r.id, title: r.title, description: r.description, project: r.project, projectName: folderName(r.project),
          host: r.host, engine: r.engine, mode: r.mode, isolation: r.isolation, branch: r.branch, status: r.status,
          deps, blockedBy: deps.map((id) => byId.get(id)).filter((d) => d.status !== "done")
            .map((d) => ({ id: d.id, title: d.title, status: d.status })),
          agentId: r.agent_id, summary: r.summary, error: r.error, permission: r.permission === 1, reason: r.reason,
          createdAt: r.created_at, updatedAt: r.updated_at, position: r.position,
          origin: r.origin, agentRun: r.agent_run, role: ROLES.includes(r.role) ? r.role : "writer",
          chain: r.chain, autostart: r.autostart === 1, runEngine: r.run_engine,
          retryAt: r.status === "todo" && r.retry_at ? r.retry_at : null,
        };
      });
  }
  // Empreinte de la table : détecte les écritures d'un autre processus (second serveur sur la même base).
  const fingerprint = () => {
    const r = db.prepare("SELECT count(*) AS n, max(updated_at) AS t, sum(position) AS p FROM tasks").get();
    return `${r.n}|${r.t}|${r.p}`;
  };
  let seen = "";
  function emit(changed = [], removed = []) {
    seen = fingerprint();
    const tasks = snapshot();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const id of changed) if (byId.has(id)) broadcast({ type: "task.changed", task: byId.get(id) });
    for (const id of removed) broadcast({ type: "task.changed", id, deleted: true });
    broadcast({ type: "tasks", tasks });
    scheduleAdvance();
  }

  // ---------- Validation ----------
  function checkDeps(selfId, deps) {
    if (!Array.isArray(deps)) fail("la liste des dépendances est invalide");
    const unique = [...new Set(deps.map((d) => String(d)))];
    const byId = new Map(rowsOf().map((r) => [r.id, r]));
    for (const dep of unique) {
      if (dep === selfId) fail("une tâche ne peut pas dépendre d'elle-même (cycle)");
      if (!byId.has(dep)) fail("dépendance inconnue : la tâche n'existe plus");
    }
    // Cycle : depuis chaque dépendance, peut-on retrouver la tâche en suivant les dépendances ?
    const seen = new Set();
    const stack = [...unique];
    while (stack.length) {
      const id = stack.pop();
      if (id === selfId) fail("ces dépendances créent un cycle");
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...depsOf(byId.get(id) || { deps: "[]" }));
    }
    return unique;
  }

  // Lit les champs modifiables ; `partial` : seuls les champs présents dans le message sont lus.
  function readFields(m, selfId, partial) {
    const has = (key) => !partial || key in m;
    const out = {};
    if (has("title")) {
      out.title = clean(m.title, LIMITS.title);
      if (!out.title) fail("le titre est obligatoire");
    }
    if (has("description")) out.description = clean(m.description, LIMITS.description);
    if (has("project")) {
      out.project = clean(m.project, LIMITS.project);
      // « D:ProjetsMonDossier » : les  d'un chemin Windows ont été mangés par un shell (bash).
      if (/^[A-Za-z]:(?![\\/])/.test(out.project)) fail(`dossier invalide : ${out.project} (les antislashs ont été supprimés par le shell : écrivez le chemin avec des / ou entre guillemets)`);
    }
    if (has("host")) {
      // Sans machine précisée : celle du projet suivi qui porte ce dossier, sinon la machine du poste (et non « local » en dur :
      // sur Oracle, « local » est le Mini PC, et la tâche échouait avec « répertoire introuvable »).
      out.host = clean(m.host, LIMITS.host) || hostOfProject(out.project ?? clean(m.project, LIMITS.project)) || SELF_HOST;
      if (!hosts.has(out.host)) fail(`machine inconnue : ${out.host}`);
    }
    if (has("engine")) {
      out.engine = clean(m.engine, LIMITS.engine);
      if (out.engine && out.engine !== AUTO && !ENGINE.test(out.engine)) fail("le moteur doit avoir la forme fournisseur/modèle");
    }
    if (has("mode")) {
      out.mode = clean(m.mode, LIMITS.mode);
      if (!MODE.test(out.mode)) fail("mode invalide");
    }
    if (has("isolation")) {
      out.isolation = m.isolation === "worktree" ? "worktree" : "local";
      if (m.isolation != null && m.isolation !== "local" && m.isolation !== "worktree") fail("isolation invalide");
    }
    if (has("branch")) {
      out.branch = clean(m.branch, LIMITS.branch);
      if (!BRANCH.test(out.branch)) fail("nom de branche invalide");
    }
    if (has("role")) {
      out.role = m.role == null || m.role === "" ? "writer" : String(m.role);
      if (!ROLES.includes(out.role)) fail("rôle invalide (writer, reader ou planner)");
    }
    if (has("deps")) out.deps = JSON.stringify(checkDeps(selfId, m.deps ?? []));
    return out;
  }

  const need = (id) => rowById(id) || fail("tâche introuvable");
  const on = (type, handler) =>
    onMessage(type, async (ws, m) => {
      try {
        await handler(ws, m);
      } catch (error) {
        sendError(ws, error instanceof UserError ? error.message : safeError(error));
      }
    });

  // ---------- Messages ----------
  on("task.list", (ws) => send(ws, { type: "tasks", tasks: snapshot() }));

  on("task.create", (ws, m) => {
    if (rowsOf().length >= MAX_TASKS) fail(`maximum ${MAX_TASKS} tâches`);
    const id = randomUUID();
    // Agent de base (profil) : sa consigne, son rôle et son moteur par défaut complètent la tâche demandée.
    if (m.profile != null && m.profile !== "") {
      const applied = ctx.profiles?.apply(m.profile, m);
      if (!applied) fail(`agent de base inconnu : ${clean(m.profile, 40)} (liste : postectl agents)`);
      m = applied;
    }
    const fields = readFields(m, id, false);
    // L'origine « agent » n'est acceptée que des appels internes (API, mode Agent), jamais d'un navigateur.
    const internal = String(ws?._uiId ?? "").startsWith("invoke:");
    const origin = internal && m.origin === "agent" ? "agent" : "";
    const agentRun = origin ? clean(m.agentRun, 80) : "";
    // Chaîne et démarrage automatique (T40) : même règle, jamais acceptés d'un navigateur.
    const chain = internal ? clean(m.chain, 80) : "";
    const autostart = internal && (m.autostart === true || m.autostart === 1) ? 1 : 0;
    transaction(() => {
      const stamp = now();
      db.prepare(`INSERT INTO tasks (id, title, description, project, host, engine, mode, isolation, branch, status,
        deps, created_at, updated_at, position, origin, agent_run, role, chain, autostart) VALUES (?,?,?,?,?,?,?,?,?, 'todo', ?,?,?,?,?,?,?,?,?)`).run(
        id, fields.title, fields.description, fields.project, fields.host, fields.engine, fields.mode,
        fields.isolation, fields.branch, fields.deps, stamp, stamp, column("todo").length, origin, agentRun, fields.role || "writer",
        chain, autostart);
    });
    emit([id]);
    send(ws, { type: "task.created", id });
  });

  on("task.update", (ws, m) => {
    const row = need(m.id);
    const fields = readFields(m, row.id, true);
    if (!Object.keys(fields).length) fail("aucune modification");
    transaction(() => patch(row.id, fields));
    emit([row.id]);
  });

  // L'état réel d'une session, pour refuser « En cours » sans session vivante.
  async function liveAgent(row) {
    const entry = hosts.get(row.host);
    if (!entry || !entry.connected() || !row.agent_id) return null;
    try {
      return (await within(entry.api.agents.ref(row.agent_id).refresh()))?.agent ?? null;
    } catch {
      return null;
    }
  }

  on("task.move", async (ws, m) => {
    const row = need(m.id);
    const to = m.status == null ? row.status : String(m.status);
    if (!STATUSES.includes(to)) fail("colonne inconnue");
    // Workflow : déposer une tâche dans « En cours » sans session active la (re)lance ; déposer une tâche terminée,
    // à valider ou bloquée dans « À faire » la relance aussi (sauf si m.auto === false).
    let relaunch = false;
    if (to === "doing" && row.status !== "doing") {
      const agent = row.agent_id ? await liveAgent(row) : null;
      if (!agent || !["running", "initializing"].includes(agent.status)) {
        // Les appels d'agent (API, auto:false) gardent l'ancien garde-fou : « Démarrer » explicite.
        if (m.auto === false) fail("Une tâche ne passe « En cours » que par « Démarrer » (aucune session active).");
        relaunch = true;
      }
    } else if (to === "todo" && ["done", "review", "blocked"].includes(row.status) && m.auto !== false) {
      relaunch = true;
    }
    if (relaunch && row.status === "doing") relaunch = false;
    if (relaunch) {
      // Vérifie avant de bouger la carte : une tâche non démarrable reste où elle est (sauf retour vers « À faire »).
      if (to === "doing") await startRow(ws, row);
      else {
        transaction(() => {
          const target = column("todo").map((r) => r.id).filter((id) => id !== row.id);
          target.push(row.id);
          patch(row.id, { status: "todo", permission: 0, reason: "", error: "", retry_at: "" });
          renumber("todo", target);
          renumber(row.status, column(row.status).map((r) => r.id));
        });
        emit([row.id]);
        try {
          await startRow(ws, rowById(row.id));
        } catch (error) {
          sendError(ws, `Remise « À faire » faite, mais la relance automatique a échoué : ${error instanceof UserError ? error.message : safeError(error)}`);
        }
      }
      return;
    }
    // T48 : vérification après le travail de l'agent sur BlastWin avant de quitter « En cours ».
    let blastwinVerified = false;
    if (row.status === "doing" && (to === "review" || to === "done") && isBlastwinProject(row.project)) {
      const verdict = await runBlastwinVerification(ws, row);
      if (!verdict.passed) {
        await handleBlastwinVerifyFailure(ws, row, to, verdict, null);
        return; // la tâche passe « Bloquée », pas de move normal
      }
      ctx.agentActivity?.record({
        method: "POST", route: "/tasks/move", ok: true, status: 200,
        summary: `Vérification BlastWin verte avant ${to} : ${row.title}`,
        mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
      });
      blastwinVerified = true;
    }
    transaction(() => {
      const target = column(to).map((r) => r.id).filter((id) => id !== row.id);
      const index = Number.isInteger(m.index) ? Math.max(0, Math.min(m.index, target.length)) : target.length;
      target.splice(index, 0, row.id);
      const fields = {};
      if (to !== row.status) {
        Object.assign(fields, {
          status: to, permission: 0, reason: to === "blocked" ? "Déplacée manuellement" : "", retry_at: "",
        });
        if (to !== "doing") fields.error = "";
      }
      if (Object.keys(fields).length) patch(row.id, fields);
      renumber(to, target);
      if (to !== row.status) renumber(row.status, column(row.status).map((r) => r.id));
    });
    emit([row.id]);
    // T48 : après vérification verte, proposer la fusion dans le vrai BlastWin (2e confirmation de Philippe).
    if (blastwinVerified) {
      await requestBlastwinMergeConfirmation(ws, row);
    }
  });

  on("task.delete", (ws, m) => {
    const row = need(m.id);
    transaction(() => {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(row.id);
      // Maillon de chaîne supprimé : les suivants héritent de ses dépendances (sinon ils démarreraient trop tôt).
      const inherited = row.chain ? depsOf(row) : [];
      for (const other of rowsOf()) {
        const deps = depsOf(other);
        if (deps.includes(row.id)) {
          patch(other.id, { deps: JSON.stringify([...new Set([...deps.filter((d) => d !== row.id), ...inherited])]) });
        }
      }
      renumber(row.status, column(row.status).map((r) => r.id));
    });
    emit([], [row.id]);
  });

  const busy = new Set(); // tâches en cours de démarrage ou d'arrêt : la synchronisation les laisse tranquilles

  on("task.start", (ws, m) => {
    const row = need(m.id);
    if (row.status === "done") fail("Cette tâche est terminée : déplacez-la d'abord vers « À faire ».");
    return startRow(ws, row);
  });

  // Repli de moteur (T44) : { engine, note } pour démarrer `row` ; lance Resting si tous les moteurs sont au repos.
  const clock = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  function chooseEngine(row) {
    if (!ctx.quota) {
      if (row.engine === AUTO) fail("moteur « auto » indisponible : le classement des modèles n'est pas chargé");
      return { engine: row.engine, note: "" };
    }
    let pick;
    try {
      pick = ctx.quota.pickEngine(wanted(row), row.role, { agentsOnly: !isSelfHost(row.host) }); // FreeBuff ne tourne que sur la machine du poste
    } catch (error) {
      ctx.log("tasks", `repli de moteur : ${safeError(error)}`);
      if (row.engine === AUTO) fail("moteur « auto » : le classement des modèles n'a pas répondu");
      return { engine: row.engine, note: "" };
    }
    if (pick?.engine) {
      const why = String(pick.reason ?? "").split(" -> repli sur ")[0];
      if (row.engine === AUTO) return { engine: pick.engine, note: `Moteur choisi par le classement : ${pick.engine}` };
      return { engine: pick.engine, note: pick.changed ? `Moteur remplacé : ${why}, utilisé : ${pick.engine}` : "" };
    }
    const retryAt = Number.isFinite(pick?.retryAt) ? new Date(pick.retryAt).toISOString() : "";
    if (!retryAt) fail(shorten(pick?.reason || "aucun moteur disponible", 300));
    const message = `Tous les moteurs sont au repos, reprise vers ${clock(retryAt)}`;
    if (rowById(row.id)?.status === "todo") {
      patch(row.id, { reason: message, retry_at: retryAt });
      emit([row.id]);
    }
    throw new Resting(message);
  }

  // ---------- Tâches confiées à FreeBuff (moteur « freebuff/code » du classement) ----------
  // Pas d'agent : un lancement FreeBuff en arrière-plan (ctx.freebuff). La tâche reste « En cours » sans session ; à la fin du
  // lancement elle passe « À valider » (réponse en résumé) ou « Bloquée » (échec). La raison garde l'identifiant du lancement.
  const FB_JOB = /FreeBuff : (fb-[\w-]+)/;
  function moveTo(id, from, status, fields) {
    transaction(() => {
      const target = column(status).map((r) => r.id).filter((x) => x !== id);
      target.push(id);
      patch(id, { status, ...fields });
      renumber(status, target);
      renumber(from, column(from).map((r) => r.id));
    });
    emit([id]);
  }
  function finishFreebuff(id, job) {
    const row = rowById(id);
    if (!row || row.status !== "doing" || row.run_engine !== FREEBUFF) return; // arrêtée, déplacée ou supprimée entre-temps
    if (job.status === "done" && job.result?.completed) {
      moveTo(id, "doing", "review", { summary: shorten(plain(job.result.reply) || plain(job.result.screenTail) || "FreeBuff a terminé (réponse vide)", 1500), error: "", reason: `FreeBuff : ${job.jobId} terminé` });
    } else {
      const why = job.error || job.result?.error || "FreeBuff n'a pas terminé";
      if (job.status === "failed" && !/annulé|interrompu/i.test(why)) ctx.quota?.noteFailure?.(FREEBUFF, why); // un arrêt ou un redémarrage n'est pas un manque de quota
      moveTo(id, "doing", "blocked", { error: shorten(`FreeBuff : ${why}`, 300), reason: `FreeBuff : ${job.jobId} échec` });
    }
  }
  async function startWithFreebuff(ws, row, { note, prefix }) {
    if (typeof ctx.freebuff?.delegate !== "function") throw new Error("FreeBuff indisponible sur ce poste");
    let moved = false;
    let early = null; // fin du lancement arrivée avant que la tâche soit « En cours » : rejouée juste après
    const job = await ctx.freebuff.delegate(
      { project: row.project, prompt: String(row.description || row.title).slice(0, 3900) },
      { onFinish: (done) => (moved ? finishFreebuff(row.id, done) : (early = done)) },
    );
    const current = rowById(row.id);
    if (!current || current.status !== row.status) return; // arrêtée pendant le lancement : le résultat sera ignoré
    const journal = shorten(`${prefix}${note ? `${note} · ` : ""}FreeBuff : ${job.jobId}`, 300);
    moveTo(row.id, row.status, "doing", { agent_id: "", summary: "", error: "", permission: 0, reason: journal, run_engine: FREEBUFF, retry_at: "", fb_tries: 0 });
    moved = true;
    if (early) finishFreebuff(row.id, early);
    send(ws, { type: "task.started", id: row.id, host: row.host, agentId: null });
  }
  // Après un redémarrage du poste, un lancement FreeBuff en cours est perdu : sa tâche ne doit pas rester « En cours » sans fin.
  function reconcileFreebuff() {
    for (const row of column("doing")) {
      if (row.run_engine !== FREEBUFF || row.agent_id) continue;
      const id = FB_JOB.exec(row.reason || "")?.[1];
      const job = id ? ctx.freebuff?.job?.(id) : null;
      if (job?.running) continue;
      if (job?.status === "done" || job?.status === "failed") finishFreebuff(row.id, job);
      else moveTo(row.id, "doing", "blocked", { error: "FreeBuff interrompu par un redémarrage du poste (voir le terminal)", reason: "FreeBuff interrompu" });
    }
  }

  async function startRow(ws, row, { prefix = "", relaunch = false } = {}) {
    if (row.status === "doing") fail("Cette tâche est déjà en cours.");
    const unfinished = snapshot().find((t) => t.id === row.id).blockedBy;
    if (unfinished.length) {
      fail(`Bloquée par: ${unfinished.map((d) => `${d.title} (${LABELS[d.status]})`).join(", ")}`);
    }
    if (!row.project) fail("le dossier du projet est obligatoire pour démarrer");
    if (row.engine !== AUTO && !ENGINE.test(row.engine)) fail("choisissez un moteur (fournisseur/modèle) avant de démarrer");
    const entry = hosts.get(row.host);
    if (!entry || !entry.connected()) fail(`machine indisponible : ${row.host}`);
    if (busy.has(row.id)) fail("démarrage déjà en cours");
    const { engine, note } = chooseEngine(row);
    busy.add(row.id);
    try {
      // Garde-fou BlastWin : confirmable (T48). Les refus durs restent absolus (secrets, force-push,
      // push sur main, merge --admin, STOP, services BlastWin).
      const guard = checkProjectDir(row.project);
      const isBlast = Boolean(guard.guard === "blastwin" && guard.confirmable);
      if (!guard.allow) {
        if (isBlast) {
          if (!(await isBlastwinConfirmed(row.id))) {
            await requestBlastwinConfirmation(ws, row);
            return; // reste « À faire » en attente de la confirmation de Philippe
          }
          // Déjà confirmé : on procède (sauvegarde + worktree + agent).
        } else {
          throw new Error(guard.reason); // refus dur absolu
        }
      }
      if (engine === FREEBUFF) return await startWithFreebuff(ws, row, { note, prefix });
      // T48 : travail isolé obligatoire pour BlastWin sur une branche agent/<idTâche>.
      if (isBlast) {
        row.isolation = "worktree";
        row.branch = blastBranch(row);
      }
      // Même appel que le message launch.start (agent) : espace de travail puis création de l'agent.
      const workspace = await entry.api.workspaces.open({ cwd: row.project });
      // T48 : sauvegarde AVANT tout agent sur BlastWin (tag git + bundle + copie des fichiers).
      // Échec de la sauvegarde = la tâche ne démarre pas.
      if (isBlast) {
        const backup = await doBlastwinBackup(row);
        if (!backup.ok) throw new Error(`sauvegarde impossible avant démarrage : ${backup.error}`);
      }
      // T36 : un lecteur Claude démarre en mode « plan » (aucune modification possible) ; la coordination fournit l'identité de la
      // session (jeton), le serveur MCP paseo-coord et, si le moteur ne peut pas être contraint alors qu'une autre session écrit dans le
      // projet, une copie de travail séparée. Sans coordination (ou si le daemon refuse ces options), le lancement reste celui d'avant.
      const claude = /^claude/i.test(engine);
      // Philippe (2026-10-24) : plus de demandes de permission pour les commandes bash ; sans mode choisi, un agent Claude écrivain démarre en bypassPermissions.
      const modeId = row.role === "reader" && claude ? "plan" : row.mode || (claude ? "bypassPermissions" : "");
      const options = {
        config: { provider: engine, ...(modeId ? { modeId } : {}) },
        cwd: row.project,
        prompt: row.description || row.title,
        title: row.title,
      };
      const coord = ctx.coord?.prepareLaunch?.({
        host: row.host, cwd: row.project, taskId: row.id, role: row.role, engine, mode: modeId,
      });
      const forcedIsolation = row.isolation !== "worktree" && Boolean(coord?.isolate);
      // Correctif BlastWin : le worktree de la branche existe déjà, l'agent y reprend son travail (pas de nouvelle branche).
      const reusedWorktree = isBlast ? findWorktreePath(row.project, row.branch) : null;
      if (reusedWorktree) options.cwd = reusedWorktree;
      else if (row.isolation === "worktree" || forcedIsolation) {
        options.worktree = { mode: "branch-off", newBranch: row.branch || `paseo-task-${row.id.slice(0, 8)}` };
      }
      if (coord) {
        if (coord.hint) options.prompt = `${options.prompt}\n\n${coord.hint}`;
        options.agentId = coord.agentId;
        options.env = coord.env;
        if (coord.mcpServers) options.config.mcpServers = coord.mcpServers;
        if (coord.toolPolicy) options.config.toolPolicy = coord.toolPolicy;
      }
      // Les agents lancés par le poste sont « autonomes » : le hook tools/guard-hook.mjs leur applique les garde-fous durs.
      options.env = { ...(options.env || {}), POSTE_AUTONOMOUS: "1" };
      let agent;
      try {
        // Avec coordination : reculs successifs gérés par ctx.coord.createAgent (sans toolPolicy pour les moteurs qui ne pré-approuvent pas les outils MCP,
        // puis sans aucune option de coordination pour un daemon plus ancien) ; sans coordination : l'appel d'avant.
        agent = coord ? await ctx.coord.createAgent(entry.api, options, coord) : await entry.api.agents.create(options);
      } catch (error) {
        if (!forcedIsolation) throw error;
        throw new Error(`une autre session écrit dans ce projet et ce moteur ne peut pas être contraint (aucune fenêtre de permission) ; la copie de travail séparée a échoué : ${safeError(error)}. Attendez la fin de l'autre session, choisissez un moteur contraignable ou le rôle « lecteur ».`);
      }
      ctx.coord?.afterLaunch?.({ requestedId: coord?.agentId, agent });
      // Arrêtée, déplacée (blocage de chaîne, « passer » de la nuit) ou supprimée PENDANT la création de l'agent : on ne la remet
      // surtout pas « En cours » et l'agent tout juste créé est arrêté puis archivé (sinon il tournerait en cachette).
      const current = rowById(row.id);
      if (!current || current.status !== row.status) {
        await entry.daemon.cancelAgent(agent.id).catch(() => {});
        await entry.daemon.archiveAgent(agent.id).catch(() => {});
        ctx.broadcastState?.();
        return;
      }
      transaction(() => {
        const target = column("doing").map((r) => r.id).filter((id) => id !== row.id);
        target.push(row.id);
        const journal = shorten(`${prefix}${note || (prefix ? `Moteur utilisé : ${engine}` : "")}`, 300);
        patch(row.id, {
          status: "doing", agent_id: agent.id, summary: "", error: "", permission: 0, reason: journal,
          run_engine: engine, retry_at: "", ...(relaunch ? {} : { fb_tries: 0 }),
        });
        renumber("doing", target);
        renumber(row.status, column(row.status).map((r) => r.id));
      });
      emit([row.id]);
      send(ws, { type: "task.started", id: row.id, host: row.host, agentId: agent.id, workspaceId: workspace?.id });
      ctx.broadcastState?.();
    } catch (error) {
      fail(`lancement impossible : ${safeError(error)}`);
    } finally {
      busy.delete(row.id);
    }
  }

  // ---------- T48 : BlastWin — confirmation, sauvegarde, vérification, fusion ----------

  const BLASTWIN_BACKUP_SUBDIR = "blastwin";
  const BLASTWIN_VERIFY_MAX_ATTEMPTS = 2;

  // Branche de travail d'une tâche BlastWin : agent/<id>, ou celle de la tâche d'origine pour un correctif (branche déjà posée).
  const blastBranch = (row) => (/^agent\/[\w.-]+$/.test(row.branch || "") ? row.branch : `agent/${row.id}`);

  function isBlastwinProject(dir) {
    const g = checkProjectDir(dir);
    return Boolean(g.guard === "blastwin" && g.confirmable);
  }

  // Philippe a-t-il déjà confirmé cette tâche BlastWin (élément inbox traité avec décision allow) ?
  async function isBlastwinConfirmed(taskId) {
    if (!ctx.inbox) return false;
    const items = ctx.inbox.list({ kind: "permission" });
    return items.some((i) =>
      i.status === "traité" &&
      i.action?.kind === "blastwin-confirm" &&
      i.action?.taskId === taskId &&
      i.action?.decision === "allow"
    );
  }

  // Crée l'élément de boîte de réception demandant à Philippe d'autoriser le démarrage sur BlastWin.
  async function requestBlastwinConfirmation(ws, row) {
    if (!ctx.inbox) {
      fail("confirmation BlastWin requise mais la boîte de réception est indisponible");
      return;
    }
    const requestId = randomUUID();
    const body = `Tâche : ${row.title}\nDescription : ${row.description || "(aucune)"}\nMoteur : ${row.engine}\nProjet : ${row.project}\n\nÀ l'approbation : sauvegarde (tag git + bundle + copie des fichiers) puis travail dans un worktree isolé sur la branche agent/${row.id}. Vérification automatique à la fin, puis fusion dans le vrai BlastWin seulement après une 2e confirmation.`;
    ctx.inbox.add({
      kind: "permission",
      host: row.host,
      taskId: row.id,
      title: `BlastWin : autoriser la tâche ${row.title} ?`,
      body: body.slice(0, 600),
      status: "nouveau",
      source: "t48-blastwin",
      action: {
        type: "permission",
        requestId,
        kind: "blastwin-confirm",
        tool: "task",
        target: row.project,
        cwd: row.project,
        taskId: row.id,
        actions: [
          { id: "allow", behavior: "allow", label: "Autoriser" },
          { id: "deny", behavior: "deny", label: "Refuser" },
        ],
        danger: false,
      },
    });
    ctx.agentActivity?.record({
      method: "POST", route: "/tasks/start", ok: true, status: 200,
      summary: `Demande de confirmation BlastWin pour la tâche ${clip(row.title, 120)}`,
      mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
    });
    send(ws, { type: "task.started", id: row.id, host: row.host, agentId: null, confirmationRequired: true });
    ctx.broadcastState?.();
  }

  // Sauvegarde AVANT tout agent sur BlastWin : tag git + bundle + copie des fichiers modifiés/non suivis.
  // Retourne { ok, detail, tag, dir } ou { ok: false, error }.
  async function doBlastwinBackup(row) {
    const project = row.project;
    const id = row.id;
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const tagName = `pre-agent/${id}-${stamp}`;
    const dataDir = ctx.dataDir || join(process.env.HOME || process.env.GUARD_HOME || "", "paseo-dash-data");
    const backupDir = join(dataDir, "agent-backups", BLASTWIN_BACKUP_SUBDIR, `${id}-${stamp}`);
    try {
      mkdirSync(backupDir, { recursive: true });
      // 1. Tag git sur HEAD du vrai dépôt.
      execFileSync("git", ["tag", tagName], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      // 2. Bundle de HEAD.
      const bundleFile = join(backupDir, `HEAD-${stamp}.bundle`);
      execFileSync("git", ["bundle", "create", bundleFile, "HEAD"], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      // 3. Copie des fichiers modifiés ou non suivis.
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" });
      for (const line of status.split("\n")) {
        if (!line.trim()) continue;
        const filePath = line.slice(3);
        const absPath = join(project, filePath);
        let st;
        try { st = statSync(absPath); } catch { continue; }
        if (!st.isFile()) continue;
        const dest = join(backupDir, filePath);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(absPath, dest);
      }
      // Index des sauvegardes.
      writeFileSync(join(backupDir, "_index.json"), JSON.stringify({
        runId: id, projectDir: project, tag: tagName, bundle: bundleFile, at: new Date().toISOString(),
      }, null, 2));
      ctx.agentActivity?.record({
        method: "POST", route: "/tasks/start", ok: true, status: 200,
        summary: `Sauvegarde BlastWin avant agent : tag ${tagName}, bundle, fichiers dans ${backupDir}`,
        mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
      });
      return { ok: true, detail: `tag ${tagName} + bundle + fichiers dans ${backupDir}`, tag: tagName, dir: backupDir };
    } catch (e) {
      const msg = String(e.message ?? e).replace(/^Erreur\s*:\s*/, "");
      ctx.agentActivity?.record({
        method: "POST", route: "/tasks/start", ok: false, status: 500,
        summary: `Échec sauvegarde BlastWin avant agent : ${msg}`,
        mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
      });
      return { ok: false, error: msg };
    }
  }

  // ---------- T48 : Vérification après travail sur BlastWin ----------

  const VERIFY_CONFIG = "project-verify.json";
  const VERIFY_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 h max par commande

  // Tentatives de correctif par branche de travail (blastBranch → nombre) : une chaîne de correctifs ne dépasse jamais le plafond.
  const fixAttempts = new Map();

  // Chemin du worktree git associé à une branche (via `git worktree list --porcelain`).
  // Le champ `branch` de porcelain est au format « refs/heads/<nom> » ; on le compare aussi sans le préfixe.
  function findWorktreePath(project, branch) {
    try {
      const output = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: project, encoding: "utf8" });
      let currentPath = null;
      let currentBranch = null;
      for (const line of output.split("\n")) {
        if (!line.trim()) {
          if (currentPath && (currentBranch === branch || currentBranch === `refs/heads/${branch}`)) return currentPath;
          currentPath = null; currentBranch = null; continue;
        }
        const mPath = line.match(/^worktree (.+)$/);
        if (mPath) currentPath = mPath[1];
        const mBranch = line.match(/^branch (.+)$/);
        if (mBranch) currentBranch = mBranch[1];
      }
      if (currentPath && (currentBranch === branch || currentBranch === `refs/heads/${branch}`)) return currentPath;
    } catch { /* pas de worktree ou git indisponible */ }
    return null;
  }

  // Lit <dataDir>/project-verify.json : { [cheminProjet]: [commandes] }.
  function readVerifyConfig() {
    try {
      const dataDir = ctx.dataDir || join(process.env.HOME || process.env.GUARD_HOME || "", "paseo-dash-data");
      const file = join(dataDir, VERIFY_CONFIG);
      if (!existsSync(file)) return {};
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch { return {}; }
  }

  // Commandes de défaut pour BlastWin (si pas de config explicite).
  function defaultVerifyCommands(project) {
    const cmds = [];
    try { if (existsSync(join(project, "package.json"))) { cmds.push("npm test"); cmds.push("npm run build"); } } catch { /* */ }
    return cmds;
  }

  // Vérifie le travail dans le worktree. Retourne { passed, output, commands }.
  async function verifyBlastwinTask(row, wtPath) {
    const config = readVerifyConfig();
    const commands = Array.isArray(config[row.project]) ? config[row.project] : defaultVerifyCommands(row.project);
    const results = [];
    // Aucune commande de vérification connue : on ne peut pas déclarer « vert » (jamais de vert par défaut).
    let passed = commands.length > 0;
    let output = commands.length ? "" : "\nAucune commande de vérification configurée (project-verify.json ou package.json).";
    for (const cmd of commands) {
      let cmdOk = true;
      const t0 = Date.now();
      let result = "";
      try {
        result = execFileSync("bash", ["-c", cmd], { cwd: wtPath, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        result = `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message ?? e);
        cmdOk = false;
        passed = false;
      }
      const ms = Date.now() - t0;
      const out = String(result ?? "");
      output += `\n=== $ ${cmd} (${ms} ms) ===\n${out}`;
      results.push({ cmd, ok: cmdOk, output: out });
    }
    const masked = output.replace(/(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, "***");
    ctx.agentActivity?.record({
      method: "POST", route: "/tasks/verify", ok: passed, status: passed ? 200 : 400,
      summary: `Vérification BlastWin ${row.title} : ${passed ? "verte" : "rouge"} (${results.filter((r) => r.ok).length}/${results.length})`,
      mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
    });
    if (ctx.inbox) {
      ctx.inbox.add({
        kind: passed ? "fin" : "erreur",
        host: row.host,
        taskId: row.id,
        title: passed ? `Vérification verte : ${row.title}` : `Vérification rouge : ${row.title}`,
        body: `Vérification après travail sur BlastWin : ${passed ? "TOUS LES TESTS PASSÉS" : "ÉCHEC — voir le détail."}\n${shorten(masked, 4000)}`,
        status: "nouveau",
        source: "t48-blastwin-verify",
      });
    }
    return { passed, output: masked, commands: results };
  }

  // Gère un échec de vérification : bloque, tente un correctif (max 2), puis laisse en l'état.
  async function handleBlastwinVerifyFailure(ws, row, targetStatus, verdict, wtPath) {
    const attempts = (fixAttempts.get(blastBranch(row)) || 0) + 1;
    fixAttempts.set(blastBranch(row), attempts);
    ctx.agentActivity?.record({
      method: "POST", route: "/tasks/verify", ok: false, status: 400,
      summary: `Vérification BlastWin rouge pour ${row.title} : tentative ${attempts}/${BLASTWIN_VERIFY_MAX_ATTEMPTS}`,
      mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
    });
    if (attempts <= BLASTWIN_VERIFY_MAX_ATTEMPTS) {
      // Relance un correctif dans le même worktree.
      const fixTaskId = randomUUID();
      try {
        await ctx.invoke("task.create", {
          id: fixTaskId,
          title: `Correctif : ${row.title}`,
          description: `La vérification post-travail a échoué sur BlastWin. Corrige les erreurs suivantes puis relance la vérification :\n\n${shorten(verdict.output, 3000)}\n\nTravaille dans le worktree existant sur la branche ${blastBranch(row)}. Ne modifie pas le vrai dossier BlastWin.`,
          project: row.project, host: row.host, engine: row.engine,
          origin: "agent", agentRun: row.agent_run || "",
          isolation: "worktree", branch: `${blastBranch(row)}`,
        });
      } catch { /* si la création échoue, on reste bloqué */ }
      moveTo(row.id, "doing", "blocked", { error: `Vérification rouge (tentative ${attempts}/${BLASTWIN_VERIFY_MAX_ATTEMPTS})`, reason: `Vérification échouée, correctif en cours` });
      if (ctx.inbox) {
        ctx.inbox.add({
          kind: "erreur",
          host: row.host,
          taskId: row.id,
          title: `Correctif BlastWin (${attempts}/${BLASTWIN_VERIFY_MAX_ATTEMPTS}) : ${row.title}`,
          body: `Vérification rouge. Correctif lancé dans le worktree (branche ${blastBranch(row)}). Voir le détail dans l'activité de l'agent.\n${shorten(verdict.output, 2000)}`,
          status: "nouveau",
          source: "t48-blastwin-verify",
        });
      }
      return;
    }
    // Toujours rouge après 2 tentatives : rien fusionné, Philippe prévenu.
    moveTo(row.id, "doing", "blocked", { error: `Vérification échouée après ${attempts} tentatives — travail conservé sur ${blastBranch(row)}`, reason: "Vérification Bloquée" });
    if (ctx.inbox) {
      ctx.inbox.add({
        kind: "erreur",
        host: row.host,
        taskId: row.id,
        title: `BlastWin bloqué : ${row.title}`,
        body: `Vérification échouée après ${attempts} tentatives. Le travail reste sur la branche ${blastBranch(row)}. Le vrai dossier BlastWin n'a pas été modifié.`,
        status: "nouveau",
        source: "t48-blastwin-verify",
      });
    }
  }

  // Lance la vérification sur une tâche BlastWin (message WS « task.verify » ou appel interne).
  async function runBlastwinVerification(ws, row) {
    const wtPath = row.agent_id ? findWorktreePath(row.project, blastBranch(row)) : null;
    if (!wtPath) {
      if (ctx.inbox) {
        ctx.inbox.add({ kind: "erreur", host: row.host, taskId: row.id, title: `Vérification impossible : ${row.title}`, body: "Aucun worktree trouvé pour cette tâche BlastWin.", status: "nouveau", source: "t48-blastwin-verify" });
      }
      return { passed: false, error: "worktree introuvable" };
    }
    return verifyBlastwinTask(row, wtPath);
  }

  on("task.stop", async (ws, m) => {
    const row = need(m.id);
    if (row.status === "doing" && !row.agent_id && row.run_engine === FREEBUFF) {
      const jobId = FB_JOB.exec(row.reason || "")?.[1];
      moveTo(row.id, "doing", "blocked", { permission: 0, error: "", reason: "Arrêtée manuellement (lancement FreeBuff annulé, son terminal fermé)" });
      if (jobId) await ctx.freebuff?.cancel?.(jobId);
      return;
    }
    if (row.status !== "doing" || !row.agent_id) fail("Cette tâche n'a pas de session en cours.");
    const entry = hosts.get(row.host);
    if (!entry || !entry.connected()) fail(`machine indisponible : ${row.host}`);
    busy.add(row.id);
    try {
      await entry.daemon.cancelAgent(row.agent_id);
      transaction(() => {
        const target = column("blocked").map((r) => r.id).filter((id) => id !== row.id);
        target.push(row.id);
        patch(row.id, { status: "blocked", permission: 0, error: "", reason: "Arrêtée manuellement" });
        renumber("blocked", target);
        renumber("doing", column("doing").map((r) => r.id));
      });
      emit([row.id]);
    } catch (error) {
      fail(`arrêt impossible : ${safeError(error)}`);
    } finally {
      busy.delete(row.id);
    }
  });

  // T48 : vérification manuelle à la demande (« task.verify »).
  on("task.verify", async (ws, m) => {
    const row = need(m.id);
    if (!isBlastwinProject(row.project)) return sendError(ws, "vérification réservée aux projets BlastWin protégés");
    const verdict = await runBlastwinVerification(ws, row);
    if (verdict.passed) {
      send(ws, { type: "task.verified", id: row.id, passed: true, output: shorten(verdict.output, 2000) });
    } else {
      send(ws, { type: "task.verified", id: row.id, passed: false, output: shorten(verdict.output, 2000), error: verdict.error });
    }
  });

  // ---------- T48 : fusion dans le vrai BlastWin (2e confirmation) ----------

  // Vérifie s'il existe déjà une demande de fusion en attente pour cette tâche.
  function isBlastwinMergePending(taskId) {
    if (!ctx.inbox) return false;
    const items = ctx.inbox.list({ kind: "permission" });
    return items.some((i) =>
      i.action?.kind === "blastwin-merge" &&
      i.action?.taskId === taskId &&
      i.status === "nouveau"
    );
  }

  // Crée l'élément de boîte de réception demandant la 2e confirmation pour fusionner dans le vrai BlastWin.
  async function requestBlastwinMergeConfirmation(ws, row) {
    if (!ctx.inbox) return;
    if (isBlastwinMergePending(row.id)) return;
    const requestId = randomUUID();
    // Diff résumé entre HEAD du vrai dépôt et la branche agent/<id>.
    let diffSummary = "(diff indisponible)";
    try {
      const stat = execFileSync("git", ["diff", "--stat", `HEAD...${blastBranch(row)}`], { cwd: row.project, encoding: "utf8" });
      diffSummary = shorten(stat, 800);
    } catch { /* git diff indisponible : on tente quand même la fusion */ }
    const body = `Tâche : ${row.title}\nBranche : ${blastBranch(row)}\nVérification : verte (worktree)\n\nÀ l'approbation : tag pre-merge, fusion --no-ff dans le vrai dépôt BlastWin, puis revérification dans le vrai dossier. Rollback automatique si la revérification échoue. Jamais de push GitHub par l'agent.\n\nDiff :\n${diffSummary}`;
    ctx.inbox.add({
      kind: "permission",
      host: row.host,
      taskId: row.id,
      title: `BlastWin : fusionner ${row.title} ?`,
      body: body.slice(0, 600),
      status: "nouveau",
      source: "t48-blastwin-merge",
      action: {
        type: "permission",
        requestId,
        kind: "blastwin-merge",
        tool: "task",
        target: row.project,
        cwd: row.project,
        taskId: row.id,
        actions: [
          { id: "allow", behavior: "allow", label: "Fusionner" },
          { id: "deny", behavior: "deny", label: "Refuser" },
        ],
        danger: false,
      },
    });
    ctx.agentActivity?.record({
      method: "POST", route: "/tasks/move", ok: true, status: 200,
      summary: `Demande de fusion BlastWin (2e confirmation) pour ${clip(row.title, 120)}`,
      mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
    });
  }

  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // Fusionne la branche agent/<id> dans le vrai dépôt BlastWin (à appeler seulement après la 2e confirmation).
  // Rollback si la revérification est rouge : arbre propre avant → `reset --merge` vers le HEAD d'avant (garde les
  // modifications qui seraient apparues entre-temps) ; arbre NON propre → `revert -m 1` (jamais de reset --hard, les
  // modifications non commitées de Philippe ne sont jamais touchées).
  async function doBlastwinMerge(row) {
    const project = row.project;
    const id = row.id;
    const branch = blastBranch(row);
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const tagName = `pre-merge/${id}-${stamp}`;
    const mandateActive = () => Boolean(ctx.agentMode?.getState?.().enabled);
    let preHead = null;
    let merged = false;
    try {
      const status = git(project, "status", "--porcelain");
      const treeWasClean = !status.trim();
      preHead = git(project, "rev-parse", "HEAD").trim();
      git(project, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      git(project, "tag", tagName, preHead);
      try {
        git(project, "merge", "--no-ff", branch, "-m", `Fusion BlastWin ${id} (T48)`);
      } catch (e) {
        // Conflit ou fichiers locaux qui gênent : on annule la fusion en cours, le dépôt reste comme avant.
        try { git(project, "merge", "--abort"); } catch { /* pas de fusion en cours */ }
        throw e;
      }
      merged = true;
      const verdict = await verifyBlastwinTask(row, project);
      if (verdict.passed) {
        ctx.agentActivity?.record({
          method: "POST", route: "/tasks/merge", ok: true, status: 200,
          summary: `Fusion BlastWin effectuée pour ${row.title} : tag ${tagName}, merge --no-ff, revérification verte`,
          mandateActive: mandateActive(),
        });
        ctx.inbox?.add({
          kind: "fin", host: row.host, taskId: row.id,
          title: `BlastWin : fusion effectuée : ${row.title}`,
          body: `Fusion --no-ff de la branche ${branch} dans le vrai dépôt BlastWin effectuée. Tag : ${tagName}. Revérification verte. Aucun push GitHub n'a été fait par l'agent.`,
          status: "nouveau", source: "t48-blastwin-merge",
        });
        return { ok: true, merged: true, rolledBack: false, tag: tagName };
      }
      // Revérification rouge : retour arrière.
      let how;
      if (treeWasClean) {
        git(project, "reset", "--merge", preHead);
        how = "reset --merge";
      } else {
        try { git(project, "revert", "-m", "1", "--no-edit", "HEAD"); }
        catch (e) { try { git(project, "revert", "--abort"); } catch { /* rien à annuler */ } throw e; }
        how = "revert -m 1";
      }
      ctx.agentActivity?.record({
        method: "POST", route: "/tasks/merge", ok: false, status: 400,
        summary: `Fusion BlastWin annulée (rollback ${how}) pour ${row.title} : revérification rouge`,
        mandateActive: mandateActive(),
      });
      ctx.inbox?.add({
        kind: "erreur", host: row.host, taskId: row.id,
        title: `BlastWin : fusion annulée (rollback) : ${row.title}`,
        body: `La revérification après fusion a échoué. Retour arrière effectué (${how}, tag ${tagName}). Vos modifications non commitées n'ont pas été touchées.\n${shorten(verdict.output, 2000)}`,
        status: "nouveau", source: "t48-blastwin-merge",
      });
      return { ok: false, merged: false, rolledBack: true, how, tag: tagName, reason: "revérification rouge après fusion" };
    } catch (e) {
      const msg = String(e.stderr || e.message || e).replace(/^Erreur\s*:\s*/, "").trim();
      ctx.agentActivity?.record({
        method: "POST", route: "/tasks/merge", ok: false, status: 500,
        summary: `Échec de la fusion BlastWin pour ${row.title}${merged ? " (fusion faite, rollback impossible : à traiter à la main)" : ""} : ${shorten(msg, 200)}`,
        mandateActive: mandateActive(),
      });
      ctx.inbox?.add({
        kind: "erreur", host: row.host, taskId: row.id,
        title: `BlastWin : fusion en échec : ${row.title}`,
        body: `${msg}\n${merged ? `La fusion a été faite mais le retour arrière a échoué : restaurer avec le tag ${tagName}.` : "Aucune modification du dépôt BlastWin."}`.slice(0, 1500),
        status: "nouveau", source: "t48-blastwin-merge",
      });
      return { ok: false, merged, error: msg, preHead };
    }
  }

  // Décision de Philippe sur une demande BlastWin (confirmation de démarrage ou de fusion).
  // Réservée à l'interface : un appel interne (ctx.invoke, donc l'API agent) est refusé, l'agent ne peut pas s'auto-approuver.
  const isHuman = (ws) => !String(ws?._uiId ?? "").startsWith("invoke:");
  on("blastwin.decide", async (ws, m) => {
    if (!isHuman(ws)) return sendError(ws, "Seul Philippe (l'interface) peut décider d'une demande BlastWin.");
    const item = ctx.inbox?.list({ kind: "permission" }).find((i) => i.id === m.id);
    const kind = item?.action?.kind;
    if (!item || (kind !== "blastwin-confirm" && kind !== "blastwin-merge")) return sendError(ws, "Demande BlastWin inconnue.");
    if (item.status === "traité") return sendError(ws, "Demande déjà traitée.");
    const allow = m.approve === true;
    item.action.decision = allow ? "allow" : "deny";
    ctx.inbox.mark([item.id], "traité");
    ctx.agentActivity?.record({
      method: "WS", route: "blastwin.decide", ok: true, status: 200,
      summary: `BlastWin : ${kind === "blastwin-merge" ? "fusion" : "démarrage"} ${allow ? "autorisé" : "refusé"} par Philippe : ${clip(item.title, 120)}`,
      mandateActive: Boolean(ctx.agentMode?.getState?.().enabled),
    });
    send(ws, { type: "blastwin.decided", id: item.id, kind, approved: allow });
    if (!allow) return;
    const row = rowById(item.action.taskId);
    if (!row) return;
    if (kind === "blastwin-confirm") await startRow(ws, row);
    else send(ws, { type: "task.merged", id: row.id, ...(await runApprovedMerge(row)) });
  });

  // Une fusion n'est possible que s'il existe une approbation humaine de la 2e confirmation, utilisable une seule fois.
  async function runApprovedMerge(row) {
    const item = ctx.inbox?.list({ kind: "permission" }).find((i) =>
      i.action?.kind === "blastwin-merge" && i.action?.taskId === row.id &&
      i.status === "traité" && i.action?.decision === "allow" && !i.action?.consumed);
    if (!item) return { ok: false, error: "fusion non autorisée : aucune approbation de Philippe" };
    item.action.consumed = true;
    return doBlastwinMerge(row);
  }

  on("task.merge", async (ws, m) => {
    const row = need(m.id);
    if (!isBlastwinProject(row.project)) return sendError(ws, "fusion réservée aux projets BlastWin protégés");
    send(ws, { type: "task.merged", id: row.id, ...(await runApprovedMerge(row)) });
  });

  // Accès pour les scripts de vérification (les vraies fonctions, pas une copie).
  ctx.blastwin = { verifyBlastwinTask, doBlastwinMerge, runApprovedMerge, doBlastwinBackup, findWorktreePath };

  // ---------- Chaînes d'agents et démarrage automatique (T40) ----------
  const SILENT = { readyState: 3 }; // faux client : le démarrage automatique n'a personne à qui répondre
  const OWN_REASON = /^(Chaîne arrêtée|En attente de la machine)/; // raisons posées (et retirées) par advance()
  const REST_REASON = /^Tous les moteurs sont au repos/;
  const MAX_DONE_TRIES = 40; // ~100 s d'hôte injoignable avant d'abandonner le passage automatique en « Terminé »
  // Tâches de chaîne arrivées « À valider » par la synchronisation (id -> essais) : elles passeront « Terminé » seules.
  const pendingDone = new Map(
    rowsOf().filter((r) => r.chain && r.status === "review" && !r.error).map((r) => [r.id, 0]));
  let advancing = false;
  let again = false;

  function place(id, status, fields = {}) {
    const from = rowById(id).status;
    transaction(() => {
      const target = column(status).map((r) => r.id).filter((x) => x !== id);
      target.push(id);
      patch(id, { status, ...fields });
      renumber(status, target);
      if (from !== status) renumber(from, column(from).map((r) => r.id));
    });
  }

  function scheduleAdvance() {
    setImmediate(() => advance().catch((error) => ctx.log("tasks", `chaînes : ${safeError(error)}`)));
  }
  async function advance() {
    if (advancing) { again = true; return; }
    advancing = true;
    try {
      do {
        again = false;
        await advanceOnce();
      } while (again);
    } finally {
      advancing = false;
    }
  }

  async function advanceOnce() {
    const changed = [];
    // 1. Un maillon arrivé « À valider » (session au repos, sans erreur ni permission) passe « Terminé ».
    for (const [id, tries] of [...pendingDone]) {
      const row = rowById(id);
      if (!row || row.status !== "review" || row.error || !row.agent_id) { pendingDone.delete(id); continue; }
      const agent = await liveAgent(row);
      if (!agent) {
        if (tries + 1 >= MAX_DONE_TRIES) pendingDone.delete(id); else pendingDone.set(id, tries + 1);
        continue;
      }
      if (agent.status !== "idle") { pendingDone.delete(id); continue; } // la session a repris : l'humain décide
      if ((agent.pendingPermissions || []).length || rowById(id)?.status !== "review") continue;
      place(id, "done", { permission: 0, reason: "" });
      pendingDone.delete(id);
      changed.push(id);
    }
    // 2. Une tâche de chaîne en erreur ou bloquée arrête la chaîne : les suivantes attendent, avec la raison.
    const rows = rowsOf();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const failed = new Map();
    for (const r of rows) {
      if (r.chain && !failed.has(r.chain) && (r.status === "blocked" || (r.status === "doing" && r.error))) failed.set(r.chain, r);
    }
    // 3. Une tâche « démarrage automatique » dont toutes les dépendances sont terminées démarre seule.
    for (const queued of rows.filter((r) => r.status === "todo" && (r.chain || r.autostart === 1 || r.retry_at))) {
      let row = rowById(queued.id);
      if (!row || row.status !== "todo") continue;
      const stop = row.chain ? failed.get(row.chain) : null;
      const waiting = depsOf(row).some((d) => byId.has(d) && rowById(d)?.status !== "done");
      const entry = hosts.get(row.host);
      const down = !waiting && !stop && row.autostart === 1 && (!entry || !entry.connected());
      // T44 : « Tous les moteurs sont au repos » : reprise à retry_at ; passé ce délai, la raison est retirée.
      const resting = row.retry_at && Date.parse(row.retry_at) > Date.now();
      let reason = row.reason;
      if (stop) reason = `Chaîne arrêtée : ${stop.title} a échoué`;
      else if (down) reason = `En attente de la machine ${row.host}`;
      else if (resting) reason = `Tous les moteurs sont au repos, reprise vers ${clock(row.retry_at)}`;
      else if (OWN_REASON.test(reason) || (row.retry_at && REST_REASON.test(reason))) reason = "";
      if (reason !== row.reason || (!resting && row.retry_at)) {
        patch(row.id, { reason, ...(resting ? {} : { retry_at: "" }) });
        changed.push(row.id);
      }
      if (stop || waiting || down || resting || row.autostart !== 1 || busy.has(row.id)) continue;
      row = rowById(row.id);
      if (row?.status !== "todo") continue;
      try {
        await startRow(SILENT, row);
      } catch (error) {
        if (error instanceof Resting) continue; // tous les moteurs au repos : la tâche attend sa reprise
        const message = error instanceof UserError ? error.message : safeError(error);
        if (rowById(row.id)?.status !== "todo") continue; // démarrée ou déplacée entre-temps
        place(row.id, "blocked", {
          permission: 0, error: "", reason: shorten(`Démarrage automatique impossible : ${message}`, 300),
        });
        changed.push(row.id);
      }
    }
    if (changed.length) emit([...new Set(changed)]);
  }

  // ---------- Synchronisation avec les agents ----------
  async function lastReply(entry, agentId) {
    try {
      const done = await within(entry.daemon.waitForFinish(agentId, 4000), 9000);
      if (done?.lastMessage) return shorten(done.lastMessage);
    } catch {
      // repli sur le fil d'activité
    }
    try {
      const page = await within(entry.api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 40 }));
      const items = (page.entries || []).map((e) => e.item).filter((i) => i?.type === "assistant_message");
      if (items.length) return shorten(items.at(-1).text);
    } catch {
      // pas de résumé disponible
    }
    return "";
  }

  // T44 : une session tombée en 402/429/quota met son moteur (celui réellement utilisé) au repos. Renvoie vrai si
  // la tâche peut être relancée une fois avec un autre moteur.
  function engineFailed(row, text) {
    if (!ctx.quota || !row || ctx.quota.classify(text) === "other") return false;
    const used = row.run_engine || wanted(row);
    if (used) ctx.quota.noteFailure(used, text);
    return row.fb_tries < 1;
  }
  const relaunchIds = [];
  const relaunching = new Set();
  // Une seule relance automatique, avec le moteur de repli, journalisée dans la raison ; jamais de boucle.
  async function relaunchAfterFailure(id) {
    const row = rowById(id);
    if (!row || row.status !== "doing" || row.fb_tries >= 1 || busy.has(id) || relaunching.has(id)) return;
    const pick = ctx.quota?.pickEngine(wanted(row), row.role, { agentsOnly: !isSelfHost(row.host) });
    if (!pick?.engine) return; // aucun moteur disponible : l'erreur reste visible sur la carte
    relaunching.add(id);
    try {
      const cause = row.error;
      place(id, "todo", { permission: 0, error: "", reason: "", retry_at: "", fb_tries: 1 });
      try {
        const prefix = "Relance automatique après une erreur de quota (402/429). ";
        await startRow(SILENT, rowById(id), { relaunch: true, prefix });
      } catch (error) {
        if (rowById(id)?.status !== "todo") return;
        const message = error instanceof UserError ? error.message : safeError(error);
        const reason = shorten(`Relance automatique impossible : ${message} (erreur : ${cause})`, 300);
        place(id, "blocked", { permission: 0, error: "", reason });
        emit([id]);
      }
    } finally {
      relaunching.delete(id);
    }
  }

  async function syncHost(label, tasks) {
    const entry = hosts.get(label);
    if (!entry || !entry.connected()) {
      if (process.env.TASKS_DEBUG) ctx.log("tasks", `hôte ${label} non connecté`);
      return [];
    }
    let list;
    try {
      list = await within(entry.api.agents.list({}));
    } catch (error) {
      if (process.env.TASKS_DEBUG) ctx.log("tasks", `liste des agents de ${label} : ${safeError(error)}`);
      return [];
    }
    const byId = new Map((list.entries || []).map((row) => [(row.agent || row).id, row.agent || row]));
    const changed = [];
    for (const row of tasks) {
      if (busy.has(row.id) || rowById(row.id)?.status !== "doing") continue;
      let agent = byId.get(row.agent_id);
      if (!agent) {
        // Absent de la liste (page tronquée, archivé…) : on interroge l'agent lui-même avant de conclure.
        try {
          agent = (await within(entry.api.agents.ref(row.agent_id).refresh()))?.agent ?? null;
        } catch (error) {
          if (!/not found|introuvable|unknown/i.test(String(error?.message))) continue;
          agent = null;
        }
      }
      if (!agent || agent.archivedAt || agent.status === "closed") {
        const reason = !agent ? "session perdue" : agent.archivedAt ? "session archivée" : "session fermée";
        patch(row.id, { status: "blocked", permission: 0, reason });
        changed.push(row.id);
        continue;
      }
      if (process.env.TASKS_DEBUG) ctx.log("tasks", `sync ${row.id.slice(0, 8)} agent=${agent.status} pending=${(agent.pendingPermissions || []).length} busy=${busy.has(row.id)}`);
      const waiting = (agent.pendingPermissions || []).length > 0;
      if (waiting) {
        if (!row.permission) {
          patch(row.id, { permission: 1 });
          changed.push(row.id);
        }
        continue;
      }
      const fields = {};
      if (row.permission) fields.permission = 0;
      if (agent.status === "error") {
        const message = shorten(agent.lastError || "L'agent a signalé une erreur", 300);
        if (row.error !== message) {
          fields.error = message;
          if (engineFailed(rowById(row.id), agent.lastError || message)) relaunchIds.push(row.id);
        }
      } else if (agent.status === "idle") {
        const summary = await lastReply(entry, row.agent_id);
        Object.assign(fields, { status: "review", summary: summary || "(aucune réponse de l'agent)", error: "" });
      } else if (row.error) {
        fields.error = "";
      }
      if (Object.keys(fields).length) {
        if (fields.status === "review") {
          transaction(() => {
            const target = column("review").map((r) => r.id).filter((id) => id !== row.id);
            target.push(row.id);
            patch(row.id, fields);
            renumber("review", target);
            renumber("doing", column("doing").map((r) => r.id));
          });
          if (row.chain) pendingDone.set(row.id, 0);
          // T44 : avis automatique indicatif, calculé en arrière-plan (jamais bloquant, échec silencieux).
          try {
            ctx.reviewbadge?.note({ id: row.id, title: row.title, summary: fields.summary, at: now() });
          } catch { /* sans importance */ }
        } else {
          patch(row.id, fields);
        }
        changed.push(row.id);
      }
    }
    return changed;
  }

  let syncing = false;
  async function sync() {
    if (syncing) { if (process.env.TASKS_DEBUG) ctx.log("tasks", "sync déjà en cours"); return; }
    syncing = true;
    try {
      if (fingerprint() !== seen) emit();
      const doing = column("doing").filter((r) => r.agent_id);
      const labels = [...new Set(doing.map((r) => r.host))];
      const changed = [];
      for (const label of labels) {
        changed.push(...await syncHost(label, doing.filter((r) => r.host === label)));
      }
      if (changed.length) emit(changed);
      for (const id of relaunchIds.splice(0)) {
        relaunchAfterFailure(id).catch((error) => ctx.log("tasks", `relance : ${safeError(error)}`));
      }
      scheduleAdvance(); // filet de sécurité : machine revenue, hôte injoignable lors du dernier essai
    } catch (error) {
      ctx.log("tasks", `synchronisation : ${safeError(error)}`);
    } finally {
      syncing = false;
    }
  }
  setInterval(sync, POLL_MS).unref();
  setTimeout(sync, 1500).unref();
  reconcileFreebuff();
  seen = fingerprint();
  ctx.log("tasks", `base : ${db.location?.() || "brain.sqlite"} (${rowsOf().length} tâche(s))`);
}
