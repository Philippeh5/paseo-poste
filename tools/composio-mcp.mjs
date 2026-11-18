#!/usr/bin/env node
// Serveur MCP (stdio) du pont Composio : mêmes règles que `tools/composio.mjs`.
// L'identité de l'agent vient de l'environnement (COMPOSIO_AGENT / POSTECTL_AGENT),
// injecté par le poste — un agent ne peut pas usurper l'identité d'un autre via un argument.
// Les outts d'écriture (app_execute sur slug d'écriture, app_link, app_run) exigent confirm: true.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { audit, decide, identity, loadPolicy, readAudit, runComposio, toolkitOf } from "./composio-lib.mjs";

const AGENT = identity();

// ---------- Schémas ----------
const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const CONFIRM = bool("Doit valoir true : confirme cette action (écriture, connexion de compte ou script)");
const SLUG = str("Slug de l'outil Composio (ex. GMAIL_FETCH_EMAILS)");
const TOOLKIT = str("Application visée (ex. gmail, github, slack)");
const DATA = { type: "object", additionalProperties: true, description: "Arguments de l'outil (clé/valeur)" };

function validate(schema, value, path = "arguments") {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type === "integer") {
    if (!Number.isInteger(value)) return `${path} : entier attendu`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} : minimum ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} : maximum ${schema.maximum}`;
    return null;
  }
  if (schema.type && schema.type !== kind) return `${path} : type ${schema.type} attendu`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} : valeur parmi ${schema.enum.join(", ")}`;
  if (schema.type === "array") {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} : ${schema.maxItems} éléments au plus`;
    for (const [i, item] of value.entries()) {
      const problem = schema.items && validate(schema.items, item, `${path}[${i}]`);
      if (problem) return problem;
    }
  }
  if (schema.type === "object") {
    for (const key of schema.required || []) if (value[key] === undefined) return `${path}.${key} : requis`;
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties === true) continue;
        return `${path}.${key} : paramètre inconnu`;
      }
      const problem = validate(schema.properties[key], item, `${path}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

// Décision centrale : un refus est renvoyé tel quel, sans jamais lancer le CLI.
function authorize(action, opts = {}) {
  try {
    const decision = decide(loadPolicy(), AGENT, { action, ...opts });
    if (!decision.allowed) return { error: `${decision.reason} (${decision.code})`, code: decision.code };
    return { decision };
  } catch (e) {
    return { error: e.message, code: "policy_error" };
  }
}

async function invoke(args, { decision, action, slug, toolkit }) {
  // Le compte connecté est choisi par l'opérateur dans la politique, jamais par l'agent.
  const picked = [];
  if (decision?.account && action !== "search" && action !== "schema") {
    picked.push(action === "link" ? "--alias" : "--account", decision.account);
  }
  const result = await runComposio([...args, ...picked]);
  audit({ agent: AGENT, action, slug, toolkit, ok: result.ok, code: result.code, transient: result.transient });
  if (!result.ok) {
    return { isError: true, content: [{ type: "text", text: `Composio a échoué (code ${result.code}) : ${result.output}${result.transient ? "\nErreur temporaire : vérifiez avant de réessayer (l'action a peut-être déjà eu lieu)." : ""}` }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result.json ?? result.output, null, 2) }] };
}

