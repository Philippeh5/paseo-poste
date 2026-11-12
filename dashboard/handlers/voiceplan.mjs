// Handler serveur : génération d'un plan de tâches à partir d'un texte ou d'une transcription vocale.
// Réutilise l'appel LLM direct de llmchat.mjs (modèle gratuit OpenRouter ou NVIDIA).
// Crée un élément de plan dans l'inbox via le message inbox.plan.create (source "voix").
import { executeLlmCall, resolveProvider, sanitizeKey } from "./llmchat.mjs";

export const MAX_TEXT_LENGTH = 4000;
export const TIMEOUT_MS = 60000;

export function selectFreeLlmConfig() {
  const nv = resolveProvider("nvidia");
  if (nv?.key) {
    return {
      provider: "nvidia",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
    };
  }
  const or = resolveProvider("openrouter");
  if (or?.key) {
    return {
      provider: "openrouter",
      model: "poolside/laguna-s-2.1:free",
    };
  }
  return null;
}

export function parseAndValidatePlan(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Réponse vide ou invalide");
  }

  // Parse tolérant : retire les blocs markdown ```json ou ```
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();

  // Recherche de la première accolade ouvrante et de la dernière fermante
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("JSON invalide retourné par le modèle");
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("JSON invalide retourné par le modèle");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Format de plan invalide (objet attendu)");
  }

  const title = typeof parsed.title === "string" && parsed.title.trim()
    ? parsed.title.trim().slice(0, 200)
    : "Plan d'action proposé";

  if (!Array.isArray(parsed.tasks)) {
    throw new Error("Le plan doit contenir une liste de tâches");
  }

  if (parsed.tasks.length === 0) {
    throw new Error("Le plan ne contient aucune tâche");
  }

  if (parsed.tasks.length > 12) {
    throw new Error("Nombre maximal de tâches dépassé (maximum 12)");
  }

  const n = parsed.tasks.length;
  const validatedTasks = [];

  for (let i = 0; i < n; i++) {
    const t = parsed.tasks[i];
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      throw new Error(`Tâche ${i + 1} invalide`);
    }
    const taskTitle = typeof t.title === "string" ? t.title.trim() : "";
    if (!taskTitle) {
      throw new Error(`Titre de tâche manquant ou vide (tâche ${i + 1})`);
    }

    let dependsOn = [];
    if (t.dependsOn != null) {
      if (!Array.isArray(t.dependsOn)) {
        throw new Error(`Dépendances invalides pour la tâche ${i + 1}`);
      }
      for (const dep of t.dependsOn) {
        const idx = typeof dep === "number" ? dep : parseInt(String(dep), 10);
        if (Number.isNaN(idx) || idx < 0 || idx >= n) {
          throw new Error(`Dépendance hors bornes : tâche ${i + 1} pointe vers l'indice invalide ${dep}`);
        }
        if (idx === i) {
          throw new Error(`Dépendance circulaire : tâche ${i + 1} dépend d'elle-même`);
        }
        dependsOn.push(idx);
      }
    }

    validatedTasks.push({
      title: taskTitle.slice(0, 200),
      dependsOn,
    });
  }

  // Refuse les cycles (dépendances circulaires entre plusieurs tâches).
  const state = new Array(n).fill(0);
  const visit = (i) => {
    if (state[i] === 1) throw new Error("Dépendance circulaire entre les tâches du plan");
    if (state[i] === 2) return;
    state[i] = 1;
    for (const d of validatedTasks[i].dependsOn) visit(d);
    state[i] = 2;
  };
  for (let i = 0; i < n; i++) visit(i);

  return {
    title,
    tasks: validatedTasks,
  };
}

