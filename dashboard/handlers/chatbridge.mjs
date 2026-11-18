// Pont Telegram ↔ fil de groupe des projets (le fil du poste reste la vérité, Telegram n'en est que le miroir).
//   Groupes : ~/paseo-dash-data/telegram-groups.json  { "paseo-poste"|"blastwin"|"general"|"notifications": { chatId } }
//   Bot     : l'Orchestrateur (TG_BOT_ORCHESTRATEUR_TOKEN dans ~/.config/paseo/telegram-bots.env), seul à écouter.
//   Un groupe = un seul fil (pas de sujets) : paseo-poste, blastwin, general (les autres projets), notifications (à autoriser, blocages).
//   Sortie  : tout le fil du projet est copié dans son groupe (les échanges entre agents sans notification) ; les questions, décisions et blocages
//             sont en plus envoyés dans le groupe « Notifications ». Le privé avec Jarvis reste géré par Hermes.
//   Entrée  : un message de Philippe dans le groupe d'un projet est versé dans le fil de ce projet (coord.group.telegram) ; dans « general »,
//             écrire « NomDuProjet : message ». Seuls les identifiants de TELEGRAM_ALLOWED_USERS (~/.hermes/.env) sont écoutés.
// Inactif hors instance réelle (un 2e poste en test volerait les messages : Telegram n'admet qu'un seul getUpdates par bot).
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isRealInstance } from "../lib/realinstance.mjs";

