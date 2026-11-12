// Politique de permissions du mandat (T34) : fonction PURE (aucun état, aucun réseau ; seule lecture du disque :
// résolution des liens/jonctions pour vérifier qu'un chemin reste dans le dossier du projet).
//
//   evaluatePermission(item, mandate, options?) → { decision: "allow" | "deny" | "ask", reason, what }
//
// `item` est un élément de la boîte de réception (kind "permission") : titre « Permission requise : <outil> »,
// `action: { type: "permission", tool, kind, target, pattern, cwd, danger, ... }` et `body` (commande ou chemin plafonné).
// `mandate` : l'état du Mode Agent ({ enabled, projectDir, forbidden, autoPermissions, allowGit, writeScope }).
//
// PRINCIPE : « allow » = LISTE BLANCHE de formes simples, jamais un analyseur de shell. Une commande n'est autorisée que si
// chaque mot est « propre » (aucun de { } * ? [ ] ~ $ ` ! ( ) < > \ ; | & # ni retour à la ligne), si la commande et ses
// options figurent dans une liste fixe, et si chaque argument fichier (mots nus compris) reste, liens et jonctions résolus,
// dans le dossier du projet. Tout ce qui n'est pas compris ni vérifiable donne « ask ». Les refus (« deny ») sont une
// commodité d'explication : se tromper vers « ask » est sans danger, se tromper vers « allow » ne l'est jamais.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redact } from "./redact.mjs";
import { checkToolCall } from "./guardrails.mjs";

export const POSTECTL = fileURLToPath(new URL("../../tools/postectl.mjs", import.meta.url)).replace(/\\/g, "/");
export const MAX_COMMAND = 1500; // au-delà, une commande n'est jamais auto-autorisée (trop longue à vérifier)
export const MAX_TARGET = 4000; // plafond de la cible conservée dans la boîte de réception

const WIN = process.platform === "win32";
const fold = (s) => (WIN ? String(s).toLowerCase() : String(s));
const slashes = (p) => String(p ?? "").replace(/\\/g, "/");
const clip = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const WHAT_MAX = 400; // les libellés internes ne sont raccourcis qu'à la fin, APRÈS masquage des secrets
const result = (decision, reason, what = "") => ({ decision, reason, what });

// ---------------------------------------------------------------------------------------------------------
// Catégories interdites par le mandat (même logique que handlers/agentmode.mjs : isForbidden).
export function forbids(forbidden, category) {
  const list = Array.isArray(forbidden) ? forbidden : [];
  return list.some((item) => {
    const s = String(item).toLowerCase();
    if (category === "supprimer") return s.includes("supprim") || s.includes("delete");
    if (category === "pousser sur GitHub") return s.includes("pouss") || s.includes("push") || s.includes("github");
    if (category === "éteindre une machine") return s.includes("éteind") || s.includes("eteind") || s.includes("shutdown");
    return s === String(category).toLowerCase();
  });
}
const BUILTIN_FORBIDDEN = /supprim|delete|pouss|push|github|éteind|eteind|shutdown/i;
// Interdictions libres du mandat : mots significatifs d'une entrée (≥ 3 lettres, hors verbes génériques).
const GENERIC_WORDS = new Set(["modifier", "éditer", "editer", "écrire", "ecrire", "lire", "supprimer", "ouvrir", "toucher",
  "changer", "modify", "edit", "write", "read", "delete", "open", "touch", "change", "les", "des", "une", "aux", "sur", "dans",
  "avec", "pour", "the", "and", "ne", "pas", "jamais", "fichier", "fichiers", "file", "files", "dossier", "dossiers",
  "folder", "répertoire", "repertoire", "chemin", "path", "tout", "tous", "toute", "toutes", "dans", "ces", "cette", "that", "this"]);
