// Composant Mode « Agent » (N10 / T28).
// Affiche l'état du mode Agent, le dialogue avec les 3 questions et la pastille topbar.
import { el, icons, iconEl, escapeHtml } from "../core/util.js";
import { on, send, onConnection } from "../core/socket.js";
import { getState, followedProjects, defaultHost } from "../core/state.js";
import { policyBox } from "./agentalerts.js";

let currentMode = {
  enabled: false,
  project: null,
  brief: null,
  since: null,
  forbidden: [],
  questions: [],
  answers: [],
  runId: null,
  engine: null,
  projectDir: null,
  projectHost: null,
  orchestratorTaskId: null,
  launch: null,
  autoPermissions: true,
  allowGit: false,
  writeScope: [],
};

const listeners = new Set();
function notify() {
  for (const fn of listeners) {
    try {
      fn(currentMode);
    } catch {
      /* ignoré */
    }
  }
}

export function subscribeAgentMode(fn) {
  listeners.add(fn);
  fn(currentMode);
  return () => listeners.delete(fn);
}

export function getAgentModeState() {
  return currentMode;
}

// Réception de l'état du mode Agent depuis le serveur
on("agentmode.state", (m) => {
  currentMode = {
    enabled: m.enabled === true,
    project: m.project || null,
    brief: m.brief || null,
    since: m.since || null,
    forbidden: Array.isArray(m.forbidden) ? m.forbidden : [],
    questions: Array.isArray(m.questions) ? m.questions : [],
    answers: Array.isArray(m.answers) ? m.answers : [],
    runId: m.runId || null,
    engine: m.engine || null,
    projectDir: m.projectDir || null,
    projectHost: m.projectHost || null,
    orchestratorTaskId: m.orchestratorTaskId || null,
    launch: m.launch && typeof m.launch === "object" ? m.launch : null,
    autoPermissions: m.autoPermissions !== false,
    allowGit: m.allowGit === true,
    writeScope: Array.isArray(m.writeScope) ? m.writeScope.filter((x) => typeof x === "string") : [],
  };
  notify();
});

onConnection((up) => {
  if (up) send({ type: "agentmode.get" });
});

export function disableAgentMode({ stopTasks = false } = {}) {
  send({ type: "agentmode.disable", ...(stopTasks ? { stopTasks: true } : {}) });
}

export function launchLine(mode) {
  const launch = mode?.launch;
  if (launch?.status === "starting") return "L'agent est en train de démarrer…";
  if (launch?.status === "started") return `L'agent travaille en arrière-plan (moteur ${mode.engine || "?"}).`;
  if (launch?.status === "failed") return `L'agent n'a pas pu démarrer : ${launch.error || "erreur inconnue"}`;
  return "L'agent autonome est mandaté sur ce projet. Il doit lire le mandat via postectl ou MCP.";
}

// Moteurs proposés (fournisseur/modèle) : lus dans launch.options de la machine principale, avec un repli sûr.
const DEFAULT_ENGINE = "claude-openrouter/sonnet";
function engineChoices(options) {
  const list = [];
  for (const p of options?.providers || []) {
    if (!p.available) continue;
    for (const model of p.models || []) list.push(`${p.id}/${model.id}`);
  }
  if (!list.includes(DEFAULT_ENGINE)) list.unshift(DEFAULT_ENGINE);
  return [...new Set(list)];
}

