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

export function createRemoteBrowser({ onFrame = () => {}, onChange = () => {}, log = () => {}, bin = chromeBin(), profile = PROFILE_DIR, spawnFn = spawn } = {}) {
  let proc = null; let port = 0; let nextId = 1; let state = "stopped"; let active = null; let poller = null; let tabList = [];
  const tabs = new Map(); // id -> { id, ws }
  const pending = new Map();

  const send = (method, params = {}, tabId = active) => new Promise((resolve, reject) => {
    const tab = tabs.get(tabId);
    if (!tab || tab.ws.readyState !== WebSocket.OPEN) return reject(new Error("Navigateur non démarré."));
    const id = nextId++; pending.set(id, { resolve, reject });
    tab.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error("Délai dépassé (navigateur).")); }, 15_000).unref?.();
  });
  const listTargets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page");

  async function attach(target) {
    if (tabs.has(target.id)) return;
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const tab = { id: target.id, ws }; tabs.set(target.id, tab);
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
      if (m.method === "Page.screencastFrame") {
        if (target.id === active) onFrame({ data: m.params.data, width: m.params.metadata?.deviceWidth ?? VIEW.width, height: m.params.metadata?.deviceHeight ?? VIEW.height });
        send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, target.id).catch(() => {});
      }
    });
    ws.on("close", () => { tabs.delete(target.id); });
    await send("Page.enable", {}, target.id);
    await send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false }, target.id);
  }

  async function refresh() {
    if (state !== "running") return;
    const targets = await listTargets();
    for (const t of targets) await attach(t).catch(() => {});
    const before = JSON.stringify(tabList);
    tabList = targets.filter((t) => tabs.has(t.id)).map((t) => ({ id: t.id, title: String(t.title || "").slice(0, 80), url: String(t.url || "") }));
    if (active && !tabList.some((t) => t.id === active)) { if (tabList[0]) await activate(tabList[0].id, false); else active = null; }
    if (JSON.stringify(tabList) !== before) onChange();
  }

  async function activate(id, notify = true) {
    if (!tabs.has(id)) throw new Error("Onglet inconnu.");
    if (active && active !== id && tabs.has(active)) await send("Page.stopScreencast", {}, active).catch(() => {});
    active = id;
    await send("Page.bringToFront", {}, id).catch(() => {});
    await send("Page.stopScreencast", {}, id).catch(() => {});
    await send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 }, id);
    if (notify) onChange();
  }

  async function start() {
    if (state === "running" || state === "starting") return status();
    if (!bin) throw new Error("Aucun Chrome/Chromium trouvé sur cette machine.");
    state = "starting";
    try {
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      port = 9300 + Math.floor(Math.random() * 600);
      proc = spawnFn(bin, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`, `--window-size=${VIEW.width},${VIEW.height}`, "--no-first-run", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), "--no-default-browser-check", "about:blank"], { stdio: "ignore", env: chromeEnv() });
      proc.on("exit", () => { state = "stopped"; proc = null; });
      let first = null;
      for (let i = 0; i < 50 && !first; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try { first = (await listTargets())[0]; } catch { /* pas encore prêt */ }
      }
      if (!first) throw new Error("Le navigateur n'a pas démarré à temps.");
      state = "running";
      await attach(first);
      await refresh();
      await activate(first.id, false);
      poller = setInterval(() => { refresh().catch(() => {}); }, 2000); poller.unref?.();
      log("rbrowser", "navigateur distant démarré");
    } catch (e) { stop(); throw e; }
    return status();
  }

  function stop() {
    state = "stopped";
    clearInterval(poller); poller = null;
    for (const [, t] of tabs) { try { t.ws.close(); } catch { /* déjà fermé */ } }
    tabs.clear(); tabList = []; active = null;
    try { proc?.kill(); } catch { /* déjà arrêté */ }
    proc = null;
    for (const [, p] of pending) p.reject(new Error("Navigateur arrêté."));
    pending.clear();
    return status();
  }

  const MAX_TABS = 8;
  async function openTab(input = "about:blank") {
    if (state !== "running") throw new Error("Navigateur non démarré.");
    if (tabList.length >= MAX_TABS) throw new Error(`${MAX_TABS} onglets au plus.`);
    const target = input === "about:blank" ? "about:blank" : safeUrl(input);
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(target)}`, { method: "PUT" });
    const t = await res.json();
    await attach(t); await refresh(); await activate(t.id);
    return status();
  }
  async function closeTab(id) {
    if (state !== "running") throw new Error("Navigateur non démarré.");
    if (!tabs.has(id)) throw new Error("Onglet inconnu.");
    if (tabList.length <= 1) throw new Error("Gardez au moins un onglet (ou arrêtez le navigateur).");
    await fetch(`http://127.0.0.1:${port}/json/close/${id}`);
    tabs.get(id)?.ws.close(); tabs.delete(id);
    await refresh(); onChange();
    return status();
  }
  const switchTab = (id) => activate(id);

  const status = () => ({ state, url: tabList.find((t) => t.id === active)?.url ?? "", title: tabList.find((t) => t.id === active)?.title ?? "", tabs: tabList, active, view: VIEW, chrome: !!bin });
  const requireRunning = () => { if (state !== "running") throw new Error("Navigateur non démarré."); };

  async function navigate(input) { requireRunning(); const target = safeUrl(input); await send("Page.navigate", { url: target }); await refresh().catch(() => {}); return status(); }
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
  return { start, stop, status, openTab, closeTab, switchTab, navigate, history, input, getSelection, paste, _send: send };
}
