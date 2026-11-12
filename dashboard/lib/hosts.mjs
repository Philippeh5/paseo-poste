import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readJson, writeJsonAtomic } from "./store.mjs";
import { extractQuestions } from "./questions.mjs";

// Les passerelles (OpenRouter, API) n'acceptent que les alias de niveau :
// un identifiant de catalogue demande trop de jetons (erreur 402).
export const GATEWAY_ALIASES = {
  "claude-openrouter": [
    { id: "sonnet", label: "sonnet (alias passerelle)", isDefault: true },
    { id: "opus", label: "opus (alias passerelle)" },
    { id: "fable", label: "fable (alias passerelle)" },
  ],
  "claude-nvidia": [
    { id: "sonnet", label: "sonnet (alias passerelle)", isDefault: true },
    { id: "opus", label: "opus (alias passerelle)" },
  ],
};

// Alias des passerelles avec le vrai modèle derrière chacun (lu dans ~/.<fournisseur>/settings.json, sans toucher aux clés) ; repli : liste fixe.
export function gatewayModels(provider) {
  const fallback = Object.hasOwn(GATEWAY_ALIASES, provider) ? GATEWAY_ALIASES[provider] : null;
  if (!fallback) return null;
  let env = {};
  try { env = JSON.parse(readFileSync(join(homedir(), `.${provider}`, "settings.json"), "utf8")).env || {}; } catch { return fallback; }
  const list = ["sonnet", "opus", "haiku", "fable"].filter((a) => typeof env[`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`] === "string" && env[`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`])
    .map((a) => ({ id: a, label: `${a[0].toUpperCase()}${a.slice(1)} (${env[`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`].slice(0, 120)})`, isDefault: a === "sonnet" }));
  return list.length ? list : fallback;
}

export function folderName(directory) {
  return directory ? directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
}

// Un dossier = un projet : les workspaces d'un même dossier sont fusionnés et nommés d'après le dossier.
export function uniqueProjects(entries) {
  const byDir = new Map();
  for (const x of entries) {
    const directory = x.workspaceDirectory || x.directory || x.projectRootPath;
    if (!directory || byDir.has(directory)) continue;
    byDir.set(directory, { workspaceId: x.id, name: folderName(directory) || x.name || x.id, directory });
  }
  return [...byDir.values()].sort((p, q) => p.name.localeCompare(q.name));
}

function safeUrl(value) {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "URL invalide";
  }
}

