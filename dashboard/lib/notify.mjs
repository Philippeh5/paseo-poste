// Notifications Telegram du poste. Le jeton est lu dans l'environnement de Hermes (~/.hermes/.env) à chaque envoi et n'est ni
// journalisé ni stocké. NOTIFY_DRY_FILE=<chemin> : écrit les messages dans ce fichier au lieu d'appeler Telegram (tests).
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRealInstance } from "./realinstance.mjs";

const envFile = () => process.env.HERMES_ENV_FILE || join(homedir(), ".hermes", ".env");
const pick = (text, key) => (text.split("\n").reverse().find((l) => l.startsWith(`${key}=`)) || "").slice(key.length + 1).replace(/["'\s]/g, "");

export async function telegramSend(text, keyboard = null) {
  if (process.env.NOTIFY_DRY_FILE) { appendFileSync(process.env.NOTIFY_DRY_FILE, JSON.stringify({ text, keyboard }) + "\n"); return true; }
  if (!isRealInstance()) return false; // instance de test / worktree : jamais le vrai Telegram
  try { appendFileSync(join(homedir(), "paseo-dash-data", "telegram-sent.log"), `${new Date().toISOString()} ${String(text).split("\n")[0].slice(0, 80)}\n`); } catch { /* journal facultatif */ }
  try {
    const raw = readFileSync(envFile(), "utf8");
    const token = pick(raw, "TELEGRAM_BOT_TOKEN"), chat = pick(raw, "TELEGRAM_HOME_CHANNEL");
    if (!token || !chat) return false;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: chat, text: String(text).slice(0, 3900), ...(keyboard ? { reply_markup: JSON.stringify({ inline_keyboard: keyboard }) } : {}) }), signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch { return false; }
}
