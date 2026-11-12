#!/usr/bin/env node
// Prépare l'accès au dashboard par le réseau Tailscale (voir dashboard/README.md, « Accès par Tailscale »).
//  - crée dashboard/data/tailscale-password.txt (aléatoire, jamais affiché) s'il n'existe pas ;
//  - écrit dashboard/start-dashboard.ps1 (lance le serveur avec DASHBOARD_TAILSCALE=1 + mot de passe lu du fichier) ;
//  - affiche l'URL à ouvrir et l'emplacement du mot de passe.
// Option --dir <dossier dashboard> : cible un autre dossier (tests). N'arrête ni ne modifie aucun serveur en marche.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
const dashboardDir = dirIdx >= 0 ? resolve(args[dirIdx + 1] || "") : resolve(dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
const dataDir = join(dashboardDir, "data");
const passwordFile = join(dataDir, "tailscale-password.txt");
const scriptFile = join(dashboardDir, "start-dashboard.ps1");
const MARKER = "# Géré par tools/tailscale-setup.mjs";

function restrict(file) {
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME;
      if (!user) return false;
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
    } else {
      chmodSync(file, 0o600);
    }
    return true;
  } catch { return false; }
}

function tailscaleIp() {
  const forced = (process.env.DASHBOARD_TAILSCALE_IP || "").trim();
  if (forced) return forced;
  for (const bin of ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]) {
    try {
      const out = execFileSync(bin, ["ip", "-4"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      const ip = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^100\.\d+\.\d+\.\d+$/.test(l));
      if (ip) return ip;
    } catch { /* essai suivant */ }
  }
  return null;
}

mkdirSync(dataDir, { recursive: true });
let created = false;
if (!existsSync(passwordFile)) {
  // 32 octets -> 43 caractères base64url ; écriture exclusive pour ne jamais écraser un mot de passe existant.
  writeFileSync(passwordFile, randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
  created = true;
}
const restricted = restrict(passwordFile);
if (readFileSync(passwordFile, "utf8").trim().length < 16) {
  console.error(`${passwordFile} contient moins de 16 caractères : supprimez-le puis relancez pour en générer un nouveau.`);
  process.exit(1);
}

const script = [
  MARKER + " — peut être régénéré, ne contient aucun secret.",
  "$ErrorActionPreference = 'Stop'",
  "Set-Location $PSScriptRoot",
  "$env:DASHBOARD_TAILSCALE = '1'",
  "$env:DASHBOARD_TAILSCALE_PASSWORD = (Get-Content -Raw (Join-Path $PSScriptRoot 'data\\tailscale-password.txt')).Trim()",
  "node server.mjs",
  "",
].join("\r\n");
let backup = null;
if (existsSync(scriptFile) && !readFileSync(scriptFile, "utf8").includes(MARKER)) {
  backup = scriptFile + ".bak";
  if (!existsSync(backup)) copyFileSync(scriptFile, backup);
}
writeFileSync(scriptFile, script);

const ip = tailscaleIp();
const port = process.env.DASHBOARD_PORT || 7070;
console.log(created ? "Mot de passe Tailscale créé." : "Mot de passe Tailscale déjà présent (conservé).");
if (!restricted) console.log("Attention : droits du fichier de mot de passe non restreints automatiquement, vérifiez-les.");
console.log(`Mot de passe : ${passwordFile} (utilisateur : admin)`);
console.log(`Script de démarrage : ${scriptFile}${backup ? ` (ancien contenu sauvegardé dans ${backup})` : ""}`);
console.log(ip ? `URL à ouvrir : http://${ip}:${port}` : "IP Tailscale introuvable : lancez `tailscale ip -4` ; l'URL sera http://<ip-tailscale>:" + port);
console.log("Démarrage : powershell -File dashboard\\start-dashboard.ps1 (redémarrez le dashboard pour activer l'écouteur).");