export function createHosts({ hostsFile, hostNamesFile }) {
  const clients = new Map();
  const removedListeners = new Set();
  const hostNamesPath = hostNamesFile ||
    (process.env.DASHBOARD_DATA_DIR
      ? join(process.env.DASHBOARD_DATA_DIR, "host-names.json")
      : fileURLToPath(new URL("../data/host-names.json", import.meta.url)));

  const readHostNames = () => {
    try {
      const data = readJson(hostNamesPath, {});
      return typeof data === "object" && data !== null ? data : {};
    } catch {
      return {};
    }
  };

  const getDisplayName = (label) => {
    const map = readHostNames();
    if (map && typeof map[label] === "string" && map[label].trim()) return map[label].trim();
    if (label === "local") return "Mini PC";
    if (label === "oracle") return "Oracle";
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
  };

  const readHosts = () => {
    const data = readJson(hostsFile, {});
    return Array.isArray(data.hosts) ? data.hosts : [];
  };
  const writeHosts = (hosts) => writeJsonAtomic(hostsFile, { hosts });
  const currentHosts = () => new Map(readHosts().map((h) => [h.label, h]));

  const safeError = (e) => {
    let message = String(e?.message || e || "Erreur inconnue").replace(/password|mot de passe/gi, "identifiant");
    for (const { config } of clients.values()) {
      if (config.password) message = message.replaceAll(config.password, "[secret masqué]");
    }
    return message;
  };

  function closeEntry(entry) {
    entry.api.dispose().catch(() => {});
    entry.daemon.close().catch(() => {});
  }

  function connectHost(config) {
    const old = clients.get(config.label);
    if (old) closeEntry(old);
    const daemon = new DaemonClient({
      url: config.url,
      clientId: `paseo-dashboard-${config.label}-${randomUUID()}`,
      clientType: "cli",
      password: config.password || undefined,
      reconnect: { enabled: true, baseDelayMs: 1500, maxDelayMs: 30000 },
      connectTimeoutMs: 8000,
    });
    const entry = { daemon, api: createPaseoApi(daemon), config };
    clients.set(config.label, entry);
    // Le client ne retente pas après un échec du tout premier essai : on boucle nous-mêmes.
    (async () => {
      for (let delay = 1500; clients.get(config.label) === entry; delay = Math.min(delay * 2, 30000)) {
        try {
          await daemon.connect();
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    })();
    return entry;
  }

  function removeClient(label) {
    const old = clients.get(label);
    if (old) closeEntry(old);
    clients.delete(label);
    for (const listener of removedListeners) listener(label);
  }

  function hostCard(label, entry, data) {
    const info = entry.daemon.getLastServerInfoMessage?.() || {};
    const agents = data.agents || [];
    const counts = {};
    for (const a of agents) counts[a.status] = (counts[a.status] || 0) + 1;
    const quota = data.usage?.providers
      ?.map((p) => {
        const windows = p.windows?.map((w) => `${w.shortLabel || w.label} ${Math.round(w.usedPct || 0)}%`);
        return `${p.displayName || p.providerId}: ${windows?.join(", ") || p.status}`;
      })
      .join(" · ");
    return {
      label,
      displayName: getDisplayName(label),
      url: safeUrl(entry.config.url),
      status: "connected",
      reason: null,
      hasPassword: Boolean(entry.config.password),
      version: info.version || info.daemonVersion || null,
      hostname: info.hostname || info.hostName || null,
      os: info.os || info.platform || null,
      agents: agents.length,
      agentCounts: counts,
      terminals: (data.terminals || []).length,
      quota: quota || data.usage?.reason || "Indisponible",
    };
  }

  const offline = (label, entry, status, reason, usageReason) => ({
    host: {
      label,
      displayName: getDisplayName(label),
      url: safeUrl(entry.config.url),
      status,
      reason,
      hasPassword: Boolean(entry.config.password),
    },
    workspaces: [],
    agents: [],
    terminals: [],
    usage: { available: false, reason: usageReason },
  });

  function mapAgent(label, row) {
    const x = row.agent || row;
    const pending = (x.pendingPermissions || []).map((p) => ({
      id: p.id,
      title: p.title || p.name || "Permission",
      kind: typeof p.kind === "string" ? p.kind : "tool",
      questions: extractQuestions(p) || undefined,
      actions: (p.actions || []).map((z) => ({ id: z.id, label: z.label, behavior: z.behavior })),
    }));
    const started = x.activeTurn?.startedAt || x.createdAt || null;
    return {
      host: label,
      agentId: x.id,
      workspaceId: x.workspaceId || null,
      parentAgentId: x.parentAgentId ?? null,
      provider: x.provider || "inconnu",
      model: x.model || x.runtimeInfo?.model || null,
      status: pending.length ? "waiting-permission" : x.status || "idle",
      cwd: x.cwd || null,
      title: x.title || null,
      updatedAt: x.updatedAt || null,
      pending,
      duration: started ? Date.now() - new Date(started).getTime() : 0,
    };
  }

  async function hostState(label, entry) {
    const conn = entry.daemon.getConnectionState();
    const status = conn.status === "connected" ? "connected" : conn.status === "connecting" ? "reconnecting" : "error";
    const reason = status === "error" ? conn.reason || "Connexion indisponible" : null;
    const result = offline(label, entry, status, reason, "hôte déconnecté");
    if (status !== "connected") return result;
    const [w, a, t, u] = await Promise.allSettled([
      entry.api.workspaces.list({}),
      entry.api.agents.list({}),
      entry.api.terminals.list({}),
      entry.api.providers.listUsage({}),
    ]);
    if (w.status === "fulfilled") {
      result.workspaces = (w.value.entries || []).map((x) => {
        const directory = x.workspaceDirectory || x.directory || x.projectRootPath;
        return {
          host: label,
          workspaceId: x.id,
          name: folderName(directory) || x.name || x.id,
          directory,
          status: x.status,
        };
      });
    }
    if (a.status === "fulfilled") result.agents = (a.value.entries || []).map((row) => mapAgent(label, row));
    if (t.status === "fulfilled") {
      result.terminals = (t.value.entries || []).map((x) => ({
        host: label,
        terminalId: x.id,
        workspaceId: x.workspaceId,
        name: x.name,
        cwd: x.cwd,
      }));
    }
    result.usage = u.status === "fulfilled" ? u.value : { available: false, reason: safeError(u.reason) };
    result.host = hostCard(label, entry, result);
    return result;
  }

  async function collect(label, entry) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(offline(label, entry, "error", "Le daemon ne répond pas", "Hôte sans réponse")),
        7000,
      );
    });
    try {
      return await Promise.race([hostState(label, entry), timeout]);
    } catch {
      return offline(label, entry, "error", "État de l’hôte indisponible", "État indisponible");
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildState() {
    const configured = currentHosts();
    for (const label of [...clients.keys()]) if (!configured.has(label)) removeClient(label);
    for (const [label, config] of configured) if (!clients.has(label)) connectHost(config);
    const rows = await Promise.all([...clients].map(([label, entry]) => collect(label, entry)));
    return {
      hosts: rows.map((x) => x.host),
      workspaces: rows.flatMap((x) => x.workspaces),
      agents: rows.flatMap((x) => x.agents),
      terminals: rows.flatMap((x) => x.terminals),
      usage: Object.fromEntries(rows.map((x) => [x.host.label, x.usage])),
    };
  }

  // Vue publique des clients Paseo : jamais de mot de passe, ni de configuration brute.
  const publicHosts = {
    get: (label) => {
      const entry = clients.get(label);
      if (!entry) return undefined;
      return {
        label,
        url: safeUrl(entry.config.url),
        api: entry.api,
        daemon: entry.daemon,
        connected: () => entry.daemon.getConnectionState().status === "connected",
      };
    },
    has: (label) => clients.has(label),
    labels: () => [...clients.keys()],
  };

  return {
    clients,
    publicHosts,
    readHosts,
    writeHosts,
    connectHost,
    removeClient,
    buildState,
    safeError,
    onHostRemoved: (fn) => removedListeners.add(fn),
    startAll: () => readHosts().forEach(connectHost),
    closeAll: () => Promise.all([...clients.values()].map(async ({ api, daemon }) => {
      await api.dispose().catch(() => {});
      await daemon.close().catch(() => {});
    })),
  };
}
