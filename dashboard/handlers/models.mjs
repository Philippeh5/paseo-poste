// Modèles derrière les alias de « Claude via OpenRouter » et « Claude via NVIDIA » (opus / sonnet / haiku / fable).
// Lit et écrit ANTHROPIC_DEFAULT_<ALIAS>_MODEL dans ~/.claude-openrouter/settings.json et ~/.claude-nvidia/settings.json de la machine
// où tourne le tableau de bord. Les clés ne quittent jamais le serveur : elles servent seulement à interroger les catalogues en ligne
// et à tester un modèle. OpenRouter n'accepte que des modèles GRATUITS (":free"), comme le reste du projet (quota.mjs).
// Messages : models.get -> models.state ; models.refresh (catalogue) ; models.set {provider, alias, model} -> models.state ;
// models.test {provider, model} -> models.tested {ok, ms, error?}.
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "../lib/redact.mjs";

const ALIASES = ["opus", "sonnet", "haiku", "fable"];
const MODEL_RE = /^[A-Za-z0-9][\w.\-]*(?:\/[\w.\-:@+]+){1,3}$|^[A-Za-z0-9][\w.\-:@+]{1,80}$/;
const CATALOG_TTL_MS = 10 * 60_000;
const PROVIDERS = {
  "claude-openrouter": { label: "Claude via OpenRouter", dir: ".claude-openrouter", catalog: "https://openrouter.ai/api/v1/models", chat: "https://openrouter.ai/api/v1/chat/completions", freeOnly: true },
  "claude-nvidia": { label: "Claude via NVIDIA", dir: ".claude-nvidia", catalog: "https://integrate.api.nvidia.com/v1/models", chat: "https://integrate.api.nvidia.com/v1/chat/completions", freeOnly: false },
};

const fileOf = (id) => join(homedir(), PROVIDERS[id].dir, "settings.json");
const envKey = (alias) => `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
const mask = (t) => redact(String(t ?? ""));

function readSettings(id) {
  const f = fileOf(id);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8"));
}
function secretOf(settings) {
  const e = settings?.env || {};
  return e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY || "";
}

async function fetchCatalog(id, settings) {
  const p = PROVIDERS[id];
  const headers = {};
  const key = secretOf(settings);
  if (key && id === "claude-nvidia") headers.Authorization = `Bearer ${key}`;
  const res = await fetch(p.catalog, { headers, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`catalogue indisponible (HTTP ${res.status})`);
  const data = (await res.json()).data || [];
  if (id === "claude-openrouter") {
    return data
      .filter((m) => String(m.id).endsWith(":free"))
      .map((m) => ({ id: m.id, name: m.name || m.id, context: m.context_length ?? null, tools: (m.supported_parameters || []).includes("tools") }))
      .sort((a, b) => (b.context ?? 0) - (a.context ?? 0));
  }
  return data.map((m) => ({ id: m.id, name: m.id, context: null, tools: null })).sort((a, b) => a.id.localeCompare(b.id));
}

export function register(ctx) {
  const { onMessage, send, sendError } = ctx;
  const catalogs = new Map(); // provider -> { at, items, error }

  const refuseInvoke = (ws) => {
    if (!String(ws?._uiId ?? "").startsWith("invoke:")) return false;
    sendError(ws, "Message réservé à l'interface.");
    return true;
  };

  async function catalogOf(id, force = false) {
    const hit = catalogs.get(id);
    if (!force && hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit;
    let settings = null;
    try { settings = readSettings(id); } catch { /* illisible : catalogue public seulement */ }
    try {
      const items = await fetchCatalog(id, settings);
      const entry = { at: Date.now(), items, error: null };
      catalogs.set(id, entry);
      return entry;
    } catch (e) {
      const entry = { at: Date.now(), items: hit?.items ?? [], error: mask(e?.message || "catalogue indisponible") };
      catalogs.set(id, entry);
      return entry;
    }
  }

  async function state(force = false) {
    const providers = [];
    for (const [id, p] of Object.entries(PROVIDERS)) {
      let settings = null;
      let problem = null;
      try { settings = readSettings(id); } catch (e) { problem = "settings.json illisible"; }
      const cat = await catalogOf(id, force);
      providers.push({
        id, label: p.label, freeOnly: p.freeOnly, available: Boolean(settings), problem,
        aliases: Object.fromEntries(ALIASES.map((a) => [a, settings?.env?.[envKey(a)] ?? null])),
        catalog: cat.items, catalogError: cat.error, catalogAt: new Date(cat.at).toISOString(),
      });
    }
    return { type: "models.state", providers };
  }

  onMessage("models.get", async (ws, m) => { send(ws, { ...(await state(false)), ref: m.ref ?? null }); });
  onMessage("models.refresh", async (ws, m) => { if (refuseInvoke(ws)) return; send(ws, { ...(await state(true)), ref: m.ref ?? null }); });

  onMessage("models.set", async (ws, m) => {
    if (refuseInvoke(ws)) return;
    try {
      const id = String(m.provider ?? "");
      const alias = String(m.alias ?? "");
      const model = String(m.model ?? "").trim();
      if (!Object.hasOwn(PROVIDERS, id)) throw new Error("fournisseur inconnu");
      if (!ALIASES.includes(alias)) throw new Error("alias inconnu");
      if (!MODEL_RE.test(model) || model.length > 120) throw new Error("nom de modèle invalide");
      const p = PROVIDERS[id];
      const cat = await catalogOf(id);
      const known = cat.items.some((x) => x.id === model);
      if (p.freeOnly && !model.endsWith(":free")) throw new Error("OpenRouter : seuls les modèles gratuits (:free) sont acceptés");
      if (cat.items.length && !known) throw new Error("modèle absent du catalogue : actualise la liste");
      const file = fileOf(id);
      const settings = readSettings(id);
      if (!settings) throw new Error(`${p.dir}/settings.json introuvable`);
      const backup = `${file}.bak-modeles`;
      if (!existsSync(backup)) copyFileSync(file, backup);
      settings.env = { ...(settings.env || {}), [envKey(alias)]: model };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, file);
      send(ws, { ...(await state(false)), ref: m.ref ?? null, saved: { provider: id, alias, model } });
    } catch (e) {
      sendError(ws, mask(e?.message || ctx.safeError(e)));
    }
  });

  // Test réel : une requête minimale au fournisseur, avec la clé du serveur (jamais renvoyée).
  onMessage("models.test", async (ws, m) => {
    if (refuseInvoke(ws)) return;
    const id = String(m.provider ?? "");
    const model = String(m.model ?? "").trim();
    const reply = (r) => send(ws, { type: "models.tested", provider: id, model, ref: m.ref ?? null, ...r });
    if (!Object.hasOwn(PROVIDERS, id) || !MODEL_RE.test(model)) return reply({ ok: false, error: "paramètres invalides" });
    const t0 = Date.now();
    try {
      const key = secretOf(readSettings(id));
      if (!key) return reply({ ok: false, error: "clé introuvable dans settings.json" });
      const res = await fetch(PROVIDERS[id].chat, {
        method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "Réponds : OK" }] }),
        signal: AbortSignal.timeout(60_000),
      });
      const ms = Date.now() - t0;
      if (!res.ok) return reply({ ok: false, ms, error: `HTTP ${res.status}` });
      reply({ ok: true, ms });
    } catch (e) {
      reply({ ok: false, ms: Date.now() - t0, error: mask(e?.name === "TimeoutError" ? "pas de réponse en 60 s" : e?.message) });
    }
  });
}
