#!/usr/bin/env node
// Modèles gratuits d'OpenRouter et modèles hébergés NVIDIA : liste en ligne, vérification des alias de claude-openrouter / claude-nvidia,
// et test réel optionnel (un tout petit appel par modèle). Ne modifie JAMAIS les settings.json.
//   node tools/free-models.mjs                 liste + validité des alias actuels
//   node tools/free-models.mjs --test          + un appel réel (« pong ») par modèle gratuit retenu et par alias
//   node tools/free-models.mjs --json          sortie JSON
// Les clés sont lues dans ~/.claude-openrouter/settings.json (jamais affichées).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const TEST = args.has("--test");
const JSON_OUT = args.has("--json");
const ROUTERS = /^openrouter\/(auto|free|fusion|pareto)|auto-beta|fusion|pareto-code/i; // coût affiché 0 mais peuvent router vers du payant
const ALIASES = ["SONNET", "OPUS", "HAIKU", "FABLE"];

const readEnv = (dir) => {
  try { return JSON.parse(readFileSync(join(homedir(), dir, "settings.json"), "utf8")).env || {}; } catch { return {}; }
};
const fetchJson = async (url, init = {}, ms = 20000) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms), headers: { "user-agent": "paseo-free-models/1", ...(init.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: r.status, body };
};

const openrouterFree = async () => {
  const { status, body } = await fetchJson("https://openrouter.ai/api/v1/models");
  if (status !== 200) throw new Error(`OpenRouter ${status}`);
  return body.data
    .filter((m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && !ROUTERS.test(m.id) && (m.architecture?.output_modalities || ["text"]).join() === "text")
    .map((m) => ({ id: m.id, ctx: m.context_length, tools: (m.supported_parameters || []).includes("tools") }));
};
const nvidiaHosted = async () => {
  const { status, body } = await fetchJson("https://integrate.api.nvidia.com/v1/models");
  if (status !== 200) throw new Error(`NVIDIA ${status}`);
  return body.data.map((m) => m.id);
};

// Appel minimal au format Anthropic (celui que Claude Code utilise) via la passerelle du fournisseur.
const ping = async (env, model) => {
  const base = String(env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "");
  const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || "";
  if (!base) return { ok: false, why: "pas d'URL" };
  const t0 = Date.now();
  try {
    const { status, body } = await fetchJson(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(key ? { authorization: `Bearer ${key}`, "x-api-key": key } : {}) },
      body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "user", content: "Réponds exactement : pong" }] }),
    }, 60000);
    const text = Array.isArray(body?.content) ? body.content.map((c) => c.text || c.thinking || "").join("").trim() : "";
    const err = body?.error?.message || (typeof body === "string" ? body : "");
    return { ok: status === 200 && text.length > 0, status, ms: Date.now() - t0, why: status === 200 ? (text ? "" : "réponse vide") : String(err).slice(0, 90) };
  } catch (e) { return { ok: false, why: e.name === "TimeoutError" ? "délai dépassé" : e.message.slice(0, 90) }; }
};

const [orFree, nvAll] = await Promise.all([openrouterFree(), nvidiaHosted()]);
const orEnv = readEnv(".claude-openrouter");
const nvEnv = readEnv(".claude-nvidia");
const orIds = new Set(orFree.map((m) => m.id));
const nvIds = new Set(nvAll);

const alias = (env, label, isValid) => ALIASES.map((a) => {
  const raw = env[`ANTHROPIC_DEFAULT_${a}_MODEL`];
  const model = typeof raw === "string" ? raw.slice(0, 120) : "";
  return { provider: label, alias: a.toLowerCase(), model, valid: isValid(model) };
});
const rows = [
  ...alias(orEnv, "claude-openrouter", (m) => orIds.has(m)),
  ...alias(nvEnv, "claude-nvidia", (m) => nvIds.has(m)),
];
if (TEST) {
  for (const r of rows) Object.assign(r, { ping: r.model ? await ping(r.provider === "claude-openrouter" ? orEnv : nvEnv, r.model) : { ok: false, why: "aucun modèle" } });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ openrouterFree: orFree, nvidiaHosted: nvAll, aliases: rows }, null, 2));
} else {

console.log(`OpenRouter — ${orFree.length} modèle(s) gratuit(s) (routeurs exclus) ; ✓ = appels d'outils déclarés`);
for (const m of orFree.sort((a, b) => a.id.localeCompare(b.id))) console.log(`  ${m.tools ? "✓" : "·"} ${m.id}  (ctx ${m.ctx})`);
console.log(`\nNVIDIA hébergé — ${nvAll.length} modèle(s) au catalogue public (le catalogue ne dit pas lesquels sont gratuits) ; extrait utile :`);
for (const id of nvAll.filter((i) => /nemotron|kimi|glm|deepseek|gpt-oss|laguna/i.test(i)).sort()) console.log(`  ${id}`);
console.log("\nAlias actuels (lus dans ~/.claude-*/settings.json) :");
for (const r of rows) {
  const p = r.ping ? (r.ping.ok ? `  appel OK (${r.ping.ms} ms)` : `  appel KO : ${r.ping.status || ""} ${r.ping.why}`) : "";
  const kind = r.provider === "claude-openrouter" ? "gratuit ?" : "au catalogue ?";
  console.log(`  ${r.valid ? "✓" : "✗"} ${r.provider.padEnd(18)} ${r.alias.padEnd(7)} ${r.model || "(vide)"}  [${kind} ${r.valid ? "oui" : "non"}]${p}`);
}
if (!TEST) console.log("\n(ajoute --test pour un appel réel par alias)");
}