const BOT_KEY = "ORCHESTRATEUR";
const MAX_TEXT = 3800;
const clip = (t, n) => { const f = String(t ?? "").trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
const esc = (t) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

const envValue = (file, key) => {
  try {
    const line = readFileSync(file, "utf8").split("\n").reverse().find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).replace(/["'\s]/g, "") : "";
  } catch { return ""; }
};

export function register(ctx) {
  const groupsFile = join(ctx.dataDir || join(homedir(), "paseo-dash-data"), "telegram-groups.json");
  const botsEnv = join(homedir(), ".config", "paseo", "telegram-bots.env");
  if (!isRealInstance() && process.env.CHATBRIDGE_FORCE !== "1") { ctx.log("chatbridge", "instance de test : pont Telegram inactif"); return; }
  if (!existsSync(groupsFile)) { ctx.log("chatbridge", "telegram-groups.json absent : pont inactif"); return; }

  const token = () => envValue(botsEnv, `TG_BOT_${BOT_KEY}_TOKEN`);
  const groups = () => ctx.store.read("telegram-groups", {}) || {};
  const allowed = new Set(envValue(join(homedir(), ".hermes", ".env"), "TELEGRAM_ALLOWED_USERS").split(",").map((s) => s.trim()).filter(Boolean));
  if (!token()) { ctx.log("chatbridge", "jeton Orchestrateur absent : pont inactif"); return; }
  if (!allowed.size) { ctx.log("chatbridge", "TELEGRAM_ALLOWED_USERS vide : le pont n'écoutera personne (sortie seule)"); }

  const api = async (method, body, timeoutMs = 15_000) => {
    const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    return r.json().catch(() => ({ ok: false }));
  };

  // Liens d'ouverture des groupes (sans aucun secret) pour la vue Groupes.
  const linkOf = (g) => `https://t.me/c/${String(g.chatId).replace(/^-100/, "")}/1`;
  ctx.onMessage("tg.links", (ws) => ctx.send(ws, { type: "tg.links", links: Object.fromEntries(Object.entries(groups()).map(([k, g]) => [k, linkOf(g)])) }));

  // ---------- Sortie : fil du poste → Telegram ----------
  const seen = new Set();            // identifiants déjà envoyés (un message de groupe existe en une copie par destinataire)
  const echoed = new Map();          // texte venu de Telegram → heure : pas de renvoi vers Telegram
  const nameOfProject = (key) => {
    const base = basename(String(key || "").split("|").slice(1).join("|")).toLowerCase();
    return base === "paseo-poste" ? "paseo-poste" : base === "blastwin" ? "blastwin" : "general";
  };
  const projectTitle = (key) => basename(String(key || "").split("|").slice(1).join("|")) || "projet";

  async function post(group, html, silent) {
    const g = groups()[group];
    if (!g?.chatId) return;
    const r = await api("sendMessage", {
      chat_id: g.chatId, text: html.slice(0, MAX_TEXT), parse_mode: "HTML",
      disable_notification: silent, disable_web_page_preview: true,
    });
    if (!r.ok) ctx.log("chatbridge", `envoi refusé (${group}) : ${clip(r.description, 120)}`);
  }

  // Silencieux : bavardage des agents ; avec bruit : ce qui demande Philippe (question, décision, blocage, réponse de l'orchestrateur).
  function route(msg) {
    if (msg.fromKind === "human" || msg.from === "human") return { silent: true };
    if (msg.kind === "blocker" || (msg.to === "human" && (msg.kind === "question" || msg.kind === "decision"))) return { silent: false, portal: true };
    return { silent: !(msg.fromKind === "orchestrator" && msg.to === "human") };
  }

  async function onStore(msg) {
    const id = msg.group || msg.id;
    if (!id || seen.has(id) || !msg.text) return;
    seen.add(id);
    if (seen.size > 600) seen.delete(seen.values().next().value);
    const sentAt = echoed.get(clip(msg.text, 200));
    if (sentAt && Date.now() - sentAt < 120_000) return;
    const r = route(msg);
    const group = nameOfProject(msg.project);
    const who = msg.fromKind === "human" ? "👤 Philippe" : esc(msg.fromLabel || "agent");
    const where = group === "general" ? ` · ${esc(projectTitle(msg.project))}` : "";
    const html = `<b>${who}</b>${where}\n${esc(clip(msg.text, 3000))}`;
    await post(group, html, r.silent);
    if (r.portal) await post("notifications", `<b>${esc(projectTitle(msg.project))}</b> · ${html}`, false);
  }

  // Demandes de permission : un message avec Valider / Refuser dans « Notifications » ; le tap passe par perm.respond (mêmes garde-fous que le panneau).
  const pending = new Map(); // id d'élément de la boîte → { host, agentId, requestId, actions }
  async function onInboxItem(item) {
    const a = item.action;
    if (item.kind !== "permission" || a?.type !== "permission" || a.questions) return;
    pending.set(item.id, { host: item.host, agentId: item.agentId, requestId: a.requestId, actions: a.actions || [] });
    if (pending.size > 200) pending.delete(pending.keys().next().value);
    const g = groups().notifications;
    if (!g?.chatId) return;
    const text = `${a.danger ? "⚠️ " : "🔐 "}<b>${esc(item.project || "projet")}</b> · ${esc(item.title)}\n${esc(clip(item.body, 600))}${a.target ? `\n<code>${esc(clip(a.target, 300))}</code>` : ""}`;
    const r = await api("sendMessage", { chat_id: g.chatId, text: text.slice(0, MAX_TEXT), parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "✅ Valider", callback_data: `ib:${item.id}:a` }, { text: "❌ Refuser", callback_data: `ib:${item.id}:r` }]] } });
    if (!r.ok) ctx.log("chatbridge", `permission non envoyée : ${clip(r.description, 100)}`);
  }
  async function onCallback(q) {
    const hit = /^ib:([\w-]+):([ar])$/.exec(q.data || "");
    if (!hit || !allowed.has(String(q.from?.id))) return;
    const p = pending.get(hit[1]);
    const allow = hit[2] === "a";
    let result = "Demande introuvable (redémarrage du poste ?).";
    if (p) {
      const wanted = allow ? "allow" : "deny";
      const chosen = p.actions.find((x) => x.behavior === wanted);
      const res = await ctx.invoke("perm.respond", { host: p.host, agentId: p.agentId, requestId: p.requestId, behavior: wanted, actionId: chosen?.id || undefined }, { timeoutMs: 30_000 });
      result = res.error ? `Non appliqué : ${clip(res.error, 150)}` : allow ? "✅ Validé" : "❌ Refusé";
      if (!res.error) { pending.delete(hit[1]); ctx.invoke("inbox.mark", { ids: [hit[1]], status: "traité" }).catch(() => {}); }
    }
    await api("answerCallbackQuery", { callback_query_id: q.id, text: result.slice(0, 190) });
    if (q.message) await api("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: result.slice(0, 60), callback_data: "ib:done" }]] } });
  }

  let off = null; let offInbox = null;
  const attach = () => {
    if (!offInbox && typeof ctx.inbox?.onAdded === "function") {
      offInbox = ctx.inbox.onAdded((item) => { onInboxItem(item).catch((e) => ctx.log("chatbridge", `permission : ${clip(e?.message, 100)}`)); });
    }
    if (off || typeof ctx.coord?.onStore !== "function") return Boolean(off && offInbox);
    off = ctx.coord.onStore((msg) => { onStore(msg).catch((e) => ctx.log("chatbridge", `sortie : ${clip(e?.message, 100)}`)); });
    ctx.log("chatbridge", "pont Telegram actif (sortie)");
    return Boolean(offInbox);
  };
  const attachTimer = setInterval(() => { if (attach()) clearInterval(attachTimer); }, 3000);
  attachTimer.unref?.();

  // ---------- Entrée : Telegram → fil du poste ----------
  async function projects() {
    const r = await ctx.invoke("project.list", {}, { timeoutMs: 15_000 });
    return (r.replies.find((x) => x.type === "project.list")?.projects || []).filter((p) => p.host && p.dir);
  }
  const reply = (chatId, text) => api("sendMessage", { chat_id: chatId, text, disable_notification: true });

  async function onTelegram(m) {
    if (process.env.CHATBRIDGE_DEBUG) ctx.log("chatbridge", `reçu chat=${m?.chat?.id} thread=${m?.message_thread_id} de=${m?.from?.id}`);
    if (!m?.text || !m.from || m.from.is_bot) return;
    if (!allowed.has(String(m.from.id))) return;
    const cfg = groups();
    const entry = Object.entries(cfg).find(([, g]) => String(g.chatId) === String(m.chat?.id));
    if (!entry) return;
    const [group, g] = entry;
    if (group === "notifications") return;
    const list = await projects();
    let target; let text = m.text.trim();
    if (group === "general") {
      const hit = text.match(/^([^:：\n]{1,60})\s*[:：]\s*([\s\S]+)$/);
      const found = hit && list.find((p) => String(p.name).toLowerCase() === hit[1].trim().toLowerCase());
      if (!found) { await reply(m.chat.id, `Écris « NomDuProjet : message ». Projets : ${list.map((p) => p.name).join(", ")}.`); return; }
      target = found; text = hit[2].trim();
    } else {
      const wanted = group === "paseo-poste" ? "paseo-poste" : "blastwin";
      target = list.find((p) => String(p.name).toLowerCase() === wanted);
      if (!target) { await reply(m.chat.id, `Projet « ${wanted} » introuvable dans les projets suivis.`); return; }
    }
    echoed.set(clip(text, 200), Date.now());
    const res = await ctx.invoke("coord.group.telegram", { host: target.host, dir: target.dir, text, launch: false }, { timeoutMs: 30_000 });
    if (process.env.CHATBRIDGE_DEBUG) ctx.log("chatbridge", `invoke → ${res.error || JSON.stringify(res.replies.map((x) => x.type))}`);
    if (res.error) await reply(m.chat.id, `Non transmis : ${clip(res.error, 200)}`);
    else await api("setMessageReaction", { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
  }

  let stopped = false; let offset = 0;
  async function poll() {
    while (!stopped) {
      try {
        const r = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000);
        if (!r.ok) { await new Promise((ok) => setTimeout(ok, r.error_code === 409 ? 30_000 : 5000)); continue; }
        for (const u of r.result) {
          offset = u.update_id + 1;
          if (u.callback_query) { await onCallback(u.callback_query).catch((e) => ctx.log("chatbridge", `bouton : ${clip(e?.message, 100)}`)); continue; }
          await onTelegram(u.message).catch((e) => ctx.log("chatbridge", `entrée : ${clip(e?.message, 100)}`));
        }
      } catch { await new Promise((ok) => setTimeout(ok, 5000)); }
    }
  }
  if (allowed.size) poll();
  ctx.onDisconnect?.(() => {});
  process.once("exit", () => { stopped = true; });
}
