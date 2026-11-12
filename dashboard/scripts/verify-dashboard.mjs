// Vérification du tableau de bord : création de terminal, exécution de commande, retour de sortie.
// Usage : node dashboard/scripts/verify-dashboard.mjs
// Variables : DASHBOARD_VERIFY_URL (fourni par le poste jetable), VERIFY_SANDBOX.
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const url = process.env.DASHBOARD_VERIFY_URL || "ws://127.0.0.1:7070/ui";
const sandbox = process.env.VERIFY_SANDBOX || "/tmp";
const origin = new URL(url).origin.replace("ws:", "http:").replace("wss:", "https:");

const socket = new WebSocket(url, { origin });
let shellTerminal = null;
let hostConnected = false;
let shellOutput = "";
let sawCanary = false;
let sawState = false;
const timeout = setTimeout(() => finish(2), 30000);

function finish(code = 0) {
  clearTimeout(timeout);
  socket.close();
  console.log(`PROOF_RESULT host=${hostConnected} state=${sawState} canary=${sawCanary}`);
  process.exitCode = code;
}

function sendLaunch() {
  const ref = "vd-" + Date.now().toString(36);
  socket.send(JSON.stringify({ type: "launch.start", host: "local", cwd: sandbox, kind: "terminal", ref }));
  return ref;
}

let launchRef = null;

socket.on("message", (buffer) => {
  const message = JSON.parse(buffer.toString());
  if (message.type === "state") {
    sawState = true;
    const state = message.payload;
    const host = state.hosts?.find((h) => h.label === "local");
    if (host && host.status === "connected") hostConnected = true;
    console.log("STATE", JSON.stringify({ hosts: state.hosts?.map((h) => ({ label: h.label, status: h.status })), terminals: state.terminals?.length }));
    if (!launchRef && hostConnected) launchRef = sendLaunch();
  } else if (message.type === "launch.started" && message.kind === "terminal" && message.ref === launchRef) {
    shellTerminal = message.terminalId;
    console.log("CREATED_SHELL", JSON.stringify({ terminalId: shellTerminal, workspaceId: message.workspaceId }));
    socket.send(JSON.stringify({ type: "term.open", host: "local", terminalId: shellTerminal, rows: 24, cols: 80 }));
    setTimeout(() => socket.send(JSON.stringify({ type: "term.input", host: "local", terminalId: shellTerminal, data: "echo CANARY_DASH\r" })), 1500);
  } else if (message.type === "term.output") {
    const text = Buffer.from(message.data, "base64").toString("utf8");
    if (message.terminalId === shellTerminal) {
      console.log("SHELL_OUTPUT", JSON.stringify(text));
      // Le terminal renvoie l'écho de la commande puis son résultat, parfois dans le même morceau : on cherche le résultat
      // (CANARY_DASH non précédé de « echo ») dans tout ce qui est arrivé, pas morceau par morceau.
      shellOutput += text;
      if (/(?<!echo )CANARY_DASH/.test(shellOutput)) sawCanary = true;
    }
    if (hostConnected && sawState && sawCanary) finish(0);
  } else if (message.type === "error") {
    console.log("UI_ERROR", message.message);
  }
});
socket.on("error", (error) => { console.log("WS_ERROR", error.message); finish(1); });
socket.on("open", () => {
  console.log("WS_OPEN");
});
