// dashboard/scripts/verify-gh-sync.mjs
// Vérification de la synchro GitHub à la minute (tools/gh-sync.sh) et de la redirection du mini-PC (tools/redirect-poste.mjs).
// Tout est hors ligne : « origin » nu temporaire + clones qui jouent les deux machines, `gh` factice en tête du PATH,
// notificateur factice (NOTIFY_DRY_FILE, jamais le vrai Telegram), HOME temporaire, horloge simulée (GH_SYNC_NOW).
// - un changement de la machine A apparaît chez B après un passage de chaque côté (et inversement) ;
// - message de commit « sync <machine> : fichiers (+N autres) · +A −D » + corps = liste complète, auteur « Philippe (auto-sync) » ;
// - secret toujours bloqué, gros fichier toujours écarté ;
// - mode branche : CI verte -> main en avance rapide ; CI rouge qui dure >= 10 min -> UNE alerte (puis une autre après 6 h) ;
//   retour au vert -> « synchro rétablie » ; completed/cancelled -> ni alerte ni « CI rouge » ;
// - timer à la minute, concurrence CI, redirection 302 avec chemin + requête.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { freePort } from "../../tools/test-fixture.mjs";
import { isRealInstance } from "../lib/realinstance.mjs";
import { redirectLocation, tailscaleIp, watchTailscaleIp } from "../../tools/redirect-poste.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ghSync = join(repo, "tools", "gh-sync.sh");
const tmp = mkdtempSync(join(tmpdir(), "gh-sync-test-"));
const home = join(tmp, "home"); mkdirSync(home);

let passed = 0, failed = 0;
const ok = (l) => { passed++; console.log(`OK   ${l}`); };
const fail = (l, d = "") => { failed++; console.error(`FAIL ${l}${d ? ` -> ${d}` : ""}`); };
const expect = (c, l, d = "") => (c ? ok(l) : fail(l, d));
const section = (n) => console.log(`\n=== ${n} ===`);

// --- git de test
const git = (cwd, ...a) => {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8", env: { ...process.env, HOME: home } });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} : ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => { const f = join(root, "proj", rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };

// --- gh factice : « gh run list … » rend le contenu du fichier d'état
const bin = join(tmp, "bin"); mkdirSync(bin);
const ghState = join(tmp, "gh-state"); writeFileSync(ghState, "queued/null");
writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nif [ "$1 $2" = "run list" ]; then [ -f "${ghState}.fail" ] && { echo "gh: not logged in" >&2; exit 1; }; [ -f "${ghState}.warn" ] && echo "warning: gh 2.99 disponible (mise à jour recommandée)" >&2; cat "${ghState}"; exit 0; fi\nexit 0\n`);
chmodSync(join(bin, "gh"), 0o755);
const notified = join(tmp, "notif.jsonl");
const messages = () => (existsSync(notified) ? readFileSync(notified, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text) : []);

function sync(root, { host, machine, now, branch = false, repos = ["proj"], pathPrefix = "" }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DASHBOARD_|TELEGRAM_|NOTIFY_|GH_SYNC_|HERMES_)/.test(k)));
  Object.assign(env, {
    HOME: home, PATH: `${pathPrefix ? pathPrefix + delimiter : ""}${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    GH_SYNC_HOST: host, GH_SYNC_MACHINE: machine, NOTIFY_DRY_FILE: notified, GH_SYNC_NOTIFY_MJS: join(repo, "dashboard", "lib", "notify.mjs"),
  });
  if (now !== undefined) env.GH_SYNC_NOW = String(now);
  if (branch) env.GH_SYNC_BRANCH_REPOS = "proj";
  const r = spawnSync("bash", [ghSync, root, ...repos], { env, encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) fail(`gh-sync sort en 0 (${host})`, `${r.status} ${r.stderr}`);
  return r;
}
const readIf = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");

