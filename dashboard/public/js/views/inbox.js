// Vue « Boîte de réception » : fil d'attention unique (permissions, fins de travail, erreurs, alertes machines).
// Données : handlers/inbox.mjs (messages inbox.*). Les réponses de permission passent par perm.respond.
import { registerView } from "./registry.js";
import { el, icons, iconEl } from "../core/util.js";
import { setInboxUnread } from "../core/topbar.js";
import { hostLabel, projectLabel } from "../core/names.js";
import { openVoicePlanDialog } from "../components/voiceplan.js";
import { mountCockpit } from "../components/cockpit.js";
import { mountJournal } from "../components/journal.js";

// Une forme distincte par type (la couleur seule ne suffit pas) : losange, coche, croix, écran, info.
const glyph = (path) => '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" ' +
  `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const KINDS = {
  permission: { label: "Permission", slug: "permission", icon: glyph('<path d="M10 2.5l7 7.5-7 7.5L3 10z"/>') },
  plan: { label: "Plan", slug: "plan",
    icon: glyph('<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 7h6M7 10h6M7 13h4"/>') },
  fin: { label: "Fin de travail", slug: "fin", icon: glyph('<path d="M4 10.5l4 4 8-9"/>') },
  erreur: { label: "Erreur", slug: "erreur", icon: glyph('<path d="M5 5l10 10M15 5L5 15"/>') },
  machine: { label: "Machine", slug: "machine",
    icon: glyph('<rect x="3" y="4" width="14" height="9" rx="1.5"/><path d="M7 17h6M10 13v4"/>') },
  "système": { label: "Système", slug: "systeme",
    icon: glyph('<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.2v.1"/>') },
};
const STATUS_SLUG = { nouveau: "nouveau", lu: "lu", "traité": "traite" };
const KIND_FILTERS = [["all", "Tous"], ["permission", "Permissions"], ["plan", "Plans"], ["fin", "Fins"],
  ["erreur", "Erreurs"], ["machine", "Machines"], ["système", "Système"]];
const STATUS_FILTERS = [["all", "Tous"], ["nouveau", "Nouveaux"], ["lu", "Lus"], ["traité", "Traités"]];

const BANNER_PREF_KEY = "paseo:inbox-banner-expanded";
function isBannerExpanded() {
  try {
    const val = window.localStorage?.getItem(BANNER_PREF_KEY);
    return val === null ? true : val === "true";
  } catch {
    return true;
  }
}
function setBannerExpanded(expanded) {
  try {
    window.localStorage?.setItem(BANNER_PREF_KEY, String(expanded));
  } catch {
    // stockage indisponible
  }
}

let items = [];
let filterStatus = "all";
let filterKind = "all";
let selectedId = null;
let bannerExpanded = isBannerExpanded();
let root = null;
let ctx = null;
let unsubs = [];
let timer = null;
const sending = new Set(); // permissions dont la réponse part, en attente de confirmation du serveur

function relative(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 5) return "à l’instant";
  if (sec < 60) return `il y a ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.floor(hours / 24)} j`;
}

const visibleItems = () => items.filter((i) =>
  (filterStatus === "all" || i.status === filterStatus) && (filterKind === "all" || i.kind === filterKind));
const isOpenPermission = (item) => item.kind === "permission" && item.status !== "traité";
const isBlastwinRequest = (item) => /^blastwin-(confirm|merge)$/.test(item.action?.kind || "");
const isOpenPlan = (item) => item.kind === "plan" && item.status !== "traité";

// ---------- Fenêtre de validation accessible (focus piégé, Échap, résumé) ----------
function openDecisionDialog(item, mode) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = el("dialog", {
      class: "dialog inbox-decision-dialog",
      "aria-labelledby": "inbox-dialog-title",
      "aria-describedby": "inbox-dialog-desc",
    });

    const isAccept = mode === "accept";
    const isRefuse = mode === "refuse";
    const isDanger = isAccept && Boolean(item.action?.danger);
    const titleText = isDanger
      ? "Confirmation d’action sensible"
      : (isAccept
          ? "Valider et accepter l’action"
          : (isRefuse ? "Refuser le plan d’action" : "Passer à la suite (refuser)"));

    const blast = isBlastwinRequest(item);
    const summaryText = blast
      ? (isAccept
          ? "Vous autorisez cette étape sur BlastWin (sauvegarde, vérification et retour arrière automatiques). Un refus ne lance et ne fusionne rien."
          : "Vous refusez : rien ne sera lancé ni fusionné dans BlastWin.")
      : isAccept
      ? "Vous autorisez l’agent à exécuter l’action ci-dessous. Son travail reprendra immédiatement."
      : (isRefuse
          ? "Vous refusez ce plan d’action. Aucune tâche ne sera créée et l’élément sera marqué comme traité."
          : "Vous refusez cette demande d’action. L’agent sera notifié et la boîte passera à l’élément suivant.");

    const titleEl = el("h2", { id: "inbox-dialog-title" }, titleText);
    const descEl = el("p", { id: "inbox-dialog-desc", class: "dialog-text" }, summaryText);

    const mLabel = hostLabel(item.host);
    const pLabel = projectLabel(item.project);
    const where = [mLabel, pLabel, item.agentTitle].filter(Boolean).join(" · ") || "Session agent";

    const metaRows = [
      el("div", { class: "inbox-dialog-row" }, el("strong", {}, "Cible : "), el("span", {}, where)),
      el("div", { class: "inbox-dialog-row" }, el("strong", {}, "Demande : "), el("span", {}, item.title || "—")),
    ];
    if (item.body) {
      metaRows.push(el("div", { class: "inbox-dialog-row inbox-dialog-body-block" },
        el("strong", {}, "Détail de l’action : "),
        el("pre", { class: "inbox-dialog-pre" }, item.body)));
    }
    const metaInfo = el("div", { class: "inbox-decision-summary" }, ...metaRows);

    let understoodCheck = null;
    let okBtn;

    if (isDanger) {
      understoodCheck = el("input", { type: "checkbox", id: "inbox-danger-check" });
      const dangerBox = el("div", { class: "inbox-dialog-danger-box" },
        el("div", { class: "inbox-danger-heading" }, "Action sensible ou destructrice"),
        el("label", { class: "check inbox-dialog-check-label", for: "inbox-danger-check" },
          understoodCheck,
          el("span", {}, " J’ai vérifié les paramètres et je confirme cette action.")
        )
      );
      metaInfo.append(dangerBox);
    }

    let result = false;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      result = value;
      try { dialog.close(); } catch {}
      dialog.remove();
      previous?.focus?.();
      resolve(result);
    };

    const cancelBtn = el("button", {
      class: "btn",
      type: "button",
      onclick: () => finish(false),
    }, "Annuler");

    const okClass = isDanger
      ? "btn btn-danger"
      : (isAccept ? "btn btn-primary" : (isRefuse ? "btn btn-danger" : "btn btn-ghost"));
    const okLabel = isDanger
      ? "Approuver malgré le risque"
      : (isAccept ? "Accepter l’action" : (isRefuse ? "Refuser le plan" : "Passer à la suite"));
    okBtn = el("button", {
      class: okClass,
      type: "button",
      onclick: () => finish(true),
    }, okLabel);

    if (isDanger && understoodCheck) {
      okBtn.disabled = true;
      understoodCheck.addEventListener("change", () => {
        okBtn.disabled = !understoodCheck.checked;
      });
    }

    const foot = el("footer", { class: "dialog-foot" }, cancelBtn, okBtn);
    const body = el("div", { class: "dialog-body" }, titleEl, descEl, metaInfo);
    dialog.append(body, foot);

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    dialog.addEventListener("close", () => {
      finish(result);
    });

    // Piégeage du focus au clavier
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
        return;
      }
      if (e.key === "Tab") {
        const query = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusables = Array.from(dialog.querySelectorAll(query));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    document.body.append(dialog);
    dialog.showModal();
    cancelBtn.focus();
  });
}

// ---------- Fenêtre de validation accessible d'un plan généré ----------
function openPlanValidationDialog(item) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = el("dialog", {
      class: "dialog inbox-decision-dialog",
      "aria-labelledby": "inbox-dialog-title",
      "aria-describedby": "inbox-dialog-desc",
    });

    const tasks = Array.isArray(item.tasks) ? item.tasks : [];
    const count = tasks.length;

    const titleEl = el("h2", { id: "inbox-dialog-title" }, "Valider et créer les tâches du plan");
    const descEl = el("p", { id: "inbox-dialog-desc", class: "dialog-text" },
      `Vous allez créer ${count} tâche(s) dans le gestionnaire de tâches. ` +
      "Les dépendances indiquées seront respectées lors de l’exécution.");

    const taskRows = tasks.map((t, idx) => {
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn : (t.dependsOn ? [t.dependsOn] : []);
      const depLabels = deps.map((d) => {
        const depIdx = tasks.findIndex((x) => x.id === d || x.title === d || String(x.id) === String(d));
        if (depIdx >= 0) return `#${depIdx + 1} (${tasks[depIdx].title})`;
        return String(d);
      });
      const depText = depLabels.length > 0 ? ` (dépend de ${depLabels.join(", ")})` : "";
      const projText = t.project ? ` [${t.project}]` : "";
      const harnessText = (t.harness || t.engine) ? ` (${t.harness || t.engine})` : "";
      return el("li", { class: "inbox-decision-task-row" },
        el("strong", {}, `#${idx + 1} `),
        el("span", {}, `${t.title}${projText}${harnessText}${depText}`)
      );
    });

    const tasksList = el("ol", { class: "inbox-decision-tasks-list" }, ...taskRows);

    const metaInfo = el("div", { class: "inbox-decision-summary" },
      el("div", { class: "inbox-dialog-row" },
        el("strong", {}, "Plan : "),
        el("span", {}, item.title || "Plan d’action")),
      el("div", { class: "inbox-dialog-row" },
        el("strong", {}, "Tâches à créer : "),
        tasksList)
    );

    let result = false;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      result = value;
      try { dialog.close(); } catch {}
      dialog.remove();
      previous?.focus?.();
      resolve(result);
    };

    const cancelBtn = el("button", {
      class: "btn",
      type: "button",
      onclick: () => finish(false),
    }, "Annuler");

    const okBtn = el("button", {
      class: "btn btn-primary",
      type: "button",
      onclick: () => finish(true),
    }, `Créer ${count} tâche(s)`);

    const foot = el("footer", { class: "dialog-foot" }, cancelBtn, okBtn);
    const body = el("div", { class: "dialog-body" }, titleEl, descEl, metaInfo);
    dialog.append(body, foot);

    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    dialog.addEventListener("close", () => {
      finish(result);
    });

    // Piégeage du focus au clavier
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
        return;
      }
      if (e.key === "Tab") {
        const query = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const focusables = Array.from(dialog.querySelectorAll(query));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    document.body.append(dialog);
    dialog.showModal();
    cancelBtn.focus();
  });
}

