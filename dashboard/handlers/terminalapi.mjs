// API agent : ouvrir un terminal sur une machine, avec un outil au choix (Claude Code, FreeBuff, Hermes, Pi…).
// Même chemin que l'interface : message `launch.start` (terminal) puis saisie de la commande dans le terminal (`term.input`),
// comme le fait la barre de lanceurs. La commande vient d'une LISTE FERMÉE : un agent ne peut pas saisir de texte libre.
import { ApiError } from "./agentapi.mjs";
import { SELF_HOST } from "../lib/selfhost.mjs";

// Dossier des projets par machine, utilisé quand aucun projet n'est précisé.
const ROOTS = { oracle: "/home/USERNAME/Projets" };
const TOOLS = { terminal: "", claude: "claude", freebuff: "freebuff", hermes: "hermes", pi: "pi", codex: "codex" };
const START_DELAY_MS = 1500;

export function register(ctx) {
  if (typeof ctx.apiRoute !== "function") { ctx.log("terminalapi", "ctx.apiRoute absent : route non enregistrée"); return; }
  const bad = (m) => new ApiError(400, "bad_request", m);

  ctx.apiRoute("POST", "/terminals", async ({ body }) => {
    const host = String(body?.host || SELF_HOST); // machine par défaut = celle du poste (Oracle)
    const cwd = String(body?.cwd || ROOTS[host] || "");
    const tool = String(body?.tool ?? "terminal").toLowerCase();
    if (!Object.hasOwn(TOOLS, tool)) throw bad(`outil inconnu (${Object.keys(TOOLS).join(", ")})`);
    if (!cwd || cwd.length > 500 || /[\u0000-\u001f]/.test(cwd)) throw bad("cwd (dossier du projet) requis");
    const ref = `api-term-${Date.now().toString(36)}`;
    const r = await ctx.invoke("launch.start", { ref, host, cwd, kind: "terminal" }, { timeoutMs: 30_000 });
    if (r.error) throw bad(r.error);
    const started = r.replies.find((x) => x.type === "launch.started");
    if (!started?.terminalId) throw bad("le terminal n'a pas démarré");
    let commandSent = false;
    if (TOOLS[tool]) {
      await new Promise((res) => setTimeout(res, START_DELAY_MS));
      const t = await ctx.invoke("term.input", { host, terminalId: started.terminalId, data: `${TOOLS[tool]}\r` }, { timeoutMs: 10_000 });
      if (t.error) throw bad(`terminal ouvert mais commande non saisie : ${t.error}`);
      commandSent = true;
    }
    return { host: started.host ?? host, terminalId: started.terminalId, tool, commandSent };
  });
}
