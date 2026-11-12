// Rapport de fin de mission (T42) : quand la tâche orchestrateur de Jarvis (origine « agent », titre
// « Jarvis — <projet> ») passe en « À valider », « Terminé » ou en erreur, le poste écrit UN rapport clair (projet,
// mission, tâches filles, fichiers modifiés, verdicts des relecteurs, prochaine étape) et l'ajoute UNE fois à la
// boîte de réception (ctx.inbox.add, clé « mission:<runId> » ; la boîte coupe le corps à 600 caractères, le texte
// complet reste ici).
// Mémoire : data/mission-reports.json via ctx.store (50 derniers rapports). Aucune écriture ailleurs.
// Messages WS : missionreport.get {runId?} -> missionreport.data {runId, report, reports[]}.
// REST (si ctx.apiRoute) : GET /api/v1/mission-reports?runId= .
// Exposé : ctx.missionReports.list() / .get(runId) / .sync().
// Git : lecture seule (`git status --porcelain`, `git diff --stat`) par execFile, sans shell, 5 s, 30 lignes au plus.
// Aucun mot de passe, jeton ni chemin hors projet dans le rapport (lib/redact.mjs puis masquage des chemins).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { redact } from "../lib/redact.mjs";
import { telegramSend } from "../lib/notify.mjs";

