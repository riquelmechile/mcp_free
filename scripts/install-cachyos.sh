#!/usr/bin/env bash
set -euo pipefail

MODE="workspace"
SETUP_DESKTOP=0
while (($#)); do
  case "$1" in
    --full) MODE="full" ;;
    --observe) MODE="observe" ;;
    --desktop-control) SETUP_DESKTOP=1 ;;
    -h|--help)
      cat <<'HELP'
Usage: ./scripts/install-cachyos.sh [--observe|--full] [--desktop-control]
  default             workspace mode (files/projects + approved developer commands)
  --observe           read-only inspection mode; recommended for first installation
  --full              full filesystem, shell, processes, apps, clipboard and GUI tools
  --desktop-control   install/configure KDE Wayland input automation through ydotool
HELP
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mcp-free"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/mcp-free"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="$CONFIG_DIR/env"

if ! command -v pacman >/dev/null 2>&1; then
  echo "This installer is only for CachyOS/Arch (pacman was not found)." >&2
  exit 1
fi

chmod +x "$ROOT_DIR"/scripts/*.sh

sudo pacman -S --needed --noconfirm \
  nodejs npm git ripgrep fd jq curl wl-clipboard spectacle xdg-utils trash-cli ydotool

if ! command -v kdotool >/dev/null 2>&1; then
  if command -v paru >/dev/null 2>&1; then paru -S --needed --noconfirm kdotool || true
  elif command -v yay >/dev/null 2>&1; then yay -S --needed --noconfirm kdotool || true
  else echo "Optional: install kdotool from AUR for better KDE Plasma window control." >&2
  fi
fi

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$UNIT_DIR"
chmod 700 "$CONFIG_DIR" "$STATE_DIR"

npm --prefix "$ROOT_DIR" install
npm --prefix "$ROOT_DIR" run check
npm --prefix "$ROOT_DIR" run build

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<ENV
MCP_HOST=127.0.0.1
MCP_PORT=8787
MCP_PATH=/mcp
MCP_MODE=$MODE
MCP_ALLOWED_ROOTS=$HOME/code:$HOME/Documents:$HOME/Downloads
MCP_ALLOW_SECRETS=0
MCP_AUTH_TOKEN=
MCP_MAX_READ_BYTES=1048576
MCP_MAX_OUTPUT_BYTES=262144
MCP_COMMAND_TIMEOUT_MS=120000
MCP_DEVELOPMENT_TIMEOUT_MS=1800000
MCP_RATE_LIMIT_PER_MINUTE=120
MCP_STATE_DIR=$STATE_DIR
MCP_LOG_LEVEL=info
YDOTOOL_SOCKET=/run/user/$UID/.ydotool_socket
ENV
  chmod 600 "$ENV_FILE"
else
  sed -i "s/^MCP_MODE=.*/MCP_MODE=$MODE/" "$ENV_FILE"
  grep -q '^MCP_DEVELOPMENT_TIMEOUT_MS=' "$ENV_FILE" || printf '\nMCP_DEVELOPMENT_TIMEOUT_MS=1800000\n' >> "$ENV_FILE"
fi

SERVICE_PATH="$HOME/.local/bin:$HOME/go/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/bin:/usr/bin"
cat > "$UNIT_DIR/mcp-free.service" <<UNIT
[Unit]
Description=MCP Free computer-control server for CachyOS
Documentation=https://github.com/riquelmechile/mcp_free
After=graphical-session.target network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=$SERVICE_PATH
ExecStart=$(command -v node) $ROOT_DIR/dist/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes
RestrictRealtime=yes

[Install]
WantedBy=default.target
UNIT

if (( SETUP_DESKTOP )); then
  "$ROOT_DIR/scripts/setup-desktop-control.sh"
fi

systemctl --user daemon-reload
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE DBUS_SESSION_BUS_ADDRESS || true
systemctl --user enable --now mcp-free.service
sleep 1

curl --fail --silent --show-error "http://127.0.0.1:8787/healthz" | jq .
echo
echo "Installed in mode: $MODE"
echo "Config: $ENV_FILE"
echo "Logs: journalctl --user -u mcp-free -f"
echo "Development setup: ./scripts/setup-gentle-development.sh opencode ~/code/MI_PROYECTO"
echo "Then restart mcp-free.service and call development_status before development_execute."
echo "Next: create an OpenAI Secure MCP Tunnel and run ./scripts/setup-secure-tunnel.sh"
