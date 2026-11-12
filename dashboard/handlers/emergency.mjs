// Arrêt d'urgence (garde-fou durs, PLAN-AUTONOMIE.md phase 4). Un fichier STOP dans le dossier de données :
// tant qu'il existe, tools/guard-hook.mjs refuse TOUT appel d'outil des agents autonomes (effet immédiat, sans redémarrage)
// et lib/permpolicy.mjs refuse toute demande de permission. Aucun agent n'est tué : il est simplement bloqué.
// Messages WS : emergency.status {}, emergency.stop {reason?}, emergency.resume {}. HTTP : GET /api/emergency (lecture seule).
// Les trois premiers rendent {type:"emergency.state", stopped, since, reason} et le diffusent à tous.
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stopFile } from "../lib/guardrails.mjs";
import { telegramSend } from "../lib/notify.mjs";
import { secretMatches } from "../lib/decision-auth.mjs";
import { ApiError } from "./agentapi.mjs";

export function register(ctx) {
  const read = () => {
    const f = stopFile();
    if (!existsSync(f)) return { stopped: false, since: null, reason: null };
    try { return { stopped: true, ...JSON.parse(readFileSync(f, "utf8")) }; } catch { return { stopped: true, since: null, reason: null }; }
  };
  const announce = () => ctx.broadcast({ type: "emergency.state", ...read() });
  ctx.onMessage("emergency.status", (ws) => ctx.send(ws, { type: "emergency.state", ...read() }));
  const stop = (reason) => {
    const f = stopFile(); mkdirSync(dirname(f), { recursive: true });
    const why = typeof reason === "string" ? reason.slice(0, 200) : "arrêt demandé";
    writeFileSync(f, JSON.stringify({ since: new Date().toISOString(), reason: why }));
    ctx.log("emergency", `ARRÊT D'URGENCE : ${why}`); announce();
    telegramSend(`⛔ ARRÊT D'URGENCE actif (${why}). Aucun agent autonome ne peut agir.`, [[{ text: "▶️ Reprendre", callback_data: "ps:r" }]]);
  };
  const resume = () => { try { unlinkSync(stopFile()); } catch {} ctx.log("emergency", "reprise"); announce(); };
  ctx.onMessage("emergency.stop", (_ws, m) => stop(m.reason));
  ctx.onMessage("emergency.resume", resume);
  // API locale : arrêter est permis à tous (sans danger) ; REPRENDRE exige le secret de Philippe (un agent bloqué ne peut pas se libérer).
  ctx.apiRoute?.("POST", "/emergency/stop", ({ body }) => { stop(body?.reason || "arrêt demandé"); return read(); });
  ctx.apiRoute?.("POST", "/emergency/resume", ({ req }) => {
    if (!secretMatches(ctx.dataDir, req?.headers?.["x-decide-secret"])) throw new ApiError(403, "forbidden", "seul Philippe peut reprendre");
    resume(); return read();
  });
  ctx.onHttp?.("/api/emergency", (_req, res) => { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(read())); });
}
