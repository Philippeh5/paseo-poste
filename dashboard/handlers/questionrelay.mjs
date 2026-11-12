// Relais des QUESTIONS DE DIRECTION des agents vers Telegram : quand un agent pose une question (outil AskUserQuestion), le poste envoie
// un message à Philippe avec des BOUTONS (API Bot Telegram ; repli : `hermes send`, options numérotées, aucun modèle impliqué). Philippe répond par un numéro ; Hermes
// retrouve la question en attente (post_inbox_list) et répond avec post_inbox_answer. Si Hermes n'est pas installé, rien n'est envoyé :
// la question reste dans la boîte de réception du dashboard (boutons d'options).
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRealInstance } from "../lib/realinstance.mjs";

const HERMES = process.env.HERMES_BIN || join(homedir(), ".local", "bin", "hermes");
const HERMES_ENV = join(homedir(), ".hermes", ".env");
const MAX_PER_10_MIN = 6;
const clip = (t, n) => { const f = String(t ?? "").replace(/\s+/g, " ").trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

export function formatQuestion(item) {
  const a = item.action || {};
  const where = [item.agentTitle, item.project].filter(Boolean).join(" · ");
  const lines = [`❓ Question d'un agent${where ? ` (${clip(where, 80)})` : ""}`];
  (a.questions || []).forEach((q, qi) => {
    lines.push("", clip(q.question, 300));
    q.options.forEach((o, i) => lines.push(`${i + 1}) ${o.label}${o.description ? ` — ${clip(o.description, 120)}` : ""}`));
    if (!q.options.length) lines.push("(réponse libre)");
    if ((a.questions || []).length > 1) lines.push(`[question ${qi + 1}/${a.questions.length}]`);
  });
  lines.push("", "Réponds par un numéro (ou avec tes mots).", `[réf ${String(item.id).slice(-8)}]`);
  return lines.join("\n");
}

// Jeton et conversation du bot Hermes (lus dans ~/.hermes/.env, jamais journalisés).
function telegramTarget() {
  try {
    const env = Object.fromEntries(readFileSync(HERMES_ENV, "utf8").split(/\r?\n/)
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^["']|["']$/g, "")]));
    const chat = env.TELEGRAM_HOME_CHANNEL || String(env.TELEGRAM_ALLOWED_USERS || "").split(",")[0].trim();
    return env.TELEGRAM_BOT_TOKEN && chat ? { token: env.TELEGRAM_BOT_TOKEN, chat } : null;
  } catch { return null; }
}

// Un message par question, avec boutons : le plugin Hermes « paseo-question-buttons » traite les taps (callback_data `pq:<réf>:<q>:<action>`).
export function formatQuestionButtons(item) {
  const a = item.action || {};
  const where = [item.agentTitle, item.project].filter(Boolean).join(" · ");
  const ref = String(item.id).slice(-8);
  const qs = a.questions || [];
  return qs.map((q, qi) => {
    const lines = [`❓ Question d'un agent${where ? ` (${clip(where, 80)})` : ""}${qs.length > 1 ? ` [${qi + 1}/${qs.length}]` : ""}`, "", clip(q.question, 300)];
    q.options.forEach((o) => { if (o.description) lines.push(`• ${o.label} — ${clip(o.description, 120)}`); });
    if (q.multiSelect) lines.push("", "(plusieurs choix possibles : coche puis Valider)");
    const rows = q.options.map((o, i) => [{ text: `${q.multiSelect ? "☐ " : ""}${o.label}`.slice(0, 60), callback_data: `pq:${ref}:${qi}:${i}` }]);
    rows.push([{ text: "✏️ Autre (taper ma réponse)", callback_data: `pq:${ref}:${qi}:o` }]);
    rows.push([...(q.multiSelect ? [{ text: "✅ Valider", callback_data: `pq:${ref}:${qi}:v` }] : []), { text: "⛔ Arrêter", callback_data: `pq:${ref}:${qi}:x` }]);
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: rows } };
  });
}

async function sendButtons(item) {
  const target = telegramTarget();
  if (!target) return false;
  for (const m of formatQuestionButtons(item)) {
    const r = await fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ chat_id: target.chat, text: m.text, reply_markup: m.reply_markup }),
    });
    if (!r.ok) return false;
  }
  return true;
}

export function register(ctx) {
  const available = process.platform !== "win32" && existsSync(HERMES) && isRealInstance();
  if (!available || !ctx.inbox?.onAdded) { ctx.log("questionrelay", "relais Telegram inactif (Hermes absent)"); return; }
  let sent = [];
  const tell = (text) => {
    const child = execFile(HERMES, ["send", "-t", "telegram", "-q", "-f", "-"], { timeout: 30_000, windowsHide: true }, () => {});
    child.stdin.end(text);
  };
  // Réponse donnée sur le poste : on l'indique sur Telegram pour que la question y soit close aussi (la première réponse gagne).
  ctx.questionRelay = {
    answeredOnPoste: (answers) => {
      const shown = Object.values(answers || {}).map((a) => clip(a, 80)).join(" · ");
      tell(`✔ Question réglée : réponse donnée sur le poste${shown ? ` (« ${shown} »)` : ""}. Rien à faire ici.`);
    },
  };
  ctx.inbox.onAdded((item) => {
    try {
      if (item?.kind !== "permission" || !item.action?.questions?.length) return;
      const now = Date.now();
      sent = sent.filter((t) => now - t < 600_000);
      if (sent.length >= MAX_PER_10_MIN) { ctx.log("questionrelay", "trop de questions : message non relayé (visible dans la boîte de réception)"); return; }
      sent.push(now);
      sendButtons(item).catch(() => false).then((ok) => {
        if (ok) return;
        // Repli : message texte numéroté (Hermes retrouve la question et répond via post_inbox_answer).
        const child = execFile(HERMES, ["send", "-t", "telegram", "-q", "-f", "-"], { timeout: 30_000, windowsHide: true }, (err) => {
          if (err) ctx.log("questionrelay", `envoi Telegram impossible : ${ctx.safeError(err)}`);
        });
        child.stdin.end(formatQuestion(item));
      });
    } catch (e) { ctx.log("questionrelay", `relais ignoré : ${ctx.safeError(e)}`); }
  });
  ctx.log("questionrelay", "relais des questions d'agents vers Telegram actif");
}
