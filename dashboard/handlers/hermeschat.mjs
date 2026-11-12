// Hermes sur Telegram, vu depuis le tableau de bord : état de la passerelle (service systemd d'Oracle) et discussion récente
// lue dans la base d'Hermes (~/.hermes/state.db, en lecture seule). Remplace l'affichage de l'ancien bot Jarvis du PC.
// Messages : hermes.status -> hermes.state {available, gateway, connected, messages[{role, text, at}]} ; hermes.restart (confirmé côté interface).
// Sur une machine sans Hermes (PC Windows), available vaut false et l'interface le dit simplement.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redact } from "../lib/redact.mjs";

const DB = process.env.HERMES_STATE_DB || join(homedir(), ".hermes", "state.db");
const UNIT = "hermes-gateway";
const API_URL = (process.env.HERMES_API_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
const API_KEY = process.env.HERMES_API_KEY || "";
const SAY_MAX = 2000;
const SAY_TIMEOUT_MS = 5 * 60_000;
const SHOWN = 40;
const MAX_TEXT = 1500;

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || "") }));
});

// L'ordre « /poste » est injecté par Hermes sous forme d'un long texte de skill : on l'affiche comme la commande tapée.
function cleanUser(text) {
  const m = text.match(/invoked the "([\w-]+)" skill/);
  return m ? `/${m[1]}` : text;
}

function readMessages() {
  if (!existsSync(DB)) return [];
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT m.role AS role, m.content AS content, m.timestamp AS ts FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE s.source LIKE '%telegram%' AND m.role IN ('user','assistant') AND m.content IS NOT NULL AND TRIM(m.content) <> ''
       ORDER BY m.timestamp DESC LIMIT ?`).all(SHOWN * 2);
    return rows.reverse().slice(-SHOWN).map((r) => {
      const raw = r.role === "user" ? cleanUser(String(r.content)) : String(r.content);
      return { role: r.role, text: redact(raw).slice(0, MAX_TEXT), at: new Date(Number(r.ts) * 1000).toISOString() };
    });
  } finally {
    db.close();
  }
}

// Session Telegram la plus récente : le panneau continue CETTE conversation (même fil que sur Telegram).
function telegramSessionId() {
  if (!existsSync(DB)) return null;
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM sessions WHERE source LIKE '%telegram%' ORDER BY started_at DESC LIMIT 1").get()?.id ?? null;
  } finally { db.close(); }
}

async function gatewayState() {
  const active = await run("systemctl", ["--user", "is-active", UNIT]);
  const gateway = active.out.trim() || "unknown";
  let connected = null;
  if (gateway === "active") {
    const log = await run("journalctl", ["--user", "-u", UNIT, "--since", "-15min", "--no-pager", "-o", "cat"], 10000);
    const lines = log.out.split("\n").filter((l) => /Telegram/i.test(l));
    const last = [...lines].reverse().find((l) => /Connected to Telegram|polling conflict|failed to connect|Fatal telegram/i.test(l));
    connected = last ? /Connected to Telegram/i.test(last) : null;
  }
  return { gateway, connected };
}

export function register(ctx) {
  const { onMessage, send, sendError } = ctx;
  const available = process.platform !== "win32" && existsSync(DB);

  async function state() {
    if (!available) return { type: "hermes.state", available: false, gateway: "unknown", connected: null, messages: [] };
    let messages = [];
    try { messages = readMessages(); } catch (e) { ctx.log("hermeschat", `lecture impossible : ${ctx.safeError(e)}`); }
    return { type: "hermes.state", available: true, ...(await gatewayState()), messages, at: new Date().toISOString() };
  }

  onMessage("hermes.status", async (ws, m) => { send(ws, { ...(await state()), ref: m.ref ?? null }); });

  // Écrire à Hermes depuis le panneau : un tour d'agent dans la session Telegram (API locale d'Hermes, clé côté serveur).
  // La réponse arrive dans la base ; le panneau la relit. Un seul message en cours à la fois.
  let saying = false;
  onMessage("hermes.say", async (ws, m) => {
    if (String(ws?._uiId ?? "").startsWith("invoke:")) return sendError(ws, "Message réservé à l'interface.");
    if (!available) return sendError(ws, "Hermes n'est pas installé sur cette machine.");
    if (!API_KEY) return sendError(ws, "L'API d'Hermes n'est pas configurée (HERMES_API_KEY).");
    const text = String(m.text ?? "").trim();
    if (!text) return sendError(ws, "Message vide.");
    if (text.length > SAY_MAX) return sendError(ws, `Message trop long (${SAY_MAX} caractères au plus).`);
    if (saying) return sendError(ws, "Hermes répond encore au message précédent : patiente un instant.");
    const id = telegramSessionId();
    if (!id) return sendError(ws, "Aucune conversation Telegram trouvée : écris d'abord à Hermes sur Telegram.");
    saying = true;
    send(ws, { type: "hermes.said", ok: true, pending: true, ref: m.ref ?? null });
    (async () => {
      let error = null;
      try {
        const res = await fetch(`${API_URL}/api/sessions/${encodeURIComponent(id)}/chat`, {
          method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify({ message: text }), signal: AbortSignal.timeout(SAY_TIMEOUT_MS),
        });
        if (!res.ok) error = `Hermes a répondu HTTP ${res.status}`;
      } catch (e) { error = e?.name === "TimeoutError" ? "Hermes n'a pas répondu en 5 minutes." : "Hermes est injoignable."; }
      saying = false;
      ctx.broadcast({ ...(await state()), said: { ok: !error, error } });
    })();
  });

  onMessage("hermes.restart", async (ws, m) => {
    if (String(ws?._uiId ?? "").startsWith("invoke:")) return sendError(ws, "Message réservé à l'interface.");
    if (!available) return sendError(ws, "Hermes n'est pas installé sur cette machine.");
    const r = await run("systemctl", ["--user", "restart", UNIT], 30000);
    if (!r.ok) return sendError(ws, "La relance d'Hermes a échoué.");
    send(ws, { ...(await state()), ref: m.ref ?? null });
  });
}
