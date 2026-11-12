// Faux moteur ACP (Agent Client Protocol) pour les tests T36 : AUCUN modèle, AUCUN appel réseau.
// Lancé par un daemon Paseo JETABLE (fournisseur « fakeacp » étendant « acp »). Il sert à prouver, avec le vrai daemon :
//  - quelles variables d'environnement le daemon met dans le processus du moteur (PASEO_AGENT_ID, PASEO_AGENT_CWD, nos PASEO_COORD_*) ;
//  - quels `mcpServers` le daemon transmet à la session ACP (session/new) ;
//  - un cycle complet : le faux moteur LANCE le serveur MCP paseo-coord reçu du daemon, avec exactement la configuration injectée,
//    et l'utilise (coord_claim…), ou demande une permission d'écriture que le poste (dashboard) accepte ou refuse.
// Le texte du prompt est un script JSON : { "steps": [ {"say": "..."} | {"edit": "chemin"} | {"mcp": "coord_claim", "args": {...}} | {"sleep": ms} ] }.
// Tout ce qui est observé est écrit dans <FAKE_ACP_PROBE_DIR>/<sessionId>.json (jamais affiché : contient des jetons de test).
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const probeDir = process.env.FAKE_ACP_PROBE_DIR || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envSeen = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PASEO_|FAKE_ACP_)/.test(k)));

// Invite en langage naturel (suites existantes qui s'attendent à un modèle) : quelques consignes simples sont comprises, sans aucun modèle.
//   « Reply with the single word PONG » -> répond PONG ; « Create a file X [in DIR] » -> demande la permission d'écrire X puis l'écrit (« hi »).
function naturalScript(text, cwd) {
  const steps = [];
  const file = /create a file(?: named)?\s+([^\s,]+)(?:[^.\n]*?\sin\s+(\S+))?/i.exec(text);
  if (file) {
    const dir = file[2] && /[\\/]/.test(file[2]) ? file[2] : cwd;
    steps.push({ edit: join(dir || ".", file[1]).replace(/\\/g, "/"), write: "hi\n" });
  }
  const word = /single word\s+([A-Za-z0-9_-]+)/i.exec(text);
  steps.push({ say: word ? word[1] : file ? "Fait." : "pong" });
  return { steps };
}

class FakeAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false, mcpCapabilities: { http: false, sse: false } } };
  }
  async newSession(params) {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
    const probe = { sessionId, pid: process.pid, cwd: params.cwd, env: envSeen, mcpServers: params.mcpServers ?? null, results: [] };
    this.sessions.set(sessionId, { probe, mcp: null });
    this.save(probe);
    return { sessionId };
  }
  async authenticate() { return {}; }
  async setSessionMode() { return {}; }
  save(probe) {
    if (!probeDir) return;
    try { mkdirSync(probeDir, { recursive: true }); writeFileSync(join(probeDir, `${probe.sessionId}.json`), JSON.stringify(probe, null, 2)); } catch { /* sans importance */ }
  }
  async say(sessionId, text) {
    await this.connection.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  }
  // Se connecte au serveur MCP paseo-coord avec la configuration reçue du daemon (stdio).
  async mcp(session) {
    if (session.mcp) return session.mcp;
    const servers = Array.isArray(session.probe.mcpServers) ? session.probe.mcpServers : [];
    const cfg = servers.find((s) => s.name === "paseo-coord");
    if (!cfg) throw new Error("serveur MCP paseo-coord absent de session/new");
    const env = Object.fromEntries((cfg.env || []).map((e) => [e.name, e.value]));
    const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args || [], env, cwd: session.probe.cwd, stderr: "ignore" });
    const client = new Client({ name: "fake-acp-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    session.mcp = client;
    return client;
  }
  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error("session inconnue");
    const raw = (params.prompt || []).map((p) => p.text || "").join("\n").trim();
    let script;
    try { script = JSON.parse(raw); } catch { script = naturalScript(raw, session.probe.cwd); }
    for (const step of script.steps || []) {
      if (step.say !== undefined) await this.say(params.sessionId, String(step.say));
      else if (step.sleep) await sleep(step.sleep);
      else if (step.mcp) {
        try {
          const client = await this.mcp(session);
          const res = await client.callTool({ name: step.mcp, arguments: step.args || {} });
          session.probe.results.push({ step: `mcp:${step.mcp}`, isError: res.isError === true, text: (res.content || []).map((c) => c.text).join("\n") });
        } catch (e) {
          session.probe.results.push({ step: `mcp:${step.mcp}`, isError: true, text: `exception: ${e.message}` });
        }
        this.save(session.probe);
      } else if (step.edit) {
        const path = String(step.edit);
        const toolCallId = `call_${Math.random().toString(36).slice(2, 8)}`;
        await this.connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: "Edit", kind: "edit", status: "pending", locations: [{ path }], rawInput: { file_path: path } } });
        const res = await this.connection.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId, title: "Edit", kind: "edit", status: "pending", locations: [{ path }], rawInput: { file_path: path } },
          options: [{ kind: "allow_once", name: "Autoriser", optionId: "allow" }, { kind: "reject_once", name: "Refuser", optionId: "reject" }],
        });
        const allowed = res.outcome.outcome === "selected" && res.outcome.optionId === "allow";
        if (allowed && step.write !== undefined) { try { writeFileSync(path, String(step.write)); } catch { /* dossier absent : sans importance pour le test */ } }
        session.probe.results.push({ step: `edit:${path}`, allowed, outcome: res.outcome });
        this.save(session.probe);
        await this.connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" } });
      }
    }
    this.save(session.probe);
    await this.say(params.sessionId, script.done ?? "terminé");
    return { stopReason: "end_turn" };
  }
  async cancel() {}
}

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
new acp.AgentSideConnection((conn) => new FakeAgent(conn), acp.ndJsonStream(input, output));
