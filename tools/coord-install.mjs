#!/usr/bin/env node
// coord-install : prépare la configuration de la coordination entre sessions (T36) pour chaque harnais de CETTE machine.
//   DRY-RUN PAR DÉFAUT : affiche ce qui serait fait, ne modifie rien. `--apply` exécute, après une SAUVEGARDE de chaque fichier existant
//   (<fichier>.bak-paseo-coord-<horodatage>). JAMAIS de secret : ni jeton de session, ni mot de passe (les sessions reçoivent leur identité du
//   poste au lancement, ou par « coord hello » confirmé par Philippe ; le mot de passe éventuel reste dans POSTECTL_PASSWORD, dans l'environnement).
//   Ne touche à aucune machine distante : les commandes pour WSL et Oracle sont seulement AFFICHÉES. Ne modifie jamais ~/.claude.json.
// Usage : node tools/coord-install.mjs [--apply] [--only pi,freebuff,hermes,claude,wsl,oracle] [--url URL] [--remote-url URL]
//                                      [--home DIR] [--pi-dir DIR] [--freebuff-dir DIR] [--hermes-bin CMD] [--json]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = join(here, "paseo-coord-mcp.mjs");
const CLI_SCRIPT = join(here, "coord.mjs");
const SKILL_SRC = join(here, "pi-skill-paseo-coord", "SKILL.md");
const ALL = ["pi", "freebuff", "hermes", "claude", "wsl", "oracle"];
const SERVER = "paseo-coord";

function parse(argv) {
  const flags = {};
  const valued = new Set(["only", "url", "remote-url", "home", "pi-dir", "freebuff-dir", "hermes-bin", "wsl-distro"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`argument inattendu : ${a}`);
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (valued.has(k)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined) throw new Error(`--${k} attend une valeur`);
      flags[k] = v;
    } else if (["apply", "json", "help"].includes(k)) flags[k] = true;
    else throw new Error(`option inconnue : --${k}`);
  }
  return flags;
}

const HELP = `coord-install : configure la coordination entre sessions pour les harnais de cette machine (DRY-RUN par défaut)

  node tools/coord-install.mjs                   affiche le plan, ne modifie rien
  node tools/coord-install.mjs --apply           exécute le plan (sauvegarde avant chaque modification)
  --only pi,freebuff,hermes,claude,wsl,oracle    limite aux harnais cités
  --url URL          poste de commande vu de cette machine (défaut http://127.0.0.1:7070)
  --remote-url URL   poste vu de WSL / Oracle (défaut : http://<IP-Tailscale-du-Mini-PC>:7070)
  --home DIR         dossier personnel à utiliser (défaut : le vôtre) ; --pi-dir, --freebuff-dir, --hermes-bin pour affiner
  --json             sortie JSON

Aucun secret n'est écrit. Les commandes pour WSL et Oracle sont seulement affichées.`;

const stamp = () => new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const q = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : process.platform === "win32" ? `"${s}"` : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);
const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };

export function buildPlan(flags) {
  const home = resolve(flags.home || homedir());
  const url = String(flags.url || "http://127.0.0.1:7070").replace(/\/+$/, "");
  const remote = String(flags["remote-url"] || "http://<IP-Tailscale-du-Mini-PC>:7070").replace(/\/+$/, "");
  for (const u of [flags.url, flags["remote-url"]].filter(Boolean)) {
    let p;
    try { p = new URL(u); } catch { throw new Error(`URL invalide : ${u}`); }
    if (!/^https?:$/.test(p.protocol) || p.username || p.password) throw new Error("l'URL doit être http(s) sans identifiant ni mot de passe (aucun secret n'est écrit)");
  }
  const only = flags.only ? String(flags.only).split(",").map((s) => s.trim()).filter(Boolean) : ALL;
  for (const o of only) if (!ALL.includes(o)) throw new Error(`harnais inconnu : ${o} (parmi ${ALL.join(", ")})`);
  const piDir = resolve(flags["pi-dir"] || join(home, ".pi", "agent"));
  const fbDir = resolve(flags["freebuff-dir"] || join(home, ".config", "manicode"));
  const steps = [];
  const node = process.execPath;
  const mcpEnv = { PASEO_COORD_URL: url };

  if (only.includes("pi")) {
    const skillTarget = join(piDir, "skills", "paseo-coord", "SKILL.md");
    const src = read(SKILL_SRC);
    const cur = read(skillTarget);
    steps.push({
      harness: "pi", id: "pi-skill", kind: "file", target: skillTarget, content: src,
      action: cur === null ? "create" : cur === src ? "unchanged" : "update",
      note: "Skill Pi (Pi n'a pas de MCP natif : il utilise la CLI coord, voir le Skill).",
    });
    const bin = join(home, ".paseo-coord", "bin");
    const win = process.platform === "win32";
    const shim = join(bin, win ? "coord.cmd" : "coord");
    const shimText = win ? `@echo off\r\nnode "${CLI_SCRIPT}" %*\r\n` : `#!/bin/sh\nexec node ${q(CLI_SCRIPT)} "$@"\n`;
    const curShim = read(shim);
    steps.push({
      harness: "pi", id: "pi-shim", kind: "file", target: shim, content: shimText, mode: 0o755,
      action: curShim === null ? "create" : curShim === shimText ? "unchanged" : "update",
      note: `Commande « coord » : ajoutez ${bin} au PATH (sinon le Skill utilise « node "$PASEO_COORD_CLI" »).`,
    });
  }

  if (only.includes("freebuff")) {
    const target = join(fbDir, "mcp.json");
    const raw = read(target);
    let json = { mcpServers: {} };
    let action = "create";
    let problem = null;
    if (raw !== null) {
      try { json = JSON.parse(raw); } catch { problem = "mcp.json existant illisible (JSON invalide) : non modifié"; }
      if (!problem && (typeof json !== "object" || json === null || Array.isArray(json))) problem = "mcp.json existant inattendu : non modifié";
      json.mcpServers = json.mcpServers && typeof json.mcpServers === "object" ? json.mcpServers : {};
      action = "update";
    }
    const entry = { command: node, args: [MCP_SCRIPT], env: mcpEnv };
    if (!problem && raw !== null && JSON.stringify(json.mcpServers[SERVER]) === JSON.stringify(entry)) action = "unchanged";
    if (!problem) json.mcpServers[SERVER] = entry;
    steps.push({
      harness: "freebuff", id: "freebuff-mcp", kind: "file", target, content: problem ? null : `${JSON.stringify(json, null, 2)}\n`,
      action: problem ? "manual" : action,
      note: problem || "Emplacement du fichier NON VÉRIFIÉ pour FreeBuff (test payant en Freebucks, non lancé) : adaptez --freebuff-dir si votre version le lit ailleurs.",
    });
  }

  if (only.includes("hermes")) {
    const bin = flags["hermes-bin"] || "hermes";
    steps.push({
      harness: "hermes", id: "hermes-mcp", kind: "command", action: "run", bin,
      args: ["mcp", "add", SERVER, "--command", node, "--env", `PASEO_COORD_URL=${url}`, "--args", MCP_SCRIPT],
      backup: { bin, args: ["config", "path"] },
      note: "Hermès (Mini PC, Windows) : ajoute le serveur MCP à sa configuration (sauvegardée avant).",
    });
  }

  if (only.includes("claude")) {
    steps.push({
      harness: "claude", id: "claude-mcp", kind: "manual", action: "manual",
      command: `claude mcp add --scope user ${SERVER} --env PASEO_COORD_URL=${url} -- ${q(node)} ${q(MCP_SCRIPT)}`,
      note: "Seulement pour les sessions Claude lancées EN DEHORS du poste (celles qu'il lance reçoivent déjà le serveur et leur identité). Jamais appliqué par cet outil.",
    });
  }

  if (only.includes("wsl")) {
    const distro = flags["wsl-distro"] ? ` -d ${q(String(flags["wsl-distro"]))}` : "";
    const wslScript = MCP_SCRIPT.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
    steps.push({
      harness: "wsl", id: "hermes-wsl", kind: "manual", action: "manual",
      command: `wsl.exe${distro} -- hermes mcp add ${SERVER} --command node --env PASEO_COORD_URL=${remote} --args ${q(wslScript)}`,
      note: "Hermès dans WSL : node et @modelcontextprotocol/sdk doivent exister DANS WSL (npm install --prefix /mnt/.../paseo-lab). POSTECTL_PASSWORD (si le poste a un mot de passe) se définit dans l'environnement de WSL, jamais ici. Affiché seulement.",
    });
  }

  if (only.includes("oracle")) {
    steps.push({
      harness: "oracle", id: "hermes-oracle", kind: "manual", action: "manual",
      command: [
        "ssh <utilisateur>@<oracle> 'mkdir -p ~/paseo-coord'",
        "scp tools/paseo-coord-mcp.mjs tools/coord-lib.mjs tools/coord.mjs <utilisateur>@<oracle>:~/paseo-coord/",
        "ssh <utilisateur>@<oracle> 'cd ~/paseo-coord && npm init -y >/dev/null && npm install @modelcontextprotocol/sdk@1.31.0'",
        `ssh <utilisateur>@<oracle> 'hermes mcp add ${SERVER} --command node --env PASEO_COORD_URL=${remote} --args ~/paseo-coord/paseo-coord-mcp.mjs'`,
      ].join("\n"),
      note: "Oracle (Ubuntu) : le poste doit être joignable par Tailscale depuis Oracle (DASHBOARD_TAILSCALE=1) ; POSTECTL_PASSWORD se définit dans l'environnement d'Oracle. Affiché seulement : jamais exécuté.",
    });
  }
  return { home, url, remote, steps };
}

