// Confirmation et saisie de texte intégrées à la page (jamais alert/confirm/prompt).
import { el } from "./util.js";

function run(build) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = el("dialog", { class: "dialog dialog-small" });
    let result = null;
    const finish = (value) => {
      result = value;
      dialog.close();
    };
    build(dialog, finish);
    dialog.addEventListener("close", () => {
      dialog.remove();
      previous?.focus?.();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// confirmDialog({ title, message, confirmLabel, danger, twoStep }) -> Promise<boolean>
// twoStep : la confirmation exige de cocher « J’ai compris » (actions irréversibles).
export function confirmDialog({ title, message, confirmLabel = "Confirmer", danger = false, twoStep = false }) {
  return run((dialog, finish) => {
    const ok = el("button", { class: danger ? "btn btn-danger" : "btn btn-primary", type: "button" }, confirmLabel);
    const understood = el("input", { type: "checkbox" });
    ok.disabled = twoStep;
    understood.addEventListener("change", () => {
      ok.disabled = !understood.checked;
    });
    ok.addEventListener("click", () => finish(true));
    dialog.append(
      el("div", { class: "dialog-body" },
        el("h2", {}, title),
        el("p", { class: "dialog-text" }, message),
        twoStep && el("label", { class: "check" }, understood, " J’ai compris, cette action est irréversible."),
      ),
      el("footer", { class: "dialog-foot" },
        el("button", { class: "btn", type: "button", onclick: () => finish(false) }, "Annuler"),
        ok,
      ),
    );
  }).then((value) => value === true);
}

// promptDialog({ title, label, value, confirmLabel, maxLength }) -> Promise<string|null>
export function promptDialog({ title, label, value = "", confirmLabel = "Valider", maxLength = 60 }) {
  return run((dialog, finish) => {
    const input = el("input", { type: "text", maxlength: maxLength, value, autocomplete: "off", required: true });
    const form = el("form", { class: "dialog-body", method: "dialog" },
      el("h2", {}, title),
      el("label", { class: "field" }, label, input),
      el("div", { class: "dialog-foot" },
        el("button", { class: "btn", type: "button", onclick: () => finish(null) }, "Annuler"),
        el("button", { class: "btn btn-primary", type: "submit" }, confirmLabel),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (text) finish(text);
      else input.focus();
    });
    dialog.append(form);
    setTimeout(() => input.select(), 0);
  });
}
