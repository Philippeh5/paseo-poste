// Secret partagé entre le poste et le plugin Telegram de Hermes : seul lui permet de VALIDER une idée ou de REPRENDRE après un arrêt
// d'urgence par l'API locale. Fichier <données>/decide-secret.txt (600), protégé par lib/guardrails.mjs : un agent autonome ne peut pas le lire,
// donc ne peut pas s'auto-valider en imitant Telegram.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export function ensureSecret(dataDir) {
  const f = join(dataDir, "decide-secret.txt");
  if (!existsSync(f)) { writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600 }); try { chmodSync(f, 0o600); } catch {} }
  return readFileSync(f, "utf8").trim();
}
export function secretMatches(dataDir, provided) {
  const real = Buffer.from(ensureSecret(dataDir)), got = Buffer.from(String(provided ?? ""));
  return real.length === got.length && timingSafeEqual(real, got);
}
