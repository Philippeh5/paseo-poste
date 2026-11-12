// Machine du tableau de bord : l'étiquette de l'hôte dont le daemon tourne sur la MÊME machine que le dashboard.
// Par défaut « local » (dashboard sur le Mini PC). Sur Oracle, DASHBOARD_SELF_HOST=oracle : les règles « ne marche que sur la machine
// du poste » (orchestrateur, FreeBuff, rapports, fichiers locaux) visent alors Oracle, et plus l'étiquette « local » (= Mini PC, distant).
export const SELF_HOST = (process.env.DASHBOARD_SELF_HOST || "").trim() || "local";
export const isSelfHost = (host) => host === SELF_HOST;
export const SELF_LABEL = SELF_HOST === "oracle" ? "Oracle" : SELF_HOST === "local" ? "Mini PC" : SELF_HOST;
