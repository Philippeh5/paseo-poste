// Bouton « Telegram » (T32) : état du bot Telegram du poste, en LECTURE SEULE.
// Le bot (D:\Projets\TelegramAssistant, variable TELEGRAM_BOT_DIR pour un autre dossier) écrit :
//   .heartbeat.json       {pid, startedAt, lastSeenAt, version}, réécrit toutes les 30 s ;
//   poste_activity.jsonl  une ligne JSON {at, kind, label, result} par commande ou assistant (500 au plus).
// Ce module ne fait QUE lire ces deux fichiers : il n'exécute rien, ne contacte pas Telegram et ne lit aucun jeton.
// Fichier de vie absent, illisible ou plus vieux que 90 s = « bot arrêté ».
// Messages : telegram.status {ref?} -> telegram.status {running, lastSeenAt, startedAt, ageMs, version, recent[], ref} ;
// diffusion du même message à chaque changement (interrogation toutes les 10 s).
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BOT_DIR = "D:\\Projets\\TelegramAssistant";
export const STALE_MS = 90_000;
const POLL_MS = 10_000;
const RECENT = 20;
const MAX_TAIL_BYTES = 256 * 1024;
const CLOCK_SKEW_MS = 5_000;

const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const botDir = () => process.env.TELEGRAM_BOT_DIR || DEFAULT_BOT_DIR;
const isoOrNull = (value) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null);

export function readHeartbeat(dir = botDir()) {
  try {
    const data = JSON.parse(readFileSync(join(dir, ".heartbeat.json"), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const lastSeenAt = isoOrNull(data.lastSeenAt);
    if (!lastSeenAt) return null;
    return {
      lastSeenAt,
      startedAt: isoOrNull(data.startedAt),
      version: typeof data.version === "string" ? clip(data.version, 40) : null,
    };
  } catch {
    return null; // absent, illisible ou mal formé : le bot est considéré arrêté
  }
}

// Lit la fin du journal (jamais plus de 256 Ko) et renvoie les `limit` entrées les plus récentes, la plus récente d'abord.
export function readRecent(dir = botDir(), limit = RECENT) {
  let text = "";
  try {
    const fd = openSync(join(dir, "poste_activity.jsonl"), "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, MAX_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      const at = isoOrNull(raw?.at);
      if (!at) continue;
      entries.push({ at, kind: clip(raw.kind, 30), label: clip(raw.label, 160), result: clip(raw.result, 160) });
    } catch {
      // ligne tronquée (coupée par la lecture de la fin du fichier) : ignorée
    }
  }
  return entries.slice(-limit).reverse();
}

export function buildStatus(now = Date.now(), dir = botDir()) {
  const beat = readHeartbeat(dir);
  const age = beat ? now - Date.parse(beat.lastSeenAt) : null;
  const running = beat !== null && age <= STALE_MS && age >= -CLOCK_SKEW_MS;
  return {
    running,
    lastSeenAt: beat?.lastSeenAt ?? null,
    startedAt: beat?.startedAt ?? null,
    version: beat?.version ?? null,
    ageMs: age === null ? null : Math.max(0, age),
    recent: readRecent(dir),
  };
}

export function register(ctx) {
  const { onMessage, send, broadcast } = ctx;
  const signature = (status) => JSON.stringify({ ...status, ageMs: null });
  let last = signature(buildStatus());

  onMessage("telegram.status", (ws, m) => {
    send(ws, { type: "telegram.status", ...buildStatus(), ref: m.ref ?? null });
  });

  const poll = () => {
    try {
      const status = buildStatus();
      const now = signature(status);
      if (now === last) return;
      last = now;
      broadcast({ type: "telegram.status", ...status, ref: null });
    } catch {
      // le prochain cycle réessaiera
    }
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
