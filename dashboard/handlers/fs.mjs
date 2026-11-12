// Explorateur de dossiers par machine : fs.roots, fs.list, fs.mkdir.
// Lecture seule hors fs.mkdir. Machine du dashboard (URL de boucle locale) : système de fichiers Node ;
// autres machines : requêtes de navigation du daemon Paseo (listDirectory, createProjectDirectory).
// Réponses : { type: "fs.roots" | "fs.list" | "fs.mkdir", host, ref, ok, ... } ; en cas d'échec ok:false, code, error.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_PATH = 1024;
const MAX_ENTRIES = 1000;
const MAX_LOCAL_PROBES = 300;
const MAX_REMOTE_PROBES = 40;
const REMOTE_TIMEOUT_MS = 8000;
const MARKERS = [
  ".git", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pom.xml",
  "composer.json", "Gemfile", "CLAUDE.md", "AGENTS.md",
];
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export class FsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function withTimeout(promise, ms, label = "opération") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FsError("timeout", `Délai dépassé : ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isLoopbackUrl(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

// Machine visée : { label, local, daemon } ou lève FsError.
export function resolveHost(ctx, message) {
  const { label } = ctx.hostOf(message);
  const entry = ctx.hosts.get(label);
  if (!entry) throw new FsError("unknown_host", `Machine inconnue : ${label}`);
  const local = isLoopbackUrl(entry.url);
  // Machine du dashboard en boucle locale : le système de fichiers Node suffit (valider / suivre un
  // dossier local n'a besoin ni du daemon Paseo ni d'une connexion — tests hors ligne inclus).
  // Seules les machines distantes doivent être connectées.
  if (!local && !entry.connected()) throw new FsError("host_unavailable", `La machine ${label} n’est pas connectée.`);
  return { label, local, daemon: entry.daemon, api: entry.api };
}

// Valide et normalise un chemin absolu. Refus des « .. », des chemins relatifs, UNC et caractères de contrôle.
export function validatePath(raw, { local = false } = {}) {
  if (typeof raw !== "string" || !raw.trim()) throw new FsError("invalid_path", "Chemin vide ou invalide.");
  const text = raw.trim();
  if (text.length > MAX_PATH) throw new FsError("invalid_path", `Chemin trop long (maximum ${MAX_PATH} caractères).`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(text)) throw new FsError("invalid_path", "Le chemin contient des caractères de contrôle.");
  if (text.split(/[\\/]/).includes("..")) {
    throw new FsError("invalid_path", "Chemin refusé : « .. » n’est pas autorisé.");
  }
  let flavor;
  if (/^[A-Za-z]:([\\/]|$)/.test(text)) flavor = "win32";
  else if (text.startsWith("/") && !text.startsWith("//")) flavor = "posix";
  else if (text.startsWith("\\\\") || text.startsWith("//")) {
    throw new FsError("invalid_path", "Les chemins réseau (UNC) ne sont pas pris en charge.");
  } else throw new FsError("invalid_path", "Chemin absolu requis (par exemple D:\\Projets ou /home/ubuntu).");
  if (local && flavor !== (process.platform === "win32" ? "win32" : "posix")) {
    throw new FsError("invalid_path", "Ce chemin n’a pas le format de cette machine.");
  }
  if (flavor === "win32") {
    if (/[<>"|?*]/.test(text) || text.slice(2).includes(":")) {
      throw new FsError("invalid_path", "Le chemin contient des caractères interdits sous Windows.");
    }
    const normal = path.win32.normalize(text.length === 2 ? `${text}\\` : text);
    const trimmed = normal.length > 3 ? normal.replace(/[\\/]+$/, "") : normal;
    return { path: trimmed[0].toUpperCase() + trimmed.slice(1), flavor };
  }
  const normal = path.posix.normalize(text);
  return { path: normal.length > 1 ? normal.replace(/\/+$/, "") : normal, flavor };
}

export const joinPath = (flavor, base, name) => (flavor === "win32" ? path.win32 : path.posix).join(base, name);
export const parentOf = (flavor, p) => {
  const lib = flavor === "win32" ? path.win32 : path.posix;
  const parent = lib.dirname(p);
  return parent === p ? null : parent;
};
export const baseName = (flavor, p) => (flavor === "win32" ? path.win32 : path.posix).basename(p);

function validateFolderName(name, flavor) {
  if (typeof name !== "string" || !name) throw new FsError("invalid_name", "Le nom du dossier est obligatoire.");
  if (name !== name.trim()) throw new FsError("invalid_name", "Le nom ne doit pas commencer ou finir par un espace.");
  if (name.length > 100) throw new FsError("invalid_name", "Le nom du dossier dépasse 100 caractères.");
  if (name === "." || name === "..") throw new FsError("invalid_name", "Nom de dossier invalide.");
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f]/.test(name)) throw new FsError("invalid_name", "Le nom ne peut pas contenir de séparateur.");
  if (flavor === "win32") {
    if (/[<>:"|?*]/.test(name)) throw new FsError("invalid_name", "Caractères interdits sous Windows : < > : \" | ? *");
    if (/[. ]$/.test(name)) throw new FsError("invalid_name", "Le nom ne peut pas finir par un point ou un espace.");
    if (WIN_RESERVED.test(name)) throw new FsError("invalid_name", `« ${name} » est un nom réservé par Windows.`);
  }
}

function mapNodeError(error, target) {
  const code = error?.code;
  if (code === "ENOENT") return new FsError("not_found", `Dossier introuvable : ${target}`);
  if (code === "ENOTDIR") return new FsError("not_directory", `Ce n’est pas un dossier : ${target}`);
  if (code === "EACCES" || code === "EPERM") return new FsError("denied", `Accès refusé : ${target}`);
  return new FsError("fs_error", `Lecture impossible : ${target}`);
}

function mapDaemonError(error, target) {
  if (error instanceof FsError) return error;
  const text = String(error?.message || error);
  if (/ENOENT|no such file|not found/i.test(text)) return new FsError("not_found", `Dossier introuvable : ${target}`);
  if (/ENOTDIR|not a directory/i.test(text)) return new FsError("not_directory", `Ce n’est pas un dossier : ${target}`);
  if (/EACCES|EPERM|permission/i.test(text)) return new FsError("denied", `Accès refusé : ${target}`);
  return new FsError("fs_error", `Lecture impossible sur la machine : ${target}`);
}

const isHidden = (name, flavor) => name.startsWith(".") || (flavor === "win32" && name.startsWith("$"));
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function localMarkers(dir) {
  const found = [];
  for (const marker of MARKERS) if (await exists(path.join(dir, marker))) found.push(marker);
  return found;
}

async function listLocal(dir, flavor, showHidden) {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw mapNodeError(error, dir);
  }
  const folders = [];
  for (const d of dirents) {
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(path.join(dir, d.name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir && (showHidden || !isHidden(d.name, flavor))) folders.push({ name: d.name });
  }
  folders.sort(byName);
  const truncated = folders.length > MAX_ENTRIES;
  const entries = folders.slice(0, MAX_ENTRIES).map((f) => ({ name: f.name, path: joinPath(flavor, dir, f.name) }));
  await mapLimit(entries.slice(0, MAX_LOCAL_PROBES), 16, async (entry) => {
    entry.markers = await localMarkers(entry.path);
    entry.probed = true;
  });
  return { entries, truncated, markers: await localMarkers(dir) };
}

async function listRemote(host, dir, flavor, showHidden) {
  let payload;
  try {
    payload = await withTimeout(host.daemon.listDirectory(dir, "."), REMOTE_TIMEOUT_MS, `lecture de ${dir}`);
  } catch (error) {
    throw mapDaemonError(error, dir);
  }
  const names = (payload.entries || []).map((e) => e.name);
  const folders = (payload.entries || [])
    .filter((e) => e.kind === "directory" && (showHidden || !isHidden(e.name, flavor)))
    .map((e) => ({ name: e.name }))
    .sort(byName);
  const truncated = folders.length > MAX_ENTRIES;
  const entries = folders.slice(0, MAX_ENTRIES).map((f) => ({ name: f.name, path: joinPath(flavor, dir, f.name) }));
  const deadline = Date.now() + 5000;
  await mapLimit(entries.slice(0, MAX_REMOTE_PROBES), 6, async (entry) => {
    if (Date.now() > deadline) return;
    try {
      const child = await withTimeout(host.daemon.listDirectory(entry.path, "."), 3000, entry.path);
      const set = new Set((child.entries || []).map((e) => e.name));
      entry.markers = MARKERS.filter((m) => set.has(m));
      entry.probed = true;
    } catch {
      entry.probed = false;
    }
  });
  return { entries, truncated, markers: MARKERS.filter((m) => names.includes(m)) };
}

// Dossier existant ? Lève FsError(not_found | not_directory | ...) sinon. Utilisé aussi par projects.mjs.
export async function ensureDirectory(host, dir) {
  if (host.local) {
    try {
      const stat = await fsp.stat(dir);
      if (!stat.isDirectory()) throw new FsError("not_directory", `Ce n’est pas un dossier : ${dir}`);
    } catch (error) {
      throw error instanceof FsError ? error : mapNodeError(error, dir);
    }
    return;
  }
  try {
    await withTimeout(host.daemon.listDirectory(dir, "."), REMOTE_TIMEOUT_MS, `lecture de ${dir}`);
  } catch (error) {
    const mapped = mapDaemonError(error, dir);
    if (mapped.code === "not_found" || mapped.code === "not_directory") throw mapped;
    // Les autres échecs (droits, fichier verrouillé) prouvent que le dossier existe.
  }
}

export async function listFolders(host, dir, flavor, showHidden = false) {
  return host.local ? listLocal(dir, flavor, showHidden) : listRemote(host, dir, flavor, showHidden);
}

async function remotePlatform(host) {
  try {
    await withTimeout(host.daemon.listDirectory("/", "."), REMOTE_TIMEOUT_MS, "racine");
    return "posix";
  } catch (error) {
    return /ENOENT|no such file/i.test(String(error?.message)) ? "win32" : "posix";
  }
}

async function remoteHome(host) {
  try {
    const result = await withTimeout(
      host.daemon.getDirectorySuggestions({ query: "~", includeDirectories: true, includeFiles: false, limit: 3 }),
      REMOTE_TIMEOUT_MS,
      "dossier personnel",
    );
    const first = (result.directories || [])[0];
    return first ? parentOf(/^[A-Za-z]:/.test(first) ? "win32" : "posix", first) : null;
  } catch {
    return null;
  }
}

async function rootsFor(host, store) {
  const roots = [];
  const platform = host.local ? process.platform === "win32" ? "win32" : "posix" : await remotePlatform(host);
  if (platform === "win32") {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const found = await mapLimit(letters, 8, async (letter) => {
      const root = `${letter}:\\`;
      if (host.local) return (await withTimeout(exists(root), 1500, root).catch(() => false)) ? root : null;
      try {
        await withTimeout(host.daemon.listDirectory(root, "."), 3000, root);
        return root;
      } catch (error) {
        return /ENOENT|no such file/i.test(String(error?.message)) ? null : root;
      }
    });
    for (const root of found.filter(Boolean)) roots.push({ label: root.slice(0, 2), path: root, kind: "drive" });
  } else {
    roots.push({ label: "/", path: "/", kind: "root" });
  }
  const home = host.local ? os.homedir() : await remoteHome(host);
  if (home) roots.push({ label: "Dossier personnel", path: home, kind: "home" });
  const candidates = platform === "win32" ? ["D:\\Projets"] : home ? [joinPath("posix", home, "projets")] : [];
  for (const candidate of candidates) {
    try {
      await ensureDirectory(host, candidate);
      roots.push({ label: "Projets", path: candidate, kind: "projects" });
    } catch {
      // absent sur cette machine : pas proposé
    }
  }
  const flavor = platform;
  const recents = [];
  const seen = new Set();
  const followed = (store.read("projects", {}).projects || [])
    .filter((p) => p.host === host.label)
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  for (const project of followed) {
    const parent = parentOf(flavor, project.dir);
    if (parent && !seen.has(parent)) {
      seen.add(parent);
      recents.push({ path: parent, name: baseName(flavor, parent) || parent });
    }
    if (recents.length >= 8) break;
  }
  return { platform, roots, recents };
}

export function register(ctx) {
  const { onMessage, send, store } = ctx;
  const reply = (ws, type, message, body) => send(ws, { type, host: message.host || "local", ref: message.ref ?? null, ...body });
  const fail = (ws, type, message, error) => {
    const known = error instanceof FsError;
    if (!known) ctx.log("fs", `${type} : ${ctx.safeError(error)}`);
    reply(ws, type, message, {
      ok: false,
      code: known ? error.code : "fs_error",
      error: known ? error.message : "Opération impossible sur cette machine.",
      path: typeof message.path === "string" ? message.path : null,
    });
  };

  onMessage("fs.roots", async (ws, message) => {
    try {
      const host = resolveHost(ctx, message);
      reply(ws, "fs.roots", message, { ok: true, ...(await rootsFor({ ...host, label: host.label }, store)) });
    } catch (error) {
      fail(ws, "fs.roots", message, error);
    }
  });

  onMessage("fs.list", async (ws, message) => {
    try {
      const host = resolveHost(ctx, message);
      const { path: dir, flavor } = validatePath(message.path, { local: host.local });
      const result = await listFolders(host, dir, flavor, message.showHidden === true);
      const git = result.markers.includes(".git");
      reply(ws, "fs.list", message, {
        ok: true,
        path: dir,
        parent: parentOf(flavor, dir),
        flavor,
        isGit: git,
        isProject: result.markers.length > 0,
        markers: result.markers,
        truncated: result.truncated,
        entries: result.entries.map((e) => ({
          name: e.name,
          path: e.path,
          git: (e.markers || []).includes(".git"),
          project: (e.markers || []).length > 0,
          probed: e.probed === true,
        })),
      });
    } catch (error) {
      fail(ws, "fs.list", message, error);
    }
  });

  // Crée UN dossier (pas de création récursive). `path` = chemin complet du nouveau dossier.
  onMessage("fs.mkdir", async (ws, message) => {
    try {
      const host = resolveHost(ctx, message);
      const { path: target, flavor } = validatePath(message.path, { local: host.local });
      const parent = parentOf(flavor, target);
      if (!parent) throw new FsError("invalid_path", "Impossible de créer une racine.");
      const name = baseName(flavor, target);
      validateFolderName(name, flavor);
      if (host.local) {
        await ensureDirectory(host, parent);
        try {
          await fsp.mkdir(target);
        } catch (error) {
          if (error?.code === "EEXIST") throw new FsError("exists", `Ce dossier existe déjà : ${target}`);
          throw mapNodeError(error, target);
        }
      } else {
        const result = await withTimeout(
          host.daemon.createProjectDirectory({ parentPath: parent, name }),
          REMOTE_TIMEOUT_MS,
          `création de ${target}`,
        );
        if (result.error) {
          const codes = { invalid_name: "invalid_name", parent_directory_not_found: "not_found", permission_denied: "denied" };
          throw new FsError(codes[result.errorCode] || "fs_error", result.error);
        }
      }
      reply(ws, "fs.mkdir", message, { ok: true, path: target, parent });
    } catch (error) {
      fail(ws, "fs.mkdir", message, error);
    }
  });
}
