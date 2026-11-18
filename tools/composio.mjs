#!/usr/bin/env node
// CLI Composio du poste de commande : accès aux applications des agents, sous politique.
// L'identité de l'agent vient de l'environnement (COMPOSIO_AGENT / POSTECTL_AGENT),
// jamais d'un argument : un agent ne peut pas se faire passer pour un autre.
// Codes de sortie : 0 OK, 2 usage, 3 refus de politique, 75 erreur temporaire Composio.
import { decide, identity, loadPolicy, readAudit, runComposio, toolkitOf } from "./composio-lib.mjs";

const USAGE = `Composio pour le poste de commande

Usage :
  composio.mjs whoami
  composio.mjs policy
  composio.mjs search "<besoin>" [--toolkit gmail,github]
  composio.mjs schema <slug>
  composio.mjs dry-run <slug> [-d '{"clé":"valeur"}']
  composio.mjs execute <slug> [-d '{"clé":"valeur"}'] [--confirm]
  composio.mjs link <toolkit> [--confirm]
  composio.mjs run '<code JS>' [--toolkit gmail,github] [--confirm]
  composio.mjs audit [--limit 20]

Variables :
  COMPOSIO_AGENT / POSTECTL_AGENT  identité de l'agent (injectée par le poste)
  COMPOSIO_POLICY_FILE             fichier de politique (sinon $DASHBOARD_DATA_DIR/composio-policy.json)
  COMPOSIO_BIN                     binaire Composio (défaut : composio)
`;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const [rawKey, inline] = token.slice(2).split("=", 2);
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key === "confirm") {
        flags.confirm = true;
      } else if (inline !== undefined) {
        flags[key] = inline;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else if (token.startsWith("-d")) {
      // -d '{"clé":...}' ou -d@email (format Composio accepté)
      flags.data = token === "-d" ? argv[++i] : token.slice(2);
    } else if (token.startsWith("-")) {
      flags[token.slice(1)] = true;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function emit(payload, code = 0) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.exitCode = code;
}

function fail(message, code = 2) {
  process.stderr.write(`Erreur : ${message}\n`);
  process.exitCode = code;
}

function refusal(decision, agent) {
  emit({ ok: false, agent, error: { code: decision.code, message: decision.reason }, hint: "Demandez à l'opérateur de modifier la politique (COMPOSIO_POLICY_FILE)." }, 3);
}

function parseData(raw) {
  if (raw === undefined) return "{}";
  if (typeof raw !== "string") return JSON.stringify(raw);
  if (raw.startsWith("@") || raw === "-") return raw; // fichier / stdin géré par le CLI Composio
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    fail(`--data n'est pas du JSON valide : ${raw.slice(0, 120)}`);
    return null;
  }
}

