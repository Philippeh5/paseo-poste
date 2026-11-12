#!/usr/bin/env node
// tools/tg-setup.mjs — Mise en place Telegram du poste via le « compte assistant » (voir tools/tg-login.mjs).
//   node tools/tg-setup.mjs bots [--dry-run] [--prefix poste_ph]
//       crée les 7 bots via @BotFather (idempotent : les bots déjà dans telegram-bots.env sont ignorés)
//   node tools/tg-setup.mjs group <nomProjet> [--dry-run]
//       crée (ou retrouve) le supergroupe forum « <nomProjet> · Poste » avec les 7 bots, la photo de
//       l'Orchestrateur et les 4 topics ; affiche le JSON { chatId, topics }
// N'écrit rien d'autre que telegram-bots.env (le dashboard stockera la correspondance projet → groupe plus tard).
// Dossier des secrets : ~/.config/paseo (override : TG_USER_DIR). Les tokens ne sont jamais affichés.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const L = await import(pathToFileURL(join(ROOT, "dashboard", "lib", "tguser.mjs")).href);
const { AGENTS, avatarPng } = await import(pathToFileURL(join(ROOT, "dashboard", "lib", "tgagents.mjs")).href);

const args = process.argv.slice(2);
const cmd = args[0];
const hasFlag = (f) => args.includes(f);
const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg) => { console.error(`ERREUR : ${msg}`); process.exit(1); };

if (cmd === "bots") {
  const prefix = getArg("--prefix") || "poste_ph";
  if (hasFlag("--dry-run")) {
    console.log(`[DRY-RUN] Création des bots (préfixe « ${prefix} », aucun envoi à Telegram) :`);
    await L.createBots({ prefix, dryRun: true });
    console.log(`[DRY-RUN] Fichier des tokens : ${L.tgBotsEnvPath()}`);
    process.exit(0);
  }
  let client;
  try { client = await L.connect(); } catch (e) { fail(e.message); }
  try {
    const r = await L.createBots({ client, prefix });
    console.log(`Bots créés : ${r.created.length}, repris : ${r.resumed.length}, déjà présents : ${r.skipped.length}. Tokens dans : ${L.tgBotsEnvPath()}`);
  } catch (e) {
    try { await client.disconnect(); } catch { /* ignore */ }
    fail(e.message);
  }
  try { await client.disconnect(); } catch { /* ignore */ }
  process.exit(0);
}

if (cmd === "group") {
  const projectName = args[1] && !args[1].startsWith("--") ? args[1] : null;
  if (!projectName) fail("usage : node tools/tg-setup.mjs group <nomProjet> [--dry-run]");
  const title = `${projectName} · Poste`;
  const bots = await L.readBotUsernames();
  if (hasFlag("--dry-run")) {
    console.log(`[DRY-RUN] Groupe « ${title} » (supergroupe forum, aucun envoi à Telegram)`);
    console.log(`  Bots invités et admins : ${bots.length ? bots.map((b) => "@" + b).join(", ") : "(aucun dans telegram-bots.env — lance d'abord « bots »)"}`);
    console.log("  Photo : avatar de l'Orchestrateur");
    console.log("  Topics : 💬 Discussion, 🧠 Fil des agents, ✋ À décider, 🚨 Alertes");
    console.log("  Dossier de chats : Projets");
    process.exit(0);
  }
  if (!bots.length) fail("aucun bot dans telegram-bots.env : lance d'abord « node tools/tg-setup.mjs bots »");
  let client;
  try { client = await L.connect(); } catch (e) { fail(e.message); }
  const tmp = mkdtempSync(join(tmpdir(), "tg-setup-"));
  try {
    let photoPng;
    try {
      photoPng = join(tmp, "orchestrateur.png");
      await avatarPng(AGENTS.find((a) => a.id === "orchestrateur"), photoPng);
    } catch (e) {
      console.error(`[tg-setup] photo du groupe ignorée : ${e.message}`);
      photoPng = undefined;
    }
    const result = await L.createProjectGroup({
      client, title, about: `Projet ${projectName} — les agents du poste`, photoPng, bots, folderTitle: "Projets",
      log: (m) => console.error(m), // les logs vont sur stderr : stdout ne contient que le JSON
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    try { await client.disconnect(); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
    fail(e.message);
  }
  try { await client.disconnect(); } catch { /* ignore */ }
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

console.log(`Utilisation :
  node tools/tg-setup.mjs bots [--dry-run] [--prefix <préfixe>]
  node tools/tg-setup.mjs group <nomProjet> [--dry-run]`);
process.exit(1);
