// Navigateur distant : un Chrome sans écran lancé SUR la machine, vu et piloté depuis le poste (flux d'images CDP, souris,
// clavier, copie de la sélection, collage de texte). Aucune installation : utilise google-chrome / chromium déjà présent.
// Profil persistant dans ~/.paseo-browser-profile (les connexions aux sites restent). Seuls http(s) et about:blank sont navigables.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { findBin } from "./connections.mjs";

export const PROFILE_DIR = process.env.PASEO_BROWSER_PROFILE || join(homedir(), ".paseo-browser-profile");
export const VIEW = { width: 1280, height: 800 };
export function safeUrl(input) {
  let u = String(input ?? "").trim();
  if (!u) throw new Error("Adresse vide.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error("Adresse invalide."); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Seules les adresses http(s) sont autorisées.");
  return parsed.toString();
}
export const chromeBin = () => process.env.PASEO_CHROME || ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((n) => findBin(n)).find(Boolean) || null;

// Environnement minimal du navigateur : aucun secret du poste (clés d'API, mots de passe) n'y fuit, et les variables de session
// d'un agent n'y perturbent pas le réseau de Chrome (constaté : avec l'environnement complet d'une session Claude, les pages http n'aboutissaient pas).
export const chromeEnv = (env = process.env) => Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR", "TMPDIR"].filter((k) => env[k]).map((k) => [k, env[k]]));

const KEYS = { Enter: [13, "\r"], Backspace: [8], Tab: [9], Escape: [27], Delete: [46], ArrowLeft: [37], ArrowUp: [38], ArrowRight: [39], ArrowDown: [40], Home: [36], End: [35], PageUp: [33], PageDown: [34] };
const MODS = (m) => (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);

export function createRemoteBrowser({ onFrame = () => {}, log = () => {}, bin = chromeBin(), profile = PROFILE_DIR, spawnFn = spawn } = {}) {
  let proc = null; let ws = null; let nextId = 1; let state = "stopped"; let url = "about:blank"; let title = "";
  const pending = new Map();

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Navigateur non démarré."));
    const id = nextId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error("Délai dépassé (navigateur).")); }, 15_000).unref?.();
  });

  async function start() {
    if (state === "running" || state === "starting") return status();
    if (!bin) throw new Error("Aucun Chrome/Chromium trouvé sur cette machine.");
    state = "starting";
    try {
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const port = 9300 + Math.floor(Math.random() * 600);
      proc = spawnFn(bin, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`, `--window-size=${VIEW.width},${VIEW.height}`, "--no-first-run", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "--no-default-browser-check", "about:blank"], { stdio: "ignore", env: chromeEnv() });
      proc.on("exit", () => { state = "stopped"; ws = null; proc = null; });
      let target = null;
      for (let i = 0; i < 50 && !target; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { /* pas encore prêt */ }
      }
      if (!target) throw new Error("Le navigateur n'a pas démarré à temps.");
      ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      ws.on("message", (raw) => {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
        if (m.method === "Page.screencastFrame") {
          onFrame({ data: m.params.data, width: m.params.metadata?.deviceWidth ?? VIEW.width, height: m.params.metadata?.deviceHeight ?? VIEW.height });
          send("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
        } else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) { url = m.params.frame.url; }
      });
      ws.on("close", () => { if (state === "running") state = "stopped"; });
      await send("Page.enable");
      await send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
      await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
      state = "running";
      log("rbrowser", "navigateur distant démarré");
    } catch (e) { stop(); throw e; }
    return status();
  }

  function stop() {
    state = "stopped";
    try { ws?.close(); } catch { /* déjà fermé */ }
    try { proc?.kill(); } catch { /* déjà arrêté */ }
    ws = null; proc = null;
    for (const [, p] of pending) p.reject(new Error("Navigateur arrêté."));
    pending.clear();
    return status();
  }

  const status = () => ({ state, url, title, view: VIEW, chrome: !!bin });
  const requireRunning = () => { if (state !== "running") throw new Error("Navigateur non démarré."); };

  async function navigate(input) { requireRunning(); const target = safeUrl(input); await send("Page.navigate", { url: target }); url = target; return status(); }
  async function history(dir) {
    requireRunning();
    const h = await send("Page.getNavigationHistory");
    const entry = h.entries[h.currentIndex + (dir === "back" ? -1 : 1)];
    if (entry) await send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }
  async function input(ev) {
    requireRunning();
    const x = Math.max(0, Math.min(VIEW.width, Number(ev.x) || 0)); const y = Math.max(0, Math.min(VIEW.height, Number(ev.y) || 0));
    const modifiers = MODS(ev);
    if (ev.kind === "mouse") {
      const type = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" }[ev.action];
      if (!type) throw new Error("Action souris inconnue.");
      return send("Input.dispatchMouseEvent", { type, x, y, button: ["left", "middle", "right"][ev.button] ?? "none", buttons: ev.action === "up" ? 0 : 1, clickCount: ev.action === "move" ? 0 : 1, modifiers });
    }
    if (ev.kind === "wheel") return send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(ev.dx) || 0, deltaY: Number(ev.dy) || 0, modifiers });
    if (ev.kind === "key") {
      const key = String(ev.key ?? "");
      const special = KEYS[key];
      if (special) {
        const base = { key, windowsVirtualKeyCode: special[0], nativeVirtualKeyCode: special[0], modifiers };
        await send("Input.dispatchKeyEvent", { type: special[1] ? "keyDown" : "rawKeyDown", ...base, ...(special[1] ? { text: special[1] } : {}) });
        return send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      }
      if (key.length === 1) {
        if (modifiers & 6) { // Ctrl/Meta + lettre : raccourcis (a, c, v, x…) laissés au navigateur
          const code = key.toUpperCase().charCodeAt(0);
          await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, windowsVirtualKeyCode: code, modifiers, commands: { a: ["selectAll"], c: ["copy"], x: ["cut"], v: ["paste"] }[key.toLowerCase()] });
          return send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers });
        }
        await send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key, modifiers });
        return send("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers });
      }
      throw new Error("Touche non gérée.");
    }
    throw new Error("Évènement inconnu.");
  }
  async function getSelection() {
    requireRunning();
    const r = await send("Runtime.evaluate", { expression: "String(window.getSelection())", returnByValue: true });
    return String(r?.result?.value ?? "").slice(0, 200_000);
  }
  async function paste(text) {
    requireRunning();
    const t = String(text ?? "");
    if (t.length > 20_000) throw new Error("Texte trop long (20 000 caractères au plus).");
    return send("Input.insertText", { text: t });
  }
  return { start, stop, status, navigate, history, input, getSelection, paste, _send: send };
}
