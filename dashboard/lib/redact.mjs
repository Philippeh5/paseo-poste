// Aucun secret dans les journaux : jetons connus, en-têtes d'authentification et longues chaînes opaques masqués.
// Partagé par handlers/agentapi.mjs (journal d'audit), handlers/permpolicy.mjs et lib/permpolicy.mjs (T34), et par la
// fiche projet (T37, lib/projectbrief.mjs). À appeler AVANT toute troncature : un secret coupé en deux n'est plus
// reconnaissable.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_WORDS = "token|pass|passwd|password|passphrase|pwd|secret|key|apikey|credential|credentials|cl[eé]|jeton|mdp";
// NOM_TOKEN=valeur, DB_PASS: valeur, SECRET_KEY_BASE=…, "password": "valeur" (insensible à la casse, noms composés)
const SECRET_NAME = new RegExp(
  `\\b((?:[A-Za-z0-9]+[_.-])*(?:${SECRET_WORDS})(?:[_.-][A-Za-z0-9]+)*)(["']?\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|\\S+)`,
  "gi",
);
// noms en camelCase : accessToken=…, clientSecret: …
const SECRET_CAMEL = /\b([a-z0-9]*(?:Token|Secret|Password|Passwd|Key|Credential)s?(?:[_.-][A-Za-z0-9]+)*)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/g;
const BASE64_LONG = /(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g;

export const redact = (text) => String(text)
  // blocs de clé PEM entiers (multi-ligne), même sans ligne END
  .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, "[bloc de clé masqué]")
  .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*$/, "[bloc de clé masqué]")
  // adresses de webhook (le chemin EST le secret)
  .replace(/https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[^\s"'<>)]+/gi, "[webhook masqué]")
  .replace(/https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/[^\s"'<>)]+/gi, "[webhook masqué]")
  .replace(/https?:\/\/[\w.-]+\.webhook\.office\.com\/[^\s"'<>)]+/gi, "[webhook masqué]")
  // « Authorization: Bearer <jeton> » : on garde le schéma, on masque le jeton
  .replace(/\b(authorization\s*[:=]\s*["']?)(Bearer|Basic|Token|Digest|Negotiate)\s+[^\s"']+/gi, "$1$2 [masqué]")
  .replace(SECRET_NAME, "$1$2[masqué]")
  .replace(SECRET_CAMEL, "$1$2[masqué]")
  .replace(/(authorization|password|passwd|token|secret|api[-_]?key)\s*[:=]\s*(?!(?:Bearer|Basic|Token|Digest|Negotiate) \[masqué\])\S+/gi, "$1=[masqué]")
  .replace(/(mot\s+de\s+passe|password|passwd|mdp|pwd|passphrase|jeton)\s*(?:est|is|:|=)?\s*\S+/gi, "$1 [masqué]")
  .replace(/:\/\/[^\s/:@]+:[^\s/@]+@/g, "://[masqué]@")
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [masqué]")
  .replace(/\b(sk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{10,}/g, "[masqué]")
  .replace(/\b(?:sk|pk|key|api|AKIA)[-_][A-Za-z0-9_-]{8,}/gi, "[masqué]")
  .replace(/\bAKIA[0-9A-Z]{12,}\b/g, "[masqué]")
  .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, "[masqué]")
  .replace(/\bxox[a-z]-[A-Za-z0-9-]{8,}/gi, "[masqué]")
  .replace(/\b(?:glpat|AIza)[-_]?[A-Za-z0-9_-]{16,}/g, "[masqué]")
  .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[masqué]")
  .replace(BASE64_LONG, "[masqué]")
  .replace(/[A-Za-z0-9+_=-]{32,}/g, (m) => (UUID.test(m) ? m : "[masqué]"));