function backupFile(file) {
  if (!existsSync(file)) return null;
  const bak = `${file}.bak-paseo-coord-${stamp()}`;
  copyFileSync(file, bak);
  return bak;
}

export function applyPlan(plan) {
  const results = [];
  for (const s of plan.steps) {
    const r = { id: s.id, action: s.action, done: false, backup: null, error: null };
    try {
      if (s.kind === "file" && ["create", "update"].includes(s.action)) {
        mkdirSync(dirname(s.target), { recursive: true });
        if (s.action === "update") r.backup = backupFile(s.target);
        writeFileSync(s.target, s.content);
        if (s.mode) { try { chmodSync(s.target, s.mode); } catch { /* Windows */ } }
        r.done = true;
      } else if (s.kind === "command") {
        try {
          const path = execFileSync(s.backup.bin, s.backup.args, { encoding: "utf8", windowsHide: true, timeout: 20000 }).trim().split(/\r?\n/).pop();
          if (path) r.backup = backupFile(path);
        } catch { throw new Error("configuration de Hermès introuvable : rien n'a été modifié (pas de sauvegarde possible)"); }
        execFileSync(s.bin, s.args, { encoding: "utf8", windowsHide: true, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
        r.done = true;
      }
    } catch (e) { r.error = String(e.message).split("\n")[0].slice(0, 200); }
    results.push(r);
  }
  return results;
}

function render(plan, applied) {
  const out = [];
  out.push(applied ? "APPLICATION" : "DRY-RUN (rien n'est modifié ; ajoutez --apply pour exécuter)");
  out.push(`Poste vu d'ici : ${plan.url}   Dossier personnel : ${plan.home}`);
  out.push("");
  for (const s of plan.steps) {
    const res = applied?.find((r) => r.id === s.id);
    const label = { create: "CRÉER", update: "MODIFIER (sauvegarde avant)", unchanged: "DÉJÀ À JOUR", run: "EXÉCUTER (sauvegarde avant)", manual: "MANUEL (jamais exécuté par cet outil)" }[s.action] || s.action;
    out.push(`[${s.harness}] ${label}${res ? (res.done ? " -> fait" : res.error ? ` -> ÉCHEC : ${res.error}` : " -> rien à faire") : ""}`);
    if (s.kind === "file") out.push(`    fichier : ${s.target}`);
    if (s.kind === "command") out.push(`    commande : ${[s.bin, ...s.args].map(q).join(" ")}`);
    if (s.kind === "manual") for (const line of s.command.split("\n")) out.push(`    $ ${line}`);
    if (res?.backup) out.push(`    sauvegarde : ${res.backup}`);
    if (s.note) out.push(`    note : ${s.note}`);
  }
  out.push("");
  out.push("Aucun secret n'est écrit : l'identité de chaque session vient du poste (injection au lancement) ou de « coord hello » confirmé par Philippe.");
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let flags;
  try { flags = parse(process.argv.slice(2)); } catch (e) { console.error(`Erreur : ${e.message}\n\n${HELP}`); process.exit(2); }
  if (flags.help) { console.log(HELP); process.exit(0); }
  let plan;
  try { plan = buildPlan(flags); } catch (e) { console.error(`Erreur : ${e.message}`); process.exit(2); }
  const applied = flags.apply ? applyPlan(plan) : null;
  if (flags.json) {
    console.log(JSON.stringify({ mode: applied ? "apply" : "dry-run", url: plan.url, steps: plan.steps.map(({ content, ...s }) => ({ ...s, bytes: content ? content.length : 0 })), results: applied }, null, 2));
  } else console.log(render(plan, applied));
  process.exit(applied?.some((r) => r.error) ? 1 : 0);
}
