// Utilitaires partagés du transfert vers Oracle et de la reprise automatique (T10).
// Fonctions pures (chemins, branches, rédaction des secrets, invite de reprise) + machine d'états du failover.
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ORACLE_DISK_FREE = 193 * 1024 ** 3; // valeur de repli si la mesure est impossible
export const MIN_ORACLE_FREE_REQUIRED = 2 * 1024 ** 3; // 2 Go minimum doivent rester après le clone
export const ORACLE_PROJECTS_ROOT = "/home/USERNAME/projets";
export const TRANSFER_BRANCH_RE = /^(transfert|reprise)\/\d{8}-\d{4}$/;

// ---------- Chemins ----------
// Dernier élément d'un chemin Windows ou POSIX.
export function folderName(dir) {
  if (!dir) return "";
  return String(dir).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

// Forme canonique pour comparer deux chemins du même disque (casse et séparateurs ignorés).
export function normDir(dir) {
  return String(dir || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// D:\Projets\X -> /home/USERNAME/projets/X ("" si le dossier est vide).
export function translateProjectPath(dir) {
  const name = folderName(dir).replace(/[^A-Za-z0-9._ -]/g, "_");
  return name ? `${ORACLE_PROJECTS_ROOT}/${name}` : "";
}

// ---------- Branches ----------
export function formatDateStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function isMainOrMaster(branch) {
  const b = String(branch || "").trim().toLowerCase().replace(/^refs\/(heads|remotes\/origin)\//, "");
  return b === "main" || b === "master" || b.endsWith("/main") || b.endsWith("/master");
}

// transfert/AAAAMMJJ-HHMM ou reprise/AAAAMMJJ-HHMM, jamais autre chose.
export function isTransferBranch(branch) {
  return TRANSFER_BRANCH_RE.test(String(branch || "")) && !isMainOrMaster(branch);
}

export function assertTransferBranch(branch) {
  if (!isTransferBranch(branch)) {
    throw new Error(`Branche refusée : ${String(branch).slice(0, 80)} (seules transfert/<date> et reprise/<date> sont permises).`);
  }
  return branch;
}

export function makeBranchName(prefix = "transfert", date = new Date()) {
  if (prefix !== "transfert" && prefix !== "reprise") throw new Error("Préfixe de branche interdit.");
  return assertTransferBranch(`${prefix}/${formatDateStamp(date)}`);
}

// ---------- Secrets ----------
const SECRET_KEY = /pass(word|wd)?|token|secret|api[-_]?key|authorization|credential|bearer/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const copy = {};
    for (const [k, v] of Object.entries(value)) copy[k] = SECRET_KEY.test(k) && typeof v === "string" ? "[secret masqué]" : redact(v);
    return copy;
  }
  if (typeof value !== "string") return value;
  return value
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, "[jeton masqué]")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret masqué]")
    .replace(/\/\/[^/@\s]+@/g, "//")
    .replace(/(pass(?:word|wd)?|token|secret|api[-_]?key)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"'}]+)/gi, "$1$2[secret masqué]");
}

// Fichiers qu'il ne faut jamais committer dans une branche de transfert.
const SENSITIVE_FILE =
  /(^|\/)(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|pfx|p12|key|keystore)|credentials(\.json)?|hosts\.json|.*password.*\.txt|\.npmrc|\.netrc)$/i;
export function sensitivePaths(porcelainLines) {
  const out = [];
  for (const line of porcelainLines || []) {
    const path = String(line).slice(3).replace(/^"|"$/g, "").replace(/.* -> /, "");
    if (SENSITIVE_FILE.test(path.replace(/\\/g, "/"))) out.push(path);
  }
  return out;
}

// ---------- Exécution de commandes ----------
export function run(cmd, args, { cwd, timeout = 60000, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd, args,
      { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } },
      (error, stdout, stderr) => {
        if (error) {
          const e = new Error(redact(String(stderr || error.message)).trim().slice(0, 600));
          e.code = error.code;
          reject(e);
        } else resolve(String(stdout).replace(/\s+$/, ""));
      },
    );
  });
}
export const git = (dir, args, options) => run("git", ["-C", dir, ...args], options);

