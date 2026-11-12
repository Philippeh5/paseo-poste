#!/usr/bin/env node
// tools/tg-login.mjs — Connexion NON interactive en deux temps au « compte assistant » Telegram (GramJS).
// Pensé pour être lancé via le préfixe « ! » de Claude Code, où les saisies au clavier ne sont pas utilisables.
//
//   Étape 1 : node tools/tg-login.mjs --api-id <id> --api-hash <hash> --phone <+33...>
//             → enregistre tg-user.json, envoie le code (auth.SendCode), écrit tg-login-pending.json (600, 10 min)
//   Étape 2 : node tools/tg-login.mjs --code <code>
//             → auth.SignIn ; si la 2FA est activée : relancer avec --code <code> --password-file <fichier>
//               (ou variable d'environnement TG_2FA_PASSWORD). Jamais d'option --password : elle finirait dans
//               l'historique du shell. Écrit la session (600) et supprime le fichier pending.
//   --status : dit si une session existe et qui est connecté (rien de secret)
//   --logout : se déconnecte de Telegram (auth.LogOut) et supprime la session locale
//
// Dossier des secrets : ~/.config/paseo (override : TG_USER_DIR). Aucun secret n'est jamais affiché.

import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const L = await import(pathToFileURL(join(ROOT, "dashboard", "lib", "tguser.mjs")).href);

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const hasFlag = (name) => args.includes(name);
const fail = (msg) => { console.error(`ERREUR : ${msg}`); process.exit(1); };

try {
  // ── --status ───────────────────────────────────────────────────────────────
  if (hasFlag("--status")) {
    const cfg = L.readUserConfig();
    if (!cfg || !existsSync(L.tgSessionPath())) {
      const st = L.readPending();
      console.log("Aucune session du compte assistant. Lance : node tools/tg-login.mjs --api-id <id> --api-hash <hash> --phone <+33...>");
      if (st.state === "ok") console.log("Une connexion est en attente de code : lance node tools/tg-login.mjs --code <code>");
      process.exit(0);
    }
    try {
      const client = await L.connect();
      const me = await client.getMe();
      await client.disconnect();
      const nom = [me.firstName, me.lastName].filter(Boolean).join(" ") || "?";
      console.log(`Session active : ${nom} (@${me.username || "sans-username"}) — id ${me.id}`);
    } catch (e) {
      console.log(`Session présente mais inutilisable : ${e.message}`);
    }
    process.exit(0);
  }

  // ── --logout ───────────────────────────────────────────────────────────────
  if (hasFlag("--logout")) {
    const cfg = L.readUserConfig();
    if (cfg && existsSync(L.tgSessionPath())) {
      try {
        const client = await L.connect();
        const { Api } = await import("telegram");
        await client.invoke(new Api.auth.LogOut());
        await client.disconnect();
        console.log("Déconnecté côté Telegram.");
      } catch (e) {
        console.log(`Déconnexion côté Telegram impossible (${e.message}) — la session locale est quand même supprimée.`);
      }
    }
    for (const p of [L.tgSessionPath(), L.tgPendingPath()]) { try { unlinkSync(p); } catch { /* absent */ } }
    console.log("Session locale supprimée (tg-user.json est conservé : supprime-le à la main si besoin).");
    process.exit(0);
  }

  // ── Étape 1 : envoi du code ────────────────────────────────────────────────
  if (getArg("--api-id") || getArg("--api-hash") || getArg("--phone")) {
    const apiId = getArg("--api-id"), apiHash = getArg("--api-hash"), phone = getArg("--phone");
    if (!apiId || !apiHash || !phone) fail("l'étape 1 demande --api-id, --api-hash et --phone ensemble");
    await L.loginStart({ apiId, apiHash, phone });
    console.log("Code envoyé dans Telegram. Lance : node tools/tg-login.mjs --code 12345");
    process.exit(0);
  }

  // ── Étape 2 : saisie du code ───────────────────────────────────────────────
  if (getArg("--code")) {
    const code = getArg("--code");
    const password = L.readPassword({ file: getArg("--password-file") });
    const r = await L.loginFinish({ code, password });
    if (r.needs2fa) {
      console.error("Mot de passe 2FA requis : relance avec --code <code> --password-file <fichier>");
      console.error("(ou variable d'environnement TG_2FA_PASSWORD ; pas d'option --password, elle resterait dans l'historique)");
      process.exit(2);
    }
    const prenom = r.me?.firstName || r.me?.username || "?";
    console.log(`Connecté en tant que ${prenom} (@${r.me?.username || "sans-username"})`);
    process.exit(0);
  }

  console.log(`Utilisation :
  Étape 1 : node tools/tg-login.mjs --api-id <id> --api-hash <hash> --phone <+33...>
  Étape 2 : node tools/tg-login.mjs --code <code> [--password-file <fichier>]   (2FA : fichier ou TG_2FA_PASSWORD)
  Autres  : --status (qui est connecté ?)   --logout (déconnexion + suppression de la session)`);
  process.exit(1);
} catch (e) {
  fail(e.message);
}