function renderPlanTasks(item) {
  const isEditable = item.status !== "traité";
  const tasks = Array.isArray(item.tasks) ? item.tasks : [];
  if (!tasks.length) {
    return el("div", { class: "inbox-plan-container" },
      el("div", { class: "inbox-plan-head" }, "Aucune tâche dans ce plan"));
  }

  const listEl = el("ol", { class: "inbox-plan-tasks" });

  tasks.forEach((task, idx) => {
    const num = el("span", { class: "inbox-plan-task-num", "aria-hidden": "true" }, String(idx + 1));
    const titleEl = el("span", { class: "inbox-plan-task-title" }, task.title || `Tâche ${idx + 1}`);

    const metaParts = [];
    if (task.project) {
      metaParts.push(el("span", { class: "inbox-plan-task-proj" }, `Projet : ${projectLabel(task.project)}`));
    }
    const harness = task.harness || task.engine;
    if (harness) {
      metaParts.push(el("span", { class: "inbox-plan-task-harness" }, `Harnais : ${harness}`));
    }
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : (task.dependsOn ? [task.dependsOn] : []);
    if (deps.length > 0) {
      const depLabels = deps.map((d) => {
        const depIdx = tasks.findIndex((x) => x.id === d || x.title === d || String(x.id) === String(d));
        if (depIdx >= 0) return `#${depIdx + 1} (${tasks[depIdx].title})`;
        return String(d);
      });
      metaParts.push(el("span", { class: "inbox-plan-task-dep" }, `Dépend de : ${depLabels.join(", ")}`));
    }

    const info = el("div", { class: "inbox-plan-task-info" },
      titleEl,
      metaParts.length > 0 ? el("div", { class: "inbox-plan-task-meta" }, ...metaParts) : null
    );

    const taskActions = el("div", { class: "inbox-plan-task-actions" });
    if (isEditable) {
      const upBtn = el("button", {
        class: "btn btn-sm btn-ghost",
        type: "button",
        disabled: idx === 0,
        "aria-label": `Monter la tâche ${idx + 1} : ${task.title}`,
        dataset: { fk: `plan:${item.id}:up:${idx}` },
        onclick: (e) => {
          e.stopPropagation();
          if (idx > 0) {
            const nextTasks = [...tasks];
            const temp = nextTasks[idx - 1];
            nextTasks[idx - 1] = nextTasks[idx];
            nextTasks[idx] = temp;
            item.tasks = nextTasks;
            ctx.send({ type: "inbox.plan.update", id: item.id, tasks: nextTasks });
            render();
          }
        },
      }, "▲ Monter");

      const downBtn = el("button", {
        class: "btn btn-sm btn-ghost",
        type: "button",
        disabled: idx === tasks.length - 1,
        "aria-label": `Descendre la tâche ${idx + 1} : ${task.title}`,
        dataset: { fk: `plan:${item.id}:down:${idx}` },
        onclick: (e) => {
          e.stopPropagation();
          if (idx < tasks.length - 1) {
            const nextTasks = [...tasks];
            const temp = nextTasks[idx + 1];
            nextTasks[idx + 1] = nextTasks[idx];
            nextTasks[idx] = temp;
            item.tasks = nextTasks;
            ctx.send({ type: "inbox.plan.update", id: item.id, tasks: nextTasks });
            render();
          }
        },
      }, "▼ Descendre");

      const removeBtn = el("button", {
        class: "btn btn-sm btn-ghost",
        type: "button",
        "aria-label": `Retirer la tâche ${idx + 1} : ${task.title}`,
        dataset: { fk: `plan:${item.id}:remove:${idx}` },
        onclick: (e) => {
          e.stopPropagation();
          const removed = tasks[idx];
          const nextTasks = tasks.filter((_, i) => i !== idx);
          for (const t of nextTasks) {
            if (Array.isArray(t.dependsOn)) {
              t.dependsOn = t.dependsOn.filter((d) => d !== removed.id && d !== removed.title);
            }
          }
          item.tasks = nextTasks;
          ctx.send({ type: "inbox.plan.update", id: item.id, tasks: nextTasks });
          render();
        },
      }, "✕ Retirer");

      taskActions.append(upBtn, downBtn, removeBtn);
    }

    const row = el("li", {
      class: "inbox-plan-task",
      dataset: { taskId: task.id, taskIndex: String(idx) }
    }, num, info, taskActions);
    listEl.append(row);
  });

  const head = el("div", { class: "inbox-plan-head" },
    el("span", {}, `Tâches proposées (${tasks.length})`),
    isEditable && el("span", { class: "inbox-item-meta" }, "Réordonnez ou retirez des tâches avant validation")
  );

  return el("div", { class: "inbox-plan-container" }, head, listEl);
}

