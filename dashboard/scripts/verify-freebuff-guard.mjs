// Garde-fou du mandat pour FreeBuff (fonctions pures, aucun serveur, aucun appel externe) :
// une consigne qui demande ce que le mandat interdit est refusée ; sinon un rappel des règles précède la consigne.
import { mandateDenies, mandateGuard } from "../handlers/freebuff.mjs";

let ok = 0;
let ko = 0;
const expect = (cond, label, detail = "") => {
  if (cond) { ok += 1; console.log(`OK   ${label}`); } else { ko += 1; console.log(`FAIL ${label} ${detail}`); }
};
const M = { enabled: true, forbidden: ["supprimer", "pousser sur GitHub", "éteindre une machine"], allowGit: false };
const what = (m, p) => mandateDenies(m, p)?.what ?? null;

expect(what(M, "Add a blue button on the home page and fix the score bug") === null, "consigne normale acceptée");
expect(what(M, "Delete every file in the repo") === "supprimer des fichiers", "« delete » refusé quand supprimer est interdit");
expect(what(M, "supprime les anciens fichiers") === "supprimer des fichiers", "« supprime » refusé");
expect(what(M, "Remove all logs") === "supprimer des fichiers", "« remove all » refusé");
expect(what(M, "git push origin main") === "pousser sur GitHub", "git push refusé");
expect(what(M, "then force-push the branch") === "pousser sur GitHub", "force-push refusé");
expect(what(M, "shutdown the pc after tests") === "éteindre une machine", "shutdown refusé");
expect(what(M, "run git commit -am done") === "écrire dans git", "git commit refusé quand allowGit est faux");
expect(what(M, "git reset --hard") === "écrire dans git", "git reset refusé");
expect(what({ ...M, allowGit: true }, "git commit -m x") === null, "git commit permis si le mandat l'autorise");
expect(what({ ...M, forbidden: [] }, "delete old files") === null, "pas d'interdit « supprimer » : permis");
expect(what({ enabled: false }, "delete old files; git push") === null, "sans mandat actif : aucun refus ajouté");
expect(what(null, "delete") === null, "mandat absent : aucun refus ajouté");

const g = mandateGuard(M);
expect(/^REGLES DU MANDAT/.test(g) && /TACHE : $/.test(g), "rappel de règles : début et fin attendus", g);
expect(g.includes("ne supprime aucun fichier") && g.includes("ne pousse rien sur GitHub") && g.includes("git commit"),
  "rappel de règles : supprimer, GitHub et git mentionnés");
expect(mandateGuard({ enabled: false }) === "" && mandateGuard(null) === "", "sans mandat : aucun rappel");

console.log(`\n=== BILAN : ${ok} OK, ${ko} FAIL ===`);
console.log(ko ? "VERIFY_FREEBUFF_GUARD_FAIL" : "VERIFY_FREEBUFF_GUARD_PASS");
process.exit(ko ? 1 : 0);
