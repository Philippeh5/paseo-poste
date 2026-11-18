# Paseo Poste — Command Post

A self-hosted **command post** for managing autonomous AI agents, terminals, tasks, bots, and services across multiple machines (Oracle, Mini PC, etc.) via a web dashboard and MCP (Model Context Protocol).

> ⚠️ **Self-hosted infrastructure — Not a SaaS**
> You run this on your own machines. No cloud account required beyond your own VPS/local hardware.

> 🧭 **New here?** Follow the [Onboarding guide](ONBOARDING.md): add a machine, a provider/subscription, connect your tools, then add a project — step by step.

---

## 🎯 What It Does

- **Multi-machine orchestration**: Control agents, terminals, and services on Oracle, Mini PC, or any Linux/Windows host
- **Web dashboard** (port 7070): Real-time session view, task management, service logs, bot control
- **MCP server**: Integrates with Claude Code, Cursor, Windsurf — agents can spawn/control sessions via tools
- **Telegram bot**: Remote control via `/poste` menu (buttons for agents, terminals, tasks, services)
- **Tailscale support**: Secure remote access via Tailscale IP + Basic auth
- **Systemd integration**: Runs as user services with auto-restart, timers for sync/backup/watchdog

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Telegram Bot  │────▶│  Paseo Daemon    │────▶│  Local Machine  │
│   (/poste menu) │     │  (Node.js)       │     │  - Agents       │
└─────────────────┘     └────────┬─────────┘     │  - Terminals    │
                                 │               │  - Services     │
                    ┌────────────┴────────────┐  └─────────────────┘
                    │   Web Dashboard :7070   │
                    │   (Real-time WS)        │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │   MCP Server (tools)    │
                    │   (Claude Code, etc.)   │
                    └─────────────────────────┘
```

---

## 🚀 Quickstart

### 1. Prerequisites
- **Node.js 24** (CI and deployment units use 24)
- **Tailscale** (optional, for remote access)
- **Linux/macOS** (Windows via WSL2)
- **Git**

### 2. Clone & Install
```bash
git clone https://github.com/Philippeh5/paseo-poste.git
cd paseo-poste

# Install dependencies (declared at the repository root, not in dashboard/)
npm install

# Make scripts executable
chmod +x deploy/oracle/*.sh deploy/oracle/systemd/*/*.sh deploy/mini-pc/*.ps1 2>/dev/null || true
```

### 3. Configure (Required)
```bash
# Create data directory
mkdir -p ~/paseo-dash-data
chmod 700 ~/paseo-dash-data

# Copy example env and EDIT IT
cp deploy/oracle/poste.env.example ~/paseo-dash-data/hermes-api.env
chmod 600 ~/paseo-dash-data/hermes-api.env

# Edit with your values:
# - TELEGRAM_BOT_TOKEN (from @BotFather)
# - TELEGRAM_HOME_CHANNEL (your private channel ID for notifications)
# - BACKUP_RCLONE_REMOTE (optional, for off-machine backups)
# - BACKUP_AGE_RECIPIENT (optional, for encrypted backups)
nano ~/paseo-dash-data/hermes-api.env

# Tailscale password (if using Tailscale remote access)
echo "YOUR_STRONG_PASSWORD_16_CHARS_MIN" > ~/paseo-dash-data/tailscale-password.txt
chmod 600 ~/paseo-dash-data/tailscale-password.txt

# Hosts file (machine registry) — { "hosts": [ { label, url, password? } ] }
cp deploy/oracle/hosts.json.example ~/paseo-dash-data/hosts.json
chmod 600 ~/paseo-dash-data/hosts.json
# Edit with your machines (never commit this file):
nano ~/paseo-dash-data/hosts.json
export DASHBOARD_HOSTS_FILE="$HOME/paseo-dash-data/hosts.json"
```

### 4. Install Systemd Services (Oracle / Linux)
```bash
# Run as your user (not root)
deploy/oracle/install.sh

# Verify
systemctl --user list-timers
curl -s localhost:7070/api/healthz
```

### 5. Access Dashboard
- **Local**: `http://localhost:7070`
- **Tailscale**: `http://<your-tailscale-ip>:7070` (Basic auth: user from `DASHBOARD_TAILSCALE_USER`, password from `tailscale-password.txt`)

---

## 📂 Repository Structure

```text
paseo-poste/
├── dashboard/              # Web dashboard (Node.js + WS)
│   ├── server.mjs          # Main HTTP/WS server
│   ├── handlers/           # API handlers (agents, terminals, tasks, bots, services)
│   ├── lib/                # Shared libs (hosts, store, crypto)
│   ├── public/             # Frontend assets (HTML, CSS, JS)
│   ├── data/               # Runtime data (gitignored) — see .example files
│   └── package.json
├── deploy/
│   ├── oracle/             # Linux (systemd) deployment
│   │   ├── systemd/        # Service units (paseo, dashboard, hermes-gateway, timers)
│   │   ├── install.sh      # Idempotent installer
│   │   ├── backup.sh       # Backup script (local + rclone)
│   │   ├── watchdog.sh     # Health monitor + Telegram alerts
│   │   └── poste.env.example  # Env template (NO secrets)
│   └── mini-pc/            # Windows (PowerShell) deployment
├── tools/                  # CLI utilities (postectl, etc.)
├── .github/workflows/ci.yml
├── .gitignore
├── LICENSE
├── ONBOARDING.md           # step-by-step setup guide
└── README.md
```

---

## ⚙️ Configuration Reference

### `~/paseo-dash-data/hermes-api.env`
```bash
# Required: Telegram bot (from @BotFather)
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Required: Private channel for notifications (invite bot, get ID via @RawDataBot)
TELEGRAM_HOME_CHANNEL=-1001234567890

# Optional: Off-machine backup (rclone + age encryption)
BACKUP_RCLONE_REMOTE=oracle-storage:backups
BACKUP_AGE_RECIPIENT=age1...
```

### `~/paseo-dash-data/hosts.json` (machine registry)

The code reads a `hosts` array. `label` is the machine name shown in the dashboard; `url` is the daemon WebSocket; `password` is optional and stays on your machine.

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

Followed projects are separate: add them with `node tools/postectl.mjs project follow <host> <dir>` (see [ONBOARDING.md](ONBOARDING.md#5-add-a-project)).

### Dashboard Environment Variables
| Variable | Default | Description |
| :--- | :--- | :--- |
| `DASHBOARD_DATA_DIR` | `~/paseo-dash-data` | Data directory |
| `DASHBOARD_PORT` | `7070` | HTTP/WS port |
| `DASHBOARD_TAILSCALE` | `0` | Enable Tailscale listener (1=yes) |
| `DASHBOARD_TAILSCALE_USER` | — | Basic auth username (required if Tailscale=1) |
| `DASHBOARD_TAILSCALE_PASSWORD_FILE` | — | Path to password file (min 16 chars) |
| `DASHBOARD_HOSTS_FILE` | `~/paseo-dash-data/hosts.json` | Machine registry |
| `DASHBOARD_SELF_HOST` | `oracle` | This machine's name |

---

## 🔧 Development

```bash
# Run the dashboard locally
node dashboard/server.mjs

# Run the offline test suites
npm test
```

---

## 🛡️ Security

- **No secrets in repo** — all credentials via env files (gitignored)
- **Tailscale-only remote access** — never expose to public internet
- **Basic auth + rate limiting** on Tailscale endpoint
- **Row-level SQLite** for data isolation
- **Systemd hardening** — services run as user, no root

---

## 📄 License

MIT License.