// ---------- Actions ----------
async function respond(item, allow) {
  if (!isOpenPermission(item) || sending.has(item.id)) return;
  const ok = await openDecisionDialog(item, allow ? "accept" : "skip");
  if (!ok) return;

  const behavior = allow ? "allow" : "deny";
  const actionId = (item.action?.actions || []).find((a) => a.behavior === behavior)?.id;
  sending.add(item.id);
  // T48 : demandes BlastWin (démarrage ou fusion) : pas de session agent derrière, la décision est celle de Philippe seul.
  if (isBlastwinRequest(item)) ctx.send({ type: "blastwin.decide", id: item.id, approve: allow });
  else ctx.send({
    type: "perm.respond", host: item.host, agentId: item.agentId, requestId: item.action?.requestId, behavior,
    ...(actionId ? { actionId } : {}),
  });

  if (!allow) {
    // Passer à la suite : sélectionne l'élément suivant pour continuer la revue
    const shown = visibleItems();
    const idx = shown.findIndex((i) => i.id === item.id);
    if (idx >= 0 && idx + 1 < shown.length) selectedId = shown[idx + 1].id;
  }

  setTimeout(() => { // sans confirmation du serveur au bout de 8 s, on rend la main
    sending.delete(item.id);
    render();
  }, 8000);
  render();
}

