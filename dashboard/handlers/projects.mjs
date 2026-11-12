// Projets suivis, stockés dans data/projects.json : { projects: [{ id, host, dir, name, color, addedAt, order }] }.
// Messages : project.list, project.follow, project.unfollow, project.reorder, project.update, project.dismissSetup,
// project.status. Le serveur diffuse `project.list` à tous les navigateurs après chaque changement.
import { createHash } from "node:crypto";
import { FsError, resolveHost, validatePath, ensureDirectory, baseName } from "./fs.mjs";
import { gitStatus, ghState } from "./github.mjs";

const FILE = "projects";
const MAX_PROJECTS = 200;
const MAX_BATCH = 100;
const MAX_NAME = 80;
const STATUS_TTL_MS = 15000;
const COLOR = /^#[0-9a-fA-F]{6}$/;

const keyOf = (host, dir) => `${host}|${/^[A-Za-z]:/.test(dir) ? dir.toLowerCase() : dir}`;
const idOf = (host, dir) => createHash("sha1").update(keyOf(host, dir)).digest("hex").slice(0, 10);
const cleanName = (value, fallback) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return text || fallback;
};

export function register(ctx) {
  const { onMessage, send, broadcast, store } = ctx;
  const statusCache = new Map();

  const load = () => {
    const data = store.read(FILE, {});
    const projects = (Array.isArray(data.projects) ? data.projects : []).filter((p) => p && p.host && p.dir);
    projects.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return { projects, dismissed: data.dismissed === true };
  };
  const save = (data) => {
    // Favoris (étoile) d'abord, dans l'ordre où ils ont été étoilés ; le reste garde l'ordre choisi.
    data.projects.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)
      || (a.starred && b.starred ? (a.starredAt ?? 0) - (b.starredAt ?? 0) : 0));
    data.projects.forEach((p, index) => { p.order = index; });
    store.write(FILE, { version: 1, dismissed: data.dismissed === true, projects: data.projects });
  };
  const snapshot = (data) => ({
    type: "project.list",
    projects: data.projects,
    firstRun: data.projects.length === 0 && !data.dismissed,
  });
  const fail = (ws, type, message, error) => {
    const known = error instanceof FsError;
    if (!known) ctx.log("projects", `${type} : ${ctx.safeError(error)}`);
    send(ws, {
      type, ok: false, ref: message.ref ?? null, host: message.host ?? null, dir: message.dir ?? null,
      code: known ? error.code : "project_error", error: known ? error.message : ctx.safeError(error),
    });
  };
  // Cible { host, dir } d'un message : par identifiant d'un projet suivi, ou par host + dir.
  const resolveTarget = (data, message) => {
    if (typeof message.id === "string") {
      const found = data.projects.find((p) => p.id === message.id);
      if (!found) throw new FsError("not_followed", "Projet non suivi.");
      return found;
    }
    const host = resolveHost(ctx, message);
    const { path: dir } = validatePath(message.dir, { local: host.local });
    return { host: host.label, dir, entry: host };
  };

  onMessage("project.list", (ws) => send(ws, snapshot(load())));

  onMessage("project.follow", async (ws, message) => {
    try {
      const host = resolveHost(ctx, message);
      const wanted = Array.isArray(message.dirs) ? message.dirs : [message.dir];
      if (!wanted.length || wanted.length > MAX_BATCH) throw new FsError("invalid_path", `Entre 1 et ${MAX_BATCH} dossiers.`);
      const data = load();
      const added = [];
      const already = [];
      const errors = [];
      for (const raw of wanted) {
        try {
          const { path: dir, flavor } = validatePath(raw, { local: host.local });
          await ensureDirectory(host, dir);
          const id = idOf(host.label, dir);
          if (data.projects.some((p) => p.id === id)) {
            already.push(dir);
            continue;
          }
          if (data.projects.length >= MAX_PROJECTS) throw new FsError("too_many", `Maximum ${MAX_PROJECTS} projets suivis.`);
          const color = typeof message.color === "string" && COLOR.test(message.color) && wanted.length === 1 ? message.color : null;
          const project = {
            id, host: host.label, dir,
            name: cleanName(wanted.length === 1 ? message.name : "", baseName(flavor, dir) || dir),
            color, addedAt: new Date().toISOString(), order: data.projects.length,
          };
          data.projects.push(project);
          added.push(project);
        } catch (error) {
          if (!(error instanceof FsError)) throw error;
          errors.push({ dir: raw, code: error.code, error: error.message });
        }
      }
      if (added.length) save(data);
      send(ws, {
        type: "project.followed", ok: added.length > 0 || already.length > 0, ref: message.ref ?? null, host: host.label,
        added, already, errors,
        ...(added.length || already.length ? {} : { code: errors[0]?.code ?? "invalid_path", error: errors[0]?.error ?? "Aucun dossier suivi." }),
      });
      if (added.length) broadcast(snapshot(data));
    } catch (error) {
      fail(ws, "project.followed", message, error);
    }
  });

  onMessage("project.unfollow", (ws, message) => {
    try {
      const data = load();
      const target = resolveTarget(data, message);
      const id = target.id ?? idOf(target.host, target.dir);
      if (!data.projects.some((p) => p.id === id)) throw new FsError("not_followed", "Projet non suivi.");
      data.projects = data.projects.filter((p) => p.id !== id);
      statusCache.delete(id);
      save(data);
      send(ws, { type: "project.unfollowed", ok: true, ref: message.ref ?? null, id });
      broadcast(snapshot(data));
    } catch (error) {
      fail(ws, "project.unfollowed", message, error);
    }
  });

  // ids : nouvel ordre ; les identifiants inconnus sont ignorés, les absents gardent leur ordre relatif à la fin.
  onMessage("project.reorder", (ws, message) => {
    try {
      if (!Array.isArray(message.ids)) throw new FsError("invalid_order", "La liste des projets est invalide.");
      const data = load();
      const byId = new Map(data.projects.map((p) => [p.id, p]));
      const ordered = [];
      for (const id of message.ids) {
        const project = byId.get(id);
        if (project) {
          ordered.push(project);
          byId.delete(id);
        }
      }
      data.projects = [...ordered, ...byId.values()];
      save(data);
      send(ws, { type: "project.reordered", ok: true, ref: message.ref ?? null, ids: data.projects.map((p) => p.id) });
      broadcast(snapshot(data));
    } catch (error) {
      fail(ws, "project.reordered", message, error);
    }
  });

  onMessage("project.update", (ws, message) => {
    try {
      const data = load();
      const project = data.projects.find((p) => p.id === message.id);
      if (!project) throw new FsError("not_followed", "Projet non suivi.");
      if (message.name !== undefined) project.name = cleanName(message.name, project.name);
      if (message.starred !== undefined) {
        project.starred = message.starred === true;
        if (project.starred) project.starredAt = Date.now(); else delete project.starredAt;
      }
      if (message.color !== undefined) {
        if (message.color !== null && !COLOR.test(message.color)) throw new FsError("invalid_color", "Couleur invalide (#rrggbb).");
        project.color = message.color;
      }
      save(data);
      send(ws, { type: "project.updated", ok: true, ref: message.ref ?? null, project });
      broadcast(snapshot(data));
    } catch (error) {
      fail(ws, "project.updated", message, error);
    }
  });

  // Fin de la sélection rapide du premier lancement, sans rien suivre.
  onMessage("project.dismissSetup", (ws) => {
    const data = load();
    data.dismissed = true;
    save(data);
    broadcast(snapshot(data));
  });

  // Branche, propre/modifié, avance/retard, dépôt distant, lien GitHub. Lecture seule. Cache 15 s (fresh:true le contourne).
  onMessage("project.status", async (ws, message) => {
    try {
      const host = resolveHost(ctx, message);
      const { path: dir } = validatePath(message.dir, { local: host.local });
      const id = idOf(host.label, dir);
      const cached = statusCache.get(id);
      if (!message.fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
        send(ws, { ...cached.body, ref: message.ref ?? null });
        return;
      }
      await ensureDirectory(host, dir);
      const [git, gh] = await Promise.all([gitStatus(host, dir), ghState(host, { fresh: message.fresh === true })]);
      const linked = Boolean(git.remote?.github);
      const body = {
        type: "project.status", ok: true, id, host: host.label, dir,
        isGit: git.isGit, branch: git.branch, dirty: git.dirty, ahead: git.ahead, behind: git.behind,
        upstream: git.upstream, hasRemote: git.hasRemote,
        remoteUrl: git.remote?.url ?? null, repo: git.remote?.owner ? `${git.remote.owner}/${git.remote.repo}` : null,
        githubRemote: linked,
        // lié : le dépôt distant est sur GitHub ; non lié : pas de remote GitHub ; non connecté : gh absent/déconnecté.
        github: !gh.connected ? (gh.reason === "unknown" ? "unknown" : "disconnected") : linked ? "linked" : "unlinked",
        githubAccount: gh.account, githubReason: gh.reason,
      };
      statusCache.set(id, { at: Date.now(), body });
      send(ws, { ...body, ref: message.ref ?? null });
    } catch (error) {
      fail(ws, "project.status", message, error);
    }
  });
}