async function call(args, { policyAction, slug = "", toolkit = "", confirm = false, agent }) {
  let decision;
  try {
    decision = decide(loadPolicy(), agent, { action: policyAction, slug, toolkit, confirm });
  } catch (e) {
    return fail(e.message, 3);
  }
  if (!decision.allowed) return refusal(decision, agent);

  // Le compte connecté est imposé par l'opérateur, jamais choisi par l'agent.
  const account = decision.account;
  if (account && policyAction !== "search" && policyAction !== "schema") args.push(policyAction === "link" ? "--alias" : "--account", account);

  const result = await runComposio(args);
  if (!result.ok) {
    emit({ ok: false, agent, error: { code: result.code, message: result.output || "échec Composio" }, transient: result.transient, retry: result.transient ? "check-first" : undefined }, result.transient ? 75 : 1);
    return;
  }
  emit({ ok: true, agent, action: policyAction, slug: slug || undefined, toolkit: decision.toolkit || toolkit || undefined, result: result.json ?? result.output }, 0);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parse(rest);
  const agent = identity();

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "whoami") {
    const result = await runComposio(["whoami"]);
    emit({ ok: result.ok, agent, account: result.json ?? result.output }, result.ok ? 0 : 1);
    return;
  }

  if (command === "policy") {
    let policy;
    try {
      policy = loadPolicy();
    } catch (e) {
      return fail(e.message, 3);
    }
    if (!policy) return fail("aucune politique configurée : copier deploy/oracle/composio-policy.example.json", 3);
    const specific = policy.agents?.[agent] || policy.agents?.["*"] || {};
    const rule = { ...(policy.defaults || {}), ...specific };
    emit({ ok: true, agent, toolkits: rule.toolkits || [], writes: rule.writes === true, link: rule.link === true, scripts: rule.scripts === true, accounts: rule.accounts || policy.accounts?.[agent] || {}, deniedSlugs: [...(policy.deniedSlugs || []), ...(rule.deniedSlugs || [])] });
    return;
  }

  if (command === "audit") {
    const limit = Math.max(1, Math.min(200, Number(flags.limit) || 20));
    emit({ ok: true, agent, entries: readAudit(limit) });
    return;
  }

  if (command === "search") {
    const query = positional.join(" ").trim();
    if (!query) return fail('search nécessite un besoin : composio.mjs search "envoyer un email"');
    let decision;
    try {
      decision = decide(loadPolicy(), agent, { action: "search" });
    } catch (e) {
      return fail(e.message, 3);
    }
    if (!decision.allowed) return refusal(decision, agent);
    const args = ["search", query];
    // L'agent ne découvre que les applications que l'opérateur lui a autorisées.
    const scope = flags.toolkit || positionalToolkit(positional, decision.toolkits);
    const allowed = decision.toolkits.includes("*") ? [] : decision.toolkits;
    // Tout filtre explicite hors périmètre est réduit aux apps autorisées (jamais de fuite).
    const filter = scope ? splitList(scope).filter((t) => !allowed.length || allowed.includes(t)) : allowed;
    if (filter.length) args.push("--toolkits", filter.join(","));
    const result = await runComposio(args);
    emit({ ok: result.ok, agent, toolkitsScope: filter.length ? filter : "all-allowed", result: result.json ?? result.output }, result.ok ? 0 : 1);
    return;
  }

  if (command === "schema") {
    const [slug] = positional;
    if (!slug) return fail("schema nécessite un slug (ex. GMAIL_FETCH_EMAILS)");
    return call(["execute", slug, "--get-schema"], { policyAction: "schema", slug, toolkit: flags.toolkit || toolkitOf(slug), agent });
  }

  if (command === "dry-run") {
    const [slug] = positional;
    if (!slug) return fail("dry-run nécessite un slug");
    const data = parseData(flags.data);
    if (data === null) return;
    return call(["execute", slug, "--dry-run", "-d", data], { policyAction: "dry-run", slug, toolkit: flags.toolkit || toolkitOf(slug), agent });
  }

  if (command === "execute") {
    const [slug] = positional;
    if (!slug) return fail("execute nécessite un slug");
    const data = parseData(flags.data);
    if (data === null) return;
    return call(["execute", slug, "-d", data], { policyAction: "execute", slug, toolkit: flags.toolkit || toolkitOf(slug), confirm: flags.confirm === true, agent });
  }

  if (command === "link") {
    const [toolkit] = positional;
    if (!toolkit) return fail("link nécessite un toolkit (ex. gmail)");
    return call(["link", toolkit], { policyAction: "link", toolkit, confirm: flags.confirm === true, agent });
  }

  if (command === "run") {
    const code = positional.join(" ").trim();
    if (!code) return fail("run nécessite du code JS (ou --file)");
    const declared = flags.toolkit ? splitList(flags.toolkit) : [];
    let policy;
    try {
      policy = loadPolicy();
    } catch (e) {
      return fail(e.message, 3);
    }
    const base = decide(policy, agent, { action: "run", confirm: flags.confirm === true });
    if (!base.allowed) return refusal(base, agent);
    for (const toolkit of declared) {
      const decision = decide(policy, agent, { action: "run", toolkit, confirm: flags.confirm === true });
      if (!decision.allowed) return refusal(decision, agent);
    }
    // `declared` sert uniquement au contrôle de politique : `composio run` n'a pas de --toolkit.
    const args = ["run", code];
    const result = await runComposio(args);
    emit({ ok: result.ok, agent, declaredToolkits: declared, result: result.json ?? result.output }, result.ok ? 0 : 1);
    return;
  }

  fail(`commande inconnue : ${command}\n\n${USAGE}`);
}

function splitList(value) {
  return String(value).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function positionalToolkit(positional, allowed) {
  // Les mots de la requête sont parfois le nom d'une app autorisée ("gmail").
  const hit = positional.find((p) => allowed.includes(p.toLowerCase()));
  return hit || "";
}

await main();