const TOOLS = [
  {
    name: "app_policy",
    destructive: false,
    description: "Affiche les applications, opérations d'écriture et comptes autorisés pour l'agent courant (identité injectée par le poste).",
    schema: object({}),
    run: async () => {
      let policy;
      try {
        policy = loadPolicy();
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Erreur : ${e.message}` }] };
      }
      if (!policy) return { isError: true, content: [{ type: "text", text: "Erreur : aucune politique configurée (COMPOSIO_POLICY_FILE)." }] };
      const specific = policy.agents?.[AGENT] || policy.agents?.["*"] || {};
      const rule = { ...(policy.defaults || {}), ...specific };
      return { content: [{ type: "text", text: JSON.stringify({
        agent: AGENT,
        toolkits: rule.toolkits || [],
        writes: rule.writes === true,
        link: rule.link === true,
        scripts: rule.scripts === true,
        accounts: rule.accounts || policy.accounts?.[AGENT] || {},
        deniedSlugs: [...(policy.deniedSlugs || []), ...(rule.deniedSlugs || [])],
      }, null, 2) }] };
    },
  },
  {
    name: "app_search",
    destructive: false,
    description: "Recherche des outils Composio par besoin. Ne montre que les applications autorisées pour cet agent.",
    schema: object({ query: str("Besoin en langage naturel (ex. « lire mes emails »)"), toolkits: str("Filtre optionnel, apps séparées par des virgules (ex. gmail,github)") }, ["query"]),
    run: async (a) => {
      const gate = authorize("search");
      if (gate.error) return { isError: true, content: [{ type: "text", text: `Refusé : ${gate.error}` }] };
      const allowed = gate.decision.toolkits.includes("*") ? [] : gate.decision.toolkits;
      const requested = a.toolkits ? String(a.toolkits).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : allowed;
      // Un filtre hors périmètre est réduit aux apps autorisées : jamais de découverte d'app interdite.
      const scope = requested.filter((t) => !allowed.length || allowed.includes(t));
      const args = ["search", a.query];
      if (scope.length) args.push("--toolkits", scope.join(","));
      return invoke(args, { action: "search", toolkit: scope.join(",") });
    },
  },
  {
    name: "app_schema",
    destructive: false,
    description: "Affiche le schéma d'entrée d'un outil Composio sans l'exécuter. Préférer cela à toute supposition d'arguments.",
    schema: object({ slug: SLUG }, ["slug"]),
    run: async (a) => {
      const toolkit = toolkitOf(a.slug);
      const gate = authorize("schema", { slug: a.slug, toolkit });
      if (gate.error) return { isError: true, content: [{ type: "text", text: `Refusé : ${gate.error}` }] };
      return invoke(["execute", a.slug, "--get-schema"], { action: "schema", slug: a.slug, toolkit: gate.decision.toolkit });
    },
  },
  {
    name: "app_dry_run",
    destructive: false,
    description: "Valide et prévisualise un appel d'outil Composio sans l'exécuter.",
    schema: object({ slug: SLUG, data: DATA, toolkit: TOOLKIT }, ["slug"]),
    run: async (a) => {
      const toolkit = a.toolkit || toolkitOf(a.slug);
      const gate = authorize("dry-run", { slug: a.slug, toolkit });
      if (gate.error) return { isError: true, content: [{ type: "text", text: `Refusé : ${gate.error}` }] };
      return invoke(["execute", a.slug, "--dry-run", "-d", JSON.stringify(a.data ?? {})], { action: "dry-run", slug: a.slug, toolkit: gate.decision.toolkit });
    },
  },
  {
    name: "app_execute",
    destructive: true,
    description: "Exécute un outil Composio. Les opérations d'écriture exigent writes:true dans la politique et confirm:true. Le compte connecté est imposé par l'opérateur.",
    schema: object({ slug: SLUG, data: DATA, toolkit: TOOLKIT, confirm: CONFIRM }, ["slug"]),
    run: async (a) => {
      const toolkit = a.toolkit || toolkitOf(a.slug);
      const gate = authorize("execute", { slug: a.slug, toolkit, confirm: a.confirm === true });
      if (gate.error) return { isError: true, content: [{ type: "text", text: `Refusé : ${gate.error}` }] };
      return invoke(["execute", a.slug, "-d", JSON.stringify(a.data ?? {})], { decision: gate.decision, action: "execute", slug: a.slug, toolkit: gate.decision.toolkit });
    },
  },
  {
    name: "app_link",
    destructive: true,
    description: "Connecte un compte à une application. Réservé à l'opérateur via la politique (link:true) et confirm:true. Ouvre un navigateur OAuth.",
    schema: object({ toolkit: TOOLKIT, confirm: CONFIRM }, ["toolkit"]),
    run: async (a) => {
      const gate = authorize("link", { toolkit: a.toolkit, confirm: a.confirm === true });
      if (gate.error) return { isError: true, content: [{ type: "text", text: `Refusé : ${gate.error}` }] };
      return invoke(["link", a.toolkit], { decision: gate.decision, action: "link", toolkit: a.toolkit });
    },
  },
  {
    name: "app_run",
    destructive: true,
    description: "Exécute un script Composio multi-outils (execute/search/proxy). Exige scripts:true et confirm:true. Déclarer les apps touchées dans `toolkits` pour qu'elles soient contrôlées.",
    schema: object({ code: str("Code JS à exécuter (helpers injectés : execute, search, proxy)"), toolkits: str("Apps touchées, séparées par des virgules (ex. gmail,github)"), confirm: CONFIRM }, ["code"]),
    run: async (a) => {
      const declared = a.toolkits ? String(a.toolkits).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
      const base = authorize("run", { confirm: a.confirm === true });
      if (base.error) return { isError: true, content: [{ type: "text", text: `Refusé : ${base.error}` }] };
      for (const toolkit of declared) {
        const gate = authorize("run", { toolkit, confirm: a.confirm === true });
        if (gate.error) return { isError: true, content: [{ type: "text", text: `Refusé (app « ${toolkit} ») : ${gate.error}` }] };
      }
      return invoke(["run", a.code], { action: "run", toolkit: declared.join(",") });
    },
  },
  {
    name: "app_audit",
    destructive: false,
    description: "Lit le journal d'audit du pont Composio (métadonnées uniquement : aucun jeton ni charge utile).",
    schema: object({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
    run: async (a) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(readAudit(a.limit ?? 20), null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Erreur : ${e.message}` }] };
      }
    },
  },
];

// ---------- Serveur ----------
const server = new Server({ name: "composio-poste", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((t) => t.name === request.params.name);
  const fail = (message) => ({ isError: true, content: [{ type: "text", text: `Erreur : ${message}` }] });
  if (!tool) return fail(`outil inconnu : ${request.params.name}`);
  const args = request.params.arguments ?? {};
  const problem = validate(tool.schema, args);
  if (problem) return fail(problem);
  if (tool.destructive && args.confirm !== true) {
    audit({ agent: AGENT, tool: tool.name, ok: false, code: "confirm_required" });
    return fail(`action sensible (${tool.name}) : passez confirm: true pour la confirmer`);
  }
  try {
    return await tool.run(args);
  } catch (e) {
    audit({ agent: AGENT, tool: tool.name, ok: false, error: String(e.message).slice(0, 200) });
    return fail(e.message);
  }
});

await server.connect(new StdioServerTransport());