// ---------- Invite de reprise ----------
export function buildResumePrompt({
  task, branch, lastCommit = null, modifiedFiles = [], errors = "", targetSystem = "Linux (Ubuntu)", targetDir: dir,
}) {
  const targetDir = dir || translateProjectPath(task.project) || "(aucun dossier de projet)";
  const files = (modifiedFiles || []).map((f) => `- ${typeof f === "string" ? f : f.path || f}`).slice(0, 40);
  return [
    `# Reprise de tâche sur ${targetSystem}`,
    `Tâche : ${task.title || "(sans titre)"} (id : ${task.id})`,
    `Système cible : ${targetSystem} (chemins POSIX, fins de ligne LF)`,
    `Dossier du projet : ${targetDir}`,
    `Branche de travail : ${branch}`,
    `Dernier commit : ${lastCommit || "(inconnu)"}`,
    "",
    "## Fichiers modifiés au moment du transfert",
    files.length ? files.join("\n") : "(aucun)",
    "",
    "## Erreurs récentes de la tâche",
    errors ? String(errors).slice(0, 1500) : "(aucune)",
    "",
    "## Consignes",
    `- Vous êtes maintenant sur ${targetSystem} : les chemins Windows d'origine sont remplacés par ${targetDir}.`,
    `- Travaillez sur la branche ${branch} ; ne poussez jamais sur main ni master.`,
    "- Objectif d'origine de la tâche :",
    task.description || task.title || "",
  ].join("\n");
}

// ---------- Taille estimée d'un dossier (hors node_modules) ----------
export function estimateDiskNeeded(dir, { maxDepth = 6, maxFiles = 10000 } = {}) {
  let total = 0;
  let count = 0;
  const walk = (current, depth) => {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= maxFiles) return;
      const full = join(current, entry.name);
      try {
        if (entry.isFile()) {
          count += 1;
          total += statSync(full).size;
        } else if (entry.isDirectory() && entry.name !== "node_modules") walk(full, depth + 1);
      } catch { /* inaccessible : ignoré */ }
    }
  };
  walk(dir, 0);
  return Math.max(total, 1024 * 1024);
}

// ---------- Machine d'états du failover (pure) ----------
// État : { status, consecutiveFailures, firstFailureAt, lastSuccessAt, lastPingAt, resumedTasks, resumeError }.
// Événements : ping_success, ping_failure, resume_start, resume_done {tasks}, resume_failed {error},
//              reclaim_start, reclaim_done. `config` : { thresholdMinutes (5), minPings (3) }.
export function nextFailoverState(state, event, config = {}, now = Date.now()) {
  const thresholdMs = (Number.isFinite(config.thresholdMinutes) ? config.thresholdMinutes : 5) * 60000;
  const minPings = Number.isInteger(config.minPings) && config.minPings > 0 ? config.minPings : 3;
  const status = state.status || "monitoring";
  const resumedTasks = Array.isArray(state.resumedTasks) ? state.resumedTasks : [];
  const keep = (patch) => ({ ...state, resumedTasks, ...patch });

  switch (event.type) {
    case "ping_success": {
      const alive = { consecutiveFailures: 0, firstFailureAt: null, lastSuccessAt: now, lastPingAt: now };
      if (status === "idle") return keep({ lastPingAt: now });
      if (status === "resumed") return keep({ ...alive, status: "reclaim_available" });
      if (status === "resume_failed") {
        return keep({ ...alive, status: resumedTasks.length ? "reclaim_available" : "monitoring" });
      }
      if (status === "suspect" || status === "unreachable") return keep({ ...alive, status: "monitoring" });
      return keep(alive); // monitoring, resuming, reclaim_available, reclaiming : le statut ne change pas
    }
    case "ping_failure": {
      if (status === "idle") return keep({ lastPingAt: now });
      const failures = (state.consecutiveFailures ?? 0) + 1;
      const first = state.firstFailureAt ?? now;
      const counted = { consecutiveFailures: failures, firstFailureAt: first, lastPingAt: now };
      if (status === "monitoring" && failures >= minPings) return keep({ ...counted, status: "suspect" });
      if (status === "suspect" && failures >= minPings && now - first >= thresholdMs) {
        return keep({ ...counted, status: "unreachable" });
      }
      if (status === "reclaim_available" && failures >= minPings) return keep({ ...counted, status: "resumed" });
      return keep(counted);
    }
    case "resume_start":
      return status === "unreachable" ? keep({ status: "resuming", resumeError: null }) : state;
    case "resume_done": {
      if (status !== "resuming") return state;
      const merged = [...resumedTasks];
      for (const t of event.tasks || []) if (!merged.some((x) => x.id === t.id)) merged.push(t);
      return keep({ status: merged.length ? "resumed" : "unreachable", resumedTasks: merged });
    }
    case "resume_failed":
      return status === "resuming" ? keep({ status: "resume_failed", resumeError: String(event.error || "échec de reprise") }) : state;
    case "reclaim_start":
      return status === "reclaim_available" ? keep({ status: "reclaiming" }) : state;
    case "reclaim_done":
      return status === "reclaiming"
        ? keep({ status: "monitoring", consecutiveFailures: 0, firstFailureAt: null, lastSuccessAt: now, resumedTasks: [] })
        : state;
    default:
      return state;
  }
}
