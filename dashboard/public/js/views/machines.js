import { registerView } from "./registry.js";
import { el, icons, iconEl, agentStatus, hostStatus, led } from "../core/util.js";
import { send } from "../core/socket.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import { hostLabel } from "../core/names.js";

let root = null;
let ctx = null;
let cleanups = [];
let signature = "";
let grid = null;

function quotaBar(label, used) {
  const pct = Math.max(0, Math.min(100, Number(used) || 0));
  const tone = pct >= 95 ? "danger" : pct >= 80 ? "attention" : "ok";
  return el("div", { class: "quota" },
    el("div", { class: "quota-head" }, el("span", {}, label), el("span", { class: "num" }, `${Math.round(pct)} %`)),
    el("div", { class: `meter meter-${tone}`, role: "progressbar", "aria-valuenow": Math.round(pct),
      "aria-valuemin": "0",
      "aria-valuemax": "100", "aria-label": `${label} : ${Math.round(pct)} % utilisé` },
      el("i", { style: `width:${pct}%` })),
  );
}

function quotas(usage) {
  const providers = usage?.providers || [];
  if (!providers.length) return el("p", { class: "muted" }, usage?.reason || "Quotas indisponibles.");
  return el("div", { class: "quotas" }, providers.map((p) => {
    const name = p.displayName || p.providerId;
    const windows = p.windows || [];
    return el("div", { class: "quota-provider" },
      el("h4", {}, name),
      windows.length
        ? windows.map((w) => quotaBar(w.label || w.shortLabel || "Quota", w.usedPct))
        : el("p", { class: "muted" }, p.error || p.status || "Indisponible"),
    );
  }));
}

function statusCounts(host) {
  const entries = Object.entries(host.agentCounts || {});
  if (!entries.length) return el("p", { class: "muted" }, "Aucun agent.");
  return el("ul", { class: "chips" }, entries.map(([status, count]) =>
    el("li", { class: "chip" }, led(agentStatus(status).tone, { label: agentStatus(status).label }),
      ` ${agentStatus(status).label} `, el("strong", { class: "num" }, count))));
}

async function removeHost(label) {
  const mLabel = hostLabel(label);
  const ok = await confirmDialog({
    title: `Retirer la machine « ${mLabel} » ?`,
    message: "La machine disparaît du poste de commande et sa configuration est supprimée. " +
      "Ses agents et ses terminaux continuent de tourner sur la machine.",
    confirmLabel: "Retirer la machine",
    danger: true,
  });
  if (ok) send({ type: "host.remove", label });
}

function removeButton(label) {
  const mLabel = hostLabel(label);
  const button = el("button", { class: "icon-btn", type: "button", "aria-label": `Retirer la machine ${mLabel}`,
    title: "Retirer cette machine", onclick: () => removeHost(label) });
  button.innerHTML = icons.trash;
  return button;
}

function card(host, usage) {
  const hs = hostStatus(host.status);
  const mLabel = hostLabel(host);
  const transfer = host.label === "local"
    ? el("span", { title: "Bientôt" }, el("button", { class: "btn btn-sm", type: "button", disabled: true },
      "Transférer vers Oracle"))
    : null;
  return el("article", { class: "machine-card", "data-tone": hs.tone },
    el("header", { class: "machine-head" },
      led(hs.tone, { pulse: hs.tone === "attention", label: hs.label }),
      el("h2", {}, mLabel),
      el("span", { class: "machine-state" }, hs.label),
      removeButton(host.label),
    ),
    el("p", { class: "mono muted wrap" }, host.url),
    host.reason && el("p", { class: "machine-reason" }, host.reason),
    el("dl", { class: "facts" },
      el("div", {}, el("dt", {}, "Système"),
        el("dd", {}, [host.hostname, host.os].filter(Boolean).join(" · ") || "—")),
      el("div", {}, el("dt", {}, "Daemon"), el("dd", { class: "mono" }, host.version || "—")),
      el("div", {}, el("dt", {}, "Agents"), el("dd", { class: "num" }, host.agents ?? 0)),
      el("div", {}, el("dt", {}, "Terminaux"), el("dd", { class: "num" }, host.terminals ?? 0)),
    ),
    el("h3", { class: "label-caps" }, "Agents par statut"),
    statusCounts(host),
    el("h3", { class: "label-caps" }, "Quotas par fournisseur"),
    quotas(usage),
    transfer && el("footer", { class: "machine-foot" }, transfer),
  );
}

function addHostForm() {
  const name = el("input", { name: "label", required: true, autocomplete: "off", placeholder: "oracle-2" });
  const url = el("input", { name: "url", required: true, class: "mono", placeholder: "ws://hôte:6767/ws",
    value: "ws://127.0.0.1:6767/ws", autocomplete: "off" });
  const password = el("input", { name: "password", type: "password", autocomplete: "new-password" });
  const form = el("form", { class: "add-host" },
    el("h2", {}, "Ajouter une machine"),
    el("div", { class: "add-host-fields" },
      el("label", { class: "field" }, "Nom", name),
      el("label", { class: "field" }, "Adresse du daemon", url),
      el("label", { class: "field" }, "Mot de passe (facultatif)", password),
    ),
    el("button", { class: "btn btn-primary", type: "submit" }, iconEl(icons.plus), " Ajouter"),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!/^wss?:\/\//i.test(url.value.trim())) {
      toast("L’adresse doit commencer par ws:// ou wss://.", { kind: "error" });
      return;
    }
    send({ type: "host.add", label: name.value.trim(), url: url.value.trim(), password: password.value });
    form.reset();
    url.value = "ws://127.0.0.1:6767/ws";
  });
  return form;
}

function render() {
  if (!root) return;
  const state = ctx.state;
  const sig = JSON.stringify([state.hosts, state.usage]);
  if (sig === signature) return;
  signature = sig;
  const cards = state.hosts.map((host) => card(host, state.usage?.[host.label]));
  grid.replaceChildren(...(cards.length ? cards : [el("p", { class: "muted" }, "Aucune machine configurée.")]));
}

const view = {
  id: "machines",
  title: "Machines",
  short: "Machines",
  icon: icons.machines,
  order: 50,
  mount(container, context) {
    ctx = context;
    signature = "";
    grid = el("div", { class: "machine-grid" });
    root = el("div", { class: "view-page" },
      el("div", { class: "view-toolbar" }, el("h1", { class: "view-title" }, "Machines")), grid, addHostForm());
    container.replaceChildren(root);
    cleanups = [ctx.onState(render)];
    render();
  },
  unmount() {
    cleanups.forEach((fn) => fn());
    cleanups = [];
    root = null;
  },
};

registerView(view);
export default view;
