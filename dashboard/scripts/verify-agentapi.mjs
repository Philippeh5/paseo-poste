// Vérifie l'API de contrôle agent (handlers/agentapi.mjs) avec de vraies sessions claude-openrouter/sonnet.
// Usage : node dashboard/scripts/verify-agentapi.mjs
// Lance ses propres instances (7074 sans mot de passe, 7075 avec mot de passe, 7076 pour la rotation du journal),
// toutes avec un dossier de données jetable (.foreman/scratch/t17-*), puis les arrête (seuls leurs PID sont tués).
// Lectures seules en plus contre le serveur réel (AGENTAPI_PROD_URL, défaut http://127.0.0.1:7070).
// Tout ce que le test crée porte le préfixe « VERIF-T17 » et est supprimé à la fin (tâches, agents, terminal, fichier).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readJson } from "../lib/store.mjs";

const dashboardDir = fileURLToPath(new URL("../", import.meta.url));
const scratch = fileURLToPath(new URL("../../.foreman/scratch/", import.meta.url));
const SANDBOX = process.env.VERIFY_SANDBOX || "D:/Projets/AI-OS/paseo-lab/sandbox-repo";
const ENGINE = "claude-openrouter/sonnet";
const PONG = "Reply with the single word PONG and do nothing else.";
const PREFIX = "VERIF-T17";
const PROD = process.env.AGENTAPI_PROD_URL || "http://127.0.0.1:7070";
const PASSWORD = `pw-t17-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const children = [];
const agentsToDelete = new Set();
const sockets = [];
let terminal = null;
let passed = 0;

const expect = (condition, label, detail = "") => {
  if (!condition) throw new Error(`ÉCHEC : ${label} ${detail}`);
  passed += 1;
  console.log(`  ok  ${label}`);
};
const show = (label, value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`  >>  ${label} : ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
};

function startServer(port, dataName, env = {}) {
  const dataDir = `${scratch}${dataName}`;
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  return { port, dataDir, base: `http://127.0.0.1:${port}`, env };
}
async function boot(server, preseed) {
  if (preseed) preseed(server.dataDir);
  const log = `${scratch}${server.dataDir.split(/[\\/]/).pop()}.log`;
  const child = spawn(process.execPath, [`${dashboardDir}server.mjs`], {
    env: {
      ...process.env,
      DASHBOARD_PORT: String(server.port),
      DASHBOARD_DATA_DIR: server.dataDir,
      DASHBOARD_HOST: "127.0.0.1",
      ...server.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const chunks = [];
  child.stdout.on("data", (d) => chunks.push(d));
  child.stderr.on("data", (d) => chunks.push(d));
  child.on("exit", () => writeFileSync(log, Buffer.concat(chunks)));
  server.child = child;
  const auth = server.env.DASHBOARD_PASSWORD
    ? { Authorization: `Basic ${Buffer.from(`admin:${server.env.DASHBOARD_PASSWORD}`).toString("base64")}` }
    : {};
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${server.base}/api/v1/summary`, { headers: auth });
      if (r.status === 200 || r.status === 401) return;
    } catch {
      /* pas encore prêt */
    }
    await delay(250);
  }
  throw new Error(`le serveur ${server.port} ne démarre pas`);
}

const apiOf =
  (server, extra = {}) =>
  async (method, path, body, headers = {}) => {
    const auth = server.env.DASHBOARD_PASSWORD
      ? { Authorization: `Basic ${Buffer.from(`admin:${server.env.DASHBOARD_PASSWORD}`).toString("base64")}` }
      : {};
    const t0 = performance.now();
    const response = await fetch(`${server.base}/api/v1${path}`, {
      method,
      headers: {
        "X-Agent-Name": "verify-t17",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...auth,
        ...extra,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ms = Math.round(performance.now() - t0);
    let json = null;
    try {
      json = await response.json();
    } catch {
      /* corps non JSON */
    }
    return { status: response.status, json, data: json?.data, ms };
  };

function rawRequest(server, path, headers) {
  return new Promise((resolveRaw, rejectRaw) => {
    const req = httpRequest({ host: "127.0.0.1", port: server.port, path, method: "GET", headers }, (res) => {
      let text = "";
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () => resolveRaw({ status: res.statusCode, text }));
    });
    req.on("error", rejectRaw);
    req.end();
  });
}

async function waitFor(label, fn, timeoutMs = 90000, step = 700) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(step);
  }
  throw new Error(`délai dépassé : ${label}`);
}

// Flux SSE minimal : collecte les événements { event, data, id }.
async function openSse(server, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/v1/events`, { headers, signal: controller.signal });
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const ev = {};
          for (const line of block.split("\n")) {
            const i = line.indexOf(":");
            if (i > 0) ev[line.slice(0, i)] = line.slice(i + 1).trim();
          }
          if (ev.event) {
            try {
              ev.json = JSON.parse(ev.data);
            } catch {
              /* sans données */
            }
            events.push(ev);
          }
        }
      }
    } catch {
      /* fermé */
    }
  })();
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    events,
    close: () => controller.abort(),
  };
}

