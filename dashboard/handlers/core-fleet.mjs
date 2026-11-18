// Messages de base de la flotte : hôtes et lancement. Fournis avec le poste de commande (v2).
import { GATEWAY_ALIASES, gatewayModels, uniqueProjects } from "../lib/hosts.mjs";

// Reconnaît le shell d'un terminal tout neuf d'après son invite (« PS C:\x> » = PowerShell, « C:\x> » = cmd.exe, « …$ » = bash). cmd.exe par défaut.
async function detectShell(entry, terminalId, windowsHost = true) {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 350));
    try {
      const cap = await entry.api.terminals.ref(terminalId).capture({ stripAnsi: true, start: -20 });
      const last = (cap.lines || []).map(String).filter((l) => l.trim()).at(-1) || "";
      if (/^PS [^>]*>\s*$/.test(last)) return "powershell";
      if (/^[A-Za-z]:[^>]*>\s*$/.test(last)) return "cmd";
      if (/[$#]\s*$/.test(last)) return "bash";
    } catch { /* terminal pas encore prêt */ }
  }
  // Prompt illisible (terminal lent à démarrer) : sur une machine non Windows (système annoncé par l'hôte) le shell est de type POSIX, sinon les « set "VAR=…" » de cmd.exe
  // seraient tapés dans bash et la session n'aurait jamais reçu son identité de coordination.
  return windowsHost ? "cmd" : "bash";
}

