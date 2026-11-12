// Garde-fous durs du poste autonome (PLAN-AUTONOMIE.md, phase 4). Fonctions pures, sans dépendance :
//   1. BlastWin intouchable (écriture, suppression, services, commits/push) ; 2. secrets protégés (lecture/écriture/envoi) ;
//   3. aucun force-push ; 4. arrêt d'urgence (fichier STOP). La sauvegarde quotidienne (3e garde-fou du plan) est dans deploy/oracle/.
// Tout le reste est permis. Utilisé par tools/guard-hook.mjs (hook Claude Code) et par lib/permpolicy.mjs.
import { homedir } from "node:os";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const HOME = process.env.GUARD_HOME || homedir();
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Dossiers intouchables (séparés par « : » dans GUARD_PROTECTED_DIRS pour en ajouter). */
export const protectedDirs = () => [
  join(HOME, "Projets", "BlastWin"), "D:/Projets/BlastWin",
  ...(process.env.GUARD_PROTECTED_DIRS || "").split(":").filter(Boolean),
].map(norm);

// Noms de fichiers/chemins secrets. `.env.example` et modèles restent lisibles.
const SECRET_PATH = [
  /(^|\/)\.env(\.(?!example|sample|template)[^/]*)?$/, /\.(key|pem|p12|pfx|keystore)$/, /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)\.ssh\//, /(^|\/)\.hermes\/\.env/, /(^|\/)\.(claude[^/]*|codex|gemini|config\/gh)\/(\.?credentials[^/]*|hosts\.yml|auth\.json)/,
  /(^|\/)hosts\.json$/, /\.hosts\.json/, /(password|passwd|secret)[^/]*\.(txt|json|env)$/, /(^|\/)\.config\/paseo\/env$/,
  /(^|\/)hermes-api\.env$/, /(^|\/)\.git-credentials$/, /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /coord-secret\.json$/, /(^|\/)\.cloudflared\/[^/]*\.(json|pem)$/,
  // Secrets du compte assistant Telegram (session = accès total au compte de Philippe)
  /(^|\/)\.config\/paseo\/tg-user\.session$/, /(^|\/)\.config\/paseo\/tg-user\.json$/,
  /(^|\/)\.config\/paseo\/tg-login-pending\.json$/, /(^|\/)\.config\/paseo\/telegram-bots\.env$/,
  // Support TG_USER_DIR (override du dossier) : noms de fichier suffisants
  /\/tg-user\.session$/, /\/tg-user\.json$/, /\/tg-login-pending\.json$/, /\/telegram-bots\.env$/,
];
// Même chose dans une ligne de commande (noms collés dans le texte).
const SECRET_IN_CMD = new RegExp(
  "(?:^|[\\s'\"=:/])(?:\\.env(?!\\.(?:example|sample|template))\\b|[\\w.-]+\\.(?:key|pem|p12|pfx)\\b|id_(?:rsa|ed25519|ecdsa)\\b|\\.hermes/\\.env|\\.ssh/|"
  + "\\.credentials[\\w.]*|\\.git-credentials|\\.netrc|hosts\\.json|[\\w.-]*(?:password|passwd|secret)[\\w.-]*\\.(?:txt|json|env)|"
  + "\\.config/paseo/env|hermes-api\\.env|coord-secret\\.json|\\.config/gh/hosts\\.yml|\\.cloudflared/[\\w.-]+\\.(?:json|pem)|"
  + "tg-user\\.session|tg-user\\.json|tg-login-pending\\.json|telegram-bots\\.env)", "i");
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const abs = (p, cwd) => norm(real(resolve(cwd || process.cwd(), String(p).replace(/^~(?=$|[\\/])/, HOME))));

export const isProtectedPath = (p, cwd) => { const a = abs(p, cwd); return protectedDirs().some((d) => a === d || a.startsWith(d + "/")); };
export const isSecretPath = (p, cwd) => { const a = abs(p, cwd); return SECRET_PATH.some((r) => r.test(a)); };

export const stopFile = () => process.env.POSTE_STOP_FILE || join(process.env.DASHBOARD_DATA_DIR || join(HOME, "paseo-dash-data"), "STOP");
export const isStopped = () => existsSync(stopFile());

