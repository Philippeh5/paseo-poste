// Connexion WebSocket unique vers /ui, avec reconnexion automatique.
const handlers = new Map();
const connectionListeners = new Set();
let ws = null;
let attempt = 0;
let connected = false;

function emit(type, message) {
  for (const key of [type, "*"]) for (const fn of handlers.get(key) || []) fn(message);
}
function setConnected(value) {
  connected = value;
  for (const fn of connectionListeners) fn(value);
}

export function connect() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${scheme}//${location.host}/ui`);
  ws.addEventListener("open", () => {
    attempt = 0;
    setConnected(true);
  });
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    emit(message.type, message);
  });
  ws.addEventListener("close", () => {
    if (connected) setConnected(false);
    attempt += 1;
    setTimeout(connect, Math.min(500 * 2 ** Math.min(attempt, 5), 10000));
  });
}

export function send(message) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

// on("state", fn) ; on("*", fn) pour tout recevoir. Renvoie une fonction de désabonnement.
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}

// fn(true|false) à chaque changement de connexion ; appelé aussitôt si déjà connecté.
export function onConnection(fn) {
  connectionListeners.add(fn);
  if (connected) fn(true);
  return () => connectionListeners.delete(fn);
}

export const isConnected = () => connected;
