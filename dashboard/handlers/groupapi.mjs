// API agent « Groupes » : Hermes (ou postectl) peut lire les groupes de projets, lire leur fil et y écrire, ou lancer l'orchestrateur.
// Principe voulu par Philippe : Hermes ne fait pas le travail lui-même ; il transmet la demande au groupe du projet, l'orchestrateur du groupe
// prend la main, distribue aux agents et répond dans le fil. Le message est signé « Philippe (via Hermes) » (voir coord.group.api).
// Même authentification et même journal d'audit que le reste de /api/v1/ ; seul le texte (jamais de secret) est transmis.
import { ApiError } from "./agentapi.mjs";

const clip = (t, n) => { const f = String(t ?? "").replace(/\s+/g, " ").trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

export function register(ctx) {
  if (typeof ctx.apiRoute !== "function") { ctx.log("groupapi", "ctx.apiRoute absent : routes non enregistrées"); return; }
  const bad = (m, code = "bad_request") => new ApiError(400, code, m);

  // Projets suivis, un seul par nom (Oracle d'abord), dans l'ordre du serveur (favoris en tête).
  async function followed() {
    const r = await ctx.invoke("project.list", {}, { timeoutMs: 15_000 });
    const all = (r.replies.find((x) => x.type === "project.list")?.projects || []).filter((p) => p.host && p.dir);
    const key = (p) => String(p.name ?? "").trim().toLowerCase();
    const onOracle = new Set(all.filter((p) => p.host === "oracle").map(key));
    return all.filter((p) => p.host === "oracle" || !onOracle.has(key(p)));
  }
  async function resolve(name, host) {
    const q = String(name ?? "").trim().toLowerCase();
    if (!q) throw bad("project requis (nom du projet suivi)");
    const list = await followed();
    const hits = list.filter((p) => String(p.name).toLowerCase() === q && (!host || p.host === host));
    if (hits.length === 1) return hits[0];
    const part = list.filter((p) => String(p.name).toLowerCase().includes(q) && (!host || p.host === host));
    if (part.length === 1) return part[0];
    throw bad(hits.length || part.length ? `plusieurs projets correspondent à « ${clip(name, 40)} » : précise le nom` : `projet inconnu : « ${clip(name, 40)} » (projets : ${list.map((p) => p.name).join(", ")})`, "not_found");
  }

  ctx.apiRoute("GET", "/groups", async () => {
    const list = await followed();
    const out = [];
    for (const p of list) {
      let team = []; let last = null;
      try {
        const proj = ctx.coord?.projectOf?.(p.host, p.dir);
        if (proj) {
          team = ctx.coord.teamOf(proj.key);
          const th = await ctx.invoke("coord.thread.api", { host: p.host, dir: p.dir }, { timeoutMs: 8000 });
          const msgs = th.replies.find((x) => x.type === "coord.thread")?.messages || [];
          const m = msgs.filter((x) => !x.system).at(-1);
          if (m) last = { from: m.fromLabel || m.from, text: clip(m.text, 200), at: m.at };
        }
      } catch { /* groupe sans activité : résumé vide */ }
      out.push({ project: p.name, host: p.host, dir: p.dir, starred: !!p.starred, team, last });
    }
    return { groups: out };
  });

  ctx.apiRoute("GET", "/groups/thread", async ({ query }) => {
    const p = await resolve(query.get("project"), query.get("host"));
    const th = await ctx.invoke("coord.thread.api", { host: p.host, dir: p.dir }, { timeoutMs: 8000 });
    if (th.error) throw bad(th.error);
    const n = Math.max(1, Math.min(Number(query.get("limit")) || 30, 100));
    const msgs = (th.replies.find((x) => x.type === "coord.thread")?.messages || []).slice(-n)
      .map((m) => ({ at: m.at, from: m.fromLabel || m.from, kind: m.fromKind, to: m.to, text: clip(m.text, 3000), system: !!m.system }));
    return { project: p.name, host: p.host, messages: msgs };
  });

  ctx.apiRoute("POST", "/groups/say", async ({ body }) => {
    const p = await resolve(body?.project, body?.host);
    const text = String(body?.text ?? "").trim();
    if (!text) throw bad("text requis");
    if (text.length > 1000) throw bad("message trop long (1000 caractères au plus)");
    const r = await ctx.invoke("coord.group.api", { host: p.host, dir: p.dir, text, launch: body?.launch === true ? true : body?.launch === false ? false : undefined }, { timeoutMs: 120_000 });
    if (r.error) throw bad(r.error);
    const sent = r.replies.find((x) => x.type === "coord.groupSent");
    return { project: p.name, host: p.host, recipients: sent?.recipients ?? 0, orchestratorLaunched: !!sent?.launched };
  });
}
