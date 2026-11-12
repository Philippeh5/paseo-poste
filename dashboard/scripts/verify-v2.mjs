import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";

const root = process.cwd();
const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const socket = new WebSocket(url, { origin: new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:") });
const pending = [], history = [], terminalText = [];
let state = null, opened = false, closed = false;
socket.on("open", () => { opened = true; });
socket.on("close", () => { closed = true; });
socket.on("error", (error) => { pending.push({ type: "socket.error", message: error.message }); });
socket.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "state") state = msg.payload;
  if (msg.type === "term.output" && msg.data) terminalText.push(Buffer.from(msg.data, "base64").toString("utf8"));
  if (msg.type === "agent.history" || msg.type === "agent.event") history.push(msg);
  pending.push(msg);
});
function fail(msg) { throw new Error(msg); }
async function until(predicate, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; if (closed) fail("WebSocket fermé pendant " + label); await delay(100); }
  fail("Délai dépassé : " + label);
}
function send(message) { socket.send(JSON.stringify(message)); }
async function receive(predicate, label) { return until(() => { const i = pending.findIndex(predicate); return i >= 0 ? pending.splice(i, 1)[0] : null; }, label); }
function assistantText(messages) {
  const fragments = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "assistant_message" && typeof value.text === "string") fragments.push(value.text);
    if (Array.isArray(value)) value.forEach(visit); else Object.values(value).forEach(visit);
  };
  messages.forEach(visit); return fragments.join("");
}
let terminalId, agentId;
try {
  await until(() => opened, "connexion au dashboard");
  await until(() => state, "état initial");
  send({ type: "launch.options", host: "local" });
  const options = await receive((m) => m.type === "launch.options", "options du daemon local");
  const providerIds = options.providers.map((p) => p.id);
  for (const id of ["claude-openrouter", "claude-nvidia"]) {
    const provider = options.providers.find((p) => p.id === id);
    if (!provider || !provider.models.length || !provider.models.some((m) => /sonnet/i.test(m.id))) fail(`Fournisseur/modèles Sonnet manquant : ${id}`);
  }
  console.log("OPTIONS_OK", JSON.stringify(options.providers.filter((p) => ["claude-openrouter", "claude-nvidia"].includes(p.id)).map((p) => ({ id: p.id, status: p.status, available: p.available, sonnetModels: p.models.filter((m) => /sonnet/i.test(m.id)).map((m) => m.id) }))));

  const cwd = `${root}\\sandbox-repo`, token = `PASEO_${randomBytes(5).toString("hex")}`;
  send({ type: "launch.start", host: "local", cwd, kind: "terminal" });
  const startedTerm = await receive((m) => m.type === "launch.started" && m.kind === "terminal", "création du terminal");
  terminalId = startedTerm.terminalId; send({ type: "term.open", host: "local", terminalId, rows: 24, cols: 80 });
  await delay(700); send({ type: "term.input", host: "local", terminalId, data: `echo ${token}\r` });
  await until(() => terminalText.join("").includes(token), "sortie echo du terminal");
  console.log("TERMINAL_OK", JSON.stringify({ host: "local", cwd, terminalId, echoed: token }));

  const pongPrompt = "Reply with the single word PONG and do nothing else.";
  send({ type: "launch.start", host: "local", cwd, kind: "agent", provider: "claude-openrouter", model: "sonnet", title: "Vérification dashboard v2", prompt: pongPrompt });
  const startedAgent = await receive((m) => m.type === "launch.started" && m.kind === "agent", "création de l'agent"); agentId = startedAgent.agentId;
  send({ type: "agent.watch", host: "local", agentId });
  await until(() => assistantText(history.filter((m) => m.type === "agent.event" && m.agentId === agentId)).includes("PONG"), "réponse PONG du premier tour", 120000);
  console.log("AGENT_LIVE_PONG", JSON.stringify({ agentId, timelineText: assistantText(history.filter((m) => m.type === "agent.event" && m.agentId === agentId)) }));
  await until(() => history.some((m) => m.type === "agent.event" && m.agentId === agentId && m.event?.event?.type === "turn_completed"), "fin du premier tour");
  await until(() => state?.agents?.some((a) => a.host === "local" && a.agentId === agentId), "agent dans state.agents");
  const agent = state.agents.find((a) => a.host === "local" && a.agentId === agentId);
  if (!("parentAgentId" in agent)) fail("parentAgentId absent du state");
  console.log("AGENT_STATE_OK", JSON.stringify({ agentId, provider: agent.provider, model: agent.model, status: agent.status, cwd: agent.cwd, parentAgentId: agent.parentAgentId }));

  send({ type: "agent.send", host: "local", agentId, text: pongPrompt });
  const startSeq = history.length;
  await until(() => assistantText(history.slice(startSeq).filter((m) => m.type === "agent.event" && m.agentId === agentId)).includes("PONG") && history.slice(startSeq).some((m) => m.type === "agent.event" && m.agentId === agentId && m.event?.event?.type === "turn_completed"), "deuxième réponse PONG", 120000);
  console.log("AGENT_SECOND_REPLY_OK", JSON.stringify({ agentId, reply: "PONG" }));
  console.log("AGENT_TIMELINE_OK", JSON.stringify(history.filter((m) => m.agentId === agentId).map((m) => m.type === "agent.event" ? m.event?.event?.item?.type || m.event?.event?.type : m.type)));
} finally {
  if (agentId && opened) { try { send({ type: "agent.unwatch", host: "local", agentId }); await delay(100); } catch {} }
  if (agentId) { try { const { createPaseoApi } = await import("@getpaseo/client"); const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client"); const daemon = new DaemonClient({ url: "ws://127.0.0.1:6767/ws", clientId: `paseo-verify-cleanup-${Date.now()}`, clientType: "cli", reconnect: { enabled: false } }); await daemon.connect(); const api = createPaseoApi(daemon); await api.agents.ref(agentId).archive(); await api.dispose(); await daemon.close(); console.log("CLEANUP_AGENT_ARCHIVED", agentId); } catch (e) { console.log("CLEANUP_AGENT_ERROR", e.message); } }
  if (terminalId && opened) { try { send({ type: "term.kill", host: "local", terminalId }); await delay(400); console.log("CLEANUP_TERMINAL_KILLED", terminalId); } catch (e) { console.log("CLEANUP_TERMINAL_ERROR", e.message); } }
  socket.close();
}

const port = 17000 + Math.floor(Math.random() * 1000), bin = process.execPath;
async function launchSecurity(env) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["dashboard/server.mjs"], { cwd: root, env: { ...process.env, DASHBOARD_HOST: "0.0.0.0", DASHBOARD_PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => output += d);
    const exitPromise = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
    child.once("spawn", () => resolve({ child, output: () => output, exitPromise }));
    child.once("error", (error) => resolve({ child, output: () => `${output}${error.message}`, exitPromise }));
  });
}
async function waitForOutput(readOutput, needle, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (readOutput().includes(needle)) return; await delay(100); }
  fail(`Délai dépassé : ${needle}. Sortie : ${readOutput().trim()}`);
}
const denied = await launchSecurity({ DASHBOARD_PASSWORD: "" });
const deniedChild = denied.child;
const deniedExit = await denied.exitPromise, deniedText = denied.output();
console.log("SECURITY_NO_PASSWORD", JSON.stringify({ exitCode: deniedExit.code, output: deniedText.trim() }));
if (deniedExit.code !== 1) fail("Le serveur réseau sans mot de passe n'a pas refusé le démarrage");
const secure = await launchSecurity({ DASHBOARD_PASSWORD: "verify-secret" });
const secureChild = secure.child;
try {
  await waitForOutput(secure.output, "Paseo dashboard");
  const testUrl = `ws://127.0.0.1:${port}/ui`, origin = `http://127.0.0.1:${port}`;
  const rejected = await new Promise((resolve) => { const ws = new WebSocket(testUrl, { origin }); ws.once("open", () => { ws.close(); resolve("open"); }); ws.once("unexpected-response", (_req, res) => resolve(String(res.statusCode))); ws.once("error", () => resolve("refused")); });
  const allowed = await new Promise((resolve) => { const ws = new WebSocket(testUrl, { origin, headers: { Authorization: `Basic ${Buffer.from("admin:verify-secret").toString("base64")}` } }); ws.once("open", () => { ws.close(); resolve("open"); }); ws.once("unexpected-response", (_req, res) => resolve(String(res.statusCode))); ws.once("error", () => resolve("refused")); });
  const badOrigin = await new Promise((resolve) => { const ws = new WebSocket(testUrl, { origin: "http://attacker.invalid", headers: { Authorization: `Basic ${Buffer.from("admin:verify-secret").toString("base64")}` } }); ws.once("open", () => { ws.close(); resolve("open"); }); ws.once("unexpected-response", (_req, res) => resolve(String(res.statusCode))); ws.once("error", () => resolve("refused")); });
  const httpUnauth = (await fetch(`http://127.0.0.1:${port}/`)).status;
  const httpAuth = (await fetch(`http://127.0.0.1:${port}/`, { headers: { Authorization: `Basic ${Buffer.from("admin:verify-secret").toString("base64")}` } })).status;
  console.log("SECURITY_HTTP", JSON.stringify({ withoutCredentials: httpUnauth, withCredentials: httpAuth }));
  console.log("SECURITY_WEBSOCKET", JSON.stringify({ withoutCredentials: rejected, withCredentials: allowed, wrongOrigin: badOrigin }));
  if (rejected === "open" || allowed !== "open") fail("Contrôle Basic Auth WebSocket inattendu");
  if (badOrigin === "open") fail("Origine WebSocket non autorisée");
  if (httpUnauth !== 401 || httpAuth !== 200) fail("Contrôle Basic Auth HTTP inattendu");
} finally { secureChild.kill(); const exit = await secure.exitPromise; console.log("SECURITY_INSTANCE_STOPPED", JSON.stringify({ stopped: true, signal: exit.signal })); }