export function openAgentModeDialog() {
  const existing = document.getElementById("agentmode-dialog");
  if (existing) {
    existing.close();
    existing.remove();
  }

  const dialog = el("dialog", { class: "dialog agentmode-dialog", id: "agentmode-dialog" });

  const renderContent = () => {
    dialog.replaceChildren();

    const titleEl = el("h2", {}, currentMode.enabled ? "Mode Agent actif" : "Mode Agent — Confier le poste");
    const closeBtn = el(
      "button",
      {
        class: "icon-btn",
        type: "button",
        "aria-label": "Fermer",
        title: "Fermer (Échap)",
        onclick: () => dialog.close(),
      },
      iconEl(icons.close || "✕")
    );
    const header = el("div", { class: "dialog-head", style: "padding: 16px 20px 0;" }, titleEl, closeBtn);

    const body = el("div", { class: "dialog-body" });

    if (currentMode.enabled) {
      // Mandat en cours
      const banner = el(
        "div",
        {
          class: "agentmode-active-callout",
          style: "padding: 12px; margin-bottom: 16px; border-radius: var(--rayon-controle); background: color-mix(in srgb, var(--accent) 15%, transparent); border: 1px solid var(--accent);",
        },
        el("strong", { style: "display: block; font-size: var(--t-14); margin-bottom: 4px;" }, `Jarvis — ${currentMode.project || "Projet"}`),
        el("p", { class: "text-muted text-xs", style: "margin: 0;" }, launchLine(currentMode))
      );

      const briefBox = el(
        "div",
        { class: "agentmode-info-row" },
        el("strong", {}, "Consigne donnée :"),
        el("p", { class: "agentmode-brief-text" }, currentMode.brief || "(aucune consigne spécifique)")
      );

      const forbiddenItems = currentMode.forbidden.length
        ? el(
            "ul",
            { class: "agentmode-forbidden-list" },
            ...currentMode.forbidden.map((f) => el("li", {}, f))
          )
        : el("span", { class: "text-muted" }, "Aucune interdiction particulière.");

      const forbidBox = el(
        "div",
        { class: "agentmode-info-row" },
        el("strong", {}, "Actions interdites sans demander :"),
        forbiddenItems
      );

      const notice = el(
        "p",
        { class: "text-muted text-xs", style: "margin-top: 14px;" },
        "Note : Les actions destructrices de l'API sont bloquées pour les catégories interdites. Pour reprendre la main manuellement, cliquez sur le bouton ci-dessous."
      );

      const stopAll = el("input", { type: "checkbox", id: "agentmode-stop-tasks" });
      const stopRow = el(
        "label",
        { class: "check", style: "margin-top: 10px;" },
        stopAll,
        " Arrêter aussi les tâches de l'agent (sinon elles continuent)"
      );

      const permLine = el(
        "div",
        { class: "agentmode-info-row", id: "agentmode-active-policy" },
        el("strong", {}, "Permissions :"),
        el("p", { class: "agentmode-brief-text" }, currentMode.autoPermissions
          ? "Le poste répond seul à ce qui est sûr dans le dossier du projet."
          : "Tout attend votre réponse (réponse automatique désactivée)."),
        el("p", { class: "text-muted text-xs", style: "margin: 0;" },
          `git commit : ${currentMode.allowGit ? "autorisé" : "refusé"} · Modifications : ${
            currentMode.writeScope.length ? currentMode.writeScope.join(", ") : "tout le dossier du projet"}`)
      );
      body.append(banner, briefBox, forbidBox, permLine, policyBox({ id: "agentmode-active-policy-box" }), notice, stopRow);

      const foot = el(
        "div",
        { class: "dialog-foot" },
        el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Fermer"),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            id: "dialog-agentmode-view-btn",
            onclick: () => {
              location.hash = "#agent";
              dialog.close();
            },
          },
          "Voir l'agent au travail"
        ),
        el(
          "button",
          {
            class: "btn btn-danger",
            type: "button",
            id: "dialog-agentmode-takeover-btn",
            onclick: () => {
              disableAgentMode({ stopTasks: stopAll.checked });
              dialog.close();
            },
          },
          "Reprendre la main"
        )
      );

      dialog.append(header, body, foot);
    } else {
      // Formulaire d'activation : les 3 questions
      const notice = el(
        "div",
        {
          style: "padding: 10px 12px; margin-bottom: 14px; border-radius: var(--rayon-controle); background: var(--panneau-2); border: 1px solid var(--trait); font-size: var(--t-13); color: var(--texte-doux);",
        },
        "Le mandat est posé ici : l'agent le lit via ",
        el("code", {}, "postectl mandate"),
        " ou via MCP. Cochez « Lancer l'agent maintenant » pour qu'il démarre tout de suite en arrière-plan."
      );

      // Question 1 : Sur quel projet l'agent doit-il travailler ?
      const state = getState();
      const projectList = followedProjects(state)?.projects || [];
      const projectSelect = el("select", { id: "agentmode-project-select", class: "select" });
      const seenNames = new Set();
      for (const p of projectList) {
        const name = p.name || (p.directory ? p.directory.split(/[\\/]/).pop() : p.host);
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          projectSelect.append(el("option", { value: name }, name));
        }
      }
      if (!seenNames.has("sandbox-repo")) {
        projectSelect.append(el("option", { value: "sandbox-repo" }, "sandbox-repo"));
      }

      const q1 = el(
        "label",
        { class: "field" },
        el("strong", { class: "field-label", style: "margin-bottom: 4px;" }, "Sur quel projet l'agent doit-il travailler ?"),
        projectSelect
      );

      // Question 2 : Que doit-il faire ?
      const briefTextarea = el("textarea", {
        id: "agentmode-brief",
        rows: "3",
        maxlength: "2000",
        placeholder: "Consigne libre pour l'agent (ex. implémenter la tâche, exécuter les tests)...",
      });
      const q2 = el(
        "label",
        { class: "field" },
        el("strong", { class: "field-label", style: "margin-bottom: 4px;" }, "Que doit-il faire ?"),
        briefTextarea
      );

      // Question 3 : Que lui est-il interdit de faire sans demander ?
      const chkDelete = el("input", { type: "checkbox", id: "forbid-delete", checked: true, value: "supprimer" });
      const chkPush = el("input", { type: "checkbox", id: "forbid-push", checked: true, value: "pousser sur GitHub" });
      const chkShutdown = el("input", { type: "checkbox", id: "forbid-shutdown", checked: true, value: "éteindre une machine" });

      const checks = el(
        "div",
        { class: "agentmode-checks" },
        el("label", { class: "check" }, chkDelete, " Supprimer (bloqué par l'API de pilotage)"),
        el("label", { class: "check" }, chkPush, " Pousser sur GitHub (consigne à l'agent)"),
        el("label", { class: "check" }, chkShutdown, " Éteindre une machine (consigne à l'agent)")
      );

      const q3 = el(
        "div",
        { class: "field" },
        el("strong", { class: "field-label", style: "margin-bottom: 4px;" }, "Que lui est-il interdit de faire sans demander ?"),
        checks
      );

      // Démarrage automatique : case cochée par défaut + moteur (liste des moteurs disponibles ou texte libre).
      const chkLaunch = el("input", { type: "checkbox", id: "agentmode-launch", checked: true });
      const engineInput = el("input", {
        id: "agentmode-engine", class: "input", type: "text", list: "agentmode-engines", value: DEFAULT_ENGINE,
        maxlength: "200", autocomplete: "off", placeholder: "fournisseur/modèle", "aria-label": "Moteur de l'agent",
      });
      const engineList = el("datalist", { id: "agentmode-engines" });
      const fillEngines = (options) => {
        engineList.replaceChildren(...engineChoices(options).map((value) => el("option", { value })));
      };
      fillEngines(null);
      const engineHost = (getState().hosts || []).find((h) => h.status === "connected");
      if (engineHost) {
        const stop = on("launch.options", (data) => {
          if (data.host === engineHost.label) fillEngines(data);
        });
        dialog.addEventListener("close", stop, { once: true });
        send({ type: "launch.options", host: engineHost.label });
      }
      chkLaunch.addEventListener("change", () => { engineInput.disabled = !chkLaunch.checked; });
      const launchBox = el(
        "div",
        { class: "field" },
        el("label", { class: "check" }, chkLaunch, " Lancer l'agent maintenant"),
        el("span", { class: "text-muted text-xs", style: "margin: 4px 0;" }, "Moteur de l'agent (fournisseur/modèle) :"),
        engineInput,
        engineList
      );

      // T34 : politique de permissions du mandat.
      const chkAuto = el("input", { type: "checkbox", id: "agentmode-auto-permissions", checked: true });
      const chkGit = el("input", { type: "checkbox", id: "agentmode-allow-git" });
      const scopeInput = el("input", {
        id: "agentmode-write-scope", class: "input", type: "text", maxlength: "600", autocomplete: "off",
        placeholder: "ex. documents/Notes, README.md (vide : tout le dossier du projet)",
        "aria-label": "Fichiers ou dossiers que l'agent peut modifier",
      });
      const permBox = el(
        "div",
        { class: "field", id: "agentmode-permissions-field" },
        el("strong", { class: "field-label", style: "margin-bottom: 4px;" }, "Permissions pendant le mandat"),
        el("label", { class: "check" }, chkAuto, " Autoriser automatiquement ce qui est sûr dans le dossier du projet"),
        el("label", { class: "check" }, chkGit, " Autoriser git (commit)"),
        el("span", { class: "text-muted text-xs", style: "margin: 4px 0;" },
          "Fichiers ou dossiers que l'agent peut modifier (chemins relatifs au projet, séparés par des virgules) :"),
        scopeInput,
        policyBox({ id: "agentmode-policy-box" })
      );

      body.append(notice, q1, q2, q3, permBox, launchBox);

      const foot = el(
        "div",
        { class: "dialog-foot" },
        el("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Annuler"),
        el(
          "button",
          {
            class: "btn btn-primary",
            type: "button",
            id: "dialog-agentmode-enable-btn",
            onclick: () => {
              const forbidden = [];
              if (chkDelete.checked) forbidden.push(chkDelete.value);
              if (chkPush.checked) forbidden.push(chkPush.value);
              if (chkShutdown.checked) forbidden.push(chkShutdown.value);

              send({
                type: "agentmode.enable",
                project: projectSelect.value,
                brief: briefTextarea.value,
                forbidden,
                autoPermissions: chkAuto.checked,
                allowGit: chkGit.checked,
                writeScope: scopeInput.value.split(/[,;]/).map((x) => x.trim()).filter(Boolean),
                launch: chkLaunch.checked,
                ...(chkLaunch.checked ? { engine: engineInput.value.trim() || DEFAULT_ENGINE } : {}),
              });
              dialog.close();
            },
          },
          "Confier le poste"
        )
      );

      dialog.append(header, body, foot);
    }
  };

  renderContent();

  dialog.addEventListener("close", () => {
    dialog.remove();
  });

  document.body.append(dialog);
  dialog.showModal();
}
