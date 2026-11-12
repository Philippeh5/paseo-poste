// Handler LLM direct : discussion avec une API externe (OpenRouter ou NVIDIA).
// Les clés sont résolues côté serveur sans jamais transiter vers le navigateur ni les journaux.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readJsonSafe(filePath) {
  try {
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {}
  return null;
}

function sanitizeKey(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/sk-[a-zA-Z0-9_\-\.]{8,}/g, "[CLÉ MASQUÉE]");
}

function resolveOpenRouterConfig() {
  const home = homedir();
  // 1. .pi/agent/models.json
  const piModels = readJsonSafe(join(home, ".pi", "agent", "models.json"));
  let key = piModels?.providers?.["openrouter-free"]?.apiKey ||
            piModels?.providers?.["openrouter"]?.apiKey || null;

  // 2. .claude-openrouter/settings.json
  if (!key) {
    const coSettings = readJsonSafe(join(home, ".claude-openrouter", "settings.json"));
    key = coSettings?.env?.ANTHROPIC_AUTH_TOKEN || coSettings?.env?.ANTHROPIC_API_KEY || null;
  }

  // 3. .pi/agent/auth.json
  if (!key) {
    const piAuth = readJsonSafe(join(home, ".pi", "agent", "auth.json"));
    key = piAuth?.openrouter?.key || piAuth?.["openrouter-free"]?.key || null;
  }

  // 4. process.env
  if (!key) {
    key = process.env.OPENROUTER_API_KEY || null;
  }

  return {
    provider: "openrouter",
    type: "openai",
    key,
    baseUrl: "https://openrouter.ai/api/v1",
  };
}

function resolveNvidiaConfig() {
  const home = homedir();
  // 1. Clé directe dans .pi/agent/auth.json
  const piAuth = readJsonSafe(join(home, ".pi", "agent", "auth.json"));
  const directKey = piAuth?.nvidia?.key || process.env.NVIDIA_API_KEY || null;
  if (directKey) {
    return {
      provider: "nvidia",
      type: "openai",
      key: directKey,
      baseUrl: "https://integrate.api.nvidia.com/v1",
    };
  }

  // 2. Proxy dans .pi/agent/models.json
  const piModels = readJsonSafe(join(home, ".pi", "agent", "models.json"));
  let proxyKey = piModels?.providers?.["nvidia-proxy"]?.apiKey ||
                 piModels?.providers?.["nvidia"]?.apiKey || null;
  let proxyUrl = piModels?.providers?.["nvidia-proxy"]?.baseUrl ||
                 piModels?.providers?.["nvidia"]?.baseUrl || null;

  // 3. .claude-nvidia/settings.json
  if (!proxyKey) {
    const cnSettings = readJsonSafe(join(home, ".claude-nvidia", "settings.json"));
    proxyKey = cnSettings?.env?.ANTHROPIC_AUTH_TOKEN || cnSettings?.env?.ANTHROPIC_API_KEY || null;
    proxyUrl = cnSettings?.env?.ANTHROPIC_BASE_URL || proxyUrl;
  }

  // (la clé principale de Claude, ~/.claude.json, n'est volontairement JAMAIS utilisée : elle ne doit pas quitter Anthropic)

  if (proxyKey) {
    if (proxyUrl) {
      const base = proxyUrl.replace(/\/v1\/messages\/?$/, "").replace(/\/+$/, "");
      return {
        provider: "nvidia",
        type: "anthropic",
        key: proxyKey,
        baseUrl: base,
      };
    }
    return {
      provider: "nvidia",
      type: "openai",
      key: proxyKey,
      baseUrl: "https://integrate.api.nvidia.com/v1",
    };
  }

  return { provider: "nvidia", key: null };
}

function resolveProvider(providerRaw) {
  const p = String(providerRaw || "").toLowerCase().trim();
  if (p === "openrouter" || p.includes("openrouter")) {
    return resolveOpenRouterConfig();
  }
  if (p === "nvidia" || p.includes("nvidia")) {
    return resolveNvidiaConfig();
  }
  return { provider: p, key: null };
}

export { resolveProvider, sanitizeKey };

