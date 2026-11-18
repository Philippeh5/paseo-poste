// Section « Machines » de la page Connexions (ex-vue Machines) : une carte par machine (état, version du daemon,
// agents par statut, terminaux, retrait) puis « Ajouter une machine » (commandes join-machine + formulaire host.add).
// Textes via el() : aucun innerHTML dynamique. Données : state.hosts (core/state.js), messages host.add / host.remove.
import { el, icons, iconEl, agentStatus, hostStatus, led } from "../core/util.js";
import { send } from "../core/socket.js";
import { getState, subscribe } from "../core/state.js";
import { confirmDialog } from "../core/confirm.js";
import { toast } from "../core/toast.js";
import { hostLabel } from "../core/names.js";

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Commande copiée"); } catch { toast(text); }
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

function card(host) {
  const hs = hostStatus(host.status);
  const mLabel = hostLabel(host);
  return el("article", { class: "machine-card", id: `machine-${host.label}`, "data-tone": hs.tone },
    el("header", { class: "machine-head" },
      led(hs.tone, { pulse: hs.tone === "attention", label: hs.label }),
      el("h3", {}, mLabel),
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
    el("h4", { class: "label-caps" }, "Agents par statut"),
    statusCounts(host),
  );
}

const TAILSCALE = "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up";
const JOIN = "curl -fsSL https://raw.githubusercontent.com/Philippeh5/paseo-poste/main/deploy/join-machine.sh -o join-machine.sh && less join-machine.sh && bash join-machine.sh --label ma-machine";

function addHostForm() {
  const name = el("input", { name: "label", required: true, autocomplete: "off", placeholder: "oracle-2" });
  const url = el("input", { name: "url", required: true, class: "mono", placeholder: "ws://hôte:6767/ws",
    value: "ws://127.0.0.1:6767/ws", autocomplete: "off" });
  const password = el("input", { name: "password", type: "password", autocomplete: "new-password" });
  const step = (title, text, button) => el("div", { class: "pilot-row", style: "grid-template-columns:1fr auto" },
    el("div", { class: "pilot-main" }, el("strong", {}, title), el("span", { class: "pilot-detail" }, text)), button);
  const form = el("form", { class: "add-host" },
    el("h3", {}, "3. Brancher au poste"),
    el("p", { class: "pilot-help" }, "Saisir le nom, l’adresse Tailscale (ws://100.x.y.z:6767/ws) et le mot de passe affichés par le script."),
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
  return el("section", { class: "pilot-group", id: "ajouter-machine" },
    el("header", { class: "pilot-group-head" }, el("h2", {}, "Ajouter une machine")),
    step("1. Réseau privé", "Sur la nouvelle machine : installer Tailscale et se connecter au même compte.",
      el("button", { class: "btn btn-sm", type: "button", onclick: () => copy(TAILSCALE) }, "Copier la commande")),
    step("2. Démon Paseo", "Sur la nouvelle machine : télécharge le script (à relire avant de l’exécuter) ; il installe le démon, le fait écouter sur l’adresse Tailscale seulement, demande un mot de passe, le démarre et affiche quoi saisir ci-dessous.",
      el("button", { class: "btn btn-sm", type: "button", onclick: () => copy(JOIN) }, "Copier la commande")),
    form);
}

// Monte la section dans `container` ; renvoie la fonction de nettoyage. Le formulaire n'est pas redessiné
// quand l'état change (la saisie en cours serait perdue) : seules les cartes le sont.
export function mountMachines(container) {
  const grid = el("div", { class: "machine-grid" });
  const root = el("section", { class: "pilot-group machines-section", "aria-label": "Machines" },
    el("header", { class: "pilot-group-head" }, el("h2", {}, "Machines")), grid);
  container.replaceChildren(root, addHostForm());
  let signature = "";
  const paint = (state) => {
    const sig = JSON.stringify(state.hosts);
    if (sig === signature) return;
    signature = sig;
    const cards = state.hosts.map(card);
    grid.replaceChildren(...(cards.length ? cards : [el("p", { class: "muted" }, "Aucune machine configurée.")]));
  };
  paint(getState());
  return subscribe(paint);
}
