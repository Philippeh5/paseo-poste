# Onboarding — from clone to first agent

This guide takes you from a fresh clone to a working command post. Each step adds one capability: **a machine**, **a subscription/provider**, **a tool connection**, then **a project**.

> Nothing in this guide asks you to commit a credential. Secrets stay in ignored files on your own machine (`hosts.json`, `*.env`, `~/.claude-*/settings.json`).

---

## 0. Prerequisites

| Requirement | Notes |
| :--- | :--- |
| **Node.js 24** | older versions may run, but CI and deployments use 24 |
| **Git** | to clone and to publish updates |
| **Paseo daemon 0.11.x** | `npm i -g @getpaseo/cli` on each machine you want to control |
| **Tailscale** (optional) | safe remote access from your phone/laptop; never expose port 7070 to the public internet |

---

## 1. Install and start the dashboard

```sh
git clone https://github.com/Philippeh5/paseo-poste.git
cd paseo-poste
npm install                 # dependencies are declared at the repository ROOT
node dashboard/server.mjs   # listens on http://127.0.0.1:7070 by default
```

Check it is alive:

```sh
curl -s http://127.0.0.1:7070/api/healthz
```

---

## 2. Add a machine

The machine registry is a JSON file with a **`hosts` array**. Each entry needs a `label` and a daemon `url`; `password` is only needed if that daemon requires one.

```sh
mkdir -p ~/paseo-dash-data && chmod 700 ~/paseo-dash-data
cp deploy/oracle/hosts.json.example ~/paseo-dash-data/hosts.json
chmod 600 ~/paseo-dash-data/hosts.json
$EDITOR ~/paseo-dash-data/hosts.json
```

```json
{
  "hosts": [
    { "label": "oracle", "url": "ws://127.0.0.1:6767/ws" },
    {
      "label": "mini-pc",
      "url": "ws://<TAILSCALE_IP>:6767/ws",
      "password": "<DAEMON_PASSWORD>"
    }
  ]
}
```

Then point the dashboard at that file and restart it:

```sh
export DASHBOARD_HOSTS_FILE="$HOME/paseo-dash-data/hosts.json"
export DASHBOARD_SELF_HOST="oracle"        # the label of this machine
node dashboard/server.mjs
curl -s http://127.0.0.1:7070/api/v1/summary | head -c 400
```

`labels` are the names you will see in the dashboard and in `postectl` commands. An unreachable host never blocks the others.

> ⚠️ `hosts.json` contains host passwords in clear text. It is gitignored — never copy it into the repository or paste it into an issue.

---

## 3. Add subscriptions and providers

Providers are the engines that run agents. They are configured **on the machine**, not in this repository.

| Engine | What to do |
| :--- | :--- |
| **Claude Code** (subscription) | install and sign in on the host; the poste can then launch `claude` sessions |
| **OpenRouter gateway** | configure `~/.claude-openrouter/settings.json` with the gateway base URL and your key; use aliases `sonnet` / `opus` |
| **NVIDIA gateway** | same idea in `~/.claude-nvidia/settings.json` |
| **FreeBuff** | optional second engine, installed on the host |

Try one from the CLI:

```sh
npx paseo run --provider claude-openrouter --model sonnet "Say hello"
```

Optional Telegram notifications: copy `deploy/oracle/poste.env.example` to `~/paseo-dash-data/hermes-api.env`, fill in the bot token and channel ID from @BotFather, and `chmod 600` it.

---

## 4. Connect your tools

### CLI

```sh
node tools/postectl.mjs summary
node tools/postectl.mjs sessions --json
```

### MCP server for Claude Code / Cursor / Windsurf

Add the stdio server with an **absolute path**:

```sh
claude mcp add postectl -- node "$PWD/tools/postectl-mcp.mjs"
# if the dashboard has a password:
claude mcp add postectl -e POSTECTL_PASSWORD=... -- node "$PWD/tools/postectl-mcp.mjs"
```

That exposes `post_*` tools (`post_summary`, `post_list_tasks`, `post_open_terminal`, …). Destructive tools require `confirm: true`.

For agent-to-agent reservations (`coord_claim`, `coord_who`, …), inspect the generated plan first:

```sh
node tools/coord-install.mjs --only claude --url http://127.0.0.1:7070
```

