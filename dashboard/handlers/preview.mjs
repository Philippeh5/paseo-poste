// Aperçu de serveurs locaux (vue « Aperçu »). Message : preview.ports -> preview.state {ports, dashboardPort}.
// HTTP : GET/HEAD /preview/<port>/... relayé vers 127.0.0.1:<port> (voir lib/preview.mjs), même authentification que le poste.
import { listPorts, createProxy } from "../lib/preview.mjs";

export function register(ctx) {
  const dashboardPort = Number(process.env.DASHBOARD_PORT || 7070);
  const ports = () => listPorts({ exclude: [dashboardPort] });
  ctx.onMessage("preview.ports", async (ws, m) => ctx.send(ws, { type: "preview.state", ports: await ports(), dashboardPort, ref: m.ref ?? null }));
  ctx.onHttpPrefix("/preview/", createProxy({ allowed: ports }));
}
