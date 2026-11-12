// Messages brefs, annoncés aux lecteurs d'écran (zone aria-live).
import { el } from "./util.js";

let region;
export function toast(message, { kind = "info", ms = 5000 } = {}) {
  region ||= document.getElementById("toasts");
  if (!region) return;
  const item = el("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  region.append(item);
  while (region.children.length > 4) region.firstElementChild.remove();
  setTimeout(() => item.remove(), ms);
}