// Réponse à une question de direction d'un agent : un clic sur une option (ou un texte libre) ; l'agent continue ensuite.
function answerQuestion(item, question, answer) {
  const text = String(answer ?? "").trim();
  if (!text || !isOpenPermission(item) || sending.has(item.id)) return;
  sending.add(item.id);
  ctx.send({
    type: "perm.respond", host: item.host, agentId: item.agentId, requestId: item.action?.requestId, behavior: "allow",
    answers: { [question]: text },
  });
  ctx.send({ type: "inbox.mark", ids: [item.id], status: "traité" });
  setTimeout(() => { sending.delete(item.id); render(); }, 8000);
  render();
}

function questionBlock(item, busy) {
  const wrap = el("div", { class: "inbox-questions" });
  for (const q of item.action.questions) {
    // « Autre ✎ » : le champ de réponse libre n'apparaît qu'au clic.
    const free = el("input", { type: "text", class: "inbox-q-free", maxlength: "300", placeholder: "Ta réponse…", "aria-label": `Autre réponse à : ${q.question}` });
    const sendFree = () => answerQuestion(item, q.question, free.value);
    const sendBtn = el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: busy, onclick: (e) => { e.stopPropagation(); sendFree(); } }, "Envoyer");
    const freeRow = el("div", { class: "inbox-q-freerow", hidden: true }, free, sendBtn);
    free.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendFree(); } });
    const other = el("button", { class: "btn btn-sm", type: "button", disabled: busy, "aria-expanded": "false",
      onclick: (e) => { e.stopPropagation(); freeRow.hidden = !freeRow.hidden; other.setAttribute("aria-expanded", String(!freeRow.hidden)); if (!freeRow.hidden) free.focus(); } }, "✎ Autre");
    wrap.append(el("div", { class: "inbox-question" },
      el("p", { class: "inbox-q-text" }, q.question),
      el("div", { class: "inbox-q-options" },
        ...q.options.map((o) => el("button", { class: "btn btn-sm btn-primary", type: "button", disabled: busy, title: o.description || o.label,
          onclick: (e) => { e.stopPropagation(); answerQuestion(item, q.question, o.label); } }, o.label)),
        other),
      freeRow));
  }
  return wrap;
}

function openItem(item) {
  if (item.agentId) ctx.drawer.openAgent(item.host, item.agentId);
  else if (item.kind === "machine") ctx.navigate("connexions");
}

async function validatePlan(item) {
  if (!isOpenPlan(item) || sending.has(item.id)) return;
  const ok = await openPlanValidationDialog(item);
  if (!ok) return;

  sending.add(item.id);
  ctx.send({
    type: "inbox.plan.apply",
    id: item.id,
    tasks: item.tasks,
  });

  setTimeout(() => {
    sending.delete(item.id);
    render();
  }, 8000);
  render();
}