export function register(ctx) {
  const { onMessage, send, sendError, safeError, log } = ctx;

  onMessage("voiceplan.generate", async (ws, m) => {
    const rawText = typeof m.text === "string" ? m.text.trim() : "";
    const project = typeof m.project === "string" ? m.project.trim() : "";
    const host = typeof m.host === "string" ? m.host.trim() : "local";

    if (!rawText) {
      const err = "Le texte de la demande est vide.";
      send(ws, { type: "voiceplan.error", error: err });
      return sendError(ws, err);
    }

    if (rawText.length > MAX_TEXT_LENGTH) {
      const err = `Le texte dépasse la limite autorisée de ${MAX_TEXT_LENGTH} caractères.`;
      send(ws, { type: "voiceplan.error", error: err });
      return sendError(ws, err);
    }

    const llmConfig = selectFreeLlmConfig();
    if (!llmConfig) {
      const err = "Aucune clé d'API disponible (OpenRouter ou NVIDIA). " +
        "Configurez une clé dans ~/.pi/agent ou ~/.claude-*.";
      send(ws, { type: "voiceplan.error", error: err });
      return sendError(ws, err);
    }

    log("voiceplan", `génération fournisseur=${llmConfig.provider} modèle=${llmConfig.model}`);

    const systemPrompt =
      "Tu es un assistant expert en découpage de projet. À partir du message ou de la dictée vocale,\n" +
      "propose un plan d'action structuré avec des tâches ordonnées et leurs dépendances.\n\n" +
      "Règles strictes :\n" +
      "1. Réponds UNIQUEMENT avec un objet JSON strict valide sans texte avant ni après, ni bloc Markdown.\n" +
      "2. Format exact attendu :\n" +
      '{\n  "title": "Titre court du plan",\n  "tasks": [\n    {"title": "Action claire", "dependsOn": []}\n  ]\n}\n' +
      "3. Maximum 12 tâches. Titres courts en français (verbe à l'infinitif recommandé).\n" +
      "4. `dependsOn` est un tableau d'indices (entiers 0-indexés) désignant les tâches préalables qui doivent être " +
      "réalisées avant cette tâche.\n" +
      "5. Si une tâche n'a pas de prérequis, `dependsOn` doit être un tableau vide [].\n" +
      "6. Une tâche ne peut dépendre que d'une tâche d'indice inférieur (pas de cycle, ni d'auto-dépendance).";

    const userPrompt = `Voici la dictée ou le texte à découper en tâches :\n\n${rawText}`;

    try {
      const rawReply = await executeLlmCall({
        provider: llmConfig.provider,
        model: llmConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        timeoutMs: TIMEOUT_MS,
      });

      const parsedPlan = parseAndValidatePlan(rawReply);

      // Création du plan via le mécanisme existant inbox.plan.create
      const planTasks = parsedPlan.tasks.map((t) => ({
        title: t.title,
        project,
        host,
        dependsOn: t.dependsOn.map(String),
      }));

      let createdItem = null;
      if (ctx.invoke) {
        const createRes = await ctx.invoke("inbox.plan.create", {
          title: parsedPlan.title,
          body: `${planTasks.length} tâche(s) proposée(s) à valider (source voix).`,
          tasks: planTasks,
          project,
          host,
          source: "voix",
        });
        if (createRes.error) {
          throw new Error(createRes.error);
        }
        createdItem = createRes.replies?.find((r) => r.type === "inbox.plan.created")?.item;
      } else if (ctx.inbox) {
        createdItem = ctx.inbox.add({
          kind: "plan",
          title: parsedPlan.title,
          body: `${planTasks.length} tâche(s) proposée(s) à valider (source voix).`,
          tasks: planTasks,
          project,
          host,
          source: "voix",
          action: { type: "plan" },
        });
      }

      if (!createdItem?.id) {
        throw new Error("Échec de la création de l'élément de plan dans la boîte de réception.");
      }

      send(ws, {
        type: "voiceplan.created",
        itemId: createdItem.id,
        item: createdItem,
      });
    } catch (e) {
      const rawMsg = e.message || String(e);
      let frenchError = rawMsg;
      if (rawMsg.includes("timeout") || rawMsg.includes("délai")) {
        frenchError = "Délai dépassé (60 s) lors de l'appel LLM.";
      } else if (rawMsg.includes("JSON")) {
        frenchError = "JSON invalide retourné par le modèle.";
      }
      const safeMsg = sanitizeKey(safeError ? safeError(frenchError) : frenchError);
      send(ws, { type: "voiceplan.error", error: safeMsg });
      sendError(ws, safeMsg);
    }
  });
}