// --- dépôts : origin nu + 3 clones (machines A=oracle, B=mini-pc, C=mode branche)
const origin = join(tmp, "origin.git");
git(tmp, "init", "-q", "--bare", "-b", "main", origin);
const seed = join(tmp, "seed"); git(tmp, "clone", "-q", origin, seed);
writeFileSync(join(seed, "seed.txt"), "1\n2\n3\n4\n5\n");
mkdirSync(join(seed, ".github", "workflows"), { recursive: true }); writeFileSync(join(seed, ".github", "workflows", "ci.yml"), "name: CI\n");
git(seed, "add", "."); git(seed, "commit", "-qm", "départ"); git(seed, "branch", "-M", "main"); git(seed, "push", "-q", "-u", "origin", "main");
const roots = {};
for (const k of ["A", "B", "C", "D", "E"]) { roots[k] = join(tmp, `root${k}`); mkdirSync(roots[k]); git(tmp, "clone", "-q", origin, join(roots[k], "proj")); }
const originLog = (n = 1) => git(origin, "log", "-n", String(n), "--format=%an|%s", "main");

try {
  section("Deux machines, message de commit lisible");
  write(roots.A, "seed.txt", "1\nX\n");
  write(roots.A, "src/a.js", "a\nb\nc\n"); write(roots.A, "docs/a.js", "a\nb\n"); write(roots.A, "b.txt", "x\n");
  writeFileSync(join(roots.A, "proj", "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]));
  sync(roots.A, { host: "instance-20261008-1451" });
  const subject = git(origin, "log", "-n", "1", "--format=%s", "main");
  expect(subject === "sync oracle : b.txt, bin.dat, docs/a.js (+2 autres) · +7 −4", "sujet : machine, 3 fichiers, (+N autres), +A −D (binaire = 0)", subject);
  expect(originLog().startsWith("Philippe (auto-sync)|"), "auteur « Philippe (auto-sync) »", originLog());
  const body = git(origin, "log", "-n", "1", "--format=%b", "main");
  expect(["b.txt", "bin.dat", "docs/a.js", "seed.txt", "src/a.js"].every((f) => body.includes(f)), "corps = liste complète des fichiers", body);
  expect(/^M\tseed\.txt$/m.test(body) && /^A\tsrc\/a\.js$/m.test(body), "corps : statut + chemin complet", body);
  expect(subject.includes("docs/a.js") && !subject.includes("src/a.js,"), "noms les plus courts mais uniques (deux a.js -> dossier/a.js)");

  sync(roots.B, { host: "WIN-3LLN0L8LRLM" });
  expect(existsSync(join(roots.B, "proj", "src", "a.js")) && readIf(join(roots.B, "proj", "seed.txt")) === "1\nX\n", "A -> origin -> B après un passage de chaque côté");
  write(roots.B, "notes.md", "bonjour\n");
  const sB = sync(roots.B, { host: "WIN-3LLN0L8LRLM" });
  expect(git(origin, "log", "-n", "1", "--format=%s", "main") === "sync mini-pc : notes.md · +1 −0", "nom d'hôte Windows -> « mini-pc »", git(origin, "log", "-n", "1", "--format=%s", "main"));
  sync(roots.A, { host: "instance-20261008-1451" });
  expect(readIf(join(roots.A, "proj", "notes.md")) === "bonjour\n", "B -> origin -> A");
  const nb = git(join(roots.A, "proj"), "rev-list", "--count", "HEAD");
  sync(roots.A, { host: "instance-20261008-1451" }); sync(roots.B, { host: "WIN-3LLN0L8LRLM" });
  expect(git(join(roots.A, "proj"), "rev-list", "--count", "HEAD") === nb, "passage sans changement : aucun commit");
  const logA = readIf(join(roots.A, ".gh-sync.log"));
  expect((logA.match(/commit \(/g) || []).length === 1, "journal : une seule ligne de commit (pas de bruit)", logA);
  sync(roots.A, { host: "poste-inconnu" });
  write(roots.A, "z.txt", "z\n"); sync(roots.A, { host: "poste-inconnu" });
  expect(git(origin, "log", "-n", "1", "--format=%s", "main") === "sync poste-inconnu : z.txt · +1 −0", "hôte inconnu -> nom d'hôte brut");
  write(roots.A, "y.txt", "y\n"); sync(roots.A, { host: "poste-inconnu", machine: "mon-pc" });
  expect(git(origin, "log", "-n", "1", "--format=%s", "main").startsWith("sync mon-pc : y.txt"), "GH_SYNC_MACHINE prime");

  section("Garde-fous inchangés");
  const before = git(origin, "rev-parse", "main");
  write(roots.A, "leak.txt", `api_key = "${"A1b2".repeat(8)}"\n`);
  sync(roots.A, { host: "poste-inconnu" });
  expect(git(origin, "rev-parse", "main") === before, "secret : rien n'est publié");
  expect(/secret probable/.test(readIf(join(roots.A, "SYNC-PROBLEMES.log"))), "secret : signalé dans SYNC-PROBLEMES.log");
  expect(existsSync(join(roots.A, "proj", "leak.txt")), "secret : le fichier reste sur le disque");
  sync(roots.A, { host: "poste-inconnu" });
  expect((readIf(join(roots.A, "SYNC-PROBLEMES.log")).match(/secret probable/g) || []).length === 1, "secret : consigné une seule fois tant qu'il dure");
  rmSync(join(roots.A, "proj", "leak.txt"));
  writeFileSync(join(roots.A, "proj", "gros.bin"), Buffer.alloc(5 * 1024 * 1024 + 10, 1));
  sync(roots.A, { host: "poste-inconnu" });
  expect(!git(origin, "ls-tree", "-r", "--name-only", "main").includes("gros.bin") && /dépasse 5 Mo/.test(readIf(join(roots.A, "SYNC-PROBLEMES.log"))), "gros fichier : écarté et signalé");
  rmSync(join(roots.A, "proj", "gros.bin"));
  expect(messages().length === 0, "aucune alerte pour des problèmes de moins de 10 minutes");

  section("Mode branche : CI verte, rouge persistante, annulée");
  const C = { host: "instance-20261008-1451", machine: "oracle", branch: true };
  const T0 = 1_800_000_000;
  sync(roots.C, { ...C, now: T0 }); // met C à jour (récupère les commits de A/B) ; rien à publier
  write(roots.C, "ok.txt", "vert\n");
  writeFileSync(ghState, "completed/success");
  sync(roots.C, { ...C, now: T0 });
  expect(git(origin, "rev-parse", "main") === git(join(roots.C, "proj"), "rev-parse", "HEAD"), "CI verte : main avancé en avance rapide");
  expect(git(origin, "branch", "--list", "sync/*").includes("sync/instance-20261008-1451"), "publication sur sync/<hôte>");
  expect(messages().length === 0, "CI verte : aucune alerte");

  write(roots.C, "casse.txt", "rouge\n");
  writeFileSync(ghState, "completed/failure");
  for (const dt of [0, 120, 300, 599]) sync(roots.C, { ...C, now: T0 + 100 + dt });
  const mainBefore = git(origin, "rev-parse", "main");
  expect(mainBefore !== git(join(roots.C, "proj"), "rev-parse", "HEAD"), "CI rouge : pas de fusion dans main");
  expect(messages().length === 0, "CI rouge depuis < 10 min : pas d'alerte", JSON.stringify(messages()));
  sync(roots.C, { ...C, now: T0 + 100 + 600 });
  expect(messages().length === 1 && messages()[0].startsWith("🔄 Synchro · proj (oracle) : CI rouge"), "CI rouge >= 10 min : UNE alerte au bon format", JSON.stringify(messages()));
  for (const dt of [660, 1200, 3600, 20000]) sync(roots.C, { ...C, now: T0 + 100 + dt });
  expect(messages().length === 1, "pas de répétition avant 6 h", String(messages().length));
  sync(roots.C, { ...C, now: T0 + 100 + 600 + 21600 });
  expect(messages().length === 2, "répétée après 6 h", String(messages().length));
  writeFileSync(ghState, "completed/success");
  sync(roots.C, { ...C, now: T0 + 100 + 600 + 21700 });
  expect(messages().length === 3 && messages()[2].startsWith("✅ Synchro rétablie · proj (oracle)"), "retour au vert : « synchro rétablie »", JSON.stringify(messages().slice(2)));
  expect(git(origin, "rev-parse", "main") === git(join(roots.C, "proj"), "rev-parse", "HEAD"), "retour au vert : main avancé");
  sync(roots.C, { ...C, now: T0 + 100 + 600 + 21800 });
  expect(messages().length === 3 && readIf(join(roots.C, ".gh-sync.alerts")).trim() === "", "état d'alerte vidé, rien de plus envoyé");

  const nAlert = messages().length;
  write(roots.C, "annule.txt", "annulé\n");
  writeFileSync(ghState, "completed/cancelled");
  const T1 = T0 + 100_000;
  for (const dt of [0, 600, 1200, 5000]) sync(roots.C, { ...C, now: T1 + dt });
  expect(messages().length === nAlert, "completed/cancelled : aucune alerte même après 10 min", JSON.stringify(messages().slice(nAlert)));
  expect(!/CI rouge sur sync\/[^\n]*cancelled/.test(readIf(join(roots.C, "SYNC-PROBLEMES.log"))) && /annulée/.test(readIf(join(roots.C, ".gh-sync.log"))), "completed/cancelled traité comme une attente");
  writeFileSync(ghState, "in_progress/null");
  sync(roots.C, { ...C, now: T1 + 6000 });
  writeFileSync(ghState, "completed/success");
  sync(roots.C, { ...C, now: T1 + 6100 });
  expect(git(origin, "rev-parse", "main") === git(join(roots.C, "proj"), "rev-parse", "HEAD"), "annulée puis verte : main avancé");

  write(roots.C, "avertit.txt", "stderr\n");
  writeFileSync(`${ghState}.warn`, ""); writeFileSync(ghState, "completed/success");
  sync(roots.C, { ...C, now: T1 + 6500 });
  expect(git(origin, "rev-parse", "main") === git(join(roots.C, "proj"), "rev-parse", "HEAD"), "gh avec avertissement sur stderr + completed/success : main quand même avancé");
  expect(!/lecture de la CI impossible/.test(readIf(join(roots.C, "SYNC-PROBLEMES.log"))), "avertissement stderr de gh : pas pris pour une CI illisible");
  rmSync(`${ghState}.warn`);

  write(roots.C, "illisible.txt", "gh\n");
  writeFileSync(`${ghState}.fail`, "");
  sync(roots.C, { ...C, now: T1 + 7000 });
  expect(/lecture de la CI impossible/.test(readIf(join(roots.C, "SYNC-PROBLEMES.log"))), "gh en échec : signalé (sinon rien ne serait jamais fusionné)");
  rmSync(`${ghState}.fail`);
  sync(roots.C, { ...C, now: T1 + 7100 });

  section("Régressions : 5 000 fichiers, gros fichier et opération git en cours dédoublonnés + alertés");
  {
    // commit_message / short_names extraits de gh-sync.sh et exécutés seuls sur 5 000 fichiers indexés (jamais plus de 5 s)
    const srcSh = readFileSync(ghSync, "utf8");
    const fnBlock = (name) => { const m = srcSh.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m")); return m ? m[0] : ""; };
    const perf = join(tmp, "perf"); mkdirSync(perf);
    git(tmp, "init", "-q", perf);
    for (let d = 0; d < 50; d++) { mkdirSync(join(perf, `d${d}`)); for (let f = 0; f < 100; f++) writeFileSync(join(perf, `d${d}`, `f${f}.txt`), `${d}-${f}\n`); }
    git(perf, "add", "-A");
    const t0 = Date.now();
    const r5 = spawnSync("bash", ["-c", `MACHINE=oracle\n${fnBlock("short_names")}\n${fnBlock("commit_message")}\ncommit_message | head -n 1`], { cwd: perf, encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: home } });
    const dt = Date.now() - t0;
    expect(r5.status === 0 && dt < 5000, `message de commit pour 5 000 fichiers en < 5 s (${dt} ms)`, `${r5.status} ${r5.stderr}`);
    expect(r5.stdout.trim() === "sync oracle : d0/f0.txt, d0/f1.txt, d0/f10.txt (+4997 autres) · +5000 −0", "5 000 fichiers : sujet correct (3 noms + 4997 autres)", r5.stdout.trim());
    const r2 = spawnSync("bash", ["-c", `${fnBlock("short_names")}\nprintf 'a/x.js\nb/x.js\nc.txt\n' | short_names 3 | paste -sd,`], { encoding: "utf8" });
    expect(r2.stdout.trim() === "a/x.js,b/x.js,c.txt", "short_names : noms uniques inchangés", r2.stdout);

    // gros fichier : consigné une seule fois (plus de sous-shell) et alerté une fois après 10 min ; rétablie ensuite
    const D = { host: "poste-d", machine: "pc-d" };
    const TD = 1_900_000_000, nm = messages().length;
    sync(roots.D, { ...D, now: TD });
    writeFileSync(join(roots.D, "proj", "enorme.bin"), Buffer.alloc(5 * 1024 * 1024 + 10, 2));
    sync(roots.D, { ...D, now: TD + 60 }); sync(roots.D, { ...D, now: TD + 120 });
    expect((readIf(join(roots.D, "SYNC-PROBLEMES.log")).match(/enorme\.bin dépasse 5 Mo/g) || []).length === 1, "gros fichier : une seule ligne dans SYNC-PROBLEMES.log malgré plusieurs passages");
    expect((readIf(join(roots.D, ".gh-sync.log")).match(/PROBLEME[^\n]*enorme\.bin/g) || []).length === 1, "gros fichier : une seule ligne dans le journal");
    expect(messages().length === nm, "gros fichier < 10 min : pas d'alerte");
    sync(roots.D, { ...D, now: TD + 60 + 600 });
    expect(messages().length === nm + 1 && /Synchro · proj \(pc-d\) : gros fichier non publié/.test(messages()[nm]), "gros fichier >= 10 min : UNE alerte", JSON.stringify(messages().slice(nm)));
    sync(roots.D, { ...D, now: TD + 60 + 1200 });
    expect(messages().length === nm + 1, "gros fichier : pas de répétition");
    rmSync(join(roots.D, "proj", "enorme.bin"));
    sync(roots.D, { ...D, now: TD + 60 + 1300 });
    expect(messages().length === nm + 2 && /rétablie · proj \(pc-d\) : gros fichier non publié/.test(messages()[nm + 1]), "gros fichier retiré : « synchro rétablie »", JSON.stringify(messages().slice(nm + 1)));

    // rebase / fusion bloqué : même mécanisme
    const gd = join(roots.D, "proj", ".git", "rebase-merge"); mkdirSync(gd);
    const TG = TD + 100_000, ng = messages().length;
    sync(roots.D, { ...D, now: TG }); sync(roots.D, { ...D, now: TG + 300 });
    expect(messages().length === ng, "opération git en cours < 10 min : pas d'alerte");
    sync(roots.D, { ...D, now: TG + 600 }); sync(roots.D, { ...D, now: TG + 900 });
    expect(messages().length === ng + 1 && /Synchro · proj \(pc-d\) : opération git bloquée/.test(messages()[ng]), "opération git en cours >= 10 min : UNE alerte", JSON.stringify(messages().slice(ng)));
    expect((readIf(join(roots.D, "SYNC-PROBLEMES.log")).match(/opération git en cours/g) || []).length === 1, "opération git en cours : consignée une seule fois");
    rmSync(gd, { recursive: true });
    sync(roots.D, { ...D, now: TG + 1000 });
    expect(messages().length === ng + 2 && /rétablie · proj \(pc-d\) : opération git bloquée/.test(messages()[ng + 1]), "opération terminée : « synchro rétablie »", JSON.stringify(messages().slice(ng + 1)));
  }

  section("Régression : gros fichiers à noms piégés + contrôle de taille fermé par défaut");
  {
    const E = { host: "poste-e", machine: "pc-e" };
    const pe = join(roots.E, "proj"), probE = join(roots.E, "SYNC-PROBLEMES.log");
    git(pe, "config", "user.name", "Test"); git(pe, "config", "user.email", "t@t"); // le rebase de rattrapage a besoin d'une identité
    const big = (name) => writeFileSync(join(pe, name), Buffer.alloc(6 * 1024 * 1024, 7));
    const pushedFiles = () => git(origin, "ls-tree", "-r", "--name-only", "-z", "main").split("\0");
    const piege = ["trail .bin ", " lead.bin", "nl\nname.bin", "glob[1].bin", "dir avec espace/gros fichier.bin"];
    mkdirSync(join(pe, "dir avec espace"), { recursive: true });
    for (const n of piege) big(n);
    write(roots.E, "petit ok.txt", "ok\n");
    sync(roots.E, { ...E, now: 1_950_000_000 });
    const pushed = pushedFiles();
    expect(pushed.includes("petit ok.txt"), "noms piégés : le petit fichier est bien publié");
    for (const n of piege) expect(!pushed.includes(n), `gros fichier ${JSON.stringify(n)} : écarté malgré le nom piégé`, JSON.stringify(pushed));
    expect(git(pe, "ls-files", "--cached", "-z").split("\0").every((n) => !piege.includes(n)), "noms piégés : aucun gros fichier dans l'index local non plus");
    expect(piege.every((n) => existsSync(join(pe, n))), "noms piégés : les fichiers restent sur le disque");
    expect(readIf(probE).split("\n").filter((l) => /dépasse 5 Mo/.test(l)).length >= piege.length - 1, "noms piégés : chaque fichier est signalé", readIf(probE));
    expect(/nl\\nname\.bin dépasse 5 Mo/.test(readIf(probE)), "nom avec retour à la ligne : une seule ligne de journal, \\n affiché", readIf(probE));

    // contrôle de taille impossible : un git factice fait échouer `cat-file` -> rien commité ni publié, problème consigné
    const fake = (mode) => {
      const dir = join(tmp, `fakegit-${mode}`); mkdirSync(dir, { recursive: true });
      const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const body = mode === "fail"
        ? `for a in "$@"; do [ "$a" = cat-file ] && { echo "fatal: simulated cat-file failure" >&2; exit 128; }; done\nexec "${realGit}" "$@"\n`
        : `for a in "$@"; do [ "$a" = cat-file ] && { echo "blob 1"; exit 0; }; done\nexec "${realGit}" "$@"\n`;
      writeFileSync(join(dir, "git"), `#!/usr/bin/env bash\n${body}`); chmodSync(join(dir, "git"), 0o755);
      return dir;
    };
    for (const piegeBin of ["trail .bin ", " lead.bin", "nl\nname.bin"]) rmSync(join(pe, piegeBin));
    for (const [mode, label] of [["fail", "cat-file en erreur"], ["short", "cat-file : réponse incomplète"]]) {
      const head = git(origin, "rev-parse", "main"), localHead = git(pe, "rev-parse", "HEAD");
      write(roots.E, `nouveau-${mode}.txt`, "n\n"); big(`enorme-${mode}.bin`);
      const nm = messages().length;
      sync(roots.E, { ...E, now: 1_950_100_000, pathPrefix: fake(mode) });
      expect(git(origin, "rev-parse", "main") === head && git(pe, "rev-parse", "HEAD") === localHead, `${label} : rien commité ni publié`);
      expect(git(pe, "diff", "--cached", "--name-only") === "", `${label} : index vidé`);
      expect(existsSync(join(pe, `enorme-${mode}.bin`)) && existsSync(join(pe, `nouveau-${mode}.txt`)), `${label} : fichiers intacts sur le disque`);
      expect(/contrôle de taille impossible/.test(readIf(probE)), `${label} : problème « contrôle de taille impossible » consigné`, readIf(probE));
      expect(messages().length === nm, `${label} : pas d'alerte avant 10 min`);
      sync(roots.E, { ...E, now: 1_950_100_000 + 600, pathPrefix: fake(mode) });
      expect(messages().length === nm + 1 && /contrôle de taille impossible/.test(messages()[nm]), `${label} : alerte après 10 min`, JSON.stringify(messages().slice(nm)));
      expect(git(origin, "rev-parse", "main") === head, `${label} : toujours rien publié au passage suivant`);
      // retour à la normale : le petit fichier part, le gros reste écarté, le problème se résout
      sync(roots.E, { ...E, now: 1_950_100_000 + 700 });
      expect(pushedFiles().includes(`nouveau-${mode}.txt`) && !pushedFiles().includes(`enorme-${mode}.bin`), `${label} : git rétabli -> petit fichier publié, gros écarté`);
      rmSync(join(pe, `enorme-${mode}.bin`));
      sync(roots.E, { ...E, now: 1_950_100_000 + 800 });
    }
  }

  section("Notificateur : envoi réel seulement depuis le poste réel, sans secret côté bash");
  const src = readFileSync(ghSync, "utf8");
  expect(isRealInstance({ DASHBOARD_DATA_DIR: join(home, "paseo-dash-data") }, home) && !isRealInstance({}, home), "notify.mjs : réel seulement avec DASHBOARD_DATA_DIR=~/paseo-dash-data");
  expect(/DASHBOARD_DATA_DIR="\$\{DASHBOARD_DATA_DIR:-\$HOME\/paseo-dash-data\}"/.test(src) && /telegramSend/.test(src), "gh-sync.sh positionne ce dossier et appelle telegramSend");
  expect(!/TELEGRAM_BOT_TOKEN|\.env\b.*cat|source .*\.env/.test(src), "gh-sync.sh ne lit aucun secret");
  const bare = join(tmp, "sansnotif"); mkdirSync(bare);
  const r = spawnSync("bash", ["-c", `GH_SYNC_NOW=1 bash '${ghSync}' '${bare}' proj; echo rc=$?`], { env: { ...process.env, HOME: home, NOTIFY_DRY_FILE: "", GH_SYNC_NOTIFY_MJS: join(tmp, "absent.mjs") }, encoding: "utf8" });
  expect(r.stdout.includes("rc=0"), "sans notificateur configuré : sans effet, code 0");

  section("Fichiers de déploiement");
  const timer = readFileSync(join(repo, "deploy/oracle/systemd/gh-sync.timer"), "utf8");
  expect(/OnUnitActiveSec=1min/.test(timer) && /AccuracySec=5s/.test(timer) && /Description=.*minute/.test(timer), "timer : toutes les minutes, AccuracySec=5s");
  const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
  expect(/concurrency:\s*\n\s+group: ci-\$\{\{ github\.ref \}\}\s*\n\s+cancel-in-progress: true/.test(ci), "ci.yml : concurrency par branche avec annulation");
  expect(spawnSync("bash", ["-n", ghSync]).status === 0, "bash -n tools/gh-sync.sh");
  expect(spawnSync(process.execPath, ["--check", join(repo, "tools/redirect-poste.mjs")]).status === 0, "node --check tools/redirect-poste.mjs");
  const ps = ["install-sync-task.ps1", "start-poste.ps1"].map((f) => readFileSync(join(repo, "tools", f)));
  const inst = ps[0].toString();
  expect(/-RepetitionInterval \(New-TimeSpan -Minutes 1\) -RepetitionDuration \(New-TimeSpan -Days 3650\)/.test(inst) && !/\$trigger\.Repetition\s*=/.test(inst) && /-Trigger \$trigger\b/.test(inst), "install-sync-task.ps1 : répétition avec durée explicite, sans affecter .Repetition (PowerShell 5.1 et pwsh 7)");
  expect(ps.every((b) => b[0] === 0xef && b[1] === 0xbb) && /wscript\.exe/.test(ps[0].toString()) && /Windows|SW_HIDE|, 0, True/.test(ps[0].toString()), "scripts PowerShell : BOM UTF-8, lanceur masqué via wscript");

  section("Redirection du mini-PC");
  expect(tailscaleIp({ eth0: [{ family: "IPv4", address: "192.168.1.5" }], ts: [{ family: "IPv4", address: "100.103.172.69" }] }) === "100.103.172.69"
    && tailscaleIp({ a: [{ family: "IPv4", address: "100.128.0.1" }, { family: "IPv4", address: "100.63.0.1" }] }) === null, "détection de l'adresse 100.64.0.0/10");
  expect(redirectLocation("http://100.78.38.61:7070/", "/a/b?x=1&y=2") === "http://100.78.38.61:7070/a/b?x=1&y=2", "redirectLocation : chemin + requête");
  const port = await freePort();
  const child = spawn(process.execPath, [join(repo, "tools", "redirect-poste.mjs")], { env: { ...process.env, REDIRECT_LISTEN: `127.0.0.1:${port}` }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 50 && !out.includes("redirection"); i++) await sleep(100);
    expect(out.includes("redirection"), "le serveur de redirection démarre", out.slice(0, 200));
    const get = (path) => new Promise((resolve, reject) => http.get({ host: "127.0.0.1", port, path }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ res, b })); }).on("error", reject));
    const { res, b } = await get("/projets/x?tab=2&q=%C3%A9");
    expect(res.statusCode === 302 && res.headers.location === "http://100.78.38.61:7070/projets/x?tab=2&q=%C3%A9", "302 vers Oracle avec chemin + requête", `${res.statusCode} ${res.headers.location}`);
    expect(/lang="fr"/.test(b) && b.includes("http://100.78.38.61:7070/projets/x"), "page HTML française avec le lien", b.slice(0, 120));
    expect((await get("/")).res.headers.location === "http://100.78.38.61:7070/", "racine -> http://100.78.38.61:7070/");
  } finally { child.kill(); }
  {
    // Tailscale sans adresse au démarrage : réessais périodiques, écoute dès qu'elle apparaît, arrêt des essais ensuite
    const portT = await freePort(); let calls = 0;
    const w = watchTailscaleIp({ target: "http://example.test:9", port: portT, intervalMs: 40, find: () => (++calls >= 4 ? "127.0.0.1" : null), log: () => {} });
    const got = await Promise.race([w.done, sleep(5000).then(() => "timeout")]);
    expect(got === "127.0.0.1" && calls === 4, "Tailscale absent puis présent : l'écoute démarre dès que l'adresse apparaît", `${got} calls=${calls}`);
    const loc = await new Promise((rs) => http.get({ host: "127.0.0.1", port: portT, path: "/z?q=1" }, (r) => { r.resume(); rs(r.headers.location); }).on("error", () => rs(null)));
    expect(loc === "http://example.test:9/z?q=1", "l'écoute tardive redirige bien", String(loc));
    await sleep(150);
    expect(calls === 4, "plus de recherche une fois l'écoute démarrée", String(calls));
    w.stop();
    const w2 = watchTailscaleIp({ port: portT, intervalMs: 20, find: () => null, log: () => {} });
    await sleep(100); w2.stop();
    expect(await Promise.race([w2.done, sleep(1000).then(() => "timeout")]) === null, "watchTailscaleIp.stop() interrompt les essais");
  }
  const port2 = await freePort();
  const child2 = spawn(process.execPath, [join(repo, "tools", "redirect-poste.mjs")], { env: { ...process.env, REDIRECT_LISTEN: `127.0.0.1:${port2}`, POSTE_URL: "http://example.test:9" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let got = null;
    for (let i = 0; i < 50 && got === null; i++) { await sleep(100); try { got = await new Promise((rs, rj) => http.get({ host: "127.0.0.1", port: port2, path: "/p?a=1" }, (r) => { r.resume(); rs(r.headers.location); }).on("error", rj)); } catch { /* pas encore prêt */ } }
    expect(got === "http://example.test:9/p?a=1", "POSTE_URL surcharge la cible (le serveur a bien démarré)", String(got));
  } finally { child2.kill(); }
} catch (e) {
  fail("exception du test", e.stack || String(e));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} OK, ${failed} échec(s)`);
if (failed) process.exit(1);
console.log("VERIFY_GH_SYNC_PASS");
