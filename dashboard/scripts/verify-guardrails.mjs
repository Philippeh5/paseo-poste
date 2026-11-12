// dashboard/scripts/verify-guardrails.mjs — garde-fous durs (lib/guardrails.mjs + tools/guard-hook.mjs). Hors ligne, aucun LLM.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "guard-"));
process.env.GUARD_HOME = join(tmp, "home");
process.env.POSTE_STOP_FILE = join(tmp, "STOP");
mkdirSync(join(tmp, "home", "Projets", "BlastWin"), { recursive: true });
const { checkToolCall, checkProjectDir } = await import("../lib/guardrails.mjs");
const H = join(tmp, "home");
let fails = 0;
const t = (name, tool, input, expect, opts) => {
  const r = checkToolCall(tool, input, opts);
  const got = r.allow ? "allow" : r.guard;
  if (got !== expect) { fails++; console.log(`FAIL ${name} : attendu ${expect}, obtenu ${got} (${r.reason ?? ""})`); } else console.log(`PASS ${name}`);
};
const B = join(H, "Projets", "BlastWin");
// BlastWin
t("écrire dans BlastWin", "Write", { file_path: `${B}/server.js`, content: "x" }, "blastwin");
t("éditer dans BlastWin", "Edit", { file_path: `${B}/a/b.ts`, new_string: "x" }, "blastwin");
t("lire le code BlastWin", "Read", { file_path: `${B}/README.md` }, "allow");
t("rm dans BlastWin", "Bash", { command: `rm -rf ${B}/dist` }, "blastwin");
t("git commit dans BlastWin (cwd)", "Bash", { command: "git commit -am x" }, "blastwin", { cwd: B });
t("git log dans BlastWin (lecture)", "Bash", { command: "git log --oneline" }, "allow", { cwd: B });
t("systemctl blastwin-game", "Bash", { command: "systemctl --user restart blastwin-game.service" }, "blastwin");
t("autre projet", "Write", { file_path: join(H, "Projets", "Autre", "a.js"), content: "x" }, "allow");
t("chemin ../ vers BlastWin", "Write", { file_path: `${H}/Projets/Autre/../BlastWin/x.js`, content: "x" }, "blastwin");
// secrets
t("lire .env", "Read", { file_path: `${H}/Projets/Autre/.env` }, "secrets");
t("lire .env.example", "Read", { file_path: `${H}/Projets/Autre/.env.example` }, "allow");
t("lire ~/.hermes/.env", "Read", { file_path: `${H}/.hermes/.env` }, "secrets");
t("lire credentials Claude", "Read", { file_path: `${H}/.claude/.credentials.json` }, "secrets");
t("lire hosts.json", "Read", { file_path: `${H}/Projets/paseo-lab/dashboard/hosts.json` }, "secrets");
t("cat .env en Bash", "Bash", { command: "cat .env" }, "secrets");
t("grep dans ~/.hermes/.env", "Bash", { command: "grep TOKEN ~/.hermes/.env" }, "secrets");
t("printenv", "Bash", { command: "printenv" }, "secrets");
t("écrire un jeton", "Write", { file_path: `${H}/a.txt`, content: "key=ghp_" + "a".repeat(36) }, "secrets");
t("lire decide-secret.txt (Read)", "Read", { file_path: `${H}/paseo-dash-data/decide-secret.txt` }, "secrets");
t("cat decide-secret.txt (Bash)", "Bash", { command: "cat ~/paseo-dash-data/decide-secret.txt" }, "secrets");
t("npm test (normal)", "Bash", { command: "npm test" }, "allow");
t("ls .env.example", "Bash", { command: "cat .env.example" }, "allow");
// secrets Telegram (compte assistant)
t("lire tg-user.session (Read)", "Read", { file_path: `${H}/.config/paseo/tg-user.session` }, "secrets");
t("lire tg-user.json (Read)", "Read", { file_path: `${H}/.config/paseo/tg-user.json` }, "secrets");
t("lire tg-login-pending.json (Read)", "Read", { file_path: `${H}/.config/paseo/tg-login-pending.json` }, "secrets");
t("lire telegram-bots.env (Read)", "Read", { file_path: `${H}/.config/paseo/telegram-bots.env` }, "secrets");
t("cat tg-user.session (Bash)", "Bash", { command: `cat ${H}/.config/paseo/tg-user.session` }, "secrets");
t("cat telegram-bots.env (Bash)", "Bash", { command: "cat /tmp/mydir/telegram-bots.env" }, "secrets");
t("cat tg-login-pending.json (Bash)", "Bash", { command: "cat /var/run/tg-login-pending.json" }, "secrets");
// force-push
t("git push --force", "Bash", { command: "git push --force origin main" }, "force-push");
t("git push -f", "Bash", { command: "git push -f" }, "force-push");
t("git push --force-with-lease", "Bash", { command: "git push origin x --force-with-lease" }, "force-push");
t("git push +main", "Bash", { command: "git push origin +main" }, "force-push");
t("git push normal", "Bash", { command: "git push origin agent/x" }, "allow");
t("git push -u", "Bash", { command: "git push -u origin feat" }, "allow");
// push direct sur main / fusion sans CI
t("git push origin main", "Bash", { command: "git push origin main" }, "main-direct");
t("git push -u origin HEAD:main", "Bash", { command: "git push -u origin HEAD:main" }, "main-direct");
t("git push origin master", "Bash", { command: "git push origin master" }, "main-direct");
t("git push d'une branche agent", "Bash", { command: "git push -u origin agent/demo/readme" }, "allow");
t("git push d'une branche feature/main-menu", "Bash", { command: "git push origin feature/main-menu" }, "allow");
t("gh pr merge --admin", "Bash", { command: "gh pr merge 12 --admin --merge" }, "main-direct");
const repo = join(tmp, "repo"); mkdirSync(repo);
spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo }); spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
t("git push nu sur la branche main", "Bash", { command: "git push" }, "main-direct", { cwd: repo });
spawnSync("git", ["checkout", "-q", "-b", "agent/x"], { cwd: repo });
t("git push nu sur une branche agent", "Bash", { command: "git push" }, "allow", { cwd: repo });
// arrêt d'urgence
writeFileSync(process.env.POSTE_STOP_FILE, "stop");
t("STOP bloque tout", "Bash", { command: "ls" }, "stop");
rmSync(process.env.POSTE_STOP_FILE);
t("STOP levé", "Bash", { command: "ls" }, "allow");
// projets
if (checkProjectDir(B).allow) { fails++; console.log("FAIL mission sur BlastWin acceptée"); } else console.log("PASS mission sur BlastWin refusée");
if (!checkProjectDir(join(H, "Projets", "Autre")).allow) { fails++; console.log("FAIL mission sur autre projet refusée"); } else console.log("PASS mission sur autre projet permise");
// hook : sans POSTE_AUTONOMOUS il ne fait rien ; avec, il refuse (code 2)
const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "guard-hook.mjs");
const ev = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: tmp });
const run = (env) => spawnSync(process.execPath, [hook], { input: ev, env: { ...process.env, ...env, DASHBOARD_DATA_DIR: tmp }, encoding: "utf8" });
const a = run({ POSTE_AUTONOMOUS: "" }), b = run({ POSTE_AUTONOMOUS: "1" });
if (a.status !== 0) { fails++; console.log("FAIL hook actif hors mode autonome"); } else console.log("PASS hook inerte hors mode autonome");
if (b.status !== 2 || !/force-push/.test(b.stderr)) { fails++; console.log("FAIL hook ne refuse pas", b.status, b.stderr); } else console.log("PASS hook refuse (code 2) en mode autonome");
// hook : gh pr merge conditionné à la CI (faux gh : code de sortie piloté par FAKE_GH_CODE)
const bin = join(tmp, "bin"); mkdirSync(bin);
writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit ${FAKE_GH_CODE:-0}\n"); chmodSync(join(bin, "gh"), 0o755);
const merge = (code) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 7 --merge" }, cwd: tmp }), env: { ...process.env, POSTE_AUTONOMOUS: "1", DASHBOARD_DATA_DIR: tmp, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_CODE: String(code) }, encoding: "utf8" });
const g = merge(0), w = merge(8), f = merge(1);
if (g.status !== 0) { fails++; console.log("FAIL gh pr merge refusé alors que la CI est verte", g.stderr); } else console.log("PASS gh pr merge autorisé si CI verte");
if (w.status !== 2 || !/en cours/.test(w.stderr)) { fails++; console.log("FAIL gh pr merge pas bloqué CI en attente", w.status, w.stderr); } else console.log("PASS gh pr merge bloqué si CI en attente");
if (f.status !== 2 || !/pas verte/.test(f.stderr)) { fails++; console.log("FAIL gh pr merge pas bloqué CI rouge", f.status, f.stderr); } else console.log("PASS gh pr merge bloqué si CI rouge");
rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} échec(s)` : "\ntout est OK");
process.exit(fails ? 1 : 0);
