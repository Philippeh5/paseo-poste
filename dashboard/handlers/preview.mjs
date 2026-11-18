// Aperçu de serveurs locaux (vue « Aperçu »). Messages : preview.ports -> preview.state {ports, dashboardPort} ;
// preview.open {port} -> preview.opened {port, url} (adresse-capacité à jeton, 8 h, liée au port).
// HTTP : GET/HEAD /preview/<port>/... (authentifié comme le poste) ou /preview/t/<jeton>/<port>/... (jeton seul : pour les
// sous-ressources d'un cadre isolé, qui n'envoient pas le cookie du poste). Voir lib/preview.mjs.
import { listPorts, createProxy, createTokens, prefixOf, PREVIEW_PATH } from "../lib/preview.mjs";

export function register(ctx) {
  const dashboardPort = Number(process.env.DASHBOARD_PORT || 7070);
  const ports = () => listPorts({ exclude: [dashboardPort] });
  const tokens = createTokens();
  const proxy = createProxy({ allowed: ports, tokens });
  ctx.onMessage("preview.ports", async (ws, m) => ctx.send(ws, { type: "preview.state", ports: await ports(), dashboardPort, ref: m.ref ?? null }));
  ctx.onMessage("preview.open", async (ws, m) => {
    const port = Number(m.port);
    if (!(await ports()).some((p) => p.port === port)) return ctx.sendError(ws, "Ce port n'écoute pas (ou n'est pas autorisé).");
    ctx.send(ws, { type: "preview.opened", port, url: prefixOf(port, tokens.sign(port)), ref: m.ref ?? null });
  });
  ctx.onHttpPrefix("/preview/", proxy);
  // Accès par jeton seul (aucune authentification du poste) : uniquement /preview/t/<jeton valide>/<port>/ en GET/HEAD.
  ctx.onHttpCapability?.("/preview/t/", (req, url) => {
    const m = PREVIEW_PATH.exec(url.pathname);
    return !!(m && m[1] && (req.method === "GET" || req.method === "HEAD") && tokens.verify(m[1], Number(m[2])));
  }, proxy);
}
