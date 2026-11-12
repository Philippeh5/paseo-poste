// GitHub depuis le dashboard : état, plan (lecture seule), création de dépôt et synchronisation.
// Messages : github.status, github.plan, github.create, github.sync.
// Toute opération qui ÉCRIT sur GitHub (github.create, github.sync) exige `confirm: true`, sinon refus ;
// avec `dryRun: true` elle renvoie le plan d'action sans rien exécuter.
// Le jeton GitHub n'est jamais lu : `gh` (machine du dashboard) ou le daemon de la machine s'en servent seuls.
import { execFile } from "node:child_process";
import { FsError, resolveHost, validatePath, ensureDirectory, withTimeout, baseName } from "./fs.mjs";

const GH_TIMEOUT_MS = 60000;
const GH_CACHE_MS = 45000;
const MAX_FILES_SHOWN = 30;
const MAX_DESCRIPTION = 350;

const HELP_LOGIN =
  "Sur cette machine, ouvrez un terminal et lancez : gh auth login (choisissez GitHub.com puis HTTPS). " +
  "Ne copiez jamais un jeton d’une machine à l’autre : chaque machine se connecte elle-même.";

// ---------- Utilitaires ----------
export function redact(text) {
  return String(text ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, "[jeton masqué]")
    .replace(/\/\/[^/@\s]+@/g, "//");
}

// Analyse une URL de dépôt distant (https, ssh) sans jamais conserver d'identifiants intégrés.
export function parseRemote(url) {
  if (!url || typeof url !== "string") return null;
  const clean = redact(url).trim();
  const m =
    clean.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
    clean.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return { url: clean, github: false, owner: null, repo: null };
  // Les alias SSH « gh-<projet> » (une clé de déploiement par dépôt, voir ~/.ssh/config) pointent tous vers github.com.
  const github = /^(?:github\.com|gh-[a-z0-9._-]+)$/i.test(m[1]);
  return { url: clean, github, owner: m[2], repo: m[3], web: github ? `https://github.com/${m[2]}/${m[3]}` : null };
}

function runGh(args, { cwd, timeout = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        if (error) {
          const e = new Error(redact(stderr || error.message));
          e.code = error.code;
          reject(e);
        } else resolve(String(stdout).trim());
      },
    );
  });
}

const sanitizeRepoName = (folder) =>
  String(folder || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100);
function validateRepoName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === ".." || /\.git$/i.test(name)) {
    throw new FsError("invalid_name", "Nom de dépôt invalide : lettres, chiffres, points, tirets et tirets bas uniquement (100 maximum).");
  }
  return name;
}

// ---------- État GitHub d'une machine ----------
const ghCache = new Map();
// { connected, account, reason, local } ; en cache 45 s. Local : `gh` ; autres machines : le daemon.
export async function ghState(host, { fresh = false } = {}) {
  const cached = ghCache.get(host.label);
  if (!fresh && cached && Date.now() - cached.at < GH_CACHE_MS) return cached.value;
  let value;
  if (host.local) {
    // « non connecté » est réservé à gh absent ou réellement déconnecté ; une panne passagère (délai, réseau) = « unknown ».
    const AUTH_RE = /not logged|gh auth login|authentication|bad credentials|http 401|requires authentication/i;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const account = await runGh(["api", "user", "--jq", ".login"], { timeout: 15000 });
        value = { connected: Boolean(account), account: account || null, reason: account ? null : "unauthenticated", local: true };
        break;
      } catch (error) {
        if (error.code === "ENOENT") { value = { connected: false, account: null, reason: "gh_missing", local: true }; break; }
        if (AUTH_RE.test(error.message || "")) { value = { connected: false, account: null, reason: "unauthenticated", local: true }; break; }
        value = { connected: false, account: null, reason: "unknown", local: true };
      }
    }
  } else {
    try {
      const r = await withTimeout(host.daemon.searchGithubRepositories({ query: "paseo", limit: 1 }), 15000, "GitHub");
      value = { connected: r.status === "success", account: null, reason: r.status === "success" ? null : r.reason || r.status, local: false };
    } catch {
      value = { connected: false, account: null, reason: "unknown", local: false };
    }
  }
  // Une panne passagère n'est mémorisée que 5 s pour réessayer vite.
  ghCache.set(host.label, { at: value.reason === "unknown" ? Date.now() - GH_CACHE_MS + 5000 : Date.now(), value });
  return value;
}

