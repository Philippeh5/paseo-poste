#!/usr/bin/env node
// postectl : pilote le poste de commande depuis un terminal ou un agent, via l'API /api/v1 (sans dépendance).
// URL : POSTECTL_URL (défaut http://127.0.0.1:7070) ; mot de passe : POSTECTL_PASSWORD ; acteur : POSTECTL_AGENT.
// Codes de sortie : 0 succès, 1 refus ou erreur de l'API, 2 mauvais usage, 3 poste injoignable ou accès refusé.
import { loadIdentity } from "./coord-lib.mjs";

const HELP = `postectl : pilote le poste de commande (API locale /api/v1)

Usage : postectl [options] <commande> [arguments]

Lecture
  summary                          vue d'ensemble : machines, sessions, tâches, boîte de réception, permissions
  sessions [--host H] [--project P] [--status S]   liste des sessions (S : active, waiting, idle, error)
  session show <hôte> <id>         détail d'une session et derniers messages
  tasks [--status S] [--project P]  liste des tâches (S : todo, doing, review, done, blocked)
  mandate                          mandat confié à l'agent (projet, consigne, interdictions)
  decide <état> [--choice nom=opt1,opt2]... [--yesno "question ?"]... [--questions JSON]
                                   tranche une décision avec Laya (petit modèle local) ; JAMAIS comme seul garde-fou
  inbox [--unread]                 boîte de réception
  projects                         projets suivis
  agents                           agents de base disponibles (plan, review, dev, test…) à utiliser avec task add --profile
  scrollback <hôte> <terminal> [--lines N]   dernières lignes d'un terminal
  report <id>                      compte rendu COMPLET de la tâche (le résumé de la carte est coupé à 500 caractères)
  wait <id> [--timeout S]          attend la fin de la tâche puis affiche le compte rendu (code 0 ok, 1 bloquée, 2 délai)
  watch                            suit en direct les changements (flux SSE, Ctrl+C pour quitter)

Actions sur les sessions
  session close <hôte> <id>        arrête puis archive la session
  session close-many --confirm <hôte>:<id> ...   ferme plusieurs sessions (confirmation obligatoire)
  session send <hôte> <id> <texte>   envoie un message à la session
  session allow|deny <hôte> <id> <requestId>     répond à une demande de permission

Actions sur les tâches
  task add <titre> [--project DOSSIER] [--engine fournisseur/modèle] [--host H] [--mode M]
                   [--description TEXTE] [--isolation local|worktree] [--branch B] [--role writer|reader|planner]
                   [--idea ID_IDÉE]       (lie la tâche à une idée VALIDÉE : une seule tâche active par idée)
                   [--profile ID_AGENT]   (agent de base : sa consigne, son rôle et son moteur sont appliqués)
  task edit <id> [--title T] [--project DOSSIER] [--engine F/M] [--description T] [--mode M] [--host H] [--branch B] [--role R]
  task move <id> <todo|doing|review|done|blocked>
  task start|stop|close|restart <id>
  task notify <id> <hôte:session>  à la fin de la tâche, le poste envoie le compte rendu complet à cette session (--off pour annuler ;
                                   aussi : task add ... --notify hôte:session)
  task delete <id> --confirm       supprime la tâche (confirmation obligatoire)

Code avec FreeBuff (gratuit mais limité en heures de session ; ne jamais valider « take over » ; un seul FreeBuff à la fois)
  freebuff --project DOSSIER --prompt "TEXTE" [--wait N] [--terminal ID] [--async]
                                   confie une tâche de code à FreeBuff dans un projet suivi du Mini PC et attend la fin
                                   (N : 10 à 240 secondes, 180 par défaut). Le terminal reste ouvert dans le Bureau.
                                   Code de sortie 0 = terminé, 1 = non terminé ou refus. À relire ensuite soi-même.

Autonomie et idées (le cerveau PROPOSE ; seul Philippe valide, sur le site)
  autonomy                         mode (off/ideas/auto) et battement de chaque projet
  ideas [--status pending|approved|refused|done|obsolete]   liste des idées
  idea add <titre> --project DOSSIER [--body TEXTE]   propose une idée (Philippe est notifié)
  idea done <id>                   marque faite une idée DÉJÀ validée par Philippe
  idea obsolete <id> --why TEXTE   retire une de TES idées encore EN ATTENTE parce qu'elle est déjà faite (raison visible dans le Cockpit)

Boîte de réception et projets
  inbox approve|refuse <id> [--confirm]   répond à une demande de permission (--confirm si dangereuse)
  inbox mark <id>... | inbox mark --all [--status lu|traité]
  project follow|unfollow <hôte> <dossier>

Options
  --json            sortie JSON brute (pour les agents)
  --url URL         adresse du poste (sinon POSTECTL_URL, sinon http://127.0.0.1:7070)
  --help, -h        cette aide

Les identifiants de tâche peuvent être abrégés (au moins 6 caractères).
Mot de passe : variable POSTECTL_PASSWORD (utilisateur admin). Chaque écriture est journalisée côté poste.
`;

