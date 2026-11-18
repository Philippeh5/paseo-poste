// Administration du pont Composio depuis la page « Connexions » : comptes connectés (lecture), matrice agent × application
// (écriture par l'opérateur seulement). `link` et `scripts` ne peuvent JAMAIS être accordés d'ici : ils restent réservés
// à l'édition manuelle du fichier de politique. Écriture atomique en 600, autres champs (deniedSlugs, accounts) préservés.
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const policyFile = (dataDir) => process.env.COMPOSIO_POLICY_FILE || join(dataDir || join(homedir(), "paseo-dash-data"), "composio-policy.json");
export const DENY_ALL = { toolkits: [], writes: false, link: false, scripts: false };
const AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const TOOLKIT_RE = /^[a-z0-9]{1,40}$/;

export const normToolkit = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

export function readPolicy(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw new Error("Politique Composio illisible : corrigez le fichier à la main."); }
}
function writePolicy(file, policy) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// Comptes connectés : { toolkit, count, active } seulement (pas d'identifiants de compte).
export function listAccounts(run = defaultRun) {
  return run(["connections", "list"]).then((out) => {
    const data = JSON.parse(out);
    return Object.entries(data).map(([k, v]) => ({ toolkit: normToolkit(k), name: k, count: v.length, active: v.filter((a) => a.status === "ACTIVE").length }))
      .sort((a, b) => a.toolkit.localeCompare(b.toolkit));
  });
}
function defaultRun(args) {
  return new Promise((resolve, reject) => {
    execFile(process.env.COMPOSIO_BIN || "composio", args, { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (e, stdout) => (e ? reject(new Error("CLI Composio indisponible ou non connecté.")) : resolve(String(stdout))));
  });
}

export function summarize(policy) {
  if (!policy) return { exists: false, agents: [] };
  const agents = Object.entries(policy.agents || {}).map(([name, r]) => ({
    name, toolkits: Array.isArray(r.toolkits) ? r.toolkits : [], writes: !!r.writes, link: !!r.link, scripts: !!r.scripts }));
  return { exists: true, agents };
}

// Crée la politique « tout refusé » si absente ; ne remplace jamais une politique existante.
export function ensurePolicy(file) {
  if (readPolicy(file)) return false;
  writePolicy(file, { defaults: { ...DENY_ALL }, agents: { "*": { ...DENY_ALL } } });
  return true;
}

export function setAgent(file, { agent, toolkits, writes }) {
  if (!AGENT_RE.test(String(agent))) throw new Error("Nom d'agent invalide (minuscules, chiffres, - et _).");
  if (!Array.isArray(toolkits) || toolkits.length > 50 || !toolkits.every((t) => TOOLKIT_RE.test(String(t)))) throw new Error("Liste d'applications invalide (le joker * n'est pas accordé depuis la page).");
  const policy = readPolicy(file) || { defaults: { ...DENY_ALL }, agents: { "*": { ...DENY_ALL } } };
  policy.agents = policy.agents || {};
  const prev = policy.agents[agent] || {};
  policy.agents[agent] = { ...prev, toolkits: [...new Set(toolkits)], writes: !!writes, link: !!prev.link, scripts: !!prev.scripts };
  writePolicy(file, policy);
  return summarize(policy);
}
export function removeAgent(file, agent) {
  const policy = readPolicy(file);
  if (!policy?.agents || agent === "*" || !(agent in policy.agents)) return summarize(policy);
  delete policy.agents[agent];
  writePolicy(file, policy);
  return summarize(policy);
}