// ---------- État git d'un dossier (via le daemon, sur n'importe quelle machine) ----------
// Le daemon met en cache l'état git d'un dossier (un dépôt lié APRÈS le suivi apparaissait encore « non lié ») :
// sur la machine du dashboard on interroge git directement, c'est instantané et toujours à jour.
function runGit(dir, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout: 8000, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
}
async function localGitFacts(dir) {
  const inside = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;
  const [branch, porcelain, origin, remotes, upstream] = await Promise.all([
    runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(dir, ["status", "--porcelain"]),
    runGit(dir, ["config", "--get", "remote.origin.url"]),
    runGit(dir, ["remote"]),
    runGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);
  let remoteUrl = origin;
  const first = (remotes || "").split(/\s+/).filter(Boolean)[0];
  if (!remoteUrl && first) remoteUrl = await runGit(dir, ["remote", "get-url", first]);
  let ahead = null;
  let behind = null;
  if (upstream) {
    const counts = await runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    const m = counts && counts.match(/^(\d+)\s+(\d+)$/);
    if (m) { behind = Number(m[1]); ahead = Number(m[2]); }
  }
  return { branch: branch && branch !== "HEAD" ? branch : null, dirty: porcelain !== null ? porcelain.length > 0 : null,
    remoteUrl: remoteUrl || null, hasRemote: Boolean(remoteUrl), upstream: upstream || null, ahead, behind };
}

export async function gitStatus(host, dir) {
  const s = await withTimeout(host.daemon.getCheckoutStatus(dir), 20000, "statut git");
  if (s.error) throw new FsError("git_error", redact(typeof s.error === "string" ? s.error : s.error.message || "Erreur git."));
  const base = {
    isGit: s.isGit === true,
    branch: s.currentBranch ?? null,
    dirty: s.isDirty ?? null,
    ahead: s.aheadOfOrigin ?? null,
    behind: s.behindOfOrigin ?? null,
    upstream: s.upstreamRef ?? null,
    hasRemote: s.hasRemote === true,
    remoteUrl: s.remoteUrl ?? null,
  };
  if (host.local && base.isGit) {
    const fresh = await localGitFacts(dir);
    if (fresh) Object.assign(base, fresh);
  }
  const { remoteUrl, ...rest } = base;
  return { ...rest, remote: parseRemote(remoteUrl) };
}

async function pendingPush(host, dir) {
  try {
    const result = await withTimeout(host.daemon.listCheckoutCommits(dir), 12000, "liste des commits");
    const pending = (result.commits || []).filter((c) => !c.isOnRemote);
    const files = new Map();
    for (const commit of pending) for (const f of commit.files || []) files.set(f.path, f);
    return {
      available: true,
      commits: pending.length,
      subjects: pending.slice(0, 5).map((c) => `${c.shortSha} ${String(c.subject).slice(0, 100)}`),
      filesTotal: files.size,
      files: [...files.values()].slice(0, MAX_FILES_SHOWN).map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    };
  } catch {
    return { available: false, commits: null, subjects: [], filesTotal: null, files: [] };
  }
}

async function repoView(owner, repo) {
  try {
    const out = await runGh(["repo", "view", `${owner}/${repo}`, "--json", "visibility,url,defaultBranchRef"], { timeout: 20000 });
    const data = JSON.parse(out);
    return { exists: true, visibility: String(data.visibility || "").toLowerCase(), url: data.url, defaultBranch: data.defaultBranchRef?.name ?? null };
  } catch (error) {
    return { exists: /could not resolve|not found|404/i.test(error.message) ? false : null };
  }
}

// ---------- Plans ----------
const blocker = (code, message) => ({ code, message });
const disconnectedBlocker = () => blocker("github_disconnected", "GitHub n’est pas connecté sur cette machine");

async function buildPlan(host, dir, action, options = {}) {
  const [git, gh] = await Promise.all([gitStatus(host, dir), ghState(host)]);
  const blockers = [];
  const warnings = [];
  const base = {
    action, host: host.label, dir, branch: git.branch, dirty: git.dirty,
    remote: git.remote ? { url: git.remote.url, owner: git.remote.owner, repo: git.remote.repo, github: git.remote.github } : null,
    github: { connected: gh.connected, account: gh.account, reason: gh.reason, help: gh.connected ? null : HELP_LOGIN },
  };
  if (!gh.connected) blockers.push(disconnectedBlocker());
  if (!git.isGit) blockers.push(blocker("not_git", "Ce dossier n’est pas un dépôt git : initialisez-le (git init) et faites un premier commit."));
  else if (!git.branch) blockers.push(blocker("no_commit", "Ce dépôt n’a aucune branche active ni commit à envoyer."));

  if (action === "create") {
    const name = validateRepoName(options.name ?? sanitizeRepoName(baseName(/^[A-Za-z]:/.test(dir) ? "win32" : "posix", dir)));
    const visibility = options.visibility === "public" ? "public" : "private";
    const description = String(options.description ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, MAX_DESCRIPTION);
    if (git.hasRemote) blockers.push(blocker("remote_exists", `Un dépôt distant existe déjà (${git.remote?.url ?? "origin"}) : rien à créer.`));
    if (gh.connected && !host.local) {
      blockers.push(blocker("remote_unsupported", `La création de dépôt se fait depuis la machine du dashboard. Sur ${host.label}, ouvrez un terminal dans le dossier et lancez : gh repo create`));
    }
    if (visibility === "public") warnings.push("Le dépôt sera PUBLIC : tout le contenu poussé sera visible par tout le monde.");
    if (git.dirty) warnings.push("Des modifications non validées (commit) existent : elles ne seront pas envoyées.");
    const pending = git.isGit && git.branch ? await pendingPush(host, dir) : null;
    const account = gh.account ?? "(compte inconnu)";
    const sentence =
      `Cela va créer un dépôt ${visibility === "public" ? "public" : "privé"} ${name} sur le compte ${account} ` +
      `et y pousser la branche ${git.branch ?? "(aucune)"}.`;
    return finish({
      ...base, name, visibility, description, account, push: pending,
      summary: sentence,
      commands: [`gh repo create ${account}/${name} --${visibility} --source <dossier> --remote origin --push`],
    }, blockers, warnings);
  }

  // sync
  if (git.isGit && !git.hasRemote) blockers.push(blocker("no_remote", "Aucun dépôt distant : créez d’abord le dépôt GitHub."));
  else if (git.remote && !git.remote.github) blockers.push(blocker("not_github", `Le dépôt distant n’est pas sur GitHub (${git.remote.url}).`));
  if (git.dirty) warnings.push("Des modifications non validées existent : elles ne seront pas envoyées, et un pull peut échouer.");
  if (git.isGit && git.hasRemote && !git.upstream) warnings.push("La branche n’a pas de branche amont : le push la publiera.");
  const pending = git.isGit && git.hasRemote ? await pendingPush(host, dir) : null;
  const behind = git.behind ?? 0;
  const ahead = git.ahead ?? pending?.commits ?? 0;
  return finish({
    ...base, ahead, behind, upstream: git.upstream, pull: { commits: behind }, push: pending,
    summary:
      `Cela va récupérer ${behind} commit(s) puis envoyer ${ahead} commit(s) de la branche ${git.branch ?? "(aucune)"} ` +
      `vers ${git.remote?.web ?? git.remote?.url ?? "le dépôt distant"}.`,
    commands: ["git pull", "git push"],
  }, blockers, warnings);
}

function finish(plan, blockers, warnings) {
  return { ...plan, blockers, warnings, ok: blockers.length === 0 };
}

// ---------- Enregistrement ----------
export function register(ctx) {
  const { onMessage, send } = ctx;
  const busy = new Set();
  const reply = (ws, type, message, body) =>
    send(ws, { type, host: message.host || "local", dir: message.dir ?? null, ref: message.ref ?? null, ...body });
  const failBody = (error) => {
    const known = error instanceof FsError;
    if (!known) ctx.log("github", `échec : ${ctx.safeError(error)}`);
    return { ok: false, code: known ? error.code : "github_error", error: known ? error.message : redact(ctx.safeError(error)) };
  };
  const target = (message) => {
    const host = resolveHost(ctx, message);
    return { host, ...validatePath(message.dir, { local: host.local }) };
  };

  onMessage("github.status", async (ws, message) => {
    try {
      const { host, path: dir } = target(message);
      await ensureDirectory(host, dir);
      const [git, gh] = await Promise.all([gitStatus(host, dir), ghState(host, { fresh: message.fresh === true })]);
      let repo = null;
      if (host.local && gh.connected && git.remote?.github) repo = await repoView(git.remote.owner, git.remote.repo);
      reply(ws, "github.status", message, {
        ok: true,
        dir,
        git,
        github: { connected: gh.connected, account: gh.account, reason: gh.reason, help: gh.connected ? null : HELP_LOGIN },
        linked: Boolean(git.remote?.github),
        repo,
        proposedName: sanitizeRepoName(baseName(/^[A-Za-z]:/.test(dir) ? "win32" : "posix", dir)),
      });
    } catch (error) {
      reply(ws, "github.status", message, failBody(error));
    }
  });

  // Plan en lecture seule : sert à l'interface pour afficher la confirmation. Aucun effet de bord.
  onMessage("github.plan", async (ws, message) => {
    try {
      const { host, path: dir } = target(message);
      if (!["create", "sync"].includes(message.action)) throw new FsError("invalid_action", "Action inconnue (create ou sync).");
      await ensureDirectory(host, dir);
      const plan = await buildPlan(host, dir, message.action, message);
      reply(ws, "github.plan", message, { ...plan, dir, error: plan.blockers[0]?.message ?? null, code: plan.blockers[0]?.code ?? null });
    } catch (error) {
      reply(ws, "github.plan", message, failBody(error));
    }
  });

  // Opérations qui écrivent sur GitHub : confirm:true obligatoire ; dryRun:true = plan seulement.
  for (const action of ["create", "sync"]) {
    onMessage(`github.${action}`, async (ws, message) => {
      const type = "github.result";
      const lock = `${message.host || "local"}|${message.dir}`;
      try {
        if (message.confirm !== true) {
          throw new FsError("confirm_required", "Confirmation requise : cette opération écrit sur GitHub et doit être envoyée avec confirm: true.");
        }
        const { host, path: dir } = target(message);
        await ensureDirectory(host, dir);
        const plan = await buildPlan(host, dir, action, message);
        if (!plan.ok) {
          reply(ws, type, message, { action, ok: false, code: plan.blockers[0].code, error: plan.blockers[0].message, plan });
          return;
        }
        if (message.dryRun === true) {
          reply(ws, type, message, { action, ok: true, dryRun: true, executed: false, plan });
          return;
        }
        if (busy.has(lock)) throw new FsError("busy", "Une opération GitHub est déjà en cours pour ce dossier.");
        busy.add(lock);
        try {
          const outcome = action === "create" ? await runCreate(host, dir, plan) : await runSync(host, dir);
          ghCache.delete(host.label);
          reply(ws, type, message, { action, ok: true, dryRun: false, executed: true, plan, ...outcome });
        } finally {
          busy.delete(lock);
        }
      } catch (error) {
        reply(ws, type, message, { action, ...failBody(error) });
      }
    });
  }

  async function runCreate(host, dir, plan) {
    const args = ["repo", "create", `${plan.account}/${plan.name}`, `--${plan.visibility}`, "--source", dir, "--remote", "origin", "--push"];
    if (plan.description) args.push("--description", plan.description);
    ctx.log("github", `création ${plan.account}/${plan.name} (${plan.visibility}) depuis ${host.label}:${dir}`);
    const out = await runGh(args, { cwd: dir });
    return { repoUrl: redact(out.split(/\s+/).find((w) => w.startsWith("https://")) ?? `https://github.com/${plan.account}/${plan.name}`) };
  }

  async function runSync(host, dir) {
    ctx.log("github", `synchronisation ${host.label}:${dir}`);
    const pull = await withTimeout(host.daemon.checkoutPull(dir), 120000, "pull");
    if (!pull.success) {
      throw new FsError("pull_failed", `Le pull a échoué, le push n’a pas été lancé : ${redact(pull.error?.message ?? "erreur inconnue")}`);
    }
    const push = await withTimeout(host.daemon.checkoutPush(dir), 120000, "push");
    if (!push.success) throw new FsError("push_failed", `Le push a échoué : ${redact(push.error?.message ?? "erreur inconnue")}`);
    return { pulled: true, pushed: true };
  }
}
