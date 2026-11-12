// Seul le poste réel (données dans ~/paseo-dash-data) a le droit de parler au vrai Telegram. Une instance de test ou d'un
// worktree d'agent (autre DASHBOARD_DATA_DIR, ou dossier par défaut) ne doit jamais envoyer avec le jeton de Philippe.
// TELEGRAM_REAL_SEND=1 force l'envoi (à n'utiliser que volontairement).
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function isRealInstance(env = process.env, home = homedir()) {
  if (env.TELEGRAM_REAL_SEND === "1") return true;
  const dir = env.DASHBOARD_DATA_DIR;
  return Boolean(dir) && resolve(dir) === resolve(join(home, "paseo-dash-data"));
}
