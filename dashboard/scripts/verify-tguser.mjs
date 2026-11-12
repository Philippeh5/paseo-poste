// dashboard/scripts/verify-tguser.mjs — compte assistant Telegram : agents, avatars, login en 2 temps, création des bots, groupe forum.
// Hors ligne : aucun appel réseau Telegram, aucun compte réel. TG_USER_DIR pointe sur un dossier jetable ; BotFather et GramJS
// sont remplacés par de faux adaptateurs (le vrai code de tguser.mjs tourne, avec les vrais constructeurs Api de GramJS).
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "tguser-verify-"));
process.env.TG_USER_DIR = tmp;
delete process.env.TG_2FA_PASSWORD;

let fails = 0;
const ok = (name, cond, extra = "") => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " → " + extra}`); };
const skip = (name, reason) => console.log(`SKIP ${name} (${reason})`);
const mode = (p) => (statSync(p).mode & 0o777).toString(8);

const { AGENTS, avatarSvg, avatarPng } = await import("../lib/tgagents.mjs");
const L = await import("../lib/tguser.mjs");
const { Api } = await import("telegram");

// Capture de TOUTE la sortie (console + stdout/stderr) pour vérifier qu'aucun secret ne sort.
let captured = [];
const cap = (fn) => async (...a) => {
  const saved = { log: console.log, warn: console.warn, error: console.error, out: process.stdout.write, err: process.stderr.write };
  captured = [];
  console.log = console.warn = console.error = (...x) => { captured.push(x.join(" ")); };
  process.stdout.write = (s) => { captured.push(String(s)); return true; };
  process.stderr.write = (s) => { captured.push(String(s)); return true; };
  try { return await fn(...a); }
  finally { console.log = saved.log; console.warn = saved.warn; console.error = saved.error; process.stdout.write = saved.out; process.stderr.write = saved.err; }
};
const out = () => captured.join("\n");
const noSleep = async () => {};

// ── 1. Table des agents ─────────────────────────────────────────────────────
ok("AGENTS : 7 agents dans l'ordre", AGENTS.map((a) => a.id).join() === "vigie,relecteur,batisseur,eclaireur,concierge,recap,orchestrateur");
ok("AGENTS : couleurs du cahier des charges", AGENTS.map((a) => a.couleur).join() === "#0EA5E9,#8B5CF6,#F59E0B,#22C55E,#64748B,#EAB308,#EF4444");
ok("AGENTS : noms accentués", AGENTS.find((a) => a.id === "batisseur").nom === "Bâtisseur" && AGENTS.find((a) => a.id === "eclaireur").nom === "Éclaireur" && AGENTS.find((a) => a.id === "recap").nom === "Récap");
ok("AGENTS : id/nom/emoji/couleur/rôle présents", AGENTS.every((a) => a.id && a.nom && a.emoji && /^#[0-9A-F]{6}$/i.test(a.couleur) && a.role));

// ── 2. Usernames ────────────────────────────────────────────────────────────
ok("normaliseId : Bâtisseur → batisseur", L.normaliseId("Bâtisseur") === "batisseur");
ok("normaliseId : Éclaireur → eclaireur", L.normaliseId("Éclaireur") === "eclaireur");
ok("normaliseId : minuscules, ponctuation retirée", L.normaliseId("Ré-CAP !") === "recap");
ok("botUsername : défaut poste_ph_vigie_bot", L.botUsername("poste_ph", "vigie") === "poste_ph_vigie_bot");
ok("botUsername : le préfixe garde son tiret bas", L.botUsername("Poste_PH", "batisseur") === "poste_ph_batisseur_bot");
ok("botUsername : préfixe accentué normalisé", L.botUsername("Pôste_é", "recap") === "poste_e_recap_bot");
ok("botUsername : suffixe numérique AVANT _bot (doit finir par bot)", L.botUsername("poste_ph", "vigie", 1) === "poste_ph_vigie2_bot" && L.botUsername("poste_ph", "vigie", 5) === "poste_ph_vigie6_bot");
ok("botUsername : tous les agents → ASCII, finit par _bot, 5–32 car.", AGENTS.every((a) => { const u = L.botUsername("poste_ph", a.id); return /^[a-z0-9_]{5,32}$/.test(u) && u.endsWith("_bot"); }));

// ── 3. Réponses de BotFather ────────────────────────────────────────────────
const TOKEN = "7123456789:AAHdefGHIjklMNOpqrSTUvwxYZ-1234567_0";
const rOk = L.parseBotFatherReply(`Done! Congratulations on your new bot. You will find it at t.me/poste_ph_vigie_bot. You can now add a description.\n\nUse this token to access the HTTP API:\n${TOKEN}\n\nKeep your token secure and store it safely.`);
ok("réponse succès : token extrait", rOk.kind === "token" && rOk.token === TOKEN, JSON.stringify(rOk));
ok("réponse succès : username lu dans t.me/…", rOk.username === "poste_ph_vigie_bot");
ok("réponse « already taken »", L.parseBotFatherReply("Sorry, this username is already taken. Please try something different.").kind === "taken");
ok("réponse « invalid »", L.parseBotFatherReply("Sorry, this username is invalid.").kind === "invalid");
ok("réponse « must end in bot »", L.parseBotFatherReply("Sorry, the username must end in 'bot'. E.g. 'Tetris_bot' or 'TetrisBot'").kind === "invalid");
const rr = L.parseBotFatherReply("Sorry, too many attempts. Please try again in 37 seconds.");
ok("réponse « too many attempts » : 37 s", rr.kind === "rate" && rr.seconds === 37);
ok("réponse « too many attempts » : 3 minutes → 180 s", L.parseBotFatherReply("Sorry, too many attempts. Please try again in 3 minutes.").seconds === 180);
ok("réponse « Success! » reconnue", L.parseBotFatherReply("Success! Profile photo updated.").kind === "success");
ok("réponse neutre → other, null → other", L.parseBotFatherReply("Choose a bot to change profile picture.").kind === "other" && L.parseBotFatherReply(null).kind === "other");
ok("token trop court non reconnu", L.parseBotFatherReply("123456:abc").kind !== "token");

// ── 4. Faux BotFather (machine à états) ─────────────────────────────────────
function makeFakeBotFather({ taken = new Set(), rateFirst = null, noSuccess = false } = {}) {
  const sent = []; const photos = []; let mode_ = null; let target = null; let rated = false; let next = null; let n = 0;
  const reply = (t) => { next = t; };
  const bf = {
    sent, photos,
    async send(text) {
      sent.push(text);
      if (rateFirst && !rated && text === "/newbot") { rated = true; return reply(`Sorry, too many attempts. Please try again in ${rateFirst} seconds.`); }
      if (text === "/newbot") { mode_ = "name"; return reply("Alright, a new bot. How are we going to call it? Please choose a name for your bot."); }
      if (text === "/cancel") { mode_ = null; return reply("The current operation was cancelled."); }
      if (["/setuserpic", "/setdescription", "/setprivacy"].includes(text)) { mode_ = text; target = null; return reply("Choose a bot to change."); }
      if (mode_ === "name") { mode_ = "username"; return reply("Good. Now let's choose a username for your bot. It must end in `bot`."); }
      if (mode_ === "username") {
        if (taken.has(text)) return reply("Sorry, this username is already taken. Please try something different.");
        mode_ = null; n++;
        return reply(`Done! Congratulations on your new bot. You will find it at t.me/${text}.\n\nUse this token to access the HTTP API:\n${String(1000000000 + n)}:AAFAKE${"x".repeat(20)}${String(n).padStart(10, "T")}\n\nKeep it safe.`);
      }
      if (["/setuserpic", "/setdescription", "/setprivacy"].includes(mode_) && !target && text.startsWith("@")) { target = text; return reply("OK. Send me the new value."); }
      if (target) { const m = mode_; mode_ = null; return reply(noSuccess ? "Hmm, something is odd." : `Success! ${m} updated.`); }
      return reply("I did not understand that.");
    },
    async sendPhoto(file) {
      sent.push(`<photo:${file.split("/").pop()}>`); photos.push(readFileSync(file).subarray(0, 8).toString("hex"));
      const m = mode_; mode_ = null; reply(noSuccess ? "Hmm, something is odd." : `Success! ${m} updated.`);
    },
    async recv() { const r = next; next = null; return r; },
  };
  return bf;
}
const fakeAvatar = async (agent, file) => writeFileSync(file, Buffer.from("89504e470d0a1a0a00", "hex"));
const envText = () => (existsSync(L.tgBotsEnvPath()) ? readFileSync(L.tgBotsEnvPath(), "utf8") : "");

// 4a. création complète (aucun bot connu)
{
  const bf = makeFakeBotFather();
  const sleeps = [];
  const r = await cap(L.createBots)({ adapter: bf, avatar: fakeAvatar, sleepFn: async (ms) => { sleeps.push(ms); }, pauseMs: 1500 });
  const env = envText();
  ok("createBots : 7 bots créés", r.created.length === 7 && r.skipped.length === 0, JSON.stringify(r));
  ok("createBots : 7 tokens + 7 usernames dans telegram-bots.env", (env.match(/^TG_BOT_[A-Z]+_TOKEN=\d+:/gm) || []).length === 7 && (env.match(/^TG_BOT_[A-Z]+_USERNAME=/gm) || []).length === 7);
  ok("createBots : clés en MAJUSCULES (TG_BOT_BATISSEUR_USERNAME=poste_ph_batisseur_bot)", env.includes("TG_BOT_BATISSEUR_USERNAME=poste_ph_batisseur_bot\n"));
  ok("createBots : telegram-bots.env en chmod 600", mode(L.tgBotsEnvPath()) === "600", mode(L.tgBotsEnvPath()));
  ok("createBots : /newbot puis nom « Vigie · Poste » puis username", bf.sent.slice(0, 3).join("|") === "/newbot|Vigie · Poste|poste_ph_vigie_bot", bf.sent.slice(0, 3).join("|"));
  ok("createBots : 7 /setuserpic avec photo PNG (magic 89504e47…)", bf.sent.filter((s) => s === "/setuserpic").length === 7 && bf.photos.length === 7 && bf.photos.every((h) => h === "89504e470d0a1a0a"));
  ok("createBots : 7 /setdescription avec le rôle en français", bf.sent.filter((s) => s === "/setdescription").length === 7 && bf.sent.includes("surveille le poste (CI, services, disque, quota)"));
  ok("createBots : /setprivacy UNE fois (orchestrateur) puis Disable", bf.sent.filter((s) => s === "/setprivacy").length === 1 && bf.sent.includes("Disable") && bf.sent[bf.sent.indexOf("/setprivacy") + 1] === "@poste_ph_orchestrateur_bot");
  ok("createBots : pause de 1,5 s entre les échanges", sleeps.filter((s) => s === 1500).length > 50);
  ok("createBots : aucun token dans la sortie console", !/\d{6,}:[A-Za-z0-9_-]{30,}/.test(out()));
  ok("createBots : marqueur de fin de configuration par bot", (env.match(/^# TG_BOT_[A-Z]+_SETUP=done$/gm) || []).length === 7);

  // 4b. rejeu : idempotent, rien n'est envoyé
  const bf2 = makeFakeBotFather();
  const r2 = await cap(L.createBots)({ adapter: bf2, avatar: fakeAvatar, sleepFn: noSleep });
  ok("createBots : rejeu → 7 ignorés, 0 message envoyé", r2.skipped.length === 7 && bf2.sent.length === 0 && envText() === env);
}

// 4c. fichier partiel écrit à la main (token seul, sans marqueur) → ignoré ; autres bots créés
{
  rmSync(L.tgBotsEnvPath(), { force: true });
  writeFileSync(L.tgBotsEnvPath(), `TG_BOT_VIGIE_TOKEN=5555555555:AAA${"B".repeat(32)}\nTG_BOT_VIGIE_USERNAME=mon_vigie_bot`); // pas de \n final
  const bf = makeFakeBotFather();
  const r = await cap(L.createBots)({ adapter: bf, avatar: fakeAvatar, sleepFn: noSleep });
  ok("createBots : bot déjà présent (vigie) ignoré, 6 autres créés", r.skipped.join() === "vigie" && r.created.length === 6 && !bf.sent.includes("Vigie · Poste"));
  ok("createBots : append après un fichier sans \\n final reste valide", /^TG_BOT_VIGIE_USERNAME=mon_vigie_bot$/m.test(envText()) && /^TG_BOT_RELECTEUR_TOKEN=/m.test(envText()));
}

// 4d. repli de username (déjà pris) avec suffixe numérique
{
  rmSync(L.tgBotsEnvPath(), { force: true });
  const bf = makeFakeBotFather({ taken: new Set(["poste_ph_vigie_bot", "poste_ph_vigie2_bot"]) });
  await cap(L.createBots)({ adapter: bf, avatar: fakeAvatar, sleepFn: noSleep });
  ok("createBots : username pris → poste_ph_vigie3_bot", /^TG_BOT_VIGIE_USERNAME=poste_ph_vigie3_bot$/m.test(envText()), envText().split("\n").slice(0, 3).join("|"));
  ok("createBots : usernames essayés dans l'ordre", bf.sent.slice(2, 5).join("|") === "poste_ph_vigie_bot|poste_ph_vigie2_bot|poste_ph_vigie3_bot");
}

// 4e. 6 variantes toutes prises → erreur claire, /cancel, rien d'écrit pour cet agent
{
  rmSync(L.tgBotsEnvPath(), { force: true });
  const bf = makeFakeBotFather({ taken: new Set([0, 1, 2, 3, 4, 5].map((i) => L.botUsername("poste_ph", "vigie", i))) });
  let err = null;
  await cap(L.createBots)({ adapter: bf, avatar: fakeAvatar, sleepFn: noSleep }).catch((e) => { err = e; });
  ok("createBots : 5 retries épuisés → erreur claire", err && /aucun username disponible/.test(err.message), err?.message);
  ok("createBots : /cancel envoyé, aucun token écrit", bf.sent.includes("/cancel") && !/TOKEN=/.test(envText()));
}

// 4f. rate-limit BotFather : ≤ 120 s on attend puis on renvoie ; > 120 s on s'arrête
{
  rmSync(L.tgBotsEnvPath(), { force: true });
  const sleeps = [];
  const bf = makeFakeBotFather({ rateFirst: 37 });
  const r = await cap(L.createBots)({ adapter: bf, avatar: fakeAvatar, sleepFn: async (ms) => { sleeps.push(ms); } });
  ok("rate-limit 37 s : attente de 38 s puis succès", sleeps.includes(38000) && r.created.length === 7, `sleeps=${[...new Set(sleeps)]}`);
  ok("rate-limit 37 s : /newbot renvoyé après l'attente", bf.sent.filter((s) => s === "/newbot").length === 8);
  rmSync(L.tgBotsEnvPath(), { force: true });
  let err = null;
  await cap(L.createBots)({ adapter: makeFakeBotFather({ rateFirst: 500 }), avatar: fakeAvatar, sleepFn: noSleep }).catch((e) => { err = e; });
  ok("rate-limit 500 s (> 120) : arrêt avec erreur claire", err && /500 s/.test(err.message) && /120/.test(err.message), err?.message);
}

// 4g. panne après /newbot : le token est déjà sauvegardé, la reprise ne refait que la configuration
{
  rmSync(L.tgBotsEnvPath(), { force: true });
  const bf = makeFakeBotFather({ noSuccess: true });
  let err = null;
  await cap(L.createBots)({ adapter: bf, avatar: fakeAvatar, sleepFn: noSleep }).catch((e) => { err = e; });
  ok("panne en config : erreur explicite et token déjà sauvegardé", err && /setuserpic/.test(err.message) && /^TG_BOT_VIGIE_TOKEN=/m.test(envText()) && /SETUP=pending/.test(envText()), err?.message);
  const bf2 = makeFakeBotFather();
  const r = await cap(L.createBots)({ adapter: bf2, avatar: fakeAvatar, sleepFn: noSleep });
  ok("reprise : vigie reconfiguré SANS /newbot, les 6 autres créés", r.resumed.join() === "vigie" && r.created.length === 6 && bf2.sent.indexOf("/setuserpic") < bf2.sent.indexOf("/newbot"), JSON.stringify(r));
}

// 4h. dry-run : rien envoyé, rien écrit, pas de secret
{
  rmSync(L.tgBotsEnvPath(), { force: true });
  const bf = makeFakeBotFather();
  const r = await cap(L.createBots)({ adapter: bf, dryRun: true, prefix: "test_ph" });
  const o = out();
  ok("dry-run : aucun message envoyé, aucun fichier écrit", bf.sent.length === 0 && !existsSync(L.tgBotsEnvPath()) && r.created.length === 0);
  ok("dry-run : conversation planifiée affichée (/newbot, nom, username)", o.includes("/newbot") && o.includes("Bâtisseur · Poste") && o.includes("@test_ph_batisseur_bot") && o.includes("/setprivacy → Disable"));
  ok("dry-run : /setprivacy seulement pour l'orchestrateur", (o.match(/\/setprivacy/g) || []).length === 1);
}

// ── 5. parseBotsEnv ─────────────────────────────────────────────────────────
{
  const m = L.parseBotsEnv(`TG_BOT_VIGIE_TOKEN=1:a\nTG_BOT_VIGIE_USERNAME=u_bot\n# TG_BOT_VIGIE_SETUP=pending\n# TG_BOT_VIGIE_SETUP=done\nAUTRE=1\n\r\nTG_BOT_ORCHESTRATEUR_TOKEN=2:b\n`);
  ok("parseBotsEnv : token/username/marqueur final", m.vigie.token === "1:a" && m.vigie.username === "u_bot" && m.vigie.setup === "done" && m.orchestrateur.token === "2:b");
}

