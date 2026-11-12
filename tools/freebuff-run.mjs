#!/usr/bin/env node
// freebuff-run: ouvre FreeBuff dans un vrai terminal PTY du daemon Paseo, y "tape" une invite
// et renvoie l'ecran capture (sans ANSI). Aucune dependance hors @getpaseo/client (resolue depuis ../node_modules).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPaseoClient } from "@getpaseo/client";

function parseArgs(argv) {
  const o = { url: "ws://127.0.0.1:6767/ws", waitSeconds: 90, keep: false, json: false, command: "freebuff", debug: false };
  const need = (i, k) => { if (i + 1 >= argv.length) fail(`valeur manquante pour ${k}`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") o.url = need(i++, a);
    else if (a === "--password-file") o.passwordFile = need(i++, a);
    else if (a === "--cwd") o.cwd = need(i++, a);
    else if (a === "--prompt") o.prompt = need(i++, a);
    else if (a === "--wait-seconds") o.waitSeconds = Number(need(i++, a));
    else if (a === "--command") o.command = need(i++, a);
    else if (a === "--terminal-id") o.terminalId = need(i++, a);
    else if (a === "--keep") o.keep = true;
    else if (a === "--json") o.json = true;
    else if (a === "--debug") o.debug = true;
    else if (a === "-h" || a === "--help") { console.log("usage: node freebuff-run.mjs --cwd <dir> --prompt <texte> [--url ws://...] [--password-file f] [--wait-seconds 90] [--keep] [--terminal-id <id>: suite dans un FreeBuff deja ouvert, garder avec --keep au 1er tour] [--json] [--command freebuff] [--debug]"); process.exit(0); }
    else fail(`option inconnue: ${a}`);
  }
  if (!o.cwd) fail("--cwd requis");
  if (!o.prompt) fail("--prompt requis");
  if (!Number.isFinite(o.waitSeconds) || o.waitSeconds <= 0) fail("--wait-seconds invalide");
  return o;
}
function fail(msg) { console.error(`freebuff-run: ${msg}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const clean = (l) => l.replace(ANSI, "").replace(/\s+$/, "");

// Retire les encarts publicitaires (boite indentee d'un espace, dont une ligne finit par "Ad │"),
// car la pub change/tourne et fausserait le test "ecran stable".
function stripAds(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^ ╭/.test(lines[i])) {
      let j = i;
      while (j < lines.length && !/^ ╰/.test(lines[j])) j++;
      if (j < lines.length && lines.slice(i, j + 1).some((l) => /\bAd\b(\s*\[[^\]]*\])?\s*│\s*$/.test(l))) { i = j; continue; }
    }
    out.push(lines[i]);
  }
  return out;
}
const isReady = (lines) => {
  const s = lines.join("\n");
  return /Enter a coding task|Ask a follow-up|▍/.test(s) && /\? for help|for history/.test(s) && !/esc to (interrupt|cancel)/i.test(s);
};

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const password = o.passwordFile ? readFileSync(o.passwordFile, "utf8").trim() : process.env.FREEBUFF_DAEMON_PASSWORD || process.env.PASEO_PASSWORD || undefined;
  const cwd = resolve(o.cwd);
  const client = createPaseoClient({ url: o.url, ...(password ? { password } : {}), reconnect: { enabled: false } });
  await client.connect();
  let term = null;
  const result = { terminalId: null, ready: false, completed: false, killed: false, screen: "", reply: "", error: null };
  const dbg = (...a) => { if (o.debug) console.error("[dbg]", ...a); };
  const snap = async () => {
    const cap = await term.capture({ stripAnsi: true });
    const lines = cap.lines.map(clean);
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines;
  };
  try {
    const ws = await client.workspaces.open({ cwd });
    term = o.terminalId ? client.terminals.ref(o.terminalId) : await ws.terminals.create({ name: "freebuff-run", command: o.command, args: [], size: { rows: 40, cols: 120 } });
    result.terminalId = o.terminalId || term.id;
    const deadline = Date.now() + o.waitSeconds * 1000;

    // 1. attendre l'invite d'entree prete (lecture de l'ecran, 2 captures consecutives pretes)
    let okCount = 0, lines = [];
    while (Date.now() < deadline) {
      await sleep(1000);
      lines = await snap();
      if (/Not enough hours|visit .*freebuff\.com\/plans/i.test(lines.join("\n"))) throw new Error("QUOTA: FreeBuff n'a plus assez d'heures pour ce modele (" + (lines.find((l) => /Not enough hours/i.test(l)) || "").trim().slice(0, 120) + ")");
      okCount = isReady(lines) ? okCount + 1 : 0;
      dbg("attente invite", okCount);
      if (okCount >= 3) { result.ready = true; break; }
    }
    if (!result.ready) throw new Error(`invite FreeBuff non prete apres ${o.waitSeconds}s`);

    // 2. saisir le texte, verifier qu'il apparait, puis Entree
    const before = stripAds(lines).join("\n");
    const probe = o.prompt.slice(0, 20);
    // la TUI peut avaler les premieres touches juste apres l'affichage de l'invite: on laisse se poser, puis on retente
    await sleep(o.terminalId ? 1000 : Number(process.env.FREEBUFF_SETTLE_MS || 10000));
    let echoed = false;
    for (let attempt = 1; attempt <= 5 && !echoed; attempt++) {
      term.write(o.prompt);
      for (let i = 0; i < 10 && !echoed; i++) { await sleep(500); lines = await snap(); echoed = lines.join("\n").includes(probe); }
      dbg("saisie tentative", attempt, echoed);
    }
    if (!echoed) throw new Error("le texte saisi n'apparait pas a l'ecran (5 tentatives)");
    await sleep(300);
    term.sendKeys(["Enter"]);

    // 3. attendre la fin: ecran (hors pub) change depuis l'envoi, stable >= 5 s, et invite de nouveau prete
    let last = "", stableSince = Date.now(), changed = false;
    while (Date.now() < deadline) {
      await sleep(1000);
      lines = await snap();
      const cur = stripAds(lines).join("\n");
      if (cur !== last) { last = cur; stableSince = Date.now(); }
      if (cur !== before) changed = true;
      const stable = (Date.now() - stableSince) / 1000;
      if (/Not enough hours/i.test(lines.join("\n"))) throw new Error("QUOTA: FreeBuff n'a plus assez d'heures pour ce modele (" + (lines.find((l) => /Not enough hours/i.test(l)) || "").replace(/[│]/g, "").trim().slice(0, 120) + ")");
      dbg("attente reponse", { changed, stable: stable.toFixed(1), ready: isReady(lines) });
      // exige aussi que l'echo de l'invite soit visible (la reponse s'affiche en dessous)
      if (changed && stable >= 5 && isReady(lines) && lines.some((l) => l.includes(probe))) { result.completed = true; break; }
    }
    lines = await snap();
    result.screen = lines.join("\n");
    const idx = lines.map((l) => l.includes(probe)).lastIndexOf(true);
    const end = lines.findIndex((l, i) => i > idx && /^╭/.test(l));
    if (idx >= 0) result.reply = stripAds(lines.slice(idx + 1, end > 0 ? end : undefined)).filter((l) => !/⎘ •|End session/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!result.completed) result.error = `reponse non terminee apres ${o.waitSeconds}s (ecran capture quand meme)`;
  } catch (e) {
    result.error = String(e?.message ?? e);
    try { if (term) result.screen = (await snap()).join("\n"); } catch {}
  } finally {
    if (term && !o.keep) { try { await term.kill(); result.killed = true; } catch (e) { result.killError = String(e?.message ?? e); } }
    await client.close().catch(() => {});
  }
  if (o.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`terminalId: ${result.terminalId}  ready=${result.ready} completed=${result.completed} killed=${result.killed}`);
    if (result.error) console.log(`erreur: ${result.error}`);
    console.log("----- ecran -----\n" + result.screen);
  }
  process.exit(result.completed ? 0 : 1);
}
main().catch((e) => { console.error(`freebuff-run: ${e?.message ?? e}`); process.exit(1); });
