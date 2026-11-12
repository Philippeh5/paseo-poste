import { send, on, onConnection } from "./socket.js";
import { el, icons, iconEl, agentStatus } from "./util.js";
import { confirmDialog } from "./confirm.js";
import { getState, findAgent } from "./state.js";

const feeds = new Map();
const keyOf = (host, agentId) => `${host}\u0000${agentId}`;

function entryKey(entry) {
  const item = entry?.item || entry?.event?.item;
  if (entry?.seqStart != null) return `s${entry.seqStart}`;
  return item?.callId ? `c${item.callId}` : null;
}
function upsert(feed, entry) {
  const key = entryKey(entry);
  const index = key ? feed.entries.findIndex((e) => entryKey(e) === key) : -1;
  if (index >= 0) feed.entries[index] = entry;
  else feed.entries.push(entry);
}
function notify(feed) {
  for (const fn of feed.listeners) fn(feed.entries);
}

on("agent.history", (msg) => {
  const feed = feeds.get(keyOf(msg.host, msg.agentId));
  if (!feed) return;
  feed.entries = [];
  for (const entry of msg.items || []) upsert(feed, entry);
  notify(feed);
});
on("agent.event", (msg) => {
  const feed = feeds.get(keyOf(msg.host, msg.agentId));
  if (!feed) return;
  upsert(feed, msg.event);
  notify(feed);
});
function startWatching(feed) {
  feed.watching = send({ type: "agent.watch", host: feed.host, agentId: feed.agentId });
}
// Nouvelle connexion = nouvel abonnement côté serveur (l'historique est renvoyé).
onConnection((connected) => {
  for (const feed of feeds.values()) {
    if (!connected) feed.watching = false;
    else if (!feed.watching) startWatching(feed);
  }
});

// Renvoie une fonction de désabonnement. fn(entries) reçoit la liste complète à chaque changement.
export function watchAgent(host, agentId, fn) {
  const key = keyOf(host, agentId);
  let feed = feeds.get(key);
  if (!feed) {
    feed = { host, agentId, entries: [], listeners: new Set(), watching: false };
    feeds.set(key, feed);
    startWatching(feed);
  }
  feed.listeners.add(fn);
  fn(feed.entries);
  return () => {
    feed.listeners.delete(fn);
    if (feed.listeners.size === 0) {
      feeds.delete(key);
      send({ type: "agent.unwatch", host, agentId });
    }
  };
}

const isReasoning = (type) =>
  type === "reasoning" || type === "thought" || type === "thinking";

export function getShowReasoningPref() {
  try {
    return window.localStorage?.getItem("paseo:show-reasoning") === "true";
  } catch {
    return false;
  }
}

export function setShowReasoningPref(value) {
  try {
    window.localStorage?.setItem("paseo:show-reasoning", value ? "true" : "false");
  } catch {}
}

// Le daemon diffuse le texte de l'agent par fragments : on recolle les messages d'agent consécutifs.
const itemOf = (entry) => entry?.item || entry?.event?.item;
export function coalesce(entries) {
  const out = [];
  for (const entry of entries) {
    const item = itemOf(entry);
    const last = out[out.length - 1];
    const lastItem = itemOf(last);
    if (item?.type === "assistant_message" && lastItem?.type === "assistant_message") {
      out[out.length - 1] = { item: { ...lastItem, text: `${lastItem.text || ""}${item.text || ""}` } };
    } else if (isReasoning(item?.type) && isReasoning(lastItem?.type)) {
      out[out.length - 1] = {
        item: { ...lastItem, type: "reasoning", text: `${lastItem.text || ""}${item.text || ""}` },
      };
    } else {
      out.push(entry);
    }
  }
  return out;
}

function summarize(item) {
  const detail = item.detail || {};
  const input = detail.input || {};
  return input.command || detail.command || input.description || input.file_path || input.path || "";
}

export function renderEntry(entry, options = {}) {
  const item = entry?.item || entry?.event?.item;
  if (!item) {
    const type = entry?.event?.type || entry?.type;
    if (!type || isReasoning(type)) return null;
    return el("article", { class: "thread-marker" }, type.replace(/_/g, " "));
  }
  const type = item.type || "";
  if (isReasoning(type)) {
    const raw = item.text || item.message || "";
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const cleanFirst = (lines[0] || "").replace(/^(reasoning|thought|thinking)[:\s-]*/i, "");
    const preview = cleanFirst ? ` — ${cleanFirst.slice(0, 60)}${cleanFirst.length > 60 ? "…" : ""}` : "";
    const summary = el("summary", { class: "thread-reasoning-summary" },
      el("span", { class: "thread-reasoning-title" }, "Réflexion"),
      preview && el("span", { class: "thread-reasoning-preview" }, preview),
    );
    const body = el("div", { class: "thread-reasoning-body" },
      el("pre", { class: "thread-reasoning-text" }, raw),
    );
    const details = el("details", { class: "thread-item thread-reasoning" }, summary, body);
    if (options.showReasoning) details.open = true;
    return details;
  }
  if (type === "tool_call") {
    const name = item.name || "outil";
    const line = summarize(item);
    const failed = item.status === "failed" || item.error;
    const label = `Outil: ${name}${line ? ` — ${line}` : ""}`;
    const summary = el("summary", { class: "thread-tool-summary" },
      el("span", { class: "thread-tool-label" }, label),
      item.status && el("small", { class: "thread-tool-status" }, item.status),
    );
    const extra = item.detail?.command || item.detail?.output || item.error || "";
    const details = el("details", { class: `thread-item thread-tool${failed ? " is-failed" : ""}` },
      summary,
      extra && el("div", { class: "thread-tool-body" }, el("pre", {}, String(extra).slice(0, 4000))),
    );
    return details;
  }
  if (type === "assistant_message") {
    const agent = options.agent;
    const model = agent?.model || (agent?.provider ? agent.provider.split("/").pop() : "");
    const badge = model ? el("span", { class: "thread-model-badge" }, model) : null;
    const agentName = agent?.title && !agent.title.startsWith("Agent ") ? ` · ${agent.title}` : "";
    const header = el("header", { class: "thread-msg-header" },
      el("strong", { class: "who who-agent" }, "Agent"),
      agentName && el("span", { class: "thread-agent-name" }, agentName),
      badge,
    );
    const text = item.text || item.message || "";
    return el("article", { class: "thread-item thread-assistant_message" }, header, el("p", {}, text));
  }
  if (type === "user_message") {
    const header = el("header", { class: "thread-msg-header" },
      el("strong", { class: "who who-user" }, "Vous"),
    );
    const text = item.text || item.message || "";
    return el("article", { class: "thread-item thread-user_message" }, header, el("p", {}, text));
  }
  const text = item.text || item.message || item.name || type;
  const who = type.replace(/_/g, " ");
  return el("article", { class: `thread-item thread-${type}` }, el("small", { class: "who" }, who), el("p", {}, text));
}