// ── 6. avatars ──────────────────────────────────────────────────────────────
for (const a of AGENTS) {
  const svg = avatarSvg(a);
  ok(`avatarSvg ${a.id} : 512×512, cercle ${a.couleur}, initiale ${a.nom[0]}, blanc gras, sans emoji`,
    /width="512"/.test(svg) && /height="512"/.test(svg) && svg.includes("<circle") && svg.includes(a.couleur) && />\s*[^<\s]\s*<\/text>/.test(svg) && svg.includes(`>${a.nom[0]}</text>`)
    && /fill="white"/.test(svg) && /font-weight="bold"/.test(svg) && /sans-serif/.test(svg) && !svg.includes(a.emoji));
}
{
  let chromeOk = true;
  try { const pw = await import("playwright-core"); const b = await pw.chromium.launch({ headless: true }); await b.close(); } catch { chromeOk = false; }
  if (!chromeOk) skip("avatarPng : PNG valide", "chromium ne démarre pas sur cette machine");
  else {
    const f = join(tmp, "av", "vigie.png");
    await avatarPng(AGENTS[0], f);
    const b = readFileSync(f);
    ok("avatarPng : magic bytes PNG (89 50 4E 47 0D 0A 1A 0A)", b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
    ok("avatarPng : 512×512 (IHDR)", b.readUInt32BE(16) === 512 && b.readUInt32BE(20) === 512, `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`);
  }
}

// ── 7. login en deux temps (faux client GramJS, vrais constructeurs Api) ────
const SECRET_HASH = "deadbeefcafe0123456789abcdef0123";
const CODE = "54321"; const PASS2FA = "Mot-de-passe-2FA-secret";
function fakeClientFactory({ signIn = "ok", seen = [] } = {}) {
  return async (apiId, apiHash, sessionStr) => {
    let session = sessionStr || "";
    return {
      session: { save: () => (session ? session : "SESSION-TEMP-" + "z".repeat(20)) },
      async connect() {}, async disconnect() {},
      async getMe() { return { firstName: "Philippe", username: "ph" }; },
      async invoke(req) {
        seen.push(req.className);
        if (req.className === "auth.SendCode") {
          if (!(req.settings instanceof Api.CodeSettings) || req.phoneNumber !== "+33612345678" || req.apiHash !== SECRET_HASH) throw new Error("SendCode mal formé");
          return { className: "auth.SentCode", phoneCodeHash: "HASH-ABC" };
        }
        if (req.className === "auth.SignIn") {
          if (req.phoneCodeHash !== "HASH-ABC") throw new Error("hash inattendu");
          if (signIn === "bad") throw Object.assign(new Error("400: PHONE_CODE_INVALID"), { errorMessage: "PHONE_CODE_INVALID" });
          if (signIn === "2fa") throw Object.assign(new Error("401: SESSION_PASSWORD_NEEDED"), { errorMessage: "SESSION_PASSWORD_NEEDED" });
          session = "SESSION-FINALE-" + "q".repeat(30);
          return { className: "auth.Authorization", user: { firstName: "Philippe", username: "ph" } };
        }
        throw new Error("appel inattendu " + req.className);
      },
    };
  };
}
{
  const seen = [];
  await cap(L.loginStart)({ apiId: "12345", apiHash: SECRET_HASH, phone: "+33612345678" }, { makeClient: fakeClientFactory({ seen }) });
  ok("login étape 1 : auth.SendCode appelé", seen.join() === "auth.SendCode", seen.join());
  ok("login étape 1 : tg-user.json {apiId,apiHash,phone} en 600", JSON.parse(readFileSync(L.tgUserJsonPath(), "utf8")).phone === "+33612345678" && mode(L.tgUserJsonPath()) === "600");
  const pend = JSON.parse(readFileSync(L.tgPendingPath(), "utf8"));
  ok("login étape 1 : pending (phoneCodeHash, session) en 600, expire dans 10 min", pend.phoneCodeHash === "HASH-ABC" && pend.sessionStr && mode(L.tgPendingPath()) === "600" && Math.abs(pend.expiresAt - Date.now() - L.PENDING_TTL_MS) < 5000 && L.PENDING_TTL_MS === 600000);
  ok("login étape 1 : rien de secret dans la sortie", !out().includes(SECRET_HASH) && !out().includes("HASH-ABC"));
  ok("login étape 1 : numéro/api-id invalides refusés", await L.loginStart({ apiId: "x", apiHash: "h", phone: "+33612345678" }, { makeClient: fakeClientFactory() }).then(() => false, () => true)
    && await L.loginStart({ apiId: "1", apiHash: "h", phone: "0612345678" }, { makeClient: fakeClientFactory() }).then(() => false, () => true));

  // expiration du pending
  ok("pending : valide avant 10 min", L.readPending(Date.now() + 9 * 60 * 1000).state === "ok");
  ok("pending : expiré après 10 min", L.readPending(Date.now() + 10 * 60 * 1000 + 5000).state === "expired");
  let err = null;
  await L.loginFinish({ code: CODE }, { makeClient: fakeClientFactory(), now: Date.now() + 11 * 60 * 1000 }).catch((e) => { err = e; });
  ok("login étape 2 : pending expiré → erreur « expiré » et fichier supprimé", err && /expiré/.test(err.message) && !existsSync(L.tgPendingPath()), err?.message);
  ok("pending : absent → « none » et erreur « aucune connexion en attente »", L.readPending().state === "none"
    && await L.loginFinish({ code: CODE }, { makeClient: fakeClientFactory() }).then(() => false, (e) => /aucune connexion en attente/.test(e.message)));

  // 2FA requise, puis code invalide, puis succès
  await L.loginStart({ apiId: "12345", apiHash: SECRET_HASH, phone: "+33612345678" }, { makeClient: fakeClientFactory() });
  const r2 = await cap(L.loginFinish)({ code: CODE }, { makeClient: fakeClientFactory({ signIn: "2fa" }) });
  ok("login étape 2 : SESSION_PASSWORD_NEEDED → needs2fa, pending conservé, pas de session", r2.needs2fa === true && existsSync(L.tgPendingPath()) && !existsSync(L.tgSessionPath()));
  ok("login étape 2 : code invalide → erreur claire", await L.loginFinish({ code: "00000" }, { makeClient: fakeClientFactory({ signIn: "bad" }) }).then(() => false, (e) => /code invalide/.test(e.message)));
  const r3 = await cap(L.loginFinish)({ code: CODE }, { makeClient: fakeClientFactory() });
  ok("login étape 2 : succès → me, session écrite en 600, pending supprimé", r3.me?.firstName === "Philippe" && readFileSync(L.tgSessionPath(), "utf8").startsWith("SESSION-FINALE-") && mode(L.tgSessionPath()) === "600" && !existsSync(L.tgPendingPath()));
  ok("login étape 2 : code et session absents de la sortie", !out().includes(CODE) && !out().includes("SESSION-FINALE"));
}
// mot de passe 2FA : fichier ou variable d'environnement, jamais argv
{
  const pf = join(tmp, "pw.txt"); writeFileSync(pf, PASS2FA + "\n");
  ok("readPassword : --password-file (retour ligne final retiré)", L.readPassword({ file: pf, env: {} }) === PASS2FA);
  ok("readPassword : TG_2FA_PASSWORD", L.readPassword({ env: { TG_2FA_PASSWORD: PASS2FA } }) === PASS2FA);
  ok("readPassword : aucun → null", L.readPassword({ env: {} }) === null);
  ok("readPassword : fichier absent → erreur", (() => { try { L.readPassword({ file: join(tmp, "nope") }); return false; } catch { return true; } })());
  const src = readFileSync(join(ROOT, "tools", "tg-login.mjs"), "utf8");
  ok("tg-login : aucune option --password en argv (seulement --password-file)", !/getArg\("--password"\)/.test(src) && /--password-file/.test(src) && /TG_2FA_PASSWORD/.test(src));
}

// ── 8. groupe forum (faux client, vrais constructeurs Api) ──────────────────
function fakeGroupClient({ existing = null, filters = [], topics = [] } = {}) {
  const calls = []; let nextTopic = 2;
  const state = { entity: existing, topics: [{ className: "ForumTopic", id: 1, title: "General" }, ...topics], filters: [...filters], uploads: 0, updates: [] };
  const peerOf = (e) => new Api.InputPeerChannel({ channelId: e.id, accessHash: e.accessHash });
  const client = {
    calls, state,
    async getDialogs(o = {}) { return state.entity && !o.folder ? [{ entity: state.entity }] : []; },
    async getInputEntity(x) { return x?.className === "Channel" ? peerOf(x) : x; },
    async uploadFile() { state.uploads++; return { className: "InputFile" }; },
    async invoke(req) {
      calls.push(req);
      switch (req.className) {
        case "channels.CreateChannel":
          state.entity = { className: "Channel", id: 1234567890n, accessHash: 99n, title: req.title, megagroup: true, forum: true };
          return { className: "Updates", chats: [state.entity], updates: [] };
        case "channels.CreateForumTopic": {
          const id = Math.max(nextTopic++, ...state.topics.map((t) => t.id + 1)); state.topics.push({ className: "ForumTopic", id, title: req.title });
          return { className: "Updates", updates: [{ className: "UpdateMessageID", id: 9000 + id, randomId: 1n },
            { className: "UpdateNewChannelMessage", message: { id, action: { className: "MessageActionTopicCreate", title: req.title } } }] };
        }
        case "channels.GetForumTopics": return { topics: state.topics };
        case "messages.GetDialogFilters": return { className: "messages.DialogFilters", filters: [{ className: "DialogFilterDefault" }, ...state.filters] };
        case "messages.UpdateDialogFilter": {
          state.updates.push(req);
          state.filters = [...state.filters.filter((f) => f.id !== req.id), req.filter];
          return true;
        }
        default: return {};
      }
    },
  };
  return client;
}
const PHOTO = join(tmp, "group.png"); writeFileSync(PHOTO, Buffer.from("89504e470d0a1a0a00", "hex"));
const BOTS = AGENTS.map((a) => L.botUsername("poste_ph", a.id));
{
  const c = fakeGroupClient();
  const res = await cap(L.createProjectGroup)({ client: c, title: "Demo · Poste", about: "À propos", photoPng: PHOTO, bots: BOTS, sleepFn: noSleep });
  const names = c.calls.map((r) => r.className);
  const create = c.calls[0];
  ok("groupe : CreateChannel megagroup + forum activé, titre/about", create.className === "channels.CreateChannel" && create.megagroup === true && create.forum === true && create.title === "Demo · Poste" && create.about === "À propos");
  ok("groupe : chatId = -100<channelId>", res.chatId === "-1001234567890", res.chatId);
  ok("groupe : id de topic lu dans MessageActionTopicCreate (pas UpdateMessageID)", JSON.stringify(res.topics) === JSON.stringify({ discussion: 2, fil: 3, decider: 4, alertes: 5 }), JSON.stringify(res.topics));
  ok("groupe : ids de topic numériques", Object.values(res.topics).every((v) => typeof v === "number"));
  ok("groupe : 4 topics créés dans l'ordre avec les bons titres", c.calls.filter((r) => r.className === "channels.CreateForumTopic").map((r) => r.title).join("|") === "💬 Discussion|🧠 Fil des agents|✋ À décider|🚨 Alertes");
  const inv = c.calls.filter((r) => r.className === "channels.InviteToChannel");
  ok("groupe : 7 bots invités (@username)", inv.length === 7 && inv.every((r, i) => r.users[0] === `@${BOTS[i]}` && r.channel instanceof Api.InputPeerChannel));
  const adm = c.calls.filter((r) => r.className === "channels.EditAdmin");
  const R = adm[0]?.adminRights;
  ok("groupe : 7 bots admins (poster/éditer/supprimer/épingler/topics/inviter, pas addAdmins)", adm.length === 7 && R instanceof Api.ChatAdminRights && R.postMessages && R.editMessages && R.deleteMessages && R.pinMessages && R.manageTopics && R.inviteUsers && !R.addAdmins);
  const ph = c.calls.find((r) => r.className === "channels.EditPhoto");
  ok("groupe : photo via EditPhoto + InputChatUploadedPhoto", !!ph && ph.photo instanceof Api.InputChatUploadedPhoto && c.state.uploads === 1);
  ok("groupe : ordre des étapes (créer, inviter, admin, photo, topics, dossier)",
    names.indexOf("channels.CreateChannel") < names.indexOf("channels.InviteToChannel") && names.lastIndexOf("channels.InviteToChannel") < names.indexOf("channels.EditAdmin")
    && names.lastIndexOf("channels.EditAdmin") < names.indexOf("channels.EditPhoto") && names.indexOf("channels.EditPhoto") < names.indexOf("channels.CreateForumTopic")
    && names.lastIndexOf("channels.CreateForumTopic") < names.indexOf("messages.UpdateDialogFilter"));
  const up = c.state.updates[0];
  ok("dossier : créé (« Projets », TextWithEntities, id ≥ 2, contient le groupe)", up && up.filter instanceof Api.DialogFilter && up.filter.title instanceof Api.TextWithEntities && up.filter.title.text === "Projets" && up.id >= 2 && up.filter.includePeers.length === 1 && String(up.filter.includePeers[0].channelId) === "1234567890");

  // rejeu : groupe complet → renvoyé sans rien recréer
  const before = c.calls.length;
  const again = await cap(L.createProjectGroup)({ client: c, title: "Demo · Poste", photoPng: PHOTO, bots: BOTS, sleepFn: noSleep });
  const newCalls = c.calls.slice(before).map((r) => r.className);
  ok("groupe : rejeu idempotent (même chatId/topics, aucun CreateChannel/CreateForumTopic)", JSON.stringify(again) === JSON.stringify(res) && !newCalls.includes("channels.CreateChannel") && !newCalls.includes("channels.CreateForumTopic"), newCalls.join());
}
{
  // groupe partiel (panne après 2 topics) : complété, pas dupliqué
  const ent = { className: "Channel", id: 777n, accessHash: 5n, title: "Partiel · Poste", megagroup: true, forum: true };
  const c = fakeGroupClient({ existing: ent, topics: [{ className: "ForumTopic", id: 2, title: "💬 Discussion" }, { className: "ForumTopic", id: 3, title: "🧠 Fil des agents" }] });
  const res = await cap(L.createProjectGroup)({ client: c, title: "Partiel · Poste", bots: BOTS.slice(0, 1), sleepFn: noSleep });
  ok("groupe partiel : pas de CreateChannel, 2 topics manquants créés", !c.calls.some((r) => r.className === "channels.CreateChannel") && c.calls.filter((r) => r.className === "channels.CreateForumTopic").length === 2 && res.chatId === "-100777" && res.topics.discussion === 2 && res.topics.fil === 3 && res.topics.decider > 3);
}
{
  // dossier existant : réutilisé, pair ajouté sans écraser les autres, pas de doublon
  const other = new Api.InputPeerChannel({ channelId: 42n, accessHash: 1n });
  const folder = new Api.DialogFilter({ id: 7, title: new Api.TextWithEntities({ text: "Projets", entities: [] }), pinnedPeers: [], includePeers: [other], excludePeers: [], groups: true });
  const c = fakeGroupClient({ filters: [folder] });
  await cap(L.createProjectGroup)({ client: c, title: "Autre · Poste", bots: [], sleepFn: noSleep });
  const up = c.state.updates[0];
  ok("dossier existant : réutilisé (id 7), ancien pair conservé + nouveau ajouté, drapeaux gardés", up && up.id === 7 && up.filter.includePeers.length === 2 && String(up.filter.includePeers[0].channelId) === "42" && up.filter.groups === true && c.state.updates.length === 1);
  const chan = new Api.InputPeerChannel({ channelId: 1234567890n, accessHash: 99n });
  ok("dossier : pair déjà présent → pas de nouvelle mise à jour", await L.addToFolder(c, Api, chan, "Projets") === "deja-present" && c.state.updates.length === 1);
  const c2 = fakeGroupClient({ filters: [{ className: "DialogFilter", id: 3, title: new Api.TextWithEntities({ text: "Autre", entities: [] }), includePeers: [], pinnedPeers: [], excludePeers: [] }] });
  await L.addToFolder(c2, Api, chan, "Projets");
  ok("dossier : id libre = max+1 quand d'autres dossiers existent", c2.state.updates[0].id === 4);
}
ok("extractTopicId : MessageActionTopicCreate, repli UpdateMessageID, sinon null",
  L.extractTopicId({ updates: [{ className: "UpdateNewChannelMessage", message: { id: 12, action: { className: "MessageActionTopicCreate" } } }] }) === 12
  && L.extractTopicId({ updates: [{ className: "UpdateMessageID", id: 8 }] }) === 8 && L.extractTopicId({ updates: [] }) === null);
{
  const ent = { className: "Channel", id: 888n, accessHash: 6n, title: "X · Poste", megagroup: true };
  const c = fakeGroupClient({ existing: ent });
  await L.archiveGroup("-100888", { client: c });
  const r = c.calls[0];
  ok("archiveGroup : folders.EditPeerFolders, InputFolderPeer folderId 1", r.className === "folders.EditPeerFolders" && r.folderPeers[0] instanceof Api.InputFolderPeer && r.folderPeers[0].folderId === 1 && String(r.folderPeers[0].peer.channelId) === "888");
  ok("archiveGroup : groupe inconnu → erreur claire", await L.archiveGroup("-100999", { client: c }).then(() => false, (e) => /introuvable/.test(e.message)));
}
// création : aucun secret dans la sortie (les bots invités sont des usernames publics, pas des secrets)
ok("groupe : sortie console sans token/hash", !/\d{6,}:[A-Za-z0-9_-]{30,}/.test(out()) && !out().includes(SECRET_HASH));

// ── 9. outils en ligne de commande (sans session, TG_USER_DIR vide) ─────────
{
  const empty = mkdtempSync(join(tmpdir(), "tguser-empty-"));
  const run = (script, ...a) => spawnSync(process.execPath, [join(ROOT, "tools", script), ...a], { env: { ...process.env, TG_USER_DIR: empty }, encoding: "utf8", timeout: 30000 });
  const st = run("tg-login.mjs", "--status");
  ok("tg-login --status sans session : exit 0 + message français", st.status === 0 && /Aucune session/.test(st.stdout), st.stdout + st.stderr);
  const dr = run("tg-setup.mjs", "bots", "--dry-run");
  ok("tg-setup bots --dry-run sans session : exit 0, 7 bots planifiés, rien écrit", dr.status === 0 && (dr.stdout.match(/\/newbot/g) || []).length === 7 && !existsSync(join(empty, "telegram-bots.env")), dr.stdout + dr.stderr);
  const nb = run("tg-setup.mjs", "bots");
  ok("tg-setup bots sans session : exit 1 + « compte assistant non connecté : lance tools/tg-login.mjs »", nb.status === 1 && /compte assistant non connecté : lance tools\/tg-login\.mjs/.test(nb.stderr), nb.stderr);
  const gd = run("tg-setup.mjs", "group", "Demo", "--dry-run");
  ok("tg-setup group --dry-run : titre « Demo · Poste » et 4 topics", gd.status === 0 && gd.stdout.includes("Demo · Poste") && gd.stdout.includes("🚨 Alertes"), gd.stdout + gd.stderr);
  const c2 = run("tg-login.mjs", "--code", "12345");
  ok("tg-login --code sans étape 1 : erreur « aucune connexion en attente »", c2.status === 1 && /aucune connexion en attente/.test(c2.stderr), c2.stderr);
  ok("connect() sans session : erreur française exacte", await (async () => { const old = process.env.TG_USER_DIR; process.env.TG_USER_DIR = empty; try { await L.connect(); return false; } catch (e) { return /^compte assistant non connecté : lance tools\/tg-login\.mjs/.test(e.message); } finally { process.env.TG_USER_DIR = old; } })());
  rmSync(empty, { recursive: true, force: true });
}

// ── 10. chemins de config ───────────────────────────────────────────────────
ok("chemins : tous dans TG_USER_DIR", [L.configDir(), L.tgBotsEnvPath(), L.tgPendingPath(), L.tgSessionPath(), L.tgUserJsonPath()].every((p) => p.startsWith(tmp)));
ok("chemins : noms de fichiers du cahier des charges", L.tgUserJsonPath().endsWith("/tg-user.json") && L.tgSessionPath().endsWith("/tg-user.session") && L.tgBotsEnvPath().endsWith("/telegram-bots.env") && L.tgPendingPath().endsWith("/tg-login-pending.json"));

rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} échec(s)` : "\ntout est OK");
process.exit(fails ? 1 : 0);