export function register(ctx, { hosts }) {
  const { onMessage, sendError, send, safeError, broadcastState, hostOf } = ctx;
  // Dernier état diffusé : sert à connaître le système de l'hôte (champ `os` des hôtes) pour choisir le shell d'un terminal neuf.
  let lastState = null;
  ctx.onStateChange?.((st) => { lastState = st; });

  onMessage("host.add", (ws, m) => {
    const list = hosts.readHosts();
    if (!m.label?.trim() || !/^wss?:\/\//i.test(m.url || "")) {
      return sendError(ws, "label et URL ws:// ou wss:// requis");
    }
    if (list.some((x) => x.label === m.label.trim())) return sendError(ws, "ce label existe déjà");
    const config = { label: m.label.trim(), url: m.url.trim(), password: m.password || "" };
    list.push(config);
    hosts.writeHosts(list);
    hosts.connectHost(config);
    return broadcastState();
  });

  onMessage("host.remove", (_ws, m) => {
    hosts.writeHosts(hosts.readHosts().filter((x) => x.label !== m.label));
    hosts.removeClient(m.label);
    return broadcastState();
  });

  onMessage("launch.options", async (ws, m) => {
    const { label, entry } = hostOf(m);
    if (!entry || !entry.connected()) return sendError(ws, "cet hôte est indisponible");
    try {
      const [availability, snapshot, workspaces] = await Promise.all([
        entry.api.providers.listAvailable({}),
        entry.api.providers.waitForReady({ timeoutMs: 12000 }).catch(() => entry.api.providers.snapshot({})),
        entry.api.workspaces.list({}),
      ]);
      const availableById = new Map((availability.providers || []).map((x) => [x.provider, x]));
      const providers = (snapshot.entries || []).map((p) => {
        const status = availableById.get(p.provider);
        return {
          id: p.provider,
          label: p.label || p.provider,
          status: p.status,
          available: Boolean(status?.available),
          error: status?.error || p.error || null,
          models: gatewayModels(p.provider) || p.models || [],
          modes: p.modes || [],
        };
      });
      const projects = uniqueProjects(workspaces.entries || []);
      // Options spéciales FreqTrade si c'est le bon hôte
      const isFreqtrade = label.includes("freqtrade") || label === "FreqTrade";
      let freqtradeOptions = [];
      if (isFreqtrade) {
        const strategiesDir = "/home/USERNAME/Projets/freqtrade/user_data/strategies";
        const configs = ["config.json", "config1.json", "config2.json", "config3.json", "config_AI.json", "config_btc.json"];
        freqtradeOptions = [
          { id: "strategy", label: "Stratégie", options: [] },  // Sera rempli côté JS
          { id: "config", label: "Config", options: configs.map(c => ({ id: c, label: c })) },
          { id: "mode", label: "Mode", options: [
            { id: "backtest", label: "Backtest" },
            { id: "trade", label: "Mode normal" },
            { id: "hyperopt", label: "HyperOpt" }
          ]}
        ];
      }
      send(ws, { type: "launch.options", host: label, providers, workspaces: projects, freqtradeOptions });    } catch (e) {
      sendError(ws, `options de lancement indisponibles : ${safeError(e)}`);
    }
  });

  // `ref` (facultatif) est renvoyé tel quel dans launch.started pour que le navigateur retrouve sa demande.
  onMessage("launch.start", async (ws, m) => {
    const { label, entry } = hostOf(m);
    if (!entry || !entry.connected()) return sendError(ws, "hôte indisponible");
    const ref = typeof m.ref === "string" ? m.ref.slice(0, 80) : undefined;
    let autoEngine = null; // moteur choisi par le classement : si le lancement échoue (quota, crédit), il est mis au repos
    try {
      const cwd = String(m.cwd || "").trim();
      if (!cwd) return sendError(ws, "le dossier du projet est obligatoire");
      const workspace = await entry.api.workspaces.open({ cwd });
      if (m.kind === "terminal") {
        const term = await entry.api.terminals.create({ workspaceId: workspace.id });
        // Outil lancé dans ce terminal (FreeBuff…) : le poste lui donne une identité de coordination (variables saisies dans le shell détecté : cmd.exe, PowerShell ou bash,
        // avant la commande de l'outil que le navigateur tape ensuite) pour qu'il puisse parler aux autres sessions.
        const tool = typeof m.tool === "string" ? m.tool.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30) : "";
        if (tool && tool !== "terminal") {
          const hostOs = String(lastState?.hosts?.find((h) => h.label === label)?.os ?? "");
          const shell = await detectShell(entry, term.id, !hostOs || /win/i.test(hostOs));
          const reg = ctx.coord?.registerTerminal?.({ host: label, terminalId: term.id, cwd, tool, shell });
          if (reg) {
            const CR = "\x0d";
            try { entry.daemon.sendTerminalInput(term.id, { type: "input", data: `${reg.lines.join(CR)}${CR}${reg.clear}${CR}` }); } catch { /* sans identité : l'outil se lance quand même */ }
          }
        }
        send(ws, {
          type: "launch.started", kind: "terminal", host: label, terminalId: term.id,
          workspaceId: workspace.id, cwd, ref,
        });
      } else {
        let provider = m.provider;
        let model = m.model;
        let rest = [];
        if (!provider || !model) return sendError(ws, "fournisseur et modèle requis");
        // « auto » : le poste prend le premier moteur disponible du classement des modèles pour ce rôle (écriture par défaut ; lecture = mode plan).
        let role = "writer";
        let modeId = m.mode || "";
        if (provider === "auto") {
          role = ["writer", "reader", "planner"].includes(m.role) ? m.role : ["writer", "reader", "planner"].includes(model) ? model : "writer";
          const pick = ctx.quota?.pickEngine?.(undefined, role, { agentsOnly: true });
          if (!pick?.engine) return sendError(ws, `aucun moteur disponible dans le classement (${pick?.reason || "classement indisponible"})`);
          autoEngine = pick.engine;
          [provider, ...rest] = pick.engine.split("/");
          model = rest.join("/");
          if (!modeId && role === "reader" && /^claude/i.test(provider)) modeId = "plan";
        }
        const options = {
          config: { provider: `${provider}/${model}`, ...(modeId ? { modeId } : {}) },
          cwd,
          prompt: String(m.prompt || ""),
          title: String(m.title || "") || undefined,
        };
        if (m.worktree) options.worktree = { mode: "branch-off", newBranch: String(m.branch || "paseo-task") };
        // T36 : identité de coordination et serveur MCP paseo-coord (jamais de copie de travail imposée à un lancement manuel : l'interface signale).
        const coord = ctx.coord?.prepareLaunch?.({ host: label, cwd, role, engine: options.config.provider, mode: modeId });
        if (coord) {
          if (coord.hint) options.prompt = `${options.prompt}\n\n${coord.hint}`;
          options.agentId = coord.agentId;
          options.env = coord.env;
          if (coord.mcpServers) options.config.mcpServers = coord.mcpServers;
          if (coord.toolPolicy) options.config.toolPolicy = coord.toolPolicy;
        }
        const agent = coord ? await ctx.coord.createAgent(entry.api, options, coord) : await entry.api.agents.create(options);
        ctx.coord?.afterLaunch?.({ requestedId: coord?.agentId, agent });
        send(ws, {
          type: "launch.started", kind: "agent", host: label, agentId: agent.id,
          workspaceId: agent.workspaceId, cwd, ref,
        });
      }
      await broadcastState();
    } catch (e) {
      if (autoEngine) ctx.quota?.noteFailure?.(autoEngine, safeError(e));
      sendError(ws, `lancement impossible : ${safeError(e)}`);
    }
  });
}