function renderPermissions(container, agent) {
  container.replaceChildren(...(agent?.pending || []).map((p) => {
    const actions = p.actions?.length
      ? p.actions
      : [{ id: "", label: "Approuver", behavior: "allow" }, { id: "", label: "Refuser", behavior: "deny" }];
    return el("div", { class: "perm", role: "group", "aria-label": "Permission demandée" },
      el("strong", {}, p.title),
      el("div", { class: "perm-actions" }, actions.map((a) => el("button", {
        class: `btn btn-sm ${a.behavior === "allow" ? "btn-primary" : ""}`,
        type: "button",
        onclick: () => send({
          type: "perm.respond", host: agent.host, agentId: agent.agentId,
          requestId: p.id, behavior: a.behavior, actionId: a.id || undefined,
        }),
      }, a.label))),
    );
  }));
}

// Panneau complet : permissions, fil, zone d'envoi, arrêt. Renvoie { update(agent), destroy() }.
export function mountAgentPanel(container, { host, agentId }) {
  const perms = el("div", { class: "agent-perms" });
  const checkbox = el("input", {
    type: "checkbox",
    id: `show-reasoning-${agentId}`,
    checked: getShowReasoningPref(),
  });
  const toggleLabel = el("label", {
    class: "agent-toggle-reasoning",
    for: `show-reasoning-${agentId}`,
  }, checkbox, " Afficher la réflexion");
  const toolbar = el("div", { class: "agent-panel-toolbar" }, toggleLabel);
  const thread = el("div", { class: "thread", tabindex: "0", role: "log", "aria-label": "Fil de l’agent" });
  const input = el("textarea", { name: "text", rows: "2", placeholder: "Envoyer un message à l’agent…" });
  const stop = el("button", { class: "btn btn-sm btn-danger-ghost", type: "button" }, iconEl(icons.stop), " Arrêter");
  const form = el("form", { class: "agent-send" }, input,
    el("div", { class: "agent-send-actions" },
      stop,
      el("button", { class: "btn btn-primary btn-sm", type: "submit" }, "Envoyer", " ", el("span", {}, "↵")),
    ),
  );
  let agent = null;
  let frame = 0;
  let lastEntries = [];
  const render = (entries) => {
    lastEntries = entries;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const showReasoning = checkbox.checked;
      const pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
      const currentAgent = agent || findAgent(getState(), host, agentId);
      const opts = { agent: currentAgent, showReasoning };
      const nodes = coalesce(entries).map((e) => renderEntry(e, opts)).filter(Boolean);
      const empty = el("p", { class: "thread-empty" }, "Aucune activité pour l’instant.");
      thread.replaceChildren(...(nodes.length ? nodes : [empty]));
      if (pinned) thread.scrollTop = thread.scrollHeight;
    });
  };
  checkbox.addEventListener("change", () => {
    setShowReasoningPref(checkbox.checked);
    for (const d of thread.querySelectorAll("details.thread-reasoning")) {
      d.open = checkbox.checked;
    }
    window.dispatchEvent(new CustomEvent("paseo:show-reasoning", { detail: checkbox.checked }));
  });
  const onSync = (ev) => {
    if (checkbox.checked !== ev.detail) {
      checkbox.checked = ev.detail;
      for (const d of thread.querySelectorAll("details.thread-reasoning")) {
        d.open = ev.detail;
      }
    }
  };
  window.addEventListener("paseo:show-reasoning", onSync);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send({ type: "agent.send", host, agentId, text });
    input.value = "";
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  stop.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Arrêter l’agent ?",
      message: "L’agent interrompt son tour en cours. Vous pourrez lui envoyer un nouveau message ensuite.",
      confirmLabel: "Arrêter l’agent",
      danger: true,
    });
    if (ok) send({ type: "agent.stop", host, agentId });
  });
  container.replaceChildren(perms, toolbar, thread, form);
  const unwatch = watchAgent(host, agentId, render);
  return {
    update(next) {
      agent = next;
      renderPermissions(perms, agent);
      const closed = !agent || agentStatus(agent.status).tone === "inactif";
      stop.disabled = closed;
      if (lastEntries.length) render(lastEntries);
    },
    destroy() {
      cancelAnimationFrame(frame);
      window.removeEventListener("paseo:show-reasoning", onSync);
      unwatch();
    },
  };
}