async function refusePlan(item) {
  if (!isOpenPlan(item) || sending.has(item.id)) return;
  const ok = await openDecisionDialog(item, "refuse");
  if (!ok) return;

  sending.add(item.id);
  ctx.send({
    type: "inbox.plan.refuse",
    id: item.id,
  });

  setTimeout(() => {
    sending.delete(item.id);
    render();
  }, 8000);
  render();
}

// ---------- Rendu ----------
// T34 : une demande de permission qui attend depuis plus de 2 minutes bloque un agent : on le dit clairement.
const WAIT_ALERT_MIN = 2;
function waitText(item) {
  const min = Math.floor((Date.now() - Date.parse(item.t)) / 60000);
  if (!isOpenPermission(item) || Number.isNaN(min) || min < WAIT_ALERT_MIN) return "";
  return `Un agent attend ta réponse depuis ${min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`}`;
}

function renderItem(item) {
  const kind = KINDS[item.kind] || KINDS["système"];
  const busy = sending.has(item.id);
  const selected = item.id === selectedId;
  const pillIcon = el("span", { class: "inbox-pill-icon" });
  pillIcon.innerHTML = kind.icon;
  const pill = el("span", { class: `inbox-pill pill-${kind.slug}` }, pillIcon, kind.label);

  const mLabel = hostLabel(item.host);
  const pLabel = projectLabel(item.project);
  const where = [mLabel, pLabel, item.agentTitle].filter(Boolean).join(" · ");
  const head = el("div", { class: "inbox-item-head" },
    el("div", { class: "inbox-item-tags" }, pill, el("span", { class: "inbox-item-meta" }, where)),
    el("time", { class: "inbox-item-time", datetime: item.t, dataset: { t: item.t },
      title: new Date(item.t).toLocaleString("fr-FR") }, relative(item.t)));
  const cleanTitle = (item.title || "").replace(/\bMachine\s+local\b/gi, "Machine Mini PC")
    .replace(/\bhôte\s+local\b/gi, "hôte Mini PC");
  const cleanBody = (item.body || "").replace(/\bMachine\s+local\b/gi, "Machine Mini PC")
    .replace(/\bhôte\s+local\b/gi, "hôte Mini PC");
  const content = el("div", { class: "inbox-item-content" },
    el("h3", { class: "inbox-item-title" }, cleanTitle),
    item.action?.danger && el("span", { class: "inbox-danger-badge" }, "Action signalée comme sensible"),
    isOpenPermission(item) && el("p", { class: "inbox-wait-alert", dataset: { t: item.t }, hidden: !waitText(item) }, waitText(item)),
    cleanBody && el("p", { class: "inbox-item-body" }, cleanBody));
  if (item.kind === "plan" && Array.isArray(item.tasks)) {
    content.append(renderPlanTasks(item));
  }

  const actions = el("div", { class: "inbox-item-actions" });
  const button = (key, label, onClick, cls = "", extra = {}) => el("button", {
    class: `btn btn-sm ${cls}`.trim(), type: "button", dataset: { fk: `${item.id}:${key}` }, onclick: (e) => {
      e.stopPropagation();
      onClick();
    }, ...extra,
  }, label);
  if (isOpenPermission(item) && item.action?.questions?.length) {
    // Question de direction : on répond par une option, pas par « Accepter / Passer ».
    content.append(questionBlock(item, busy));
  } else if (isOpenPermission(item)) {
    actions.append(
      button("allow", [iconEl(KINDS.fin.icon), busy ? " Envoi…" : isBlastwinRequest(item) ? " Autoriser" : " Accepter"], () => respond(item, true),
        "btn-permission-approve", { disabled: busy }),
      button("deny", [iconEl(KINDS.erreur.icon), busy ? " Envoi…" : isBlastwinRequest(item) ? " Refuser" : " Passer à la suite"], () => respond(item, false),
        "btn-permission-deny", { disabled: busy }));
  } else if (isOpenPlan(item)) {
    actions.append(
      button("allow", [iconEl(KINDS.fin.icon), busy ? " Envoi…" : " Valider le plan"], () => validatePlan(item),
        "btn-permission-approve", { disabled: busy, "data-action": "validate-plan" }),
      button("deny", [iconEl(KINDS.erreur.icon), busy ? " Envoi…" : " Refuser"], () => refusePlan(item),
        "btn-permission-deny", { disabled: busy, "data-action": "refuse-plan" }));
  }
  if (item.agentId) actions.append(button("open", "Ouvrir la session", () => openItem(item)));
  else if (item.kind === "machine") actions.append(button("open", "Voir les machines", () => openItem(item)));
  if (item.status === "nouveau") {
    actions.append(button("read", "Marquer comme lu",
      () => ctx.send({ type: "inbox.mark", ids: [item.id], status: "lu" }), "btn-ghost"));
  }
  if (item.status !== "traité") {
    if (!isOpenPlan(item)) {
      actions.append(button("done", "Marquer comme traité",
        () => ctx.send({ type: "inbox.mark", ids: [item.id], status: "traité" }), "btn-ghost"));
    }
  } else {
    const statusNote = item.action?.refused
      ? "Plan refusé · Traité"
      : (item.action?.createdTasks?.length
          ? `${item.action.createdTasks.length} tâche(s) créée(s) · Traité`
          : "Traité");
    actions.append(el("span", { class: "inbox-status-text" }, statusNote));
  }

  return el("li", {
    class: `inbox-item kind-${kind.slug} status-${STATUS_SLUG[item.status] || "lu"}${selected ? " is-selected" : ""}`,
    id: `inbox-item-${item.id}`, tabindex: selected ? "0" : "-1", dataset: { id: item.id, fk: item.id },
    "aria-current": selected ? "true" : null,
    "aria-label": `${kind.label} : ${item.title}, ${item.status}`,
    onclick: () => {
      selectedId = item.id;
      render();
    },
  }, head, content, actions);
}

function chipRow(label, list, current, onPick, countOf, prefix) {
  return el("div", { class: "inbox-filter-row" },
    el("span", { class: "inbox-filter-label" }, label),
    el("div", { class: "inbox-chips", role: "group", "aria-label": label },
      ...list.map(([id, text]) => el("button", {
        class: `inbox-chip${current === id ? " is-active" : ""}`, type: "button",
        "aria-pressed": String(current === id),
        dataset: { fk: `chip:${prefix}:${id}` }, onclick: () => onPick(id),
      }, text, el("span", { class: "inbox-chip-count" }, `(${countOf(id)})`)))));
}

function render() {
  if (!root || !ctx) return;
  const focusKey = document.activeElement?.closest?.("[data-fk]")?.dataset.fk;
  const shown = visibleItems();
  if (!shown.some((i) => i.id === selectedId)) selectedId = shown[0]?.id ?? null;
  const unread = items.filter((i) => i.status === "nouveau").length;
  setInboxUnread(unread);
  if (tabBtns.inbox) paintTabs();

  const header = el("div", { class: "inbox-header" },
    el("div", { class: "inbox-title-group" }, el("h1", { class: "inbox-title" }, "Boîte de réception"),
      unread > 0 && el("span", { class: "tab-badge", "aria-label": `${unread} nouveaux` }, String(unread))),
    el("div", { class: "inbox-header-actions" },
      el("button", {
        class: "btn btn-sm btn-primary", type: "button", dataset: { fk: "voiceplan" },
        onclick: () => openVoicePlanDialog({
          ctx,
          onCreated: (itemId) => {
            selectedId = itemId;
            filterStatus = "all";
            filterKind = "all";
            render();
          },
        }),
      }, "Dicter / Écrire un plan"),
      el("button", { class: "btn btn-sm", type: "button", disabled: unread === 0, dataset: { fk: "markAll" },
        onclick: () => ctx.send({ type: "inbox.markAll", status: "lu" }) },
      iconEl(KINDS.fin.icon), " Tout marquer comme lu"),
      el("button", { class: "btn btn-sm btn-ghost", type: "button", dataset: { fk: "clear" },
        disabled: !items.some((i) => i.status === "traité"),
        onclick: () => ctx.send({ type: "inbox.clear" }) }, "Nettoyer les traités")));

  const chevronSvg = glyph('<path d="M6 8l4 4 4-4"/>');
  const infoSvg = glyph('<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.2v.1"/>');
  const bannerIcon = el("span", { class: "inbox-banner-icon", "aria-hidden": "true" });
  bannerIcon.innerHTML = infoSvg;
  const bannerChevron = el("span", { class: "inbox-banner-chevron", "aria-hidden": "true" });
  bannerChevron.innerHTML = chevronSvg;

  const toggleBtn = el("button", {
    class: "inbox-banner-toggle",
    type: "button",
    "aria-expanded": String(bannerExpanded),
    "aria-controls": "inbox-banner-body",
    dataset: { fk: "bannerToggle" },
    onclick: () => {
      bannerExpanded = !bannerExpanded;
      setBannerExpanded(bannerExpanded);
      render();
    },
  }, bannerIcon, el("span", {}, "À quoi sert la boîte de réception ?"), bannerChevron);

  const bannerBody = el("div", {
    id: "inbox-banner-body",
    class: "inbox-banner-body",
    hidden: bannerExpanded ? null : true,
  },
  el("p", { class: "inbox-banner-text" },
    "La boîte de réception centralise toutes les notifications nécessitant votre attention : " +
    "demandes de permission, fins de travail, erreurs et alertes machines. " +
    "Les permissions bloquent le travail d’un agent jusqu’à ce que vous choisissiez d’accepter ou " +
    "de passer à la suite. Les alertes et fins de mission vous informent immédiatement de la santé du système."),
  el("div", { class: "inbox-banner-kinds-legend" },
    el("div", { class: "inbox-banner-legend-item" },
      el("span", { class: "inbox-pill pill-permission" }, iconEl(KINDS.permission.icon), " Permission"),
      el("span", { class: "inbox-banner-legend-desc" }, "Validation requise pour continuer l’action")),
    el("div", { class: "inbox-banner-legend-item" },
      el("span", { class: "inbox-pill pill-plan" }, iconEl(KINDS.plan.icon), " Plan"),
      el("span", { class: "inbox-banner-legend-desc" }, "Plan d’action généré à valider")),
    el("div", { class: "inbox-banner-legend-item" },
      el("span", { class: "inbox-pill pill-fin" }, iconEl(KINDS.fin.icon), " Fin"),
      el("span", { class: "inbox-banner-legend-desc" }, "Tâche ou session menée à terme")),
    el("div", { class: "inbox-banner-legend-item" },
      el("span", { class: "inbox-pill pill-erreur" }, iconEl(KINDS.erreur.icon), " Erreur"),
      el("span", { class: "inbox-banner-legend-desc" }, "Incident ou échec d’exécution")),
    el("div", { class: "inbox-banner-legend-item" },
      el("span", { class: "inbox-pill pill-machine" }, iconEl(KINDS.machine.icon), " Machine"),
      el("span", { class: "inbox-banner-legend-desc" }, "Alerte de liaison ou statut d’hôte"))));

  const banner = el("section", { class: "inbox-banner", "aria-label": "Présentation de la boîte" },
    el("div", { class: "inbox-banner-header" }, toggleBtn),
    bannerBody);

  const controls = el("div", { class: "inbox-controls" },
    chipRow("Statut", STATUS_FILTERS, filterStatus, (id) => { filterStatus = id; render(); },
      (id) => items.filter((i) => id === "all" || i.status === id).length, "status"),
    chipRow("Type", KIND_FILTERS, filterKind, (id) => { filterKind = id; render(); },
      (id) => items.filter((i) => id === "all" || i.kind === id).length, "kind"));

  const kbd = (key) => el("kbd", { class: "inbox-kbd" }, key);
  const help = el("div", { class: "inbox-help-bar", role: "note" },
    el("div", { class: "inbox-shortcuts-list" },
      el("span", {}, kbd("j"), " / ", kbd("k"), " Suivant / précédent"),
      el("span", {}, kbd("Entrée"), " Ouvrir la session"),
      el("span", {}, kbd("a"), " Accepter / Valider"), el("span", {}, kbd("r"), " Passer à la suite / Refuser")),
    el("span", {}, "Une fenêtre de validation résume l’action avant exécution."));

  let list;
  if (!shown.length) {
    const none = items.length === 0;
    const mark = el("div", { class: "inbox-empty-icon", "aria-hidden": "true" });
    mark.innerHTML = icons.inbox;
    list = el("div", { class: "inbox-empty" }, mark,
      el("div", { class: "inbox-empty-title" },
        none ? "Rien à traiter pour l’instant" : "Aucun élément pour ces filtres"),
      el("div", { class: "inbox-empty-desc" }, none
        ? "Les demandes de permission, les fins de travail des agents, les erreurs et les alertes de machines " +
          "apparaîtront ici dès qu’elles se produisent."
        : "Changez le statut ou le type sélectionné pour voir les autres éléments."));
  } else {
    list = el("ul", { class: "inbox-list", "aria-label": "Éléments de la boîte de réception" },
      ...shown.map(renderItem));
  }
  root.replaceChildren(el("div", { class: "inbox-view" }, header, banner, controls, help, list));
  if (focusKey) root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function refreshTimes() {
  for (const node of root?.querySelectorAll("time[data-t]") || []) node.textContent = relative(node.dataset.t);
  for (const node of root?.querySelectorAll(".inbox-wait-alert[data-t]") || []) {
    const text = waitText({ kind: "permission", status: "nouveau", t: node.dataset.t });
    node.textContent = text;
    node.hidden = !text;
  }
}

function onKeydown(event) {
  if (!root?.offsetParent) return; // onglet Idées ou Journal affiché : j/k/a/r ne concernent pas la boîte
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
  if (document.querySelector("dialog[open]") || event.target.closest?.("input, textarea, select, .xterm")) return;
  const shown = visibleItems();
  const index = shown.findIndex((i) => i.id === selectedId);
  const current = shown[index];
  const move = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[event.key];
  if (move) {
    if (!shown.length) return;
    event.preventDefault();
    selectedId = shown[Math.min(shown.length - 1, Math.max(0, index + move))].id;
    render();
    root.querySelector(".inbox-item.is-selected")?.scrollIntoView({ block: "nearest" });
    root.querySelector(".inbox-item.is-selected")?.focus({ preventScroll: true });
  } else if (current && (event.key === "a" || event.key === "r")) {
    if (isOpenPermission(current)) {
      event.preventDefault();
      respond(current, event.key === "a");
    } else if (isOpenPlan(current)) {
      event.preventDefault();
      if (event.key === "a") validatePlan(current);
      else if (event.key === "r") refusePlan(current);
    }
  } else if (current && event.key === "Enter" && !event.target.closest("button")) {
    event.preventDefault();
    openItem(current);
  }
}

function setItems(message) {
  if (!Array.isArray(message?.items)) return;
  const known = new Set(items.map((i) => i.id));
  items = message.items;
  // Une nouvelle permission ou un nouveau plan à traiter prend la sélection (pour que a / r agissent dessus aussitôt).
  const fresh = known.size ? items.find((i) => !known.has(i.id) && (isOpenPermission(i) || isOpenPlan(i))) : null;
  if (fresh) selectedId = fresh.id;
  for (const id of [...sending]) {
    const item = items.find((i) => i.id === id);
    if (!item || item.status === "traité") sending.delete(id);
  }
  render();
}

// ---------- Onglets de la page Réception : À traiter (boîte) · Idées et autonomie (ex-Cockpit) · Journal ----------
const TABS = [["inbox", "À traiter"], ["ideas", "Idées et autonomie"], ["journal", "Journal"]];
const FROM = { cockpit: "ideas", journal: "journal" }; // anciennes ancres #cockpit et #journal (posées par main.js dans history.state)
let tabBtns = {}; let panes = {}; let activeTab = "inbox"; let pendingIdeas = 0; let paneOffs = {};

function showTab(id) {
  activeTab = id;
  try { sessionStorage.setItem("paseo-reception-tab", id); } catch { /* stockage indisponible */ }
  for (const [tab] of TABS) {
    const on = tab === id;
    tabBtns[tab].setAttribute("aria-selected", String(on));
    tabBtns[tab].tabIndex = on ? 0 : -1;
    panes[tab].hidden = !on;
    if (on && !paneOffs[tab] && tab !== "inbox") paneOffs[tab] = (tab === "ideas" ? mountCockpit : mountJournal)(panes[tab], ctx);
  }
  if (id === "inbox") render();
}

function paintTabs() {
  const unread = items.filter((i) => i.status === "nouveau").length;
  tabBtns.inbox.replaceChildren(...["À traiter", unread ? el("span", { class: "tab-badge" }, String(unread)) : null].filter(Boolean));
  tabBtns.ideas.replaceChildren(...["Idées et autonomie", pendingIdeas ? el("span", { class: "tab-badge" }, String(pendingIdeas)) : null].filter(Boolean));
}

const view = {
  id: "reception",
  title: "Boîte de réception",
  short: "Réception",
  icon: icons.inbox,
  order: 60,
  rail: "none",
  mount(container, context) {
    ctx = context;
    selectedId = null;
    paneOffs = {};
    pendingIdeas = 0;
    panes = { inbox: el("div", { class: "reception-pane" }), ideas: el("div", { class: "reception-pane", hidden: true }),
      journal: el("div", { class: "reception-pane", hidden: true }) };
    root = panes.inbox;
    tabBtns = {};
    const bar = el("div", { class: "reception-tabs", role: "tablist", "aria-label": "Sections de la réception" },
      ...TABS.map(([id, label]) => (tabBtns[id] = el("button", { class: "reception-tab", type: "button", role: "tab", id: `rtab-${id}`,
        "aria-controls": `rpane-${id}`, onclick: () => showTab(id),
        onkeydown: (e) => {
          const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (!k) return;
          e.preventDefault();
          const next = TABS[(TABS.findIndex(([t]) => t === id) + k + TABS.length) % TABS.length][0];
          showTab(next); tabBtns[next].focus();
        } }, label))));
    for (const [id] of TABS) { panes[id].id = `rpane-${id}`; panes[id].setAttribute("role", "tabpanel"); panes[id].setAttribute("aria-labelledby", `rtab-${id}`); }
    container.replaceChildren(el("div", { class: "reception" }, bar, panes.inbox, panes.ideas, panes.journal));
    unsubs = [ctx.on("inbox.list", setItems), ctx.on("inbox.changed", setItems), ctx.onConnection((up) => {
      if (up) { ctx.send({ type: "inbox.list" }); ctx.send({ type: "idea.list" }); }
    }),
    // Le nombre d'idées à valider reste juste sur l'onglet même quand le Cockpit n'est pas affiché.
    ctx.on("idea.list", (m) => { pendingIdeas = (m.ideas || []).filter((i) => i.status === "pending").length; paintTabs(); }),
    ctx.on("idea.changed", () => ctx.send({ type: "idea.list" }))];
    window.addEventListener("keydown", onKeydown);
    timer = setInterval(refreshTimes, 15000);
    let first = "inbox";
    try { first = sessionStorage.getItem("paseo-reception-tab") || "inbox"; } catch { /* stockage indisponible */ }
    first = FROM[history.state?.from] || (TABS.some(([t]) => t === first) ? first : "inbox");
    paintTabs();
    showTab(first);
    ctx.send({ type: "idea.list" });
  },
  unmount() {
    window.removeEventListener("keydown", onKeydown);
    clearInterval(timer);
    timer = null;
    unsubs.forEach((fn) => fn());
    unsubs = [];
    Object.values(paneOffs).forEach((off) => off?.());
    paneOffs = {};
    root = ctx = null;
  },
};

registerView(view);
export default view;