const deny = (guard, reason) => ({ allow: false, guard, reason });
const ok = { allow: true };

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read", "notebookread"]);
const FORCE_PUSH = /\bgit\b[^|;&\n]*\bpush\b[^|;&\n]*(?:--force\b|--force-with-lease\b|--force-if-includes\b|(?:\s)-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)|\s\+[\w./-]+)/;
// Push vers la branche principale : interdit aux agents autonomes (ils passent par une branche + PR + CI verte).
const MAIN_NAMES = "main|master";
const PUSH_TO_MAIN = new RegExp(`\\bgit\\b[^|;&\\n]*\\bpush\\b[^|;&\\n]*(?:\\s|:|/)(?:${MAIN_NAMES})(?=\\s|$|;|&|\\|)`);
const BARE_PUSH = /\bgit\b(?:\s+-C\s+\S+)?\s+push(?:\s+(?:-u|--set-upstream|--tags|--no-verify|-q|--quiet))*\s*(?:$|[;&|])/;
const currentBranch = (cwd) => { try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: cwd || process.cwd(), timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
export const isPrMerge = (cmd) => /\bgh\s+pr\s+merge\b/.test(cmd);
/** Argument PR de `gh pr merge [<n°|url|branche>] …` (null = PR de la branche courante). */
export const prMergeTarget = (cmd) => { const m = /\bgh\s+pr\s+merge\b(.*)$/s.exec(cmd); const tok = (m?.[1] || "").trim().split(/\s+/).filter((t) => t && !t.startsWith("-")); return tok[0] || null; };
/** La PR a-t-elle TOUS ses contrôles verts ? (gh pr checks : 0 = tout vert, 8 = en attente, 1 = échec). */
export function prChecksGreen(target, cwd) {
  try { execFileSync("gh", ["pr", "checks", ...(target ? [target] : [])], { cwd: cwd || process.cwd(), timeout: 30_000, stdio: "ignore" }); return { green: true }; }
  catch (e) { return { green: false, status: e.status ?? null }; }
}

const BLAST_SERVICE = /\b(?:systemctl|service|journalctl)\b[^|;&\n]*blastwin|\bblastwin-(?:game|frontend|watcher)|chain-?watcher|cloudflared-blastwin/i;
const MUTATING = /\b(?:rm|rmdir|mv|cp|rsync|tee|touch|mkdir|ln|chmod|chown|truncate|dd|sed\s+-i|perl\s+-pi|git\s+(?:add|commit|push|reset|checkout|clean|rebase|merge|stash|apply|am|cherry-pick|revert)|npm\s+(?:i|install|ci|run|publish|uninstall)|pnpm|yarn|npx|node|python3?|pm2|kill|pkill)\b|>>?\s*\S/;

/**
 * Évalue un appel d'outil d'un agent autonome. `tool` = nom Claude Code (Bash, Write, Edit, Read…), `input` = ses arguments.
 * Renvoie { allow: true } ou { allow: false, guard: "blastwin"|"secrets"|"force-push"|"stop", reason }.
 */
export function checkToolCall(tool, input = {}, { cwd } = {}) {
  const t = String(tool || "").toLowerCase();
  if (isStopped()) return deny("stop", "arrêt d'urgence actif (fichier STOP) : aucune action tant que Philippe n'a pas repris");
  const path = input.file_path || input.notebook_path || input.path;
  if (path && (WRITE_TOOLS.has(t) || READ_TOOLS.has(t))) {
    if (isSecretPath(path, cwd)) return deny("secrets", `fichier protégé (secrets) : ${path}`);
    if (WRITE_TOOLS.has(t) && isProtectedPath(path, cwd)) return deny("blastwin", `BlastWin est intouchable : ${path}`);
    if (WRITE_TOOLS.has(t) && SECRET_VALUE.test(String(input.content ?? input.new_string ?? ""))) return deny("secrets", "le contenu à écrire ressemble à un secret");
  }
  if (t === "grep" || t === "glob") {
    const p = input.path || input.pattern;
    if (p && isSecretPath(String(input.path || ""), cwd) && input.path) return deny("secrets", `recherche dans un fichier protégé : ${input.path}`);
  }
  if (t === "bash" || t === "powershell") {
    const cmd = String(input.command ?? "");
    if (FORCE_PUSH.test(cmd)) return deny("force-push", "force-push interdit : l'historique GitHub est le filet de sécurité");
    if (PUSH_TO_MAIN.test(cmd) || (BARE_PUSH.test(cmd) && /^(main|master)$/.test(currentBranch(cwd)))) return deny("main-direct", "push direct sur main interdit : branche agent/…, PR, CI verte, puis gh pr merge");
    if (/\bgh\s+pr\s+merge\b[^|;&\n]*--admin\b/.test(cmd)) return deny("main-direct", "gh pr merge --admin contourne la CI : interdit");
    if (SECRET_IN_CMD.test(cmd) || SECRET_VALUE.test(cmd)) return deny("secrets", "la commande touche un fichier ou une valeur secrète");
    if (/(^|[\s;&|])(?:printenv|env|set|export\s+-p)\s*(?:$|[|;&>])/.test(cmd) || /\bcat\s+\/proc\/[^ ]*environ/.test(cmd)) return deny("secrets", "l'environnement peut contenir des secrets");
    if (BLAST_SERVICE.test(cmd)) return deny("blastwin", "les services BlastWin sont intouchables");
    const touchesBlast = protectedDirs().some((d) => norm(cmd).includes(d)) || (cwd && isProtectedPath(cwd, cwd) && !/^\s*(?:ls|cat|head|tail|grep|rg|find|git\s+(?:log|status|diff|show)|pwd|echo)\b/.test(cmd));
    if (touchesBlast && MUTATING.test(cmd)) return deny("blastwin", "BlastWin est intouchable (commande modifiante)");
  }
  return ok;
}

/** Le dossier de projet peut-il recevoir une mission autonome ? (BlastWin : confirmable, jamais un refus dur absolu) */
export const checkProjectDir = (dir) => (isProtectedPath(dir) ? { allow: false, guard: "blastwin", confirmable: true, reason: `BlastWin est protégée : confirmation requise avant toute modification (${dir})` } : ok);
