// Alimente core/names.js avec le modèle réel derrière chaque alias (sonnet, opus…) de Claude via OpenRouter / NVIDIA.
// Source : handlers/models.mjs (models.state). Les libellés de sessions affichent alors « Claude (OpenRouter) · Sonnet (nemotron-…) ».
import { on, send, onConnection } from "./socket.js";
import { setGatewayModels } from "./names.js";

on("models.state", (m) => {
  const map = {};
  for (const p of m.providers || []) {
    map[p.id] = Object.fromEntries(Object.entries(p.aliases || {}).filter(([, v]) => v).map(([a, v]) => [a, v]));
  }
  setGatewayModels(map);
  document.dispatchEvent(new CustomEvent("gateway-models")); // le rail et les listes se redessinent avec les noms de modèles
});
onConnection((up) => { if (up) send({ type: "models.get" }); });