import { SELF_HOST, SELF_LABEL, isSelfHost } from "../lib/selfhost.mjs";
const FILE = "mission-reports";
export const MAX_REPORTS = 50;
export const MAX_TEXT = 2000;
const MAX_GIT_LINES = 30;
const GIT_TIMEOUT_MS = 5000;
const ERROR_GRACE_MS = Number(process.env.MISSIONREPORT_ERROR_GRACE_MS ?? 60000);
const LABELS = { todo: "À faire", doing: "En cours", review: "À valider", done: "Terminé", blocked: "Bloquée" };
const ROLES = { writer: "rédacteur", reader: "lecteur", planner: "planificateur" };
const OUTCOMES = { review: "À valider", done: "Terminé", error: "Erreur" };
const ORCHESTRATOR_TITLE = /^Jarvis\s+[—–-]\s/;
const VERDICT = /^[\s*`#>_-]*(?:verdict\s*:?\s*)?(PASS_WITH_NOTES|PASS|FAIL)\b/i;

const slashes = (value) => String(value ?? "").replace(/\\/g, "/");
const folderName = (dir) => slashes(dir).replace(/\/+$/, "").split("/").pop() || "";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Masque secrets (redact) puis chemins : le dossier du projet devient son nom, tout autre chemin absolu est masqué.
export function scrub(value, projectDir = "") {
  let s = redact(String(value ?? ""));
  const root = slashes(projectDir).replace(/\/+$/, "");
  if (root) {
    const pattern = root.split("/").map(escapeRe).join("[\\\\/]");
    s = s.replace(new RegExp(`${pattern}(?=$|[\\\\/\\s"'),.;:])`, "gi"), folderName(root) || "projet");
  }
  return s
    .replace(/(?<![\w])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|*?]+/g, "[chemin hors projet]")
    .replace(/(?<=^|[\s("'=])\/(?:[\w.@~+-]+\/)+[\w.@~+-]*/g, "[chemin hors projet]")
    .replace(/(?<=^|[\s("'=])~\/[\w./@+-]*/g, "[chemin hors projet]");
}

// Première ligne d'un relecteur : PASS / FAIL / PASS_WITH_NOTES (ou rien).
export function verdictOf(summary) {
  const m = VERDICT.exec(String(summary ?? "").trim());
  return m ? m[1].toUpperCase() : null;
}

// Issue de la tâche orchestrateur : "review" | "done" | "error" | null (pas fini, ou arrêtée par Philippe).
export function outcomeOf(task, { errorForMs = 0, graceMs = ERROR_GRACE_MS } = {}) {
  if (!task) return null;
  if (task.status === "review" || task.status === "done") return task.status;
  if (task.status === "blocked") {
    return /arrêtée manuellement|déplacée manuellement/i.test(task.reason || "") ? null : "error";
  }
  if (task.status === "doing" && task.error) return errorForMs >= graceMs ? "error" : null;
  return null;
}

// Texte de la mission : consigne du mandat, sinon extraite de la consigne de l'orchestrateur.
export function missionOf(run, orchestrator) {
  if (run?.brief) return run.brief;
  const m = /MISSION DE PHILIPPE[^\n]*\n([\s\S]*?)\n\s*\nORGANISATION/.exec(orchestrator?.description || "");
  return m ? m[1].trim() : "(mission non précisée)";
}

export function nextStep({ outcome, tasks, verdicts, changed }) {
  if (outcome === "error") {
    return "Ouvrir la tâche de Jarvis (vue Tâches) pour voir l'erreur, puis la relancer ou reprendre la main.";
  }
  const failing = tasks.filter((t) => t.status === "blocked" || t.error);
  if (failing.length) {
    const what = failing.length === 1 ? "la tâche en échec" : `les ${failing.length} tâches en échec`;
    return `Regarder ${what} : ${failing[0].title}.`;
  }
  const fail = verdicts.find((v) => v.verdict === "FAIL");
  if (fail) {
    return `La relecture « ${fail.title} » a répondu FAIL : faire corriger les points relevés, puis la relancer.`;
  }
  const open = tasks.filter((t) => t.status === "todo" || t.status === "doing");
  if (open.length) {
    const what = open.length === 1 ? "la tâche" : `les ${open.length} tâches`;
    return `Attendre ou relancer ${what} encore ouverte(s) : ${open[0].title}.`;
  }
  const waiting = tasks.filter((t) => t.status === "review");
  if (waiting.length) {
    const what = waiting.length === 1 ? "la tâche" : `les ${waiting.length} tâches`;
    return `Valider ${what} « À valider » dans la vue Tâches.`;
  }
  if (changed > 0 && !verdicts.length) {
    return "Relire les fichiers modifiés (git diff) avant de valider : aucune relecture n'a été faite.";
  }
  return "Valider le travail terminé, puis reprendre la main si tout est bon.";
}

// Texte du rapport (2000 caractères au plus). Ordre pensé pour que le début reste lisible si la boîte le coupe.
export function reportText(r) {
  const lines = [
    `Statut : ${OUTCOMES[r.outcome] || r.outcome}${r.at ? ` · ${r.at.slice(0, 16).replace("T", " ")} UTC` : ""}`,
    `Mission : ${clip(r.mission, 300)}`,
    `Prochaine étape : ${r.next}`,
    `Tâches (${r.tasks.length}) :`,
    ...r.tasks.slice(0, 12).map((t) => {
      const who = `${t.roleLabel}${t.engine ? `, ${t.engine}` : ""}`;
      return `- [${t.statusLabel}] ${clip(t.title, 80)} (${who})${t.summary ? ` : ${clip(t.summary, 160)}` : ""}`;
    }),
  ];
  if (r.tasks.length > 12) lines.push(`- … et ${r.tasks.length - 12} autre(s)`);
  if (r.files.note) lines.push(`Fichiers modifiés : ${r.files.note}`);
  else {
    const names = r.files.changed.slice(0, 10).map((l) => l.trim()).join(", ") || "aucun";
    lines.push(`Fichiers modifiés (${r.files.changed.length}) : ${names}`);
    if (r.files.stat.length) lines.push(`Bilan : ${r.files.stat.at(-1).trim()}`);
  }
  lines.push(r.verdicts.length
    ? `Relecture : ${r.verdicts.map((v) => `${clip(v.title, 60)} → ${v.verdict}`).join(" ; ")}`
    : "Relecture : aucun verdict PASS/FAIL trouvé.");
  const text = lines.join("\n");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

// Message Telegram court de fin de mission : ce qui a été fait, ce qui reste (pas le rapport complet, qui va dans la boîte).
export function telegramText(r) {
  const icon = r.outcome === "error" ? "⛔" : r.outcome === "review" ? "🔎" : "✅";
  const ok = r.tasks.filter((t) => t.status === "done").length, review = r.tasks.filter((t) => t.status === "review").length;
  const bad = r.tasks.filter((t) => t.status === "blocked" || t.error).length, open = r.tasks.filter((t) => t.status === "todo" || t.status === "doing").length;
  const parts = [ok && `${ok} terminée(s)`, review && `${review} à valider`, bad && `${bad} en échec`, open && `${open} encore ouverte(s)`].filter(Boolean);
  const nFiles = r.files?.changed?.length || 0;
  return [
    `${icon} ${r.project} — ${OUTCOMES[r.outcome] || r.outcome} : ${clip(r.mission, 140)}`,
    `Fait : ${parts.join(", ") || "rien de mesurable"}${nFiles ? ` · ${nFiles} fichier(s) modifié(s)` : ""}`,
    `➡️ Reste : ${r.next}`,
  ].join("\n");
}

// ---------- Git en lecture seule ----------
function git(dir, args) {
  const full = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-C", dir, ...args];
  return new Promise((resolve) => {
    execFile("git", full, {
      timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error) {
        const notRepo = /not a git repository/i.test(String(stderr));
        const why = error.code === "ENOENT" ? "git n'est pas installé"
          : error.killed ? "git a dépassé le délai de 5 s"
            : notRepo ? "ce dossier n'est pas un dépôt git" : "git n'a pas pu lire ce dossier";
        return resolve({ error: why, lines: [] });
      }
      resolve({ error: null, lines: String(stdout).split(/\r?\n/).filter((l) => l.trim()) });
    });
  });
}

async function filesOf(dir, host) {
  if (host && !isSelfHost(host)) return { changed: [], stat: [], note: "non disponible pour une machine distante." };
  // Jamais de chemin réseau (UNC) : git ne doit pas aller toucher un partage distant.
  if (!dir || !isAbsolute(dir) || /^[\\/]{2}/.test(dir) || !existsSync(dir)) {
    return { changed: [], stat: [], note: "dossier du projet introuvable." };
  }
  const [status, diff] = await Promise.all([
    git(dir, ["status", "--porcelain"]),
    git(dir, ["diff", "--stat", "--no-ext-diff", "--no-textconv"]),
  ]);
  if (status.error) return { changed: [], stat: [], note: `${status.error}.` };
  const cap = (lines) => (lines.length > MAX_GIT_LINES
    ? [...lines.slice(0, MAX_GIT_LINES - 1), ` … ${lines.length - MAX_GIT_LINES + 1} ligne(s) de plus`] : lines);
  return { changed: cap(status.lines), stat: diff.error ? [] : cap(diff.lines), note: "" };
}

export function register(ctx) {
  const { onMessage, send, store, log } = ctx;

  const saved = store.read(FILE, null);
  let data = {
    since: typeof saved?.since === "string" ? saved.since : new Date().toISOString(),
    reports: Array.isArray(saved?.reports) ? saved.reports.filter((r) => r && typeof r.runId === "string") : [],
    runs: saved?.runs && typeof saved.runs === "object" && !Array.isArray(saved.runs) ? saved.runs : {},
  };
  const persist = () => {
    data.reports = data.reports.slice(0, MAX_REPORTS);
    const runIds = Object.keys(data.runs);
    if (runIds.length > MAX_REPORTS) {
      runIds.sort((a, b) => String(data.runs[a].since).localeCompare(String(data.runs[b].since)));
      for (const id of runIds.slice(0, runIds.length - MAX_REPORTS)) delete data.runs[id];
    }
    try { store.write(FILE, data); } catch (e) { log("missionreport", `écriture impossible : ${ctx.safeError(e)}`); }
  };
  if (!saved) persist();

  const errorSince = new Map(); // taskId -> premier instant où l'erreur a été vue
  let checking = null;

  // Mémorise le mandat actif (consigne, projet, orchestrateur) : il disparaît quand Philippe reprend la main.
  function trackMandate() {
    const m = ctx.agentMode?.getState?.();
    if (!m?.enabled || !m.runId) return;
    const before = JSON.stringify(data.runs[m.runId] || null);
    const run = data.runs[m.runId] || { since: m.since || new Date().toISOString() };
    Object.assign(run, {
      brief: m.brief || run.brief || null, project: m.project || run.project || null,
      projectDir: m.projectDir || run.projectDir || null, host: m.projectHost || run.host || null,
      orchestratorTaskId: m.orchestratorTaskId || run.orchestratorTaskId || null,
    });
    data.runs[m.runId] = run;
    if (JSON.stringify(run) !== before) persist();
  }

  async function listTasks() {
    const result = await ctx.invoke("task.list", {});
    return result.replies.find((r) => r.type === "tasks")?.tasks || [];
  }

  async function buildReport(runId, orchestrator, children, outcome) {
    const run = data.runs[runId] || {};
    const dir = orchestrator.project || run.projectDir || "";
    const host = orchestrator.host || run.host || "local";
    const S = (value, max) => clip(scrub(value, dir), max);
    const project = S(run.project || orchestrator.projectName || folderName(dir) || "projet", 120);
    const tasks = children.map((t) => ({
      id: t.id, title: S(t.title, 120), role: t.role, roleLabel: ROLES[t.role] || t.role, engine: S(t.engine, 80),
      status: t.status, statusLabel: LABELS[t.status] || t.status, error: S(t.error, 160),
      summary: S(String(t.summary || "").split(/\n\s*\n/)[0], 220),
    }));
    const verdicts = children
      .filter((t) => t.role === "reader")
      .map((t) => ({ title: S(t.title, 80), verdict: verdictOf(t.summary) }))
      .filter((v) => v.verdict);
    const files = await filesOf(dir, host);
    files.changed = files.changed.map((l) => S(l, 200));
    files.stat = files.stat.map((l) => S(l, 200));
    const report = {
      runId, at: new Date().toISOString(), outcome, project, host,
      mission: S(missionOf(run, orchestrator), 600),
      orchestrator: {
        id: orchestrator.id, title: S(orchestrator.title, 120), status: orchestrator.status,
        summary: S(orchestrator.summary || orchestrator.error || orchestrator.reason, 400),
      },
      tasks, files, verdicts, inboxed: false,
    };
    report.next = S(nextStep({ outcome, tasks, verdicts, changed: files.changed.length }), 300);
    report.text = reportText(report);
    return report;
  }

  function sendToInbox(report) {
    if (!ctx.inbox) return;
    try {
      ctx.inbox.add({
        kind: "fin", title: `Jarvis a terminé : ${report.project}`, body: report.text, source: "agent",
        key: `mission:${report.runId}`, taskId: report.orchestrator.id, project: report.project, host: report.host,
      });
      report.inboxed = true;
      telegramSend(telegramText(report)).catch(() => {});
    } catch (e) {
      log("missionreport", `boîte de réception : ${ctx.safeError(e)}`);
    }
  }

  async function runCheck() {
    trackMandate();
    const tasks = await listTasks();
    const byRun = new Map();
    for (const t of tasks) {
      if (t.origin !== "agent" || !t.agentRun) continue;
      if (!byRun.has(t.agentRun)) byRun.set(t.agentRun, []);
      byRun.get(t.agentRun).push(t);
    }
    const alive = new Set(tasks.map((t) => t.id));
    for (const id of errorSince.keys()) if (!alive.has(id)) errorSince.delete(id);
    let dirty = false;
    for (const [runId, list] of byRun) {
      if (data.reports.some((r) => r.runId === runId)) continue;
      const known = data.runs[runId]?.orchestratorTaskId;
      const orchestrator = list.find((t) => t.id === known) ||
        list.filter((t) => ORCHESTRATOR_TITLE.test(t.title)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!orchestrator) continue;
      if (orchestrator.status === "doing" && orchestrator.error) {
        if (!errorSince.has(orchestrator.id)) errorSince.set(orchestrator.id, Date.now());
      } else errorSince.delete(orchestrator.id);
      const since = errorSince.get(orchestrator.id) ?? Date.now();
      const outcome = outcomeOf(orchestrator, { errorForMs: Date.now() - since });
      if (!outcome || String(orchestrator.updatedAt) < data.since) continue;
      const report = await buildReport(runId, orchestrator, list.filter((t) => t.id !== orchestrator.id), outcome);
      if (data.reports.some((r) => r.runId === runId)) continue; // doublon pendant la lecture git
      data.reports.unshift(report);
      persist();
      sendToInbox(report);
      dirty = true;
      log("missionreport", `rapport ${runId.slice(0, 8)} (${outcome}) pour ${report.project}`);
    }
    for (const report of data.reports) if (!report.inboxed) { sendToInbox(report); dirty = dirty || report.inboxed; }
    if (dirty) persist();
  }
  function check() {
    if (!checking) {
      checking = runCheck()
        .catch((e) => log("missionreport", `vérification : ${ctx.safeError(e)}`))
        .finally(() => { checking = null; });
    }
    return checking;
  }

  const light = (r) => ({ runId: r.runId, at: r.at, outcome: r.outcome, project: r.project, host: r.host,
    title: `Jarvis a terminé : ${r.project}`, inboxed: r.inboxed === true });
  ctx.missionReports = {
    list: () => data.reports.map((r) => ({ ...r })),
    get: (runId) => {
      const found = data.reports.find((r) => r.runId === runId);
      return found ? { ...found } : null;
    },
    sync: check,
  };

  onMessage("missionreport.get", async (ws, m) => {
    await check();
    const runId = typeof m.runId === "string" ? m.runId : null;
    const report = runId ? ctx.missionReports.get(runId) : ctx.missionReports.list()[0] || null;
    send(ws, { type: "missionreport.data", runId, report, reports: data.reports.map(light), ref: m.ref ?? null });
  });

  ctx.apiRoute?.("GET", "/mission-reports", async ({ query }) => {
    await check();
    const runId = query.get("runId");
    return runId ? { report: ctx.missionReports.get(runId) } : { reports: data.reports.map(light) };
  });

  ctx.onStateChange(() => { check(); });
  setTimeout(check, 3000).unref();
}