// Petit client WebSocket du navigateur (modes de lancement, terminal de test).
function openUi(server) {
  return new Promise((resolveUi, rejectUi) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ui`, { origin: server.base });
    sockets.push(ws);
    const inbox = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    ws.on("error", rejectUi);
    ws.on("open", () =>
      resolveUi({
        ws,
        inbox,
        request: async (message, type, ms = 20000) => {
          const from = inbox.length;
          ws.send(JSON.stringify(message));
          return waitFor(type, () => inbox.slice(from).find((m) => m.type === type || m.type === "error"), ms, 100);
        },
      }),
    );
  });
}

// CLI postectl (processus réel) et serveur MCP (JSON-RPC sur stdio) contre l'instance de test.
async function verifyClients(server) {
  const toolsDir = fileURLToPath(new URL("../../tools/", import.meta.url));
  const env = { ...process.env, POSTECTL_URL: server.base, POSTECTL_AGENT: "verify-t17-cli" };
  const ctl = (...args) => spawnSync(process.execPath, [`${toolsDir}postectl.mjs`, ...args], { env, encoding: "utf8" });

  console.log("\n[12a] postectl");
  const help = ctl("--help");
  expect(help.status === 0 && /Usage : postectl/.test(help.stdout), "--help en français");
  const summary = ctl("summary");
  show("postectl summary", summary.stdout);
  expect(summary.status === 0 && /Sessions :/.test(summary.stdout), "summary lisible");
  const summaryJson = JSON.parse(ctl("summary", "--json").stdout);
  expect(Boolean(summaryJson.sessions && summaryJson.tasks), "summary --json");
  const sessions = ctl("sessions", "--host", "local", "--status", "idle");
  expect(sessions.status === 0 && /HÔTE/.test(sessions.stdout), "sessions --host --status");
  const added = ctl("task", "add", `${PREFIX} cli`, "--project", SANDBOX, "--engine", ENGINE, "--description", PONG);
  show("postectl task add", added.stdout);
  expect(added.status === 0 && /tâche créée/.test(added.stdout), "task add");
  const tasks = ctl("tasks");
  show("postectl tasks", tasks.stdout);
  const created = JSON.parse(ctl("tasks", "--json").stdout).tasks.find((t) => t.title === `${PREFIX} cli`);
  expect(Boolean(created) && tasks.stdout.includes(created.id.slice(0, 8)), "tasks liste la tâche créée");
  const move = ctl("task", "move", created.id.slice(0, 8), "blocked");
  expect(move.status === 0 && /Bloquée/.test(move.stdout), "task move (identifiant abrégé)");
  const closed = ctl("task", "close", created.id.slice(0, 8));
  show("postectl task close", closed.stdout);
  expect(closed.status === 0 && /Terminé/.test(closed.stdout), "task close");
  const noConfirm = ctl("task", "delete", created.id);
  show("postectl task delete (sans --confirm)", `${noConfirm.stderr.trim()} [code ${noConfirm.status}]`);
  expect(noConfirm.status === 1 && /confirm/.test(noConfirm.stderr), "task delete sans --confirm refusé (code 1)");
  const deleted = ctl("task", "delete", created.id, "--confirm");
  expect(deleted.status === 0, "task delete --confirm");
  const inbox = ctl("inbox", "--unread");
  show("postectl inbox --unread", inbox.stdout);
  expect(inbox.status === 0 && /non lu/.test(inbox.stdout), "inbox --unread");
  expect(ctl("projects").status === 0, "projects");
  const usage = ctl("task", "move");
  expect(usage.status === 2, "mauvais usage : code 2", String(usage.status));
  const unreachable = spawnSync(process.execPath, [`${toolsDir}postectl.mjs`, "summary"], {
    env: { ...process.env, POSTECTL_URL: "http://127.0.0.1:1" },
    encoding: "utf8",
  });
  expect(unreachable.status === 3 && /injoignable/.test(unreachable.stderr), "poste injoignable : code 3");

  console.log("\n[12b] serveur MCP (JSON-RPC sur stdio)");
  const child = spawn(process.execPath, [`${toolsDir}postectl-mcp.mjs`], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolveRpc, rejectRpc) => {
      const id = nextId++;
      const request = { jsonrpc: "2.0", id, method, params };
      console.log(`  --> ${JSON.stringify(request).slice(0, 300)}`);
      const timer = setTimeout(() => rejectRpc(new Error(`MCP : pas de réponse à ${method}`)), 20000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        console.log(`  <-- ${JSON.stringify(message).slice(0, 400)}`);
        resolveRpc(message);
      });
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  const callTool = (name, args) => rpc("tools/call", { name, arguments: args });
  const textOf = (r) => r.result?.content?.[0]?.text || "";

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "verify-t17", version: "1.0.0" },
  });
  expect(init.result?.serverInfo?.name === "postectl", "initialize : serveur postectl");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  show("outils", names);
  for (const wanted of [
    "post_summary",
    "post_list_sessions",
    "post_close_session",
    "post_list_tasks",
    "post_update_task",
    "post_close_task",
    "post_restart_task",
    "post_inbox_list",
    "post_inbox_decide",
    "post_follow_project",
    "post_unfollow_project",
  ]) {
    expect(names.includes(wanted), `outil ${wanted}`);
  }
  expect(
    list.result.tools.every((t) => t.inputSchema.additionalProperties === false && t.description),
    "schémas stricts (additionalProperties:false) et descriptions",
  );
  const sum = await callTool("post_summary", {});
  expect(!sum.result.isError && JSON.parse(textOf(sum)).sessions, "post_summary");
  const made = await callTool("post_create_task", { title: `${PREFIX} mcp`, project: SANDBOX, engine: ENGINE });
  const taskId = JSON.parse(textOf(made)).task.id;
  expect(Boolean(taskId), "post_create_task");
  const moved = await callTool("post_update_task", { id: taskId.slice(0, 8), status: "blocked", description: "mcp" });
  expect(JSON.parse(textOf(moved)).task.status === "blocked", "post_update_task (champs + colonne)");
  const refused = await callTool("post_close_task", { id: taskId });
  expect(refused.result.isError === true && /confirm/.test(textOf(refused)), "post_close_task sans confirm : refusé");
  const falseConfirm = await callTool("post_close_task", { id: taskId, confirm: false });
  expect(falseConfirm.result.isError === true, "post_close_task confirm:false : refusé");
  expect(textOf(await callTool("post_list_tasks", {})).includes(taskId), "tâche toujours présente");
  const accepted = await callTool("post_close_task", { id: taskId, confirm: true });
  expect(JSON.parse(textOf(accepted)).task.status === "done", "post_close_task confirm:true : exécuté");
  const unknownParam = await callTool("post_list_tasks", { bogus: 1 });
  expect(unknownParam.result.isError === true, "paramètre inconnu refusé (schéma strict)");
  const noDelete = await callTool("post_delete_task", { id: taskId, confirm: false });
  expect(noDelete.result.isError === true, "post_delete_task sans confirmation refusé");
  const yesDelete = await callTool("post_delete_task", { id: taskId, confirm: true });
  expect(!yesDelete.result.isError, "post_delete_task confirm:true");
  const inboxList = await callTool("post_inbox_list", { unread: true });
  expect(!inboxList.result.isError, "post_inbox_list");
  child.kill();
}

async function main() {
  mkdirSync(scratch, { recursive: true });
  const main = startServer(7074, "t17-data-main");
  const secured = startServer(7075, "t17-data-secured", { DASHBOARD_PASSWORD: PASSWORD });
  const rotate = startServer(7076, "t17-data-rotate");
  await Promise.all([
    boot(main),
    boot(secured),
    boot(rotate, (dir) => {
      writeFileSync(`${dir}/agent-audit.jsonl`, `${'{"seed":1}\n'.repeat(4999)}`);
    }),
  ]);
  const api = apiOf(main);
  const created = []; // identifiants de tâches à supprimer en fin de test
  await delay(2500); // premier cycle d'état

  // ---------- 1. Résumé ----------
  console.log("\n[1] summary");
  const s1 = await api("GET", "/summary");
  show("GET /summary", s1.json);
  expect(s1.status === 200 && s1.json.ok === true, "summary : 200 {ok:true,data}");
  for (const key of ["machines", "sessions", "tasks", "inbox", "pendingPermissions", "projects"]) {
    expect(key in s1.data, `summary : clé ${key}`);
  }
  expect(
    ["active", "waitingPermission", "idle", "error"].every((k) => k in s1.data.sessions),
    "summary : sessions par statut",
  );
  expect(
    ["todo", "doing", "review", "done", "blocked"].every((k) => k in s1.data.tasks),
    "summary : tâches par colonne",
  );
  expect(
    s1.data.machines.length >= 1 && s1.data.machines[0].name && s1.data.machines[0].status,
    "summary : machines (nom, état)",
  );
  const times = [];
  for (let i = 0; i < 8; i += 1) times.push((await api("GET", "/summary")).ms);
  show("durées summary (ms)", times);
  show("durée summary?fresh=1 (reconstruction de l'état, ms)", (await api("GET", "/summary?fresh=1")).ms);
  expect(Math.max(...times) < 300, "summary < 300 ms (8 appels)", String(Math.max(...times)));

  // ---------- 2. Lectures ----------
  console.log("\n[2] lectures");
  const rs = await api("GET", "/sessions");
  expect(
    rs.status === 200 && Array.isArray(rs.data.sessions) && rs.data.sessions.length > 0,
    "GET /sessions",
    String(rs.data?.sessions?.length),
  );
  const hostFiltered = await api("GET", "/sessions?host=local&status=idle");
  expect(
    hostFiltered.data.sessions.every((x) => x.host === "local" && x.group === "idle"),
    "filtre hôte+statut",
  );
  expect((await api("GET", "/tasks")).data.tasks.length === 0, "GET /tasks (base jetable vide)");
  expect(Array.isArray((await api("GET", "/inbox")).data.items), "GET /inbox");
  expect((await api("GET", "/inbox?unread=1")).status === 200, "GET /inbox?unread=1");
  expect(Array.isArray((await api("GET", "/projects")).data.projects), "GET /projects");
  expect(Array.isArray((await api("GET", "/windows")).data.windows), "GET /windows");
  const unknown = await api("GET", "/nope");
  expect(
    unknown.status === 404 && unknown.json.ok === false,
    "route inconnue : 404 {ok:false,error}",
    JSON.stringify(unknown.json),
  );
  const wrongMethod = await api("PUT", "/tasks");
  expect(wrongMethod.status === 405, "mauvaise méthode : 405", String(wrongMethod.status));

  // ---------- 3. Sécurité : origine, hôte ----------
  console.log("\n[3] origine et hôte");
  const foreign = await api("GET", "/summary", undefined, { Origin: "http://evil.example" });
  show("Origin étranger", foreign.json);
  expect(foreign.status === 403, "Origin étranger refusé (GET)");
  const foreignPost = await api("POST", "/tasks", { title: "x" }, { Origin: "http://evil.example" });
  expect(foreignPost.status === 403, "Origin étranger refusé (POST)");
  expect((await api("GET", "/summary", undefined, { Origin: main.base })).status === 200, "Origin identique accepté");
  const rebind = await rawRequest(main, "/api/v1/summary", { Host: "evil.example" });
  expect(rebind.status === 403, "nom d'hôte non local refusé (DNS rebinding)", String(rebind.status));

  // ---------- 4. Mot de passe ----------
  console.log("\n[4] mot de passe (instance 7075)");
  const noAuth = await fetch(`${secured.base}/api/v1/summary`);
  expect(noAuth.status === 401, "sans identifiants : 401");
  const wrong = await fetch(`${secured.base}/api/v1/summary`, {
    headers: { Authorization: `Basic ${Buffer.from("admin:mauvais").toString("base64")}` },
  });
  expect(wrong.status === 401, "mauvais mot de passe : 401");
  const securedApi = apiOf(secured);
  expect((await securedApi("GET", "/summary")).status === 200, "bons identifiants : 200");
  expect(
    (await securedApi("GET", "/summary", undefined, { Origin: "http://evil.example" })).status === 403,
    "bons identifiants + Origin étranger : 403",
  );
  const securedWrite = await securedApi("POST", "/tasks", { title: `${PREFIX} mot de passe`, description: PASSWORD });
  expect(securedWrite.status === 200, "écriture authentifiée acceptée", JSON.stringify(securedWrite.json));
  await securedApi("DELETE", `/tasks/${securedWrite.data.task.id}?confirm=true`);

  // ---------- 5. Flux SSE + delta ----------
  console.log("\n[5] changements");
  const sse = await openSse(main);
  expect(sse.status === 200 && /text\/event-stream/.test(sse.type), "SSE : text/event-stream");
  await waitFor("hello SSE", () => sse.events.find((e) => e.event === "hello"), 5000, 50);
  const base = (await api("GET", "/changes")).data;
  show("GET /changes sans since", base);
  expect(base.reset === true && Number.isInteger(base.cursor), "changes sans since : curseur + reset");
  const taskA = await api("POST", "/tasks", {
    title: `${PREFIX} A`,
    description: PONG,
    project: SANDBOX,
    engine: ENGINE,
  });
  show("POST /tasks", taskA.json);
  expect(taskA.status === 200 && taskA.data.task.status === "todo", "POST /tasks : créée en À faire");
  const A = taskA.data.task;
  created.push(A.id);
  const delta = (await api("GET", `/changes?since=${base.cursor}`)).data;
  show("GET /changes?since=", delta);
  expect(
    delta.changes.some((c) => c.kind === "task" && c.id === A.id && c.op === "upsert"),
    "delta : la tâche créée apparaît",
  );
  expect(delta.cursor > base.cursor, "delta : le curseur avance");
  const none = (await api("GET", `/changes?since=${delta.cursor}`)).data;
  expect(none.changes.length === 0, "delta suivant vide");
  const byDate = (await api("GET", `/changes?since=${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}`))
    .data;
  expect(
    byDate.changes.some((c) => c.id === A.id),
    "since = date ISO",
  );
  const sseTask = await waitFor(
    "événement SSE de création",
    () => sse.events.find((e) => e.event === "change" && e.json.kind === "task" && e.json.id === A.id),
    8000,
    100,
  );
  show("événement SSE", sseTask.data);
  expect(Boolean(sseTask), "SSE : événement reçu à la création d'une tâche");

  // ---------- 6. Cycle de vie d'une tâche avec un vrai agent ----------
  console.log("\n[6] tâche : modifier, déplacer, démarrer, fermer, relancer, supprimer");
  const patched = await api("PATCH", `/tasks/${A.id}`, { title: `${PREFIX} A (renommée)` });
  expect(patched.data.task.title.endsWith("(renommée)"), "PATCH : titre modifié");
  const badPatch = await api("PATCH", `/tasks/${A.id}`, { engine: "pas bon" });
  expect(badPatch.status === 400, "PATCH invalide refusé par la validation du handler", JSON.stringify(badPatch.json));
  const badMove = await api("POST", `/tasks/${A.id}/move`, { status: "doing" });
  show("move doing sans session", badMove.json);
  expect(badMove.status === 400, "move vers « En cours » refusé sans session (garde-fou réutilisé)");
  const moved = await api("POST", `/tasks/${A.id}/move`, { status: "blocked" });
  expect(moved.data.task.status === "blocked", "move : bloquée");
  expect(
    (await api("POST", `/tasks/${A.id}/move`, { status: "todo" })).data.task.status === "todo",
    "move : retour À faire",
  );
  const started = await api("POST", `/tasks/${A.id}/start`);
  show("POST /start", started.json);
  expect(
    started.status === 200 && started.data.task.status === "doing" && started.data.task.agentId,
    "start : En cours + agent",
  );
  const agentId1 = started.data.task.agentId;
  agentsToDelete.add(agentId1);
  const reviewed = await waitFor(
    "tâche en review (PONG)",
    async () => {
      const t = (await api("GET", "/tasks")).data.tasks.find((x) => x.id === A.id);
      return t.status === "review" ? t : null;
    },
    150000,
    1500,
  );
  expect(/PONG/.test(reviewed.summary), "tâche en À valider avec résumé PONG", reviewed.summary);

  // Détail de session, message, fermeture (archive).
  const detail = await api("GET", `/sessions/local/${agentId1}`);
  show("GET /sessions/local/:id", detail.json);
  expect(detail.status === 200 && detail.data.session.taskId === A.id, "détail de session lié à la tâche");
  expect(
    detail.data.messages.some((m) => /PONG/.test(m.text || "")),
    "détail : derniers messages contiennent PONG",
  );
  const emptyText = await api("POST", `/sessions/local/${agentId1}/send`, { text: "  " });
  expect(emptyText.status === 400, "send sans texte refusé");
  const bulk = await api("POST", "/sessions/close", { sessions: [{ host: "local", id: agentId1 }] });
  expect(bulk.status === 400 && bulk.json.error.code === "confirm_required", "fermeture en masse sans confirm refusée");
  const unknownSession = await api("POST", "/sessions/local/inexistante/close");
  expect(unknownSession.status === 404, "fermer une session inconnue : 404");

  const closedTask = await api("POST", `/tasks/${A.id}/close`);
  expect(closedTask.data.task.status === "done", "close : tâche Terminée");
  const restarted = await api("POST", `/tasks/${A.id}/restart`);
  show("POST /restart", restarted.json);
  expect(restarted.status === 200 && restarted.data.task.status === "doing", "restart : de nouveau En cours");
  const agentId2 = restarted.data.task.agentId;
  agentsToDelete.add(agentId2);
  expect(agentId2 && agentId2 !== agentId1, "restart : nouvelle session", `${agentId1} -> ${agentId2}`);
  const closeDoing = await api("POST", `/tasks/${A.id}/close`);
  expect(closeDoing.data.task.status === "done", "close d'une tâche en cours : arrête puis termine");

  const closedSession = await api("POST", `/sessions/local/${agentId1}/close`);
  show("POST /sessions/.../close", closedSession.json);
  expect(closedSession.status === 200 && closedSession.data.closed === true, "fermeture (archivage) d'une session");
  await api("GET", "/summary?fresh=1");
  const after = (await api("GET", "/sessions?host=local")).data.sessions.find((x) => x.id === agentId1);
  show("session après fermeture", after || "absente de la liste");
  expect(!after || after.status === "closed", "la session fermée n'est plus active");

  const refusedDelete = await api("DELETE", `/tasks/${A.id}`);
  show("DELETE sans confirm", refusedDelete.json);
  expect(
    refusedDelete.status === 400 && refusedDelete.json.error.code === "confirm_required",
    "DELETE sans confirm refusé",
  );
  expect(
    (await api("GET", "/tasks")).data.tasks.some((x) => x.id === A.id),
    "la tâche existe toujours",
  );
  const deleted = await api("DELETE", `/tasks/${A.id}?confirm=true`);
  expect(deleted.status === 200 && deleted.data.deleted === true, "DELETE ?confirm=true accepté");
  expect(!(await api("GET", "/tasks")).data.tasks.some((x) => x.id === A.id), "la tâche a disparu");
  created.length = 0;
  const sseDelete = await waitFor(
    "événement SSE de suppression",
    () => sse.events.find((e) => e.event === "change" && e.json.id === A.id && e.json.op === "delete"),
    8000,
    100,
  );
  expect(Boolean(sseDelete), "SSE : événement de suppression");
  const sseKinds = new Set(sse.events.filter((e) => e.event === "change").map((e) => e.json.kind));
  show("SSE : types d'événements reçus", [...sseKinds]);
  expect(sseKinds.has("task") && sseKinds.has("session"), "SSE : tâches et sessions diffusées");
  const replay = await openSse(main, { "Last-Event-ID": String(base.cursor) });
  await delay(600);
  expect(
    replay.events.some((e) => e.event === "change"),
    "SSE : reprise depuis Last-Event-ID",
  );
  replay.close();
  sse.close();

  // ---------- 7. Boîte de réception : permission réelle ----------
  console.log("\n[7] boîte de réception : approuver une vraie permission");
  const ui = await openUi(main);
  const options = await ui.request({ type: "launch.options", host: "local" }, "launch.options", 30000);
  const askMode = options.providers
    .find((p) => p.id === "claude-openrouter")
    ?.modes.find((x) => x.label === "Always Ask");
  expect(Boolean(askMode), "mode Always Ask disponible", askMode?.id);
  const file = `${SANDBOX}/t17-permission.txt`;
  const taskP = (
    await api("POST", "/tasks", {
      title: `${PREFIX} permission`,
      project: SANDBOX,
      engine: ENGINE,
      mode: askMode.id,
      description: `Create a file t17-permission.txt containing hi in ${SANDBOX}`,
    })
  ).data.task;
  created.push(taskP.id);
  const startedP = await api("POST", `/tasks/${taskP.id}/start`);
  expect(startedP.status === 200, "tâche Always Ask démarrée", JSON.stringify(startedP.json));
  agentsToDelete.add(startedP.data.task.agentId);
  const item = await waitFor(
    "élément de permission",
    async () => {
      const r = (await api("GET", "/inbox?unread=1")).data.items;
      return r.find((i) => i.kind === "permission" && i.agentId === startedP.data.task.agentId);
    },
    240000,
    500,
  );
  show("élément de boîte de réception", item);
  const sum2 = (await api("GET", "/summary")).data;
  expect(
    sum2.pendingPermissions.some((p) => p.sessionId === item.agentId),
    "summary : permission en attente listée",
  );
  expect(sum2.inbox.unread >= 1 && sum2.sessions.waitingPermission >= 1, "summary : compteurs permission / non lus");
  const notPerm = await api("POST", "/inbox/inb_inexistant/approve");
  expect(notPerm.status === 404, "approve d'un élément inconnu : 404");
  const approved = await api("POST", `/inbox/${item.id}/approve`, item.action.danger ? { confirm: true } : {});
  show("POST /inbox/:id/approve", approved.json);
  expect(approved.status === 200 && approved.data.decision === "allow", "approve : permission accordée");
  const afterApprove = await waitFor(
    "élément traité",
    async () => {
      const found = (await api("GET", "/inbox")).data.items.find((i) => i.id === item.id);
      return found?.status === "traité" ? found : null;
    },
    20000,
    400,
  );
  expect(Boolean(afterApprove), "l'élément passe à « traité »");
  const doneP = await waitFor(
    "tâche permission terminée",
    async () => {
      const t = (await api("GET", "/tasks")).data.tasks.find((x) => x.id === taskP.id);
      return t.status === "review" ? t : null;
    },
    180000,
    1500,
  );
  expect(existsSync(file), "l'agent a bien écrit le fichier après approbation", file);
  const again = await api("POST", `/inbox/${item.id}/approve`);
  expect(again.status === 409, "second approve refusé (déjà traité)");
  await api("POST", `/tasks/${taskP.id}/close`);
  await api("DELETE", `/tasks/${taskP.id}?confirm=true`);
  created.length = 0;
  const mark = await api("POST", "/inbox/mark", { all: true, status: "lu" });
  expect(mark.status === 200 && typeof mark.data.count === "number", "inbox/mark all", JSON.stringify(mark.data));
  expect((await api("GET", "/inbox?unread=1")).data.items.length === 0, "plus aucun élément non lu");
  expect((await api("POST", "/inbox/mark", {})).status === 400, "inbox/mark sans ids : 400");
  void doneP;

  // ---------- 8. Projets ----------
  console.log("\n[8] projets");
  const follow = await api("POST", "/projects/follow", { host: "local", dir: SANDBOX });
  show("POST /projects/follow", follow.json);
  expect(follow.status === 200 && follow.data.added.length + follow.data.already.length === 1, "follow");
  const listed = (await api("GET", "/projects")).data.projects;
  expect(
    listed.some((p) => p.dir.replace(/\\/g, "/").toLowerCase() === SANDBOX.toLowerCase()),
    "le projet est suivi",
  );
  expect((await api("GET", "/summary")).data.projects.length === 1, "summary : projets suivis");
  const badFollow = await api("POST", "/projects/follow", { host: "local", dir: "Z:/dossier/inexistant" });
  expect(badFollow.status === 400, "follow d'un dossier inexistant refusé", JSON.stringify(badFollow.json));
  const unfollow = await api("POST", "/projects/unfollow", { host: "local", dir: SANDBOX });
  expect(unfollow.status === 200 && unfollow.data.unfollowed, "unfollow");
  expect((await api("GET", "/projects")).data.projects.length === 0, "plus de projet suivi");

  // ---------- 9. Terminal : scrollback ----------
  console.log("\n[9] scrollback d'un terminal créé par le test");
  const state = await waitFor(
    "workspace local",
    () =>
      ui.inbox
        .findLast((m) => m.type === "state")
        ?.payload.workspaces.find(
          (w) => w.host === "local" && w.directory?.replace(/\\/g, "/").toLowerCase() === SANDBOX.toLowerCase(),
        ),
    15000,
    300,
  );
  const createdTerminal = await ui.request(
    { type: "term.create", host: "local", workspaceId: state.workspaceId },
    "term.created",
  );
  terminal = createdTerminal.terminalId;
  ui.ws.send(JSON.stringify({ type: "term.open", host: "local", terminalId: terminal }));
  await delay(1200);
  ui.ws.send(JSON.stringify({ type: "term.input", host: "local", terminalId: terminal, data: "echo T17-MARQUEUR\r" }));
  const scroll = await waitFor(
    "scrollback",
    async () => {
      const r = await api("GET", `/terminals/local/${terminal}/scrollback?lines=30`);
      return r.status === 200 && r.data.lines.some((l) => l.includes("T17-MARQUEUR")) ? r : null;
    },
    15000,
    600,
  );
  show("scrollback", scroll.data.lines.slice(-4));
  expect(Boolean(scroll), "scrollback contient la sortie du terminal");
  expect(
    (await api("GET", "/terminals/local/inexistant/scrollback")).status === 400,
    "scrollback d'un terminal inconnu refusé",
  );

  // ---------- 10. Journal d'audit ----------
  console.log("\n[10] journal d'audit");
  const auditText = readFileSync(`${main.dataDir}/agent-audit.jsonl`, "utf8");
  const lines = auditText
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  show("dernières lignes", lines.slice(-3));
  expect(lines.length >= 15, "le journal contient les écritures", String(lines.length));
  expect(
    lines.every((l) => l.t && l.method && l.route && l.actor === "verify-t17"),
    "chaque ligne : date, verbe, route, acteur X-Agent-Name",
  );
  expect(
    lines.some((l) => l.route.endsWith("/start")) && lines.some((l) => l.method === "DELETE"),
    "démarrage et suppression journalisés",
  );
  expect(!lines.some((l) => l.method === "GET"), "aucune lecture journalisée");
  const securedAudit = readFileSync(`${secured.dataDir}/agent-audit.jsonl`, "utf8");
  const b64 = Buffer.from(`admin:${PASSWORD}`).toString("base64");
  expect(
    securedAudit.length > 0 &&
      !securedAudit.includes(PASSWORD) &&
      !securedAudit.includes(b64) &&
      !/authorization/i.test(securedAudit),
    "journal de l'instance protégée : aucun secret ni en-tête d'authentification",
  );
  expect(!auditText.includes(PASSWORD) && !/authorization/i.test(auditText), "journal principal : aucun secret");

  // ---------- 11. Rotation à 5 000 lignes ----------
  console.log("\n[11] rotation du journal (instance 7076, 4 999 lignes pré-remplies)");
  const rapi = apiOf(rotate);
  await rapi("POST", "/tasks", {}); // refusée (titre manquant) mais journalisée : ligne 5 000
  await rapi("POST", "/tasks", {}); // déclenche la rotation
  const rotated = `${rotate.dataDir}/agent-audit.1.jsonl`;
  const rotatedLines = existsSync(rotated) ? readFileSync(rotated, "utf8").split("\n").filter(Boolean).length : 0;
  const freshLines = readFileSync(`${rotate.dataDir}/agent-audit.jsonl`, "utf8").split("\n").filter(Boolean).length;
  show("rotation", { rotatedLines, freshLines });
  expect(rotatedLines === 5000 && freshLines === 1, "rotation : 5 000 lignes archivées, nouveau journal à 1 ligne");

  // ---------- 12. CLI postectl et serveur MCP ----------
  await verifyClients(main);

  // ---------- 13. Lecture seule contre le serveur réel ----------
  console.log(`\n[13] lectures contre le serveur réel (${PROD})`);
  const prod = { base: PROD, env: {} };
  const papi = apiOf(prod);
  const ps = await papi("GET", "/summary");
  if (ps.status === 404) {
    show("serveur réel", "l'API n'est pas encore chargée sur ce serveur (à redémarrer)");
    expect(false, "le serveur réel expose /api/v1");
  }
  const ptimes = [ps.ms];
  for (let i = 0; i < 5; i += 1) ptimes.push((await papi("GET", "/summary")).ms);
  show("summary réel", {
    machines: ps.data.machines.map((m) => `${m.name}:${m.status}`),
    sessions: ps.data.sessions,
    tasks: ps.data.tasks,
    inbox: ps.data.inbox,
    projects: ps.data.projects.length,
    ms: ptimes,
  });
  for (const key of ["machines", "sessions", "tasks", "inbox", "pendingPermissions", "projects"]) {
    expect(key in ps.data, `réel : summary clé ${key}`);
  }
  expect(Math.max(...ptimes) < 300, "réel : summary < 300 ms", String(Math.max(...ptimes)));
  for (const path of ["/sessions", "/tasks", "/inbox", "/projects", "/windows", "/changes"]) {
    const r = await papi("GET", path);
    expect(r.status === 200 && r.json.ok, `réel : GET ${path}`, String(r.status));
  }

  console.log(`\nTOUT EST VERT : ${passed} vérifications`);
}

async function cleanup() {
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* ignoré */
    }
  }
  if (terminal || agentsToDelete.size) {
    const local = readJson((process.env.DASHBOARD_HOSTS_FILE || `${dashboardDir}hosts.json`), { hosts: [] }).hosts.find((h) => h.label === "local");
    const daemon = new DaemonClient({
      url: local.url,
      clientId: `verify-agentapi-${Date.now()}`,
      clientType: "cli",
      password: local.password || undefined,
    });
    try {
      await daemon.connect();
      if (terminal) await daemon.killTerminal(terminal).catch(() => {});
      for (const id of agentsToDelete) await daemon.deleteAgent(id).catch(() => {});
      console.log(`  nettoyage : ${agentsToDelete.size} agent(s) et ${terminal ? 1 : 0} terminal supprimé(s)`);
    } catch (e) {
      console.log(`  nettoyage des agents impossible : ${e.message}`);
    } finally {
      await daemon.close().catch(() => {});
    }
  }
  rmSync(`${SANDBOX}/t17-permission.txt`, { force: true });
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* déjà arrêté */
    }
  }
  await delay(500);
  for (const name of ["t17-data-main", "t17-data-secured", "t17-data-rotate"]) {
    rmSync(`${scratch}${name}`, { recursive: true, force: true });
  }
}

let code = 0;
try {
  await main();
} catch (e) {
  console.error(`\n${e.stack || e}`);
  code = 1;
}
await cleanup();
process.exit(code);
