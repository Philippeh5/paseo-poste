// Santé du poste : GET /api/healthz (JSON, 200 si tout va bien, 503 sinon). Utilisé par le chien de garde
// (deploy/oracle/watchdog.sh), qui relance le service et alerte sur Telegram. Lecture seule, aucun secret.
import { statfsSync, readFileSync } from "node:fs";
import { totalmem, freemem, loadavg } from "node:os";

const DISK_ALERT = 0.85;
const startedAt = Date.now();

function disk(path) {
  try {
    const s = statfsSync(path);
    const used = 1 - s.bavail / s.blocks;
    return { usedRatio: Number(used.toFixed(3)), freeGb: Number(((s.bavail * s.bsize) / 1e9).toFixed(1)), ok: used < DISK_ALERT };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}

export function register(ctx) {
  const hostChecks = () => {
    const out = {};
    for (const label of ctx.hosts.labels()) {
      const h = ctx.hosts.get(label);
      out[label] = { connected: !!h?.connected?.() };
    }
    return out;
  };
  ctx.onHttp?.("/api/healthz", (_req, res) => {
    const hosts = hostChecks();
    const d = disk(ctx.dataDir);
    const mem = { freeRatio: Number((freemem() / totalmem()).toFixed(3)) };
    let store = true;
    try { ctx.store.read("projects.json"); } catch { store = false; }
    // Les hôtes secondaires (Mini PC éteint) ne rendent pas le poste malade : seul l'hôte propre compte.
    const self = process.env.DASHBOARD_SELF_HOST || "local";
    const selfOk = hosts[self]?.connected ?? true;
    const ok = d.ok && store && selfOk;
    const body = { ok, uptimeS: Math.round((Date.now() - startedAt) / 1000), self, selfOk, store, disk: d, mem, load: loadavg().map((x) => Number(x.toFixed(2))), hosts };
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  });
}