class UsageError extends Error {}
class ApiFailure extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const valued = new Set([
    "host",
    "project",
    "status",
    "url",
    "engine",
    "mode",
    "description",
    "isolation",
    "branch",
    "role",
    "profile",
    "idea",
    "why",
    "lines",
    "name",
    "choice",
    "yesno",
    "questions",
    "prompt",
    "wait",
    "body",
    "notify",
    "timeout",
  ]);
  const repeatable = new Set(["choice", "yesno"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split(/=(.*)/s);
      if (valued.has(key)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`--${key} attend une valeur`);
        if (repeatable.has(key)) (flags[key] ??= []).push(value);
        else flags[key] = value;
      } else flags[key] = inline ?? true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const pad = (text, width) => {
  const s = String(text ?? "");
  return s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width);
};
const table = (rows, columns) => {
  if (!rows.length) return "(aucun)";
  const lines = [columns.map((c) => pad(c.title, c.width)).join("  ")];
  for (const row of rows) lines.push(columns.map((c) => pad(c.get(row), c.width)).join("  "));
  return lines.join("\n");
};
const TASK_LABEL = { todo: "À faire", doing: "En cours", review: "À valider", done: "Terminé", blocked: "Bloquée" };
const COLUMNS = ["todo", "doing", "review", "done", "blocked"];

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.help || !positional.length) {
    process.stdout.write(HELP);
    return positional.length || flags.help ? 0 : 2;
  }
  const base = String(flags.url || process.env.POSTECTL_URL || "http://127.0.0.1:7070").replace(/\/+$/, "");
  const password = process.env.POSTECTL_PASSWORD || "";
  const headers = { "X-Agent-Name": process.env.POSTECTL_AGENT || "postectl" };
  if (password) headers.Authorization = `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  const coord = loadIdentity(process.env);
  if (coord.token && coord.agentId) { // identité de session : le poste peut prévenir cette session (freebuff --async)
    headers["X-Coord-Host"] = coord.host;
    headers["X-Coord-Agent"] = coord.agentId;
    headers["X-Coord-Token"] = coord.token;
  }
  const json = flags.json === true;

  async function api(method, path, body) {
    let response;
    try {
      response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiFailure(`poste injoignable (${base}) : ${e.cause?.code || e.message}`, 0, "unreachable");
    }
    if (response.status === 401)
      throw new ApiFailure("accès refusé : définissez POSTECTL_PASSWORD", 401, "unauthorized");
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* corps non JSON */
    }
    if (!payload) throw new ApiFailure(`réponse inattendue (HTTP ${response.status})`, response.status, "bad_response");
    if (!payload.ok) throw new ApiFailure(payload.error?.message || "erreur", response.status, payload.error?.code);
    return payload.data;
  }
  const query = (obj) => {
    const q = new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== true));
    return q.size ? `?${q}` : "";
  };
  const out = (data, text) => process.stdout.write(`${json ? JSON.stringify(data, null, 2) : text()}\n`);
  const need = (value, usage) => {
    if (value === undefined || value === "") throw new UsageError(`usage : postectl ${usage}`);
    return value;
  };
  async function taskId(prefix) {
    need(prefix, "task <action> <id>");
    const { tasks } = await api("GET", "/tasks");
    const hits = tasks.filter((t) => t.id === prefix || (prefix.length >= 6 && t.id.startsWith(prefix)));
    if (hits.length !== 1) {
      throw new ApiFailure(
        hits.length ? `identifiant ambigu : ${prefix}` : `tâche introuvable : ${prefix}`,
        404,
        "not_found",
      );
    }
    return hits[0].id;
  }
  const taskLine = (t) => `${t.id.slice(0, 8)}  ${TASK_LABEL[t.status] || t.status}  ${t.title}`;

  const [command, sub, ...rest] = positional;
  switch (command) {
    case "summary": {
      const d = await api("GET", "/summary");
      out(d, () =>
        [
          `Machines : ${d.machines.map((m) => `${m.name} (${m.status})`).join(", ")}`,
          `Sessions : ${d.sessions.total} (actives ${d.sessions.active}, permission ${d.sessions.waitingPermission}, ` +
            `inactives ${d.sessions.idle}, erreur ${d.sessions.error})`,
          `Tâches   : ${COLUMNS.map((k) => `${TASK_LABEL[k]} ${d.tasks[k]}`).join(", ")}`,
          `Réception: ${d.inbox.unread} non lu(s) sur ${d.inbox.total}`,
          `Permissions en attente : ${d.pendingPermissions.length}`,
          ...d.pendingPermissions.map(
            (p) => `  - ${p.host}/${p.sessionId.slice(0, 8)} ${p.sessionTitle || ""} : ${p.title}`,
          ),
          `Projets suivis : ${d.projects.map((p) => p.name).join(", ") || "(aucun)"}`,
        ].join("\n"),
      );
      return 0;
    }
    case "sessions": {
      const d = await api(
        "GET",
        `/sessions${query({ host: flags.host, project: flags.project, status: flags.status })}`,
      );
      out(d, () =>
        table(d.sessions, [
          { title: "HÔTE", width: 8, get: (s) => s.host },
          { title: "ID", width: 8, get: (s) => s.id.slice(0, 8) },
          { title: "STATUT", width: 18, get: (s) => s.status },
          { title: "PROJET", width: 18, get: (s) => s.project },
          { title: "MOTEUR", width: 28, get: (s) => `${s.provider}/${s.model || ""}` },
          { title: "TITRE", width: 40, get: (s) => s.title || "" },
        ]),
      );
      return 0;
    }
    case "session": {
      // Les identifiants affichés par `sessions` sont abrégés (8 caractères) : on les résout, comme pour les tâches.
      if (["show", "close", "send", "allow", "deny"].includes(sub) && rest[0] && rest[1] && rest[1].length >= 6 && rest[1].length < 36) {
        const { sessions } = await api("GET", "/sessions");
        const hits = sessions.filter((s) => s.host === rest[0] && s.id.startsWith(rest[1]));
        if (hits.length > 1) throw new ApiFailure(`identifiant ambigu : ${rest[1]}`, 404, "not_found");
        if (hits.length === 1) rest[1] = hits[0].id;
      }
      if (sub === "show") {
        const d = await api(
          "GET",
          `/sessions/${encodeURIComponent(need(rest[0], "session show <hôte> <id>"))}/` +
            `${encodeURIComponent(need(rest[1], "session show <hôte> <id>"))}`,
        );
        out(
          d,
          () =>
            `${d.session.host}/${d.session.id}  ${d.session.status}  ${d.session.title || ""}\n` +
            d.messages.map((m) => `[${m.type}] ${m.text || m.name || ""}`).join("\n"),
        );
        return 0;
      }
      if (sub === "close") {
        const d = await api(
          "POST",
          `/sessions/${encodeURIComponent(need(rest[0], "session close <hôte> <id>"))}/` +
            `${encodeURIComponent(need(rest[1], "session close <hôte> <id>"))}/close`,
        );
        out(d, () => `session fermée : ${d.host}/${d.id}`);
        return 0;
      }
      if (sub === "close-many") {
        const sessions = rest.map((x) => {
          const i = x.indexOf(":");
          if (i < 1) throw new UsageError("usage : postectl session close-many --confirm <hôte>:<id> ...");
          return { host: x.slice(0, i), id: x.slice(i + 1) };
        });
        const d = await api("POST", "/sessions/close", { sessions, confirm: flags.confirm === true });
        out(d, () =>
          d.results.map((r) => `${r.closed ? "fermée " : "échec  "} ${r.host}/${r.id} ${r.error || ""}`).join("\n"),
        );
        return d.results.every((r) => r.closed) ? 0 : 1;
      }
      if (sub === "send") {
        const text = rest.slice(2).join(" ");
        const d = await api(
          "POST",
          `/sessions/${encodeURIComponent(need(rest[0], "session send <hôte> <id> <texte>"))}/` +
            `${encodeURIComponent(need(rest[1], "session send <hôte> <id> <texte>"))}/send`,
          { text: need(text, "session send <hôte> <id> <texte>") },
        );
        out(d, () => `message envoyé (${d.length} caractères)`);
        return 0;
      }
      if (sub === "allow" || sub === "deny") {
        const usage = `session ${sub} <hôte> <id> <requestId>`;
        const d = await api(
          "POST",
          `/sessions/${encodeURIComponent(need(rest[0], usage))}/${encodeURIComponent(need(rest[1], usage))}` +
            "/permission",
          { requestId: need(rest[2], usage), allow: sub === "allow" },
        );
        out(d, () => `permission ${d.decision === "allow" ? "accordée" : "refusée"}`);
        return 0;
      }
      throw new UsageError("usage : postectl session show|close|close-many|send|allow|deny ...");
    }
    case "tasks": {
      const d = await api("GET", `/tasks${query({ status: flags.status, project: flags.project })}`);
      out(d, () =>
        table(d.tasks, [
          { title: "ID", width: 8, get: (t) => t.id.slice(0, 8) },
          { title: "COLONNE", width: 10, get: (t) => TASK_LABEL[t.status] },
          { title: "PROJET", width: 18, get: (t) => t.projectName },
          { title: "TITRE", width: 50, get: (t) => t.title },
          { title: "NOTE", width: 40, get: (t) => t.error || t.reason || (t.permission ? "permission demandée" : "") },
        ]),
      );
      return 0;
    }
    case "agents": {
      const d = await api("GET", "/profiles");
      out(d, () =>
        table(d.profiles, [
          { title: "ID", width: 12, get: (p) => p.id },
          { title: "NOM", width: 20, get: (p) => p.name },
          { title: "RÔLE", width: 8, get: (p) => p.role },
          { title: "DESCRIPTION", width: 70, get: (p) => p.description },
        ]),
      );
      return 0;
    }
    case "autonomy": {
      const d = await api("GET", "/autonomy");
      out(d, () => Object.entries(d.projects).map(([dir, p]) => `${p.mode.padEnd(6)} ${String(p.heartbeatMin).padStart(4)} min  ${dir}`).join("\n") || "aucun projet configuré (tous en Arrêt)");
      return 0;
    }
    case "ideas": {
      const d = await api("GET", `/ideas${flags.status ? `?status=${encodeURIComponent(flags.status)}` : ""}`);
      out(d, () => table(d.ideas, [
        { title: "ID", width: 9, get: (i) => i.id }, { title: "STATUT", width: 9, get: (i) => i.status },
        { title: "PROJET", width: 16, get: (i) => String(i.project).split("/").pop() }, { title: "TITRE", width: 60, get: (i) => i.title },
      ]));
      return 0;
    }
    case "idea": {
      if (sub === "add") {
        const d = await api("POST", "/ideas", { title: need(rest.join(" "), "idea add <titre> --project DOSSIER [--body TEXTE]"), project: need(flags.project, "--project DOSSIER"), body: flags.body });
        out(d, () => d.duplicate ? `idée déjà connue (${d.idea.id}, ${d.idea.status}) : ${d.idea.title} — rien de créé` : `idée proposée (${d.idea.id}) : ${d.idea.title} — en attente de validation de Philippe`);
        return 0;
      }
      if (sub === "obsolete") {
        const d = await api("POST", `/ideas/${need(rest[0], "idea obsolete <id> --why TEXTE")}/obsolete`, { why: need(flags.why, "--why TEXTE") });
        out(d, () => `idée ${d.idea.id} retirée : ${d.idea.obsoleteWhy}`);
        return 0;
      }
      if (sub === "done") {
        const d = await api("POST", `/ideas/${need(rest[0], "idea done <id>")}/done`, {});
        out(d, () => `idée ${d.idea.id} marquée faite`);
        return 0;
      }
      throw new UsageError("usage : postectl idea add <titre> --project DOSSIER [--body TEXTE] | idea done <id> | idea obsolete <id> --why TEXTE ; valider/refuser : seulement Philippe, sur le site");
    }
    case "task": {
      if (sub === "add") {
        const body = { title: need(rest.join(" "), "task add <titre> [--project ...]") };
        for (const k of ["project", "engine", "host", "mode", "description", "isolation", "branch", "role", "profile"]) {
          if (flags[k] !== undefined) body[k] = flags[k];
        }
        if (body.role !== undefined && !["writer", "reader", "planner"].includes(body.role)) {
          throw new UsageError("--role : writer, reader ou planner");
        }
        // --idea : une idée validée n'a qu'une tâche active ; on vérifie AVANT de créer, puis on lie.
        let idea = null;
        if (flags.idea !== undefined) {
          idea = (await api("GET", `/ideas/${encodeURIComponent(need(flags.idea, "--idea ID_IDÉE"))}`)).idea;
          if (idea.status !== "approved") throw new Error(`l'idée ${idea.id} n'est pas validée (${idea.status})`);
          const old = idea.taskId && (await api("GET", "/tasks")).tasks.find((t) => t.id === idea.taskId);
          if (old && old.status !== "done") throw new Error(`l'idée ${idea.id} a déjà une tâche active : ${old.id.slice(0, 8)} (${old.status}) — ${old.title}`);
        }
        const d = await api("POST", "/tasks", body);
        if (idea) await api("POST", `/ideas/${idea.id}/task`, { task: d.task.id });
        if (flags.notify !== undefined) await api("POST", `/tasks/${d.task.id}/notify`, { session: flags.notify });
        out(d, () => `tâche créée : ${taskLine(d.task)}${idea ? ` (idée ${idea.id})` : ""}`);
        return 0;
      }
      if (sub === "edit") {
        const body = {};
        for (const k of ["title", "project", "engine", "host", "mode", "description", "isolation", "branch", "role"]) {
          if (flags[k] !== undefined) body[k] = flags[k];
        }
        if (body.role !== undefined && !["writer", "reader", "planner"].includes(body.role)) {
          throw new UsageError("--role : writer, reader ou planner");
        }
        if (!Object.keys(body).length) throw new Error("task edit <id> --title|--project|--engine|--description|--mode|--host|--branch|--role ...");
        const d = await api("PATCH", `/tasks/${await taskId(rest[0])}`, body);
        out(d, () => `tâche modifiée : ${taskLine(d.task)}`);
        return 0;
      }
      if (sub === "move") {
        const d = await api("POST", `/tasks/${await taskId(rest[0])}/move`, {
          status: need(rest[1], "task move <id> <colonne>"),
        });
        out(d, () => taskLine(d.task));
        return 0;
      }
      if (["start", "stop", "close", "restart"].includes(sub)) {
        const d = await api("POST", `/tasks/${await taskId(rest[0])}/${sub}`);
        out(d, () => taskLine(d.task));
        return 0;
      }
      if (sub === "notify") {
        const usage = "task notify <id> <hôte:session> | task notify <id> --off";
        const id = await taskId(rest[0]);
        if (flags.off === true) {
          const d = await api("DELETE", `/tasks/${id}/notify`);
          out(d, () => (d.removed ? "demande retirée" : "aucune demande"));
          return 0;
        }
        const d = await api("POST", `/tasks/${id}/notify`, { session: need(rest[1], usage) });
        out(d, () => `à la fin de la tâche, le compte rendu complet sera envoyé à ${d.notify}`);
        return 0;
      }
      if (sub === "delete") {
        const d = await api(
          "DELETE",
          `/tasks/${await taskId(rest[0])}${flags.confirm === true ? "?confirm=true" : ""}`,
        );
        out(d, () => `tâche supprimée : ${d.id}`);
        return 0;
      }
      throw new UsageError("usage : postectl task add|move|start|stop|close|restart|notify|delete ...");
    }
    case "report": {
      const d = await api("GET", `/tasks/${await taskId(sub)}/report`);
      out(d, () => `${d.title} — ${TASK_LABEL[d.status] || d.status} (${d.length} caractères, source : ${d.source})\n\n${d.report}`);
      return 0;
    }
    case "wait": {
      // Bloque jusqu'à ce que la tâche quitte « En cours » (ou jusqu'à --timeout secondes), puis affiche le compte rendu complet.
      const usage = "wait <id> [--timeout SECONDES]";
      const id = await taskId(need(sub, usage));
      const limit = Date.now() + Math.max(5, Number(flags.timeout) || 7200) * 1000;
      for (;;) {
        const { tasks } = await api("GET", "/tasks");
        const t = tasks.find((x) => x.id === id);
        if (!t) throw new ApiFailure(`tâche introuvable : ${id}`, 404, "not_found");
        if (!["doing", "todo"].includes(t.status)) {
          const d = await api("GET", `/tasks/${id}/report`);
          out(d, () => `${d.title} — ${TASK_LABEL[d.status] || d.status}\n\n${d.report}`);
          return d.status === "blocked" ? 1 : 0;
        }
        if (Date.now() > limit) { out({ id, status: t.status, timeout: true }, () => `délai dépassé, la tâche est toujours « ${TASK_LABEL[t.status] || t.status} »`); return 2; }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    case "freebuff-status": {
      const id = need(sub, "freebuff-status JOBID");
      const d = await api("GET", `/freebuff/${encodeURIComponent(id)}`);
      out(d, () => [`FreeBuff ${d.status}`, d.error ? `Erreur : ${d.error}` : null, d.result ? `--- réponse ---\n${d.result.reply || d.result.screenTail || "(vide)"}` : null].filter(Boolean).join("\n"));
      return d.status === "done" ? 0 : d.status === "running" ? 2 : 1;
    }
    case "freebuff": {
      const usage = 'freebuff --project DOSSIER --prompt "TEXTE" [--wait N]';
      if (sub !== undefined) throw new UsageError(`usage : postectl ${usage}`);
      const body = { project: need(flags.project, usage), prompt: need(flags.prompt, usage) };
      if (flags.terminal !== undefined) body.terminalId = String(flags.terminal);
      if (flags.wait !== undefined) {
        const wait = /^\d{1,4}$/.test(String(flags.wait)) ? Number(flags.wait) : NaN;
        if (!(wait >= 10 && wait <= 240)) throw new UsageError("--wait : entier entre 10 et 240 (secondes)");
        body.waitSeconds = wait;
      }
      if (flags.async) {
        const j = await api("POST", "/freebuff", { ...body, async: true });
        out(j, () => `FreeBuff lancé en arrière-plan : ${j.jobId} (état : postectl freebuff-status ${j.jobId})`);
        return 0;
      }
      const d = await api("POST", "/freebuff", body);
      out(d, () =>
        [
          `FreeBuff ${d.completed ? "terminé" : "NON terminé (il travaille peut-être encore : ne pas en relancer un)"}` +
            ` — terminal ${d.terminalId ?? "?"}`,
          d.error ? `Note : ${d.error}` : null,
          `--- réponse ---\n${d.reply || "(vide)"}`,
          `--- fin de l'écran ---\n${d.screenTail}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return d.completed ? 0 : 1;
    }
    case "inbox": {
      if (sub === "approve" || sub === "refuse") {
        const d = await api(
          "POST",
          `/inbox/${encodeURIComponent(need(rest[0], `inbox ${sub} <id>`))}/${sub}`,
          flags.confirm === true ? { confirm: true } : {},
        );
        out(d, () => `permission ${d.decision === "allow" ? "accordée" : "refusée"} (${d.id})`);
        return 0;
      }
      if (sub === "mark") {
        const body = flags.all === true ? { all: true } : { ids: rest };
        if (flags.status) body.status = flags.status;
        const d = await api("POST", "/inbox/mark", body);
        out(d, () => `${d.count} élément(s) marqué(s) « ${d.status} »`);
        return 0;
      }
      const d = await api("GET", `/inbox${query({ unread: flags.unread === true ? "1" : undefined })}`);
      out(
        d,
        () =>
          `${d.unreadCount} non lu(s)\n${table(d.items, [
            { title: "ID", width: 22, get: (i) => i.id },
            { title: "STATUT", width: 8, get: (i) => i.status },
            { title: "TYPE", width: 11, get: (i) => i.kind },
            { title: "HÔTE", width: 8, get: (i) => i.host },
            { title: "TITRE", width: 60, get: (i) => i.title },
          ])}`,
      );
      return 0;
    }
    case "projects": {
      const d = await api("GET", "/projects");
      out(d, () =>
        table(d.projects, [
          { title: "ID", width: 10, get: (p) => p.id },
          { title: "HÔTE", width: 8, get: (p) => p.host },
          { title: "NOM", width: 24, get: (p) => p.name },
          { title: "DOSSIER", width: 60, get: (p) => p.dir },
        ]),
      );
      return 0;
    }
    case "project": {
      if (sub !== "follow" && sub !== "unfollow")
        throw new UsageError("usage : postectl project follow|unfollow <hôte> <dossier>");
      const body = {
        host: need(rest[0], `project ${sub} <hôte> <dossier>`),
        dir: need(rest.slice(1).join(" "), `project ${sub} <hôte> <dossier>`),
      };
      const d = await api("POST", `/projects/${sub}`, body);
      out(d, () => (sub === "follow" ? `projet suivi : ${body.dir}` : `projet retiré : ${body.dir}`));
      return 0;
    }
    case "scrollback": {
      const usage = "scrollback <hôte> <terminal> [--lines N]";
      const d = await api(
        "GET",
        `/terminals/${encodeURIComponent(need(sub, usage))}/${encodeURIComponent(need(rest[0], usage))}` +
          `/scrollback${query({ lines: flags.lines })}`,
      );
      out(d, () => d.lines.join("\n"));
      return 0;
    }
    case "watch": {
      let response;
      try {
        response = await fetch(`${base}/api/v1/events`, { headers });
      } catch (e) {
        throw new ApiFailure(`poste injoignable (${base}) : ${e.cause?.code || e.message}`, 0, "unreachable");
      }
      if (response.status === 401)
        throw new ApiFailure("accès refusé : définissez POSTECTL_PASSWORD", 401, "unauthorized");
      if (!response.ok) throw new ApiFailure(`flux indisponible (HTTP ${response.status})`, response.status, "stream");
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event !== "change" || !data) continue;
          const c = JSON.parse(data);
          const label = `${c.data?.title || c.id}${c.data?.status ? ` [${c.data.status}]` : ""}`;
          process.stdout.write(
            json ? `${data}\n` : `${c.t.slice(11, 19)}  ${c.kind.padEnd(7)} ${c.op.padEnd(6)} ${label}\n`,
          );
        }
      }
      return 0;
    }
    case "mandate": {
      const d = await api("GET", "/mandate");
      out(d, () => {
        if (!d.enabled) return "Mode Agent inactif : aucun mandat en cours.";
        const lines = [
          `Mode Agent actif${d.project ? ` sur ${d.project}` : ""}`,
          d.brief ? `Consigne : ${d.brief}` : null,
          d.forbidden?.length ? `Interdictions : ${d.forbidden.join(", ")}` : "Aucune interdiction.",
        ].filter(Boolean);
        return lines.join("\n");
      });
      return 0;
    }
    case "decide": {
      const usage = 'decide <état> [--choice nom=opt1,opt2] [--yesno "question ?"] [--questions JSON]';
      const questions = {};
      if (flags.questions) {
        try {
          Object.assign(questions, JSON.parse(flags.questions));
        } catch {
          throw new UsageError("--questions : JSON invalide");
        }
      }
      for (const spec of flags.choice || []) {
        const i = spec.indexOf("=");
        const options = spec.slice(i + 1).split(",").map((o) => o.trim()).filter(Boolean);
        if (i < 1 || options.length < 2) throw new UsageError("usage : --choice nom=option1,option2 (2 options au moins)");
        questions[spec.slice(0, i)] = {
          type: "choice",
          instructions: `Quelle option convient pour « ${spec.slice(0, i)} » ?`,
          criteria: Object.fromEntries(options.map((o) => [o, o])),
        };
      }
      (flags.yesno || []).forEach((text, n) => {
        questions[n ? `yesno${n + 1}` : "yesno"] = { type: "noul", instructions: text };
      });
      const d = await api("POST", "/decide", {
        state: need([sub, ...rest].filter((x) => x !== undefined).join(" "), usage),
        questions,
      });
      out(d, () =>
        [
          ...Object.entries(d.answers).map(([name, a]) => {
            if (a?.choice !== undefined) return `${name} : ${a.choice}${typeof (a.answer_confidence ?? a.confidence) === "number" ? ` (confiance ${(a.answer_confidence ?? a.confidence).toFixed(2)})` : ""}`;
            if (typeof a?.noul === "number") return `${name} : ${a.noul >= 0.5 ? "oui" : "non"} (p = ${a.noul.toFixed(2)})`;
            if (typeof a?.score === "number") return `${name} : note ${a.score.toFixed(2)}`;
            return `${name} : ${JSON.stringify(a)}`;
          }),
          `(${d.latencyMs} ms)`,
        ].join("\n"),
      );
      return 0;
    }
    default:
      throw new UsageError(`commande inconnue : ${command} (voir postectl --help)`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
  } else if (e instanceof ApiFailure) {
    process.stderr.write(`erreur : ${e.message}\n`);
    process.exitCode = e.status === 0 || e.status === 401 || e.status === 403 ? 3 : 1;
  } else {
    process.stderr.write(`erreur inattendue : ${e.message}\n`);
    process.exitCode = 1;
  }
}
