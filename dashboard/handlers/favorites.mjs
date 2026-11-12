// Gestion des favoris de modèles par harnais / fournisseur.
// Persisté dans dashboard/data/model-favorites.json.
// Messages : favorites.get, favorites.toggle { provider, modelId }

const FILE = "model-favorites";

const DEFAULT_FAVORITES = {
  "claude-openrouter": ["sonnet"],
  "claude-nvidia": ["sonnet"],
  "pi": ["poolside/laguna-s-2.1:free", "nvidia/nemotron-3-ultra-550b-a55b"],
  "openrouter": ["poolside/laguna-s-2.1:free"],
  "nvidia": ["nvidia/nemotron-3-ultra-550b-a55b"],
};

function sanitize(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ...DEFAULT_FAVORITES };
  }
  const result = {};
  for (const [key, val] of Object.entries(data)) {
    if (typeof key === "string" && key.trim()) {
      const arr = Array.isArray(val) ? val.filter((x) => typeof x === "string" && x.trim()) : [];
      result[key.trim()] = [...new Set(arr)];
    }
  }
  return result;
}

export function register(ctx) {
  const { onMessage, send, broadcast, sendError, store } = ctx;

  const load = () => sanitize(store.read(FILE, DEFAULT_FAVORITES));

  onMessage("favorites.get", (ws) => {
    const favorites = load();
    send(ws, { type: "favorites.list", favorites });
  });

  onMessage("favorites.toggle", (ws, m) => {
    const provider = typeof m.provider === "string" ? m.provider.trim() : "";
    const modelId = typeof m.modelId === "string" ? m.modelId.trim() : "";

    if (!provider || !modelId) {
      return sendError(ws, "fournisseur et modèle requis");
    }
    if (!/^[A-Za-z0-9][\w.-]{0,59}$/.test(provider) || modelId.length > 200 || /[\u0000-\u001f]/.test(modelId)) {
      return sendError(ws, "fournisseur ou modèle invalide");
    }

    const data = load();
    if (!Object.hasOwn(data, provider) && Object.keys(data).length >= 30) return sendError(ws, "trop de fournisseurs");
    const list = Object.hasOwn(data, provider) && Array.isArray(data[provider]) ? [...data[provider]] : [];
    if (!list.includes(modelId) && list.length >= 100) return sendError(ws, "trop de favoris pour ce fournisseur");
    const idx = list.indexOf(modelId);

    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.push(modelId);
    }

    data[provider] = list;
    store.write(FILE, data);

    const reply = { type: "favorites.list", favorites: data };
    broadcast(reply);
  });
}