It only **prints** the commands — nothing is applied automatically.

### Composio bridge — which app each agent can use

Composio gives agents authenticated actions on external apps (Gmail, GitHub, Slack, Google Calendar…). The bridge decides **which agent may use which app, with which connected account**, and audits every call. The Composio session stays in `~/.composio` — never in the repo.

```sh
curl -fsSL https://composio.dev/install | sh
chmod 700 ~/.composio
chmod 600 ~/.composio/config.json ~/.composio/user_data.json
composio whoami          # confirm the CLI is connected
```

Copy the policy template, then restrict it to what you actually want (the policy is read-only for agents):

```sh
cp deploy/oracle/composio-policy.example.json ~/paseo-dash-data/composio-policy.json
chmod 600 ~/paseo-dash-data/composio-policy.json
```

The policy stores **aliases of connected accounts**, not secrets. Connect each account once as the operator:

```sh
composio link github --alias work
composio link gmail --alias lecture
```

Then grant each agent only what it needs via `agents.<name>.toolkits`, `writes`, `scripts`, `link` and `accounts`. In the example policy: `claude` may read Gmail and GitHub but not write; `codex` may create GitHub issues; `ops` (you) may link accounts and run multi-app scripts. An unknown agent gets nothing.

CLI:

```sh
node tools/composio.mjs policy                        # what the current agent can do
node tools/composio.mjs search "read my emails"      # only allowed apps are discoverable
node tools/composio.mjs schema GMAIL_FETCH_EMAILS     # get the input schema, don't guess
node tools/composio.mjs dry-run GMAIL_FETCH_EMAILS -d '{}'
node tools/composio.mjs execute GITHUB_CREATE_AN_ISSUE -d '{"owner":"example","repo":"demo","title":"Bug"}' --confirm
node tools/composio.mjs audit
```

MCP server (exposes `app_*` tools):

```sh
claude mcp add composio -e COMPOSIO_AGENT=claude -- node "$PWD/tools/composio-mcp.mjs"
```

`COMPOSIO_AGENT` (or `POSTECTL_AGENT`) is injected by the post: **an agent cannot change its identity by passing an argument**. Writes, account linking and scripts additionally require `confirm: true` and the matching policy flag. Denials exit with code `3` (`write_denied`, `toolkit_denied`, `confirm_required`, `forbidden_slug`); code `75` means a transient Composio error — check state before retrying.

### Remote access (optional)

```sh
node tools/tailscale-setup.mjs
```

It creates the password file, writes the launcher and prints the Tailscale URL. Remote access stays bound to the Tailscale IP, with Basic auth and rate limiting.

---

## 5. Add a project

Follow a directory on a known host, then create a task:

```sh
node tools/postectl.mjs project follow oracle /home/USERNAME/Projets/MyProject
node tools/postectl.mjs projects
node tools/postectl.mjs task add "Read the README" \
  --project /home/USERNAME/Projets/MyProject \
  --engine claude-openrouter/sonnet --host oracle
node tools/postectl.mjs summary
```

Equivalent API call:

```sh
curl -s -X POST http://127.0.0.1:7070/api/v1/projects/follow \
  -H 'Content-Type: application/json' \
  -d '{"host":"oracle","dir":"/home/USERNAME/Projets/MyProject"}'
```

At this point the poste can open terminals, run agents, track tasks and report back. See `dashboard/README.md` → « Piloter le poste par un agent » for the full API/CLI/MCP reference.

---

## 6. Safety checklist

- [ ] No `.env`, `hosts.json`, session file or private key in `git status`
- [ ] Remote access only through Tailscale — not `0.0.0.0`
- [ ] Destructive API calls include `confirm: true`
- [ ] Each agent sets `POSTECTL_AGENT` so writes are attributed in `data/agent-audit.jsonl`
- [ ] A permission request is approved only after reading its title and body

---

## 7. Publishing an update

Code is maintained in a **private working copy** and published here as a sanitized mirror. From that private repository:

```sh
tools/publish-showcase.sh --dry-run   # preview
tools/publish-showcase.sh             # copy allowlisted files, strip machine IDs, scan secrets, commit, push
```

The script never force-pushes, never copies gitignored files, and `README.md`, `ONBOARDING.md`, `LICENSE` and `.github/` are maintained directly in this public repository.

MIT License.