export function significantWords(entry) {
  return String(entry).toLowerCase().split(/[\s,;:()«»"'’]+/).map((w) => w.replace(/^[./\\]+|[./\\]+$/g, ""))
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
}

// ---------------------------------------------------------------------------------------------------------
// Chemins
const SENSITIVE_NAME = /(^|\/)(\.env(\..*)?|id_(rsa|ed25519|ecdsa|dsa)[^/]*|[^/]*\.(pem|key|pfx|p12|kdbx|secret)|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|credentials(\.[^/]*)?|secrets?(\.[^/]*)?|\.kube\/config|\.docker\/config\.json)$/i;
const CONFIG_DIRS = new Set([".git", ".claude", ".github", ".vscode", ".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const SCRIPT_EXT = /\.(mjs|cjs|js|ps1|bat|cmd|sh|py)$/i;
// Noms de fichiers dont la modification peut déclencher une exécution plus tard (git, shell, npm, make, éditeur, CI…).
const TRIGGER_FILES = /^(\.gitconfig|\.gitmodules|\.gitattributes|\.gitignore_global|\.bashrc|\.bash_profile|\.bash_login|\.bash_logout|\.profile|\.zshrc|\.zshenv|\.zprofile|\.npmrc|\.yarnrc(\..*)?|\.pypirc|\.netrc|\.envrc|\.env(\..*)?|pip\.conf|pip\.ini|makefile|gnumakefile|package\.json|package-lock\.json|.*\.code-workspace|tasks\.json|justfile|dockerfile|docker-compose\.ya?ml|\.pre-commit-config\.yaml|config\.json|hosts\.json|settings\.json|launch\.json)$/i;

// Chemin → { abs, weird, dotdot } normalisé avec des « / » ; { abs: null, reject: true } pour les préfixes d'espace de noms
// Windows (\\?\, \\.\, UNC) ; null si le chemin n'est pas interprétable.
export function resolvePath(raw, base, glob = false) {
  let s = String(raw ?? "").trim();
  if (!s || /[\u0000-\u001f]/.test(s)) return null;
  s = s.replace(/\\/g, "/");
  if (/^\/\/[?.]\//.test(s) || /^\/\/[^/]/.test(s)) return { abs: null, reject: true };
  if (WIN) s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => `${d.toUpperCase()}:`); // /d/Projets → D:/Projets (Git Bash)
  if (s === "~" || s.startsWith("~/") || /^~[^/]/.test(s)) return null;
  if (/^[A-Za-z]:$/.test(s)) s += "/";
  if (/^[A-Za-z]:[^/]/.test(s)) return null; // chemin relatif à un lecteur : ambigu
  let full;
  if (/^[A-Za-z]:\//.test(s) || s.startsWith("/")) full = s;
  else if (base) full = `${base}/${s}`;
  else return null;
  let prefix = "";
  let rest = full;
  const drive = /^([A-Za-z]):(?=\/|$)/.exec(full);
  if (drive) { prefix = `${drive[1].toUpperCase()}:`; rest = full.slice(2); }
  const out = [];
  let weird = false;
  let dotdot = false;
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { dotdot = true; out.pop(); continue; }
    if (/[<>"|]/.test(seg) || (!glob && /[?*]/.test(seg)) || /[. ]$/.test(seg) || seg.includes(":") ||
        /~\d/.test(seg) || /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i.test(seg)) weird = true;
    out.push(seg);
  }
  return { abs: `${prefix}/${out.join("/")}`.replace(/\/+$/, "") || "/", weird, dotdot };
}

const inside = (abs, root) => {
  const a = fold(abs);
  const r = fold(root).replace(/\/+$/, "");
  return a === r || a.startsWith(`${r}/`);
};

// Chemin réel (liens, jonctions et noms 8.3 résolus) du plus profond ancêtre existant, complété par le reste du chemin.
export function realOf(abs) {
  try {
    let head = abs;
    const tail = [];
    for (;;) {
      const probe = /^[A-Za-z]:$/.test(head) ? `${head}/` : head;
      if (existsSync(probe)) {
        const real = slashes(realpathSync.native(probe)).replace(/^\/\/\?\//, "").replace(/\/+$/, "");
        return real + (tail.length ? `/${tail.join("/")}` : "");
      }
      const i = head.lastIndexOf("/");
      if (i <= 0 || head.length <= 3) return abs;
      tail.unshift(head.slice(i + 1));
      head = head.slice(0, i);
    }
  } catch {
    return abs;
  }
}

// "in" : dedans ; "out" : dehors ; "link" : un lien ou une jonction mène dehors ; "odd" : à vérifier (« .. », nom étrange…).
export function classifyPath(raw, base, root, glob = false) {
  const p = resolvePath(raw, base, glob);
  if (!p) return "odd";
  if (p.reject) return "out";
  if (!inside(p.abs, root)) return "out";
  if (p.weird || p.dotdot) return "odd";
  return inside(realOf(p.abs), realOf(root)) ? "in" : "link";
}

// Y a-t-il un lien ou une jonction sous ce dossier ? (parcours borné ; dans le doute : oui). Sert aux options récursives.
function linksBelow(absDir, budget = { n: 20000 }, depth = 0) {
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return false; } // fichier ou absent : rien dessous
  for (const d of entries) {
    if (--budget.n < 0) return true;
    if (d.isSymbolicLink()) return true;
    if (d.isDirectory() && d.name.toLowerCase() !== ".git") {
      if (depth >= 12) return true;
      if (linksBelow(`${absDir}/${d.name}`, budget, depth + 1)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Analyse d'une commande shell : segments, mots, redirections, et ce qui empêche de la comprendre sans risque.
export function tokenize(cmd) {
  const segs = [];
  const issues = new Set();
  let seg = { words: [], redirects: [] };
  let cur = null;
  let pending = null;
  let q = "";
  const add = (ch) => { cur ??= { text: "", quoted: false, hasVar: false }; cur.text += ch; };
  const endWord = () => {
    if (!cur) return;
    if (pending) { seg.redirects.push({ op: pending, target: cur.text }); pending = null; } else seg.words.push(cur);
    cur = null;
  };
  const endSeg = () => {
    endWord();
    if (pending) { seg.redirects.push({ op: pending, target: "" }); pending = null; }
    if (seg.words.length || seg.redirects.length) segs.push(seg);
    seg = { words: [], redirects: [] };
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (q === "'") { if (c === "'") q = ""; else add(c); continue; }
    if (q === '"') {
      if (c === '"') { q = ""; continue; }
      if (c === "\\" && (n === '"' || n === "\\")) { issues.add("escape"); add(c); continue; }
      if (c === "`") issues.add("subst");
      if (c === "$") { if (n === "(") issues.add("subst"); else if (n && /[A-Za-z_{@*#?!$0-9]/.test(n)) cur.hasVar = true; }
      add(c);
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur ??= { text: "", quoted: true, hasVar: false }; cur.quoted = true; continue; }
    if (c === "\\") {
      if (n === '"' || n === "'") { issues.add("escape"); add(c); continue; }
      if (n === "\n") { i++; issues.add("newline"); continue; }
      add(c);
      continue;
    }
    if (c === "`") { issues.add("subst"); add(c); continue; }
    if (c === "$") {
      if (n === "(") issues.add("subst");
      else if (n === "'" || n === '"') issues.add("escape");
      else if (n && /[A-Za-z_{@*#?!$0-9]/.test(n)) { cur ??= { text: "", quoted: false, hasVar: false }; cur.hasVar = true; }
      add(c);
      continue;
    }
    if (c === " " || c === "\t") { endWord(); continue; }
    if (c === "\n" || c === "\r") { issues.add("newline"); endSeg(); continue; }
    if (c === ";") { endSeg(); continue; }
    if (c === "|") {
      if (n === "&") { issues.add("pipeamp"); i++; } else if (n === "|") i++;
      endSeg();
      continue;
    }
    if (c === "&") {
      if (n === ">") { endWord(); pending = "&>"; i++; if (cmd[i + 1] === ">") i++; continue; }
      if (n === "&") { i++; endSeg(); continue; }
      issues.add("background");
      endSeg();
      continue;
    }
    if (c === "(" || c === ")") { issues.add("group"); endSeg(); continue; }
    if (c === "#" && !cur) { issues.add("comment"); continue; }
    if (c === ">") {
      if (cur && !cur.quoted && /^\d+$/.test(cur.text)) cur = null; // « 2>… » : numéro de descripteur
      else endWord();
      let op = ">";
      if (n === ">") { op = ">>"; i++; }
      if (cmd[i + 1] === "&") {
        const m = /^&(\d+|-)/.exec(cmd.slice(i + 1, i + 8));
        if (m) { i += m[0].length; continue; } // « 2>&1 » : sans fichier
        op += "&";
        i++;
      }
      pending = op;
      continue;
    }
    if (c === "<") {
      if (n === "<") { issues.add("heredoc"); i++; if (cmd[i + 1] === "<") i++; continue; }
      if (n === "(") { issues.add("group"); continue; }
      if (cur && !cur.quoted && /^\d+$/.test(cur.text)) cur = null; else endWord();
      pending = "<";
      continue;
    }
    add(c);
  }
  if (q) issues.add("unterminated");
  endSeg();
  return { segs, issues };
}

const SINK = /^(\/dev\/null|nul)$/i;
const PREFIX_WORDS = new Set(["{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "time", "env", "command",
  "nohup", "nice", "xargs", "exec", "sudo", "doas", "builtin", "timeout", "stdbuf", "setsid", "ionice", "eval", "call"]);
const WRAPPERS_VALUE = /^(-?\d+[smhd]?|-[a-zA-Z]+|--[\w-]+(=\S*)?)$/;
// Affectation de variable (NOM=valeur, NOM+=valeur, tab[i]=valeur), entre guillemets ou non.
const ENV_ASSIGN = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/;
// Mots spéciaux du shell : jamais auto-autorisés en position de commande (ils changent l'environnement ou exécutent autre chose).
const SPECIAL_WORDS = new Set(["env", "nice", "nohup", "timeout", "time", "command", "exec", "xargs", "sudo", "doas", "stdbuf", "setsid",
  "{", "}", "!", "then", "do", "else", "elif", "fi", "done", "esac", "in", "if", "while", "until", "for", "select", "case", "function",
  "source", ".", "eval", "alias", "unalias", "export", "set", "unset", "declare", "typeset", "local", "readonly", "trap", "ulimit",
  "umask", "builtin", "ionice", "call", "shopt", "enable", "hash", "wait", "exit", "return", "coproc"]);

// Position de la vraie commande dans un segment (après variables d'environnement et mots-outils) ; wrapped = qu'on en a sauté.
function commandIndex(words) {
  let i = 0;
  let wrapped = false;
  while (i < words.length) {
    const w = words[i];
    const t = w.text.toLowerCase();
    if (ENV_ASSIGN.test(w.text)) { i++; wrapped = true; continue; }
    if (!w.quoted && PREFIX_WORDS.has(t)) {
      i++;
      wrapped = true;
      if (["timeout", "nice", "xargs", "env", "stdbuf", "ionice", "sudo", "doas"].includes(t)) {
        while (i < words.length && WRAPPERS_VALUE.test(words[i].text) && !ENV_ASSIGN.test(words[i].text)) i++;
      }
      continue;
    }
    break;
  }
  return { index: i, wrapped };
}

export const baseCmd = (text) => {
  const t = slashes(text).split("/").pop().toLowerCase();
  return t.replace(/\.(exe|cmd|bat|com|ps1)$/, "");
};
export const DELETE_CMDS = new Set(["rm", "rmdir", "del", "erase", "rd", "unlink", "shred", "remove-item", "ri", "rmtree"]);
export const MOVE_CMDS = new Set(["mv", "move", "move-item", "mi"]);
export const COPY_CMDS = new Set(["cp", "copy", "xcopy", "robocopy", "copy-item", "cpi", "install", "rsync"]);
export const WRITE_CMDS = new Set(["tee", "touch", "mkdir", "md", "ln", "mklink", "ni", "new-item", "set-content", "sc", "add-content",
  "ac", "out-file", "rename-item", "ren", "rni", "tee-object", "truncate", "dd", "chmod", "chown", "attrib", "icacls", "takeown"]);
const NET_CMDS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "start-bitstransfer"]);
const SHUTDOWN_CMDS = new Set(["shutdown", "poweroff", "halt", "reboot", "stop-computer", "restart-computer"]);
const NPX_CMDS = new Set(["npx", "pnpx", "bunx"]);
const PKG_SUBS = {
  npm: ["install", "i", "add", "ci", "update", "upgrade", "uninstall", "remove", "rm", "link", "ln", "dedupe"],
  pnpm: ["install", "i", "add", "update", "up", "upgrade", "remove", "rm", "uninstall", "link", "dlx"],
  yarn: ["install", "add", "upgrade", "up", "remove", "link", "dlx", "global"],
  bun: ["install", "i", "add", "update", "remove", "rm", "link", "x"],
  pip: ["install", "uninstall"], pip3: ["install", "uninstall"], pipx: ["install", "uninstall", "run", "upgrade"],
  uv: ["add", "remove", "sync", "pip", "tool"], poetry: ["add", "remove", "install", "update"],
  cargo: ["install", "add", "remove", "update"], go: ["install", "get"], gem: ["install", "uninstall", "update"],
  winget: ["install", "upgrade", "uninstall"], choco: ["install", "upgrade", "uninstall"], scoop: ["install", "update", "uninstall"],
  brew: ["install", "upgrade", "uninstall", "reinstall"], apt: ["install", "remove", "upgrade", "update", "purge"],
  "apt-get": ["install", "remove", "upgrade", "update", "purge"], dnf: ["install", "remove", "upgrade", "update"],
  yum: ["install", "remove", "upgrade", "update"], pacman: ["-s", "-r", "-u"], nuget: ["install", "update"],
};
const GIT_DENY = new Set(["commit", "push", "reset", "checkout", "clean", "rebase", "merge", "stash"]);
const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"]);

const isLoopbackUrl = (u) => /^(https?:\/\/)?(localhost|127(\.\d+){3}|\[::1\])(:\d+)?(\/|$)/i.test(String(u));
const HOST_TLD = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|dev|fr|ru|cn|xyz|app|ai|co|me|info|sh|cloud)(:\d+)?(\/|$)/i;
const hasUrl = (u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(u)) || HOST_TLD.test(String(u)) || isLoopbackUrl(u);

// Un mot « propre » : aucun caractère spécial du shell (substitution, joker, redirection, séparateur, échappement…).
const BAD_CHARS = /[{}*?[\]~$`!()<>\\;|&#\r\n\u0000]/;
const clean = (w) => !BAD_CHARS.test(w.text);
// Texte libre entre guillemets (titre, description, message de commit) : tout sauf ce qui s'évalue ou casse la ligne.
const FREE_TEXT_BAD = /[$`\\\r\n\u0000]/;
const freeText = (w, max = 2000) => (w.quoted ? !FREE_TEXT_BAD.test(w.text) : clean(w)) && w.text.length <= max;

// ---------------------------------------------------------------------------------------------------------
// Contexte d'évaluation
function makeEnv(item, mandate, options) {
  const projectDir = typeof mandate?.projectDir === "string" ? resolvePath(mandate.projectDir, null) : null;
  const root = projectDir?.abs && !projectDir.weird && projectDir.abs.length > 3 ? projectDir.abs : null;
  const cwdRaw = item?.action?.cwd || null;
  const cwd = cwdRaw ? resolvePath(cwdRaw, null) : null;
  const scope = [];
  for (const entry of Array.isArray(mandate?.writeScope) ? mandate.writeScope : []) {
    if (root) {
      const p = resolvePath(String(entry), root);
      if (p?.abs && !p.weird && inside(p.abs, root)) scope.push(p.abs);
      else scope.push(null); // entrée inexploitable : fait tout refuser plutôt que tout ouvrir
    }
  }
  const tools = slashes(options.postectl).replace(/\/[^/]*$/, "");
  return {
    root, base: cwd?.abs && !cwd.weird ? cwd.abs : root, cwdKnown: Boolean(cwd?.abs), scope: scope.filter(Boolean),
    scopeBroken: scope.includes(null), mandate, options, tools,
    allowGit: mandate?.allowGit === true,
    // Philippe (2026-10-24) : sous mandat, tout est autorisé sauf le très dangereux (suppression, réseau extérieur, paquets, extinction,
    // sudo, interpréteurs, git push/reset…, écriture hors projet ou dans un fichier sensible). `permissive:false` rétablit la liste blanche stricte.
    permissive: mandate?.permissive !== false,
  };
}

// Écriture d'un chemin : "allow" | "deny" | "ask" avec raison (dossier du projet + périmètre d'écriture du mandat).
function judgeWrite(raw, env, what) {
  if (!env.root) return result("ask", "dossier du projet inconnu", what);
  const cls = classifyPath(raw, env.base, env.root);
  if (cls === "out") return result("deny", "hors du dossier du projet", what);
  if (cls === "link") return result("deny", "un lien mène hors du dossier du projet", what);
  if (cls === "odd") return result("ask", "chemin à vérifier", what);
  const p = resolvePath(raw, env.base);
  const rel = p.abs.slice(env.root.length).replace(/^\//, "");
  // Périmètre d'écriture du mandat d'abord : hors périmètre = refus net.
  if (env.scopeBroken) return result("deny", "hors du périmètre du mandat", what);
  if (env.scope.length && !env.scope.some((sc) => inside(p.abs, sc))) return result("deny", "hors du périmètre du mandat", what);
  if (SENSITIVE_NAME.test(`/${rel}`)) return result("ask", "fichier sensible", what);
  const segs = rel.split("/");
  if (segs.some((sg) => CONFIG_DIRS.has(sg.toLowerCase()))) return result("ask", "dossier de configuration", what);
  // Ce que la politique elle-même (ou un outil lancé ensuite) peut EXÉCUTER ne se modifie pas sans Philippe.
  const name = p.abs.split("/").pop().toLowerCase();
  if (fold(p.abs) === fold(env.options.postectl) || (inside(p.abs, env.tools) && SCRIPT_EXT.test(p.abs))) {
    return result("ask", "script exécuté par le poste", what);
  }
  if (TRIGGER_FILES.test(name) || /(^|\/)\.husky\//i.test(`/${rel}`) || /(^|\/)\.vscode\/(tasks|settings)\.json$/i.test(`/${rel}`) ||
      /(^|\/)\.github\/workflows\//i.test(`/${rel}`)) {
    return result("ask", "fichier qui peut déclencher une exécution ultérieure", what);
  }
  // Dossier caché du projet : ask, sauf si le périmètre d'écriture le désigne explicitement.
  if (segs.slice(0, -1).some((sg) => sg.startsWith("."))) {
    const explicit = env.scope.some((sc) => inside(p.abs, sc) && sc.slice(env.root.length).split("/").some((sg) => sg.startsWith(".")));
    if (!explicit) return result("ask", "dossier caché du projet", what);
  }
  return result("allow", "dans le dossier du projet", what);
}

function judgeRead(raw, env, what, glob = false) {
  if (!env.root) return result("ask", "dossier du projet inconnu", what);
  const cls = classifyPath(raw, env.base, env.root, glob);
  if (cls !== "in") return result("ask", cls === "out" ? "hors du dossier du projet" : "chemin à vérifier", what);
  const p = resolvePath(raw, env.base, glob);
  if (SENSITIVE_NAME.test(`/${p.abs.slice(env.root.length)}`) || /\/\.git\/config$/i.test(p.abs)) {
    return result("ask", "fichier sensible", what);
  }
  return result("allow", "lecture dans le dossier du projet", what);
}

// ---------------------------------------------------------------------------------------------------------
// Options : une commande n'accepte que des options de sa liste. spec : { flags, long, value, numeric }.
// Renvoie { pos, recursive } ou null (option inconnue ou dangereuse : -f, --file, -F, -c, -C, --git-dir…).
function parseOptions(args, spec) {
  const pos = [];
  let recursive = false;
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (ended || !t.startsWith("-") || t === "-") { pos.push(args[i]); continue; }
    if (t === "--") { ended = true; continue; }
    if (t.startsWith("--")) {
      if (!spec.long?.includes(t)) return null;
      if (t === "--recursive") recursive = true;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(t)) continue;
    const m = /^-([A-Za-z])(.*)$/.exec(t);
    if (m && spec.value?.[m[1]]) {
      const re = spec.value[m[1]];
      if (m[2]) { if (!re.test(m[2])) return null; } else {
        const v = args[++i];
        if (!v || !re.test(v.text)) return null;
      }
      continue;
    }
    if (/^-[A-Za-z]+$/.test(t) && [...t.slice(1)].every((ch) => (spec.flags || "").includes(ch))) {
      if (spec.recursive && t.includes(spec.recursive)) recursive = true;
      continue;
    }
    return null;
  }
  return { pos, recursive };
}

const SAFE = {
  echo: { flags: "n", text: true },
  printf: { flags: "", text: true },
  pwd: { flags: "", none: true },
  tr: { flags: "ds", text: true },
  grep: {
    flags: "rnivwlcxEHhaoqsI", recursive: "r", files: true, pattern: true,
    long: ["--recursive", "--line-number", "--ignore-case", "--invert-match", "--word-regexp", "--count", "--files-with-matches",
      "--no-messages", "--with-filename", "--no-filename", "--extended-regexp", "--text", "--only-matching", "--quiet"],
  },
  cat: { flags: "n", files: true },
  ls: { flags: "lahtrS1dRA", recursive: "R", files: true, long: ["--all", "--almost-all", "--human-readable", "--reverse"] },
  head: { numeric: true, value: { n: /^[+-]?\d+$/, c: /^\d+$/ }, files: true },
  tail: { numeric: true, value: { n: /^[+-]?\d+$/, c: /^\d+$/ }, files: true },
  wc: { flags: "lwcmL", files: true },
  sort: { flags: "rnuhVbd", files: true },
  uniq: { flags: "cdui", files: true, maxFiles: 1 },
  diff: { flags: "uqiwB", files: true },
  cut: { value: { c: /^\d[\d,-]*$/ }, files: true },
};

// Commande de lecture seule de la liste blanche.
function judgeSafe(cmd, args, env, state, what) {
  const spec = SAFE[cmd];
  const opts = parseOptions(args, spec);
  if (!opts) return result("ask", "option non reconnue ou dangereuse", what);
  if (!opts.pos.every(clean)) return result("ask", "argument avec caractère spécial du shell", what);
  if (spec.text || spec.none) return spec.none && opts.pos.length ? result("ask", "argument inattendu", what) : result("allow", "commande de lecture seule", what);
  if (!env.root) return result("ask", "dossier du projet inconnu", what);
  if (state.baseOutside) return result("ask", "dossier de travail hors du projet", what);
  let files = opts.pos;
  if (spec.pattern) {
    if (!files.length) return result("ask", "motif de recherche manquant", what);
    files = files.slice(1); // le premier argument de grep est le motif, pas un chemin
  }
  if (spec.maxFiles != null && files.length > spec.maxFiles) return result("ask", "uniq avec fichier de sortie", what);
  for (const w of files) {
    if (w.text.startsWith("-") && w.text !== "-") return result("ask", "argument ressemblant à une option", what);
    if (classifyPath(w.text, state.base, env.root) !== "in") return result("ask", "chemin hors du dossier du projet ou à vérifier", what);
    const p = resolvePath(w.text, state.base);
    if (SENSITIVE_NAME.test(`/${p.abs.slice(env.root.length)}`) || /\/\.git\/config$/i.test(p.abs)) {
      return result("ask", "fichier sensible", what);
    }
  }
  if (opts.recursive) {
    const roots = files.length ? files.map((w) => resolvePath(w.text, state.base).abs) : [state.base];
    if (roots.some((r) => linksBelow(r))) return result("ask", "recherche récursive qui rencontre un lien ou un trop gros dossier", what);
  }
  return result("allow", "commande de lecture seule", what);
}

// ---------------------------------------------------------------------------------------------------------
const GIT_READ = {
  status: { flags: "sb", long: ["--short", "--branch", "--porcelain"], noPos: false },
  log: { numeric: true, value: { n: /^\d+$/ }, long: ["--oneline", "--stat", "--graph", "--decorate", "--name-only", "--name-status", "--no-color", "--abbrev-commit", "--all"] },
  diff: { flags: "w", long: ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--no-color", "--shortstat", "--numstat"] },
  show: { long: ["--stat", "--name-only", "--name-status", "--oneline", "--no-color"] },
  branch: { flags: "avr", long: ["--list", "--all", "--remotes", "--verbose"], noPos: true },
};

// Le dépôt contient-il une configuration capable d'exécuter un programme (fsmonitor, pager, hooksPath, alias, include…) ?
// Limite documentée : un .git/config modifié à la main (hors politique) reste un risque ; il n'est lu qu'avant d'autoriser git.
const RISKY_GIT_CONFIG = /fsmonitor|pager|hookspath|\balias\b|sshcommand|askpass|editor|\[\s*include|textconv|external|\bfilter\b|credential|gpg\.program|difftool?|mergetool|\bexec\b|receive-pack|upload-pack|\bcmd\b|command/i;
function gitConfigRisky(dir) {
  if (!dir) return true;
  try {
    const git = `${dir}/.git`;
    if (!existsSync(git)) return false;
    let text;
    try { text = readFileSync(`${git}/config`, "utf8"); } catch { return true; } // .git est un fichier (worktree) ou illisible
    return RISKY_GIT_CONFIG.test(text.slice(0, 262144));
  } catch {
    return true;
  }
}

// git : lecture (status, log, diff, show, branch) sans option dangereuse ; avec « autoriser git » : add et commit -m.
function judgeGit(args, env, state, wrapped) {
  const globals = [];
  let i = 0;
  let dirArg = null;
  while (i < args.length && args[i].text.startsWith("-")) {
    const t = args[i].text;
    globals.push(t);
    if (t === "-C") dirArg = args[i + 1];
    if (GIT_GLOBAL_VALUE.has(t)) i++;
    i++;
  }
  const sub = args[i]?.text.toLowerCase();
  const rest = args.slice(i + 1);
  const what = clip(`git ${sub ?? ""}`, 60);
  if (!sub) return result("ask", "commande git incomplète", "git");
  if (GIT_DENY.has(sub)) {
    if (sub === "push") {
      if (!env.allowGit || forbids(env.mandate?.forbidden, "pousser sur GitHub")) return result("deny", "non demandé", what);
      return result("ask", "envoi vers un dépôt distant", what);
    }
    if (!env.allowGit) return result("deny", "non demandé", what);
    if (sub === "commit" && !/\bcommit\b/i.test((env.mandate?.forbidden ?? []).join(" "))) {
      const exact = !globals.length && !wrapped && !state.baseOutside && rest.length === 2 && rest[0].text === "-m" &&
        rest[1].text.length > 0 && rest[1].text.length <= 200 && !FREE_TEXT_BAD.test(rest[1].text) && !rest[1].text.startsWith("-");
      void dirArg;
      if (exact && (!env.root || gitConfigRisky(env.root) || gitConfigRisky(state.base))) {
        return result("ask", "configuration git à risque (fsmonitor, pager, hooksPath, alias…)", what);
      }
      return exact ? result("allow", "commit autorisé par le mandat", what) : result("ask", "forme de commit non reconnue (seul « commit -m message » passe)", what);
    }
    return result("ask", "action git à vérifier", what);
  }
  if (wrapped || globals.length) return result("ask", "option git globale ou enveloppe", what);
  if (!env.root || state.baseOutside) return result("ask", "dossier de travail hors du projet", what);
  if (gitConfigRisky(env.root) || gitConfigRisky(state.base)) return result("ask", "configuration git à risque (fsmonitor, pager, hooksPath, alias…)", what);
  if (sub === "add" && env.allowGit) {
    if (!rest.length) return result("ask", "git add sans chemin", what);
    for (const w of rest) {
      if (!clean(w) || w.text.startsWith("-") || w.text === "." || w.text === "./") return result("ask", "git add : chemins relatifs précis seulement", what);
      if (/^([A-Za-z]:|\/|\\)/.test(w.text)) return result("ask", "git add : chemin relatif attendu", what);
      if (judgeWrite(w.text, { ...env, base: state.base }, what).decision !== "allow") return result("ask", "git add : chemin hors périmètre ou à vérifier", what);
    }
    return result("allow", "ajout de fichiers du périmètre", what);
  }
  const spec = GIT_READ[sub];
  if (!spec) return result("ask", "commande git à vérifier", what);
  const opts = parseOptions(rest, spec);
  if (!opts) return result("ask", "option git non reconnue ou dangereuse", what);
  if (spec.noPos && opts.pos.length) return result("ask", "git branch avec un nom (créerait une branche)", what);
  for (const w of opts.pos) {
    if (!clean(w) || !/^[A-Za-z0-9._/-]+$/.test(w.text)) return result("ask", "argument git à vérifier", what);
    if (classifyPath(w.text, state.base, env.root) !== "in") return result("ask", "chemin hors du dossier du projet ou à vérifier", what);
  }
  return result("allow", "lecture de l'historique git", what);
}

// ---------------------------------------------------------------------------------------------------------
// postectl : liste blanche de sous-commandes ; jamais de suppression ni de réponse aux permissions.
const POSTECTL_VALUED = new Set(["host", "project", "status", "url", "engine", "mode", "description", "isolation", "branch",
  "lines", "name", "choice", "yesno", "questions", "title", "role", "prompt", "wait"]);
const FREEBUFF_PROMPT_MAX = 1000; // la commande entière reste sous MAX_COMMAND (1500)
const PERMISSIVE_MODES = /^(bypasspermissions|acceptedits|dontask|yolo|bypass|auto|danger[\w-]*)$/i;
const COLUMNS = new Set(["todo", "doing", "review", "done", "blocked"]);
const TASK_ID = /^[0-9a-f-]{6,36}$/i;

function judgePostectl(args, env, state) {
  const flags = new Map(); // option → valeur (ou true)
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t.startsWith("--") || t === "-h") {
      const [key, inline] = t.slice(2).split(/=(.*)/s);
      if (POSTECTL_VALUED.has(key)) {
        const v = inline !== undefined ? { text: inline, quoted: args[i].quoted } : args[++i];
        flags.set(key, v ?? { text: "", quoted: false });
      } else flags.set(key, true);
    } else pos.push(args[i]);
  }
  const [cmdW, subW] = pos;
  const cmd = cmdW?.text.toLowerCase();
  const sub = subW?.text.toLowerCase();
  const label = `postectl ${cmd ?? ""}${sub && cmd !== "tasks" ? ` ${sub}` : ""}`.trim();
  const deleteClass = () => (forbids(env.mandate?.forbidden, "supprimer")
    ? result("deny", "suppression interdite par le mandat", label) : result("ask", "action destructrice", label));
  // Ce qui est refusé d'emblée (avant toute autre vérification)
  if (cmd === "inbox" && (sub === "approve" || sub === "refuse")) return result("deny", "seul Philippe répond aux demandes de permission", label);
  if (cmd === "session" && (sub === "allow" || sub === "deny")) return result("deny", "seul Philippe répond aux demandes de permission", label);
  if ((cmd === "task" && sub === "delete") || (cmd === "session" && (sub === "close" || sub === "close-many")) ||
      (cmd === "project" && sub === "unfollow")) return deleteClass();
  if ((cmd === "task" && (sub === "add" || sub === "edit")) && flags.has("mode")) {
    const mode = String(flags.get("mode").text ?? "").trim();
    if (PERMISSIVE_MODES.test(mode)) return result("deny", "mode de permissions plus permissif que le mandat", `${label} --mode ${clip(mode, 30)}`);
  }
  // Liste blanche
  if (flags.has("confirm")) return result("ask", "confirmation demandée", label);
  const url = flags.get("url");
  if (url !== undefined && !(url && isLoopbackUrl(url.text) && clean(url))) return result("ask", "adresse du poste inhabituelle", label);
  const allowedFlags = new Set(["json", "url"]);
  const only = (extra) => [...flags.keys()].every((k) => allowedFlags.has(k) || extra.includes(k));
  const free = (key) => !flags.has(key) || freeText(flags.get(key));
  const plain = (key) => !flags.has(key) || clean(flags.get(key));
  const ok = (what = label) => result("allow", "commande postectl de la liste blanche", what);
  // L'aide seule (« postectl --help ») ne fait que lire : sans cela l'orchestrateur attendait Philippe dès sa première commande.
  if (!cmd && pos.length === 0 && flags.size === 1 && flags.has("help")) return ok("postectl --help");
  if (!cmd) return result("ask", "commande postectl incomplète", label);
  switch (cmd) {
    case "summary": case "projects": case "mandate": case "agents":
      return pos.length === 1 && only([]) ? ok() : result("ask", "arguments inattendus", label);
    case "sessions": case "tasks":
      return pos.length === 1 && only(["host", "project", "status"]) && plain("host") && plain("status") && plain("project")
        ? ok() : result("ask", "arguments inattendus", label);
    case "inbox":
      return pos.length === 1 && only(["unread"]) ? ok() : result("ask", "seul « inbox --unread » est autorisé", label);
    case "decide":
      return pos.slice(1).every(clean) && only(["choice", "yesno", "questions"]) && free("choice") && free("yesno") && free("questions")
        ? ok() : result("ask", "décision à vérifier", label);
    case "session":
      return sub === "show" && pos.length === 4 && pos.slice(1).every(clean) && only(["lines"]) && (!flags.has("lines") || /^\d{1,3}$/.test(String(flags.get("lines").text))) ? ok() : result("ask", "sous-commande session non autorisée", label);
    case "task": {
      if (sub === "start" || sub === "stop" || sub === "restart") {
        return pos.length === 3 && TASK_ID.test(pos[2].text) && only([]) ? ok() : result("ask", "identifiant de tâche attendu", label);
      }
      if (sub === "move") {
        return pos.length === 4 && TASK_ID.test(pos[2].text) && COLUMNS.has(pos[3].text.toLowerCase()) && only([])
          ? ok() : result("ask", "déplacement de tâche à vérifier", label);
      }
      if (sub === "add" || sub === "edit") {
        const keys = sub === "add" ? ["project", "engine", "host", "mode", "description", "isolation", "branch", "role", "profile"]
          : ["title", "project", "engine", "description", "mode", "host", "branch", "role"];
        if (!only(keys)) return result("ask", "option postectl non autorisée", label);
        if (sub === "edit" && !(pos.length === 3 && TASK_ID.test(pos[2].text))) return result("ask", "identifiant de tâche attendu", label);
        if (sub === "add" && pos.length < 3) return result("ask", "titre manquant", label);
        const titleWords = pos.slice(2);
        if (sub === "add" && !titleWords.every((w) => freeText(w, 200))) return result("ask", "titre à vérifier", label);
        if (!free("title") || !free("description")) return result("ask", "texte à vérifier", label);
        if (flags.has("mode") && !/^(default|plan)$/i.test(String(flags.get("mode").text))) return result("ask", "mode de permissions à vérifier", label);
        if (flags.has("engine") && !/^[A-Za-z0-9][\w.-]*\/[\w.:@/-]+$/.test(flags.get("engine").text)) return result("ask", "moteur à vérifier", label);
        if (flags.has("host") && !/^[\w-]{1,40}$/.test(flags.get("host").text)) return result("ask", "machine à vérifier", label);
        if (flags.has("isolation") && !/^(local|worktree)$/.test(flags.get("isolation").text)) return result("ask", "isolation à vérifier", label);
        if (flags.has("branch") && !/^[\w./-]*$/.test(flags.get("branch").text)) return result("ask", "branche à vérifier", label);
        if (flags.has("profile") && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(flags.get("profile").text))) return result("ask", "agent de base à vérifier", label);
        if (flags.has("role") && !/^(writer|reader|planner)$/.test(String(flags.get("role").text))) return result("ask", "rôle à vérifier", label);
        if (flags.has("project")) {
          const pv = flags.get("project");
          if (!clean(pv) || !env.root || classifyPath(pv.text, state.base, env.root) !== "in") return result("ask", "projet hors du dossier du mandat", label);
        }
        return ok();
      }
      return result("ask", "sous-commande task non autorisée", label);
    }
    case "freebuff": {
      // Mêmes limites que « task add » : projet dans le dossier du mandat, texte libre borné, aucune option inconnue.
      // En plus : chemin ABSOLU exigé (un nom nu serait résolu par le poste parmi tous les projets suivis, pas dans le mandat)
      // et périmètre d'écriture vide (FreeBuff est un processus externe que ce périmètre ne peut pas contenir).
      if (pos.length !== 1 || !only(["project", "prompt", "wait"])) return result("ask", "option postectl non autorisée", label);
      const pv = flags.get("project");
      const pr = flags.get("prompt");
      if (!pv?.text || !pr?.text) return result("ask", "projet et consigne requis", label);
      if (!clean(pv) || !/^([A-Za-z]:[\\/]|\/)/.test(pv.text) || !env.root || classifyPath(pv.text, state.base, env.root) !== "in") {
        return result("ask", "projet hors du dossier du mandat", label);
      }
      if (!freeText(pr, FREEBUFF_PROMPT_MAX)) return result("ask", "consigne à vérifier ou trop longue", label);
      const wait = String(flags.get("wait")?.text ?? "10");
      if (!/^\d{2,3}$/.test(wait) || Number(wait) < 10 || Number(wait) > 240) {
        return result("ask", "durée d'attente à vérifier", label);
      }
      if (env.scope.length || env.scopeBroken) return result("ask", "FreeBuff ignore le périmètre d'écriture du mandat", label);
      return ok();
    }
    default:
      return result("ask", "commande postectl à vérifier", label);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Un segment de commande : { decision, reason, what } ; "allow" seulement pour une forme simple de la liste blanche.
function judgeSegment(seg, env, state) {
  const words = seg.words;
  const { index, wrapped } = commandIndex(words);
  const baseTxt = (w) => baseCmd(w.text);

  // sudo : refusé où qu'il soit dans le segment
  if (words.some((w) => !w.quoted && ["sudo", "doas", "runas"].includes(baseTxt(w)))) {
    return result("deny", "droits d'administrateur interdits", "sudo");
  }
  // redirections : seules celles vers /dev/null passent ; hors du projet = refus
  for (const r of seg.redirects) {
    if (r.op === "<") { state.notes.push(["ask", "redirection d'entrée à vérifier"]); continue; }
    if (SINK.test(r.target)) continue;
    const j = r.target ? judgeWrite(r.target, { ...env, base: state.base }, `écrire ${r.target}`) : result("ask", "redirection incomprise", "redirection");
    if (j.decision === "deny") return { ...j, what: `écrire dans ${clip(r.target, 80)}` };
    if (env.permissive && j.decision === "allow") continue; // sortie vers un fichier ordinaire du projet
    state.notes.push(["ask", "redirection de sortie vers un fichier"]);
  }
  // Un segment vide ou fait seulement d'affectations / de mots spéciaux (HOME=x; git status) change l'environnement des
  // commandes suivantes : jamais « allow », sans exception.
  if (index >= words.length) {
    return result("ask", "affectation de variable ou mot spécial du shell", clip(words.map((w) => w.text).join(" "), WHAT_MAX));
  }
  const cmd = baseTxt(words[index]);
  const args = words.slice(index + 1);
  const argTexts = args.map((a) => a.text);
  const fullWhat = clip(words.map((w) => w.text).join(" "), WHAT_MAX);
  const pathCommand = /[\\/]/.test(words[index].text);
  const exact = words[index].text; // la liste blanche est sensible à la casse (bash)

  // eval / bash -c / cmd /c / powershell -Command : on regarde le texte intérieur, sans jamais l'autoriser
  if (["bash", "sh", "zsh", "cmd", "powershell", "pwsh", "eval"].includes(cmd)) {
    const k = argTexts.findIndex((t) => /^(-c|-lc|-command|\/c|\/k|-encodedcommand|-enc)$/i.test(t));
    const inner = cmd === "eval" ? argTexts.join(" ") : k >= 0 ? argTexts.slice(k + 1).join(" ") : "";
    if (inner && state.depth < 2) {
      const sub = analyzeCommand(inner, env, { ...state, depth: state.depth + 1, notes: [] });
      if (sub.decision === "deny") return sub;
    }
    return result("ask", "interpréteur de commandes", fullWhat);
  }

  // suppression
  if (DELETE_CMDS.has(cmd)) return result("deny", "suppression interdite", clip(`${cmd} ${argTexts.join(" ")}`, WHAT_MAX));
  if (cmd === "find" && argTexts.some((t) => t === "-delete" || t === "-exec" || t === "-execdir")) {
    return result("deny", "suppression ou exécution en masse interdite", "find -delete");
  }
  // déplacement, copie, écriture hors du projet
  const targets = args.filter((a) => !a.text.startsWith("-"));
  const judgeW = (t) => judgeWrite(t.text, { ...env, base: state.base }, "").decision === "deny";
  if (MOVE_CMDS.has(cmd) || COPY_CMDS.has(cmd)) {
    const dest = targets.at(-1);
    const outside = (MOVE_CMDS.has(cmd) ? targets : dest ? [dest] : []).find(judgeW);
    if (outside) return result("deny", "hors du dossier du projet", clip(`${cmd} ${outside.text}`, WHAT_MAX));
    if (env.permissive && !wrapped && !pathCommand) {
      const checked = (MOVE_CMDS.has(cmd) ? targets : dest ? [dest] : []);
      if (checked.length && checked.every((t) => clean(t) && judgeWrite(t.text, { ...env, base: state.base }, "").decision === "allow")) {
        return result("allow", "déplacement ou copie dans le projet (mode permissif)", fullWhat);
      }
    }
    return result("ask", "déplacement ou copie de fichiers", fullWhat);
  }
  if (WRITE_CMDS.has(cmd)) {
    const outside = targets.find((t) => !/^\d+$/.test(t.text) && judgeW(t));
    if (outside) return result("deny", "écriture hors du dossier du projet", clip(`${cmd} ${outside.text}`, WHAT_MAX));
    if (env.permissive && !wrapped && !pathCommand) {
      const checked = targets.filter((t) => !/^\d+$/.test(t.text));
      if (checked.length && checked.every((t) => clean(t) && judgeWrite(t.text, { ...env, base: state.base }, "").decision === "allow")) {
        return result("allow", "écriture dans le projet (mode permissif)", fullWhat);
      }
    }
    return result("ask", "écriture de fichiers", fullWhat);
  }
  // réseau
  if (NET_CMDS.has(cmd)) {
    const real = argTexts.filter(hasUrl);
    if (real.length && real.every(isLoopbackUrl)) return result("ask", "appel direct à l'API du poste", cmd);
    return result("deny", "accès réseau extérieur interdit", clip(`${cmd} ${real[0] ?? ""}`, WHAT_MAX));
  }
  // paquets
  if (NPX_CMDS.has(cmd)) return result("deny", "installation de paquets interdite", cmd);
  const pipPython = ["python", "python3", "py"].includes(cmd) && argTexts[0] === "-m" && /^pip3?$/.test(argTexts[1] ?? "");
  const pkgName = pipPython ? "pip" : cmd;
  const pkgArgs = pipPython ? argTexts.slice(2) : argTexts;
  if (PKG_SUBS[pkgName]) {
    const sub = pkgArgs.find((t) => !t.startsWith("-"))?.toLowerCase();
    if (sub && PKG_SUBS[pkgName].includes(sub)) return result("deny", "installation de paquets interdite", `${pkgName} ${sub}`);
  }
  if (cmd === "dotnet" && /^(add|tool)$/i.test(argTexts[0] ?? "") && /^(package|install|update)$/i.test(argTexts[1] ?? "")) {
    return result("deny", "installation de paquets interdite", "dotnet package");
  }
  // extinction
  if (SHUTDOWN_CMDS.has(cmd) || (cmd === "init" && /^[06]$/.test(argTexts[0] ?? "")) ||
      (cmd === "systemctl" && /^(poweroff|reboot|halt|suspend)$/i.test(argTexts[0] ?? ""))) {
    return result("deny", "extinction de la machine interdite", cmd);
  }
  // mots spéciaux du shell (source, ., export, for, case…) : jamais auto-autorisés
  if (SPECIAL_WORDS.has(exact.toLowerCase())) return result("ask", "mot spécial du shell", fullWhat);
  // git
  if (cmd === "git") return judgeGit(args, env, state, wrapped || pathCommand || exact !== "git");
  // postectl
  if (cmd === "node" && args[0] && fold(slashes(args[0].text)) === fold(env.options.postectl)) {
    const j = judgePostectl(args.slice(1), env, state);
    if (j.decision === "allow" && (wrapped || exact !== "node")) return result("ask", "commande postectl enveloppée", j.what);
    return j;
  }
  // lecture seule : liste blanche exacte (sensible à la casse), jamais derrière un mot-outil ni un chemin
  if (SAFE[exact] && !wrapped && !pathCommand) return judgeSafe(exact, args, env, state, fullWhat);
  // mode permissif : une commande ordinaire (outil de build, test, lecture, find, node, python…) passe, tant que la ligne est simple
  // (aucune substitution, aucun enveloppe ni mot spécial, aucune sortie hors projet : déjà notée plus haut) ; sinon « ask ».
  // Chaque argument qui ressemble à un chemin doit rester dans le projet et ne pas être un fichier sensible ; « cd » reste « ask »
  // (le suivi du dossier courant est supprimé : un cd ferait juger les chemins relatifs suivants à tort).
  const pathLike = (t) => /[\\/]|^~|^\.\.?$/.test(t) || /^-[^=]*=.*[\\/~]/.test(t);
  const pathArgOk = (a) => {
    const t = a.text.includes("=") && a.text.startsWith("-") ? a.text.slice(a.text.indexOf("=") + 1) : a.text;
    if (!pathLike(a.text)) return true;
    return clean({ text: t }) && classifyPath(t, state.base, env.root) === "in" && !SENSITIVE_NAME.test(`/${t}`);
  };
  if (env.permissive && !wrapped && !SPECIAL_WORDS.has(exact.toLowerCase()) && !["cd", "pushd", "popd", "chdir"].includes(cmd) &&
      !pathCommand && !state.baseOutside && clean({ text: exact }) && args.every((a) => (a.quoted || !/[`$]/.test(a.text)) && pathArgOk(a))) {
    return result("allow", "commande ordinaire (mode permissif)", fullWhat);
  }
  return result("ask", "commande à vérifier", fullWhat);
}

// Commande complète : on combine les segments (un seul « deny » suffit ; un seul « ask » empêche « allow »).
function analyzeCommand(command, env, stateIn = {}) {
  const { segs, issues } = tokenize(command);
  const state = { depth: 0, notes: [], ...stateIn, base: env.base, baseOutside: !env.root || !env.base || !inside(env.base, env.root) };
  let ask = null;
  let allow = null;
  for (const seg of segs) {
    const j = judgeSegment(seg, env, state);
    if (j.decision === "deny") return j;
    if (j.decision === "ask") ask ??= j;
    else allow ??= j;
  }
  const noted = state.notes.find((n) => n[0] === "ask");
  if (noted) ask ??= result("ask", noted[1], clip(command, WHAT_MAX));
  if (issues.size) ask ??= result("ask", "commande trop complexe pour être vérifiée", clip(command, WHAT_MAX));
  if (!segs.length) return result("ask", "commande vide", "");
  if (ask) return ask;
  return { ...allow, what: clip(command, WHAT_MAX) };
}

// ---------------------------------------------------------------------------------------------------------
const READ_TOOLS = new Set(["read", "glob", "grep", "ls", "notebookread", "view"]);
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
const SHELL_TOOLS = /^(bash|sh|zsh|shell|powershell|pwsh|cmd|terminal|exec|exec_command|run_command|execute_command|shell_command|local_shell|command)$/;

export function toolOf(item) {
  const fromAction = item?.action?.tool;
  if (typeof fromAction === "string" && fromAction) return fromAction;
  const m = /^Permission requise\s*:\s*(.+)$/.exec(String(item?.title ?? ""));
  return m ? m[1].trim() : "";
}
export function targetOf(item) {
  const t = item?.action?.target;
  if (typeof t === "string") return t;
  return typeof item?.body === "string" ? item.body : "";
}
export const isWriteTool = (tool) => WRITE_TOOLS.has(String(tool).toLowerCase());

export function evaluatePermission(item, mandate, options = {}) {
  const opts = { postectl: POSTECTL, ...options };
  let r;
  try {
    r = evaluate(item, mandate, opts);
  } catch {
    r = result("ask", "demande impossible à analyser", "");
  }
  // Secrets masqués AVANT toute troncature du libellé.
  return { ...r, what: clip(redact(r.what ?? ""), 100) };
}

function evaluate(item, mandate, options) {
  if (!item || typeof item !== "object") return result("ask", "demande illisible");
  const action = item.action && typeof item.action === "object" ? item.action : {};
  const tool = toolOf(item);
  // Garde-fous durs (BlastWin, secrets, force-push, arrêt d'urgence) : refus d'office, avec ou sans mandat.
  {
    const name = tool.toLowerCase(), tgt = targetOf(item);
    const g = checkToolCall(tool, /^(bash|powershell)$/.test(name) ? { command: tgt } : { file_path: tgt, path: tgt }, { cwd: action.cwd });
    if (!g.allow) return result("deny", `garde-fou ${g.guard} : ${g.reason}`, tgt);
  }
  if (!mandate || mandate.enabled !== true) return result("ask", "aucun mandat actif");
  const lower = tool.toLowerCase();
  const target = targetOf(item);
  const env = makeEnv(item, mandate, options);

  // Interdictions libres du mandat (« modifier package.json »…) : tous les mots significatifs dans la demande → refus.
  const haystack = fold(slashes(`${tool} ${target} ${action.pattern ?? ""}`));
  const customForbidden = () => {
    for (const entry of Array.isArray(mandate.forbidden) ? mandate.forbidden : []) {
      const text = String(entry).trim();
      if (!text || BUILTIN_FORBIDDEN.test(text)) continue;
      const words = significantWords(text);
      if (words.length && words.every((w) => haystack.includes(fold(slashes(w))))) return text;
    }
    return null;
  };
  const finish = (j) => {
    if (j.decision !== "deny") {
      const custom = customForbidden();
      if (custom) return result("deny", `interdit par le mandat : ${clip(custom, 60)}`, j.what);
    }
    if (j.decision === "allow") {
      if (mandate.autoPermissions === false) return result("ask", "autorisation automatique désactivée", j.what);
      if (action.danger === true) return result("ask", "demande signalée dangereuse", j.what);
      if (action.targetTruncated === true || (action.target === undefined && target.length >= 299 && target.endsWith("…"))) {
        return result("ask", "commande trop longue pour être vérifiée", j.what);
      }
    }
    return j;
  };

  if (!tool) return result("ask", "outil inconnu");
  if (action.kind && action.kind !== "tool") return result("ask", "question ou plan pour Philippe", tool);

  if (SHELL_TOOLS.test(lower)) {
    if (!target.trim()) return result("ask", "commande vide", tool);
    let j = analyzeCommand(target, env);
    if (j.decision === "allow") {
      if (lower !== "bash") j = result("ask", "interpréteur non vérifié", j.what);
      else if (target.length > MAX_COMMAND) j = result("ask", "commande trop longue pour être vérifiée", j.what);
      else j = { ...j, what: `exécuter ${j.what}` };
    }
    if (j.decision === "deny" && target.length > 20000) j = result("ask", "commande trop longue pour être vérifiée", j.what);
    return finish(j);
  }
  if (WRITE_TOOLS.has(lower)) {
    if (!target.trim()) return result("ask", "fichier non indiqué", tool);
    const verb = lower === "write" ? "écrire" : "modifier";
    return finish(judgeWrite(target, env, `${verb} ${clip(target, WHAT_MAX)}`));
  }
  if (READ_TOOLS.has(lower)) {
    // Glob : le motif compte aussi (absolu, « .. », ~ → ask).
    const pattern = typeof action.pattern === "string" ? action.pattern : "";
    if (lower === "glob" && pattern && (/^([A-Za-z]:|[\\/]|~)/.test(pattern) || pattern.split(/[\\/]/).includes("..") || /[\u0000-\u001f]/.test(pattern))) {
      return result("ask", "motif de recherche hors du dossier du projet", `lire ${clip(pattern, WHAT_MAX)}`);
    }
    const path = target.trim() || env.base || "";
    if (!path) return result("ask", "dossier non indiqué", tool);
    // Sans chemin explicite, la recherche part du dossier de la session, qui doit être dans le projet.
    if (!target.trim() && !env.cwdKnown) return result("ask", "dossier de la session inconnu", tool);
    return finish(judgeRead(path, env, `lire ${clip(path, WHAT_MAX)}`, true));
  }
  return result("ask", "outil non couvert par la politique", tool);
}

// Mêmes règles, présentées en français simple (dialogue du mandat et vue Agent) ; reprises par le README.
export const POLICY_TEXT = {
  allow: [
    "Lire des fichiers du dossier du projet",
    "Commandes simples en lecture seule (echo, grep, cat, ls, head, tail, wc, sort, uniq, diff, cut, tr, git status/log/diff/show/branch)",
    "Commandes postectl de la liste blanche (summary, sessions, tasks, task add/start/stop/restart/move/edit, mandate…)",
    "Modifier des fichiers du dossier du projet (dans le périmètre d'écriture, avec une sauvegarde avant)",
  ],
  deny: [
    "git commit, push, reset, checkout, clean, rebase, merge, stash (sauf « autoriser git » : add et commit -m seulement)",
    "Supprimer des fichiers, ou en déplacer hors du projet",
    "Écrire en dehors du dossier du projet (ou du périmètre d'écriture)",
    "Accès réseau extérieur, installation de paquets, extinction, sudo",
    "Répondre soi-même aux demandes de permission, donner un mode de permissions plus large à une tâche",
  ],
  ask: ["Tout le reste attend ta réponse dans la vue Agent. Une demande signalée dangereuse n'est jamais acceptée seule."],
};

// ---------------------------------------------------------------------------------------------------------
// Aides pour les handlers (appartenance d'une session au mandat, sauvegardes).
// Un chemin est-il (lexicalement) dans un dossier ? Sans toucher au disque.
export function insideDir(raw, root) {
  const p = resolvePath(raw, null);
  const r = resolvePath(root, null);
  return Boolean(p?.abs && r?.abs && inside(p.abs, r.abs));
}
// Chemin relatif au projet (« a/b.txt », séparateurs « / ») si `raw` désigne bien un emplacement DANS le dossier
// (liens résolus, sans « .. » ni nom étrange) ; sinon null.
export function projectRelative(raw, base, root) {
  const r = resolvePath(root, null);
  if (!r?.abs || classifyPath(raw, base, r.abs) !== "in") return null;
  const p = resolvePath(raw, base);
  return p.abs.slice(r.abs.length).replace(/^\//, "") || null;
}