export async function executeLlmCall({ provider: rawProvider, model, messages, timeoutMs = 60000 }) {
  // Règle de Philippe (2026-10-21) : la clé OpenRouter n'a aucun crédit, seuls les modèles « :free » sont permis.
  if (/openrouter/i.test(String(rawProvider)) && !/:free$/.test(String(model))) {
    throw new Error(`OpenRouter : seuls les modèles « :free » sont autorisés (reçu « ${String(model).slice(0, 60)} »).`);
  }
  const config = resolveProvider(rawProvider);
  if (!config.key) {
    throw new Error(
      `Aucune clé d'API disponible pour ${rawProvider}. ` +
      "Configurez une clé dans ~/.pi/agent ou ~/.claude-*."
    );
  }

  let text = "";
  if (config.type === "openai") {
    const url = `${config.baseUrl}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:7070",
        "X-Title": "Paseo Dashboard",
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Statut HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    text = data?.choices?.[0]?.message?.content || "";
  } else if (config.type === "anthropic") {
    const url = `${config.baseUrl}/v1/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": config.key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 2048, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Statut HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const contentBlock = data?.content?.find((c) => c.type === "text") || data?.content?.[0];
    text = contentBlock?.text || "";
  }
  return text;
}

const rawProviderTooLong = (m) => String(m.provider || "").length > 80 || String(m.model || "").length > 200;

export function register(ctx) {
  const { onMessage, send, sendError, safeError, log } = ctx;

  onMessage("llm.models", (ws) => {
    send(ws, {
      type: "llm.models",
      providers: [
        {
          id: "openrouter",
          label: "OpenRouter",
          models: [
            { id: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (gratuit)" },
            { id: "thinkingmachines/inkling:free", label: "Inkling (gratuit)" },
            { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (gratuit)" },
            { id: "deepseek/deepseek-r1:free", label: "DeepSeek R1 (gratuit)" },
            { id: "google/gemini-2.0-flash-exp:free", label: "Gemini 2.0 Flash Exp (gratuit)" },
          ],
        },
        {
          id: "nvidia",
          label: "NVIDIA",
          models: [
            { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra 550B" },
            { id: "meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B" },
            { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
          ],
        },
      ],
    });
  });

  onMessage("llm.chat", async (ws, m) => {
    const rawProvider = String(m.provider || "").trim();
    const model = String(m.model || "").trim();
    const id = typeof m.id === "string" ? m.id : undefined;

    let messages = [];
    if (typeof m.messages === "string" && m.messages.trim()) {
      messages = [{ role: "user", content: m.messages.trim() }];
    } else if (Array.isArray(m.messages)) {
      messages = m.messages
        .slice(-60)
        .filter((x) => x && typeof x === "object" && typeof x.content === "string")
        .map((x) => ({ role: x.role === "assistant" ? "assistant" : "user", content: String(x.content).slice(0, 20000) }));
    }
    if (typeof m.messages === "string") messages = messages.map((x) => ({ ...x, content: x.content.slice(0, 20000) }));
    if (rawProviderTooLong(m) || messages.reduce((n, x) => n + x.content.length, 0) > 100000) {
      const err = "Requête trop volumineuse (100 000 caractères maximum, modèle et fournisseur courts).";
      send(ws, { type: "llm.reply", id: typeof m.id === "string" ? m.id.slice(0, 80) : undefined, ok: false, error: err });
      return sendError(ws, err);
    }

    if (!rawProvider) {
      const err = "Fournisseur non spécifié (choisir OpenRouter ou NVIDIA).";
      send(ws, { type: "llm.reply", id, ok: false, provider: rawProvider, model, error: err });
      return sendError(ws, err);
    }
    if (!model) {
      const err = "Modèle non spécifié.";
      send(ws, { type: "llm.reply", id, ok: false, provider: rawProvider, model, error: err });
      return sendError(ws, err);
    }
    if (messages.length === 0) {
      const err = "Aucun message à envoyer.";
      send(ws, { type: "llm.reply", id, ok: false, provider: rawProvider, model, error: err });
      return sendError(ws, err);
    }

    const config = resolveProvider(rawProvider);
    if (!config.key) {
      const err = `Aucune clé d'API disponible pour ${rawProvider}. ` +
        "Configurez une clé dans ~/.pi/agent ou ~/.claude-*.";
      send(ws, { type: "llm.reply", id, ok: false, provider: rawProvider, model, error: err });
      return sendError(ws, err);
    }

    log("llmchat", `appel fournisseur=${config.provider} modèle=${model} messages=${messages.length}`);

    try {
      const text = await executeLlmCall({
        provider: rawProvider,
        model,
        messages,
        timeoutMs: 30000,
      });

      send(ws, {
        type: "llm.reply",
        id,
        ok: true,
        provider: rawProvider,
        model,
        text,
        reply: text,
      });
    } catch (e) {
      const err = `Échec de l'appel LLM (${rawProvider}) : ${sanitizeKey(safeError(e))}`;
      send(ws, { type: "llm.reply", id, ok: false, provider: rawProvider, model, error: err });
      sendError(ws, err);
    }
  });
}
