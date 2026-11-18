// Pont Composio pour le poste de commande.
// Rôle : décider QUEL agent peut utiliser QUELLE application, avec QUEL compte connecté, et journaliser.
// Aucun secret n'est stocké ici : la session Composio reste dans ~/.composio (hors dépôt).
// Politique : COMPOSIO_POLICY_FILE ou $DASHBOARD_DATA_DIR/composio-policy.json (403/600 conseillé).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BIN = () => process.env.COMPOSIO_BIN || "composio";
export const DATA_DIR = () => process.env.DASHBOARD_DATA_DIR || join(homedir(), "paseo-dash-data");
export const POLICY_FILE = () => process.env.COMPOSIO_POLICY_FILE || join(DATA_DIR(), "composio-policy.json");
export const AUDIT_FILE = () => join(DATA_DIR(), "composio-audit.jsonl");

export function identity(env = process.env) {
  return String(env.COMPOSIO_AGENT || env.POSTECTL_AGENT || env.AGENT_NAME || "anonymous").slice(0, 40);
}

export function loadPolicy() {
  let raw;
  try {
    raw = readFileSync(POLICY_FILE(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`politique illisible (${POLICY_FILE()}) : ${e.message}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error(`politique invalide (JSON) : ${e.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("politique invalide : objet attendu");
  return value;
}

// GMAIL_FETCH_EMAILS -> gmail ; GITHUB_CREATE_AN_ISSUE -> github.
export function toolkitOf(slug) {
  return String(slug || "")
    .split("_")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const WRITE = /SEND|CREATE|UPDATE|DELETE|REMOVE|MODIFY|UPLOAD|PUBLISH|INVITE|ARCHIVE|TRASH|WRITE|POST_MESSAGE|EXECUTE/;
export function isWriteSlug(slug) {
  return WRITE.test(String(slug || "").toUpperCase());
}

// Les toolkits Composio sont parfois des noms collés (googlesheets, googlecalendar)
// parfois des noms à soulignés (google_sheets). On reconnaît le plus long préfixe
// autorisé dans le slug, plutôt que de se fier au seul premier segment.
function inferToolkit(slug, allowed) {
  const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const target = norm(slug);
  let best = "";
  for (const candidate of allowed) {
    const key = norm(candidate);
    if (key && target.startsWith(key) && key.length > norm(best).length) best = candidate;
  }
  return best;
}

export function deny(reason, code = "denied") {
  return { allowed: false, reason, code };
}

/**
 * Décision centrale. `action` : search | schema | dry-run | execute | link | run.
 * `confirm` ne peut venir que de l'appelant autorisé (CLI --confirm / MCP confirm:true).
 * Le compte connecté est choisi par l'administrateur dans la politique, jamais par l'agent.
 */
export function decide(policy, agent, { action, slug = "", toolkit = "", confirm = false } = {}) {
  if (!policy) {
    return deny("aucune politique configurée : copier deploy/oracle/composio-policy.example.json vers " + POLICY_FILE());
  }
  const defaults = policy.defaults && typeof policy.defaults === "object" ? policy.defaults : {};
  const specific = policy.agents?.[agent] || policy.agents?.["*"] || {};
  const rule = { ...defaults, ...specific };
  const toolkits = Array.isArray(rule.toolkits) ? rule.toolkits : [];

  const blocked = [...(Array.isArray(policy.deniedSlugs) ? policy.deniedSlugs : []), ...(Array.isArray(rule.deniedSlugs) ? rule.deniedSlugs : [])];
  if (slug && blocked.includes(slug)) return deny(`slug interdit par la politique : ${slug}`, "forbidden_slug");

  // Un toolkit déduit naïvement ("google" pour GOOGLESHEETS_...) peut être corrigé
  // par le préfixe autorisé le plus long. Le compte est alors résolu sur le bon toolkit.
  if (slug && !toolkits.includes("*")) {
    const inferred = inferToolkit(slug, toolkits);
    if (inferred && (!toolkit || !toolkits.includes(toolkit))) toolkit = inferred;
  }

  if (action !== "search") {
    if (!toolkit && !toolkits.length && !toolkits.includes("*"))
      return deny(`agent « ${agent} » : aucune application autorisée`, "toolkit_denied");
    // Un script (`run`) peut traverser plusieurs applications : le toolkit est alors déclaré
    // par l'appelant et vérifié, mais n'est pas obligatoire.
    if (!toolkit && action !== "run") return deny("application indéterminée (impossible de déduire le toolkit du slug)", "unknown_toolkit");
    if (toolkit && !toolkits.includes("*") && !toolkits.includes(toolkit)) {
      return deny(`agent « ${agent} » : accès à l'application « ${toolkit} » non autorisé`, "toolkit_denied");
    }
  } else if (!toolkits.length && !toolkits.includes("*")) {
    return deny(`agent « ${agent} » : aucune application autorisée`, "toolkit_denied");
  }

  if (action === "execute" && isWriteSlug(slug)) {
    if (rule.writes !== true) return deny(`agent « ${agent} » : opérations d'écriture non autorisées`, "write_denied");
    if (confirm !== true) return deny("opération d'écriture : confirm_required", "confirm_required");
  }
  if (action === "link") {
    if (rule.link !== true) return deny(`agent « ${agent} » : connexion de compte non autorisée`, "link_denied");
    if (confirm !== true) return deny("connexion d'un compte : confirm_required", "confirm_required");
  }
  if (action === "run") {
    if (rule.scripts !== true) return deny(`agent « ${agent} » : scripts Composio non autorisés`, "script_denied");
    if (confirm !== true) return deny("exécution d'un script : confirm_required", "confirm_required");
  }

  const account = rule.accounts?.[toolkit] || policy.accounts?.[agent]?.[toolkit] || null;
  return { allowed: true, rule, account, toolkits, toolkit };
}

export function redact(value) {
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) return value.map(redact);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return String(value)
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/gi, "$1…")
    .replace(/(ghp_[A-Za-z0-9]{4})[A-Za-z0-9]+/gi, "$1…")
    .replace(/([0-9]{6,9}:AA)[A-Za-z0-9_-]+/g, "$1…")
    .replace(/(password|token|secret|api[_-]?key|authorization)(["' ]*[:=]["' ]*)([^\s"',}]{4})[^\s"',}]*/gi, "$1$2$3…")
    .slice(0, 20000);
}

export function runComposio(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(BIN(), args, { stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: -1, output: e.message, json: null, transient: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: redact(e.message), json: null, transient: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = (stdout || stderr).trim();
      let json = null;
      try {
        json = redact(JSON.parse(raw));
      } catch {
        /* sortie texte */
      }
      resolve({ ok: code === 0, code, output: redact(raw), json, transient: code === 75 });
    });
  });
}

// Journal : métadonnées seulement. Jamais de charge utile, jamais de jeton.
export function audit(entry) {
  try {
    mkdirSync(DATA_DIR(), { recursive: true });
    const safe = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v === undefined || k === "data" || k === "output") continue;
      safe[k] = typeof v === "string" ? redact(v).slice(0, 200) : v;
    }
    appendFileSync(AUDIT_FILE(), JSON.stringify({ at: new Date().toISOString(), ...safe }) + "\n");
  } catch {
    /* la journalisation ne doit jamais empêcher l'action */
  }
}

export function readAudit(limit = 20) {
  try {
    const lines = readFileSync(AUDIT_FILE(), "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(200, limit))).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: redact(l).slice(0, 200) };
      }
    });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
