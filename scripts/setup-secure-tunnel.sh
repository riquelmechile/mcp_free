#!/usr/bin/env bash
set -euo pipefail

PROFILE="mcp-free"
TUNNEL_ID="${1:-${TUNNEL_ID:-}}"
API_KEY="${CONTROL_PLANE_API_KEY:-}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mcp-free"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ -z "$TUNNEL_ID" ]]; then
  echo "Usage: CONTROL_PLANE_API_KEY=sk-... $0 tunnel_..." >&2
  exit 2
fi
if [[ -z "$API_KEY" ]]; then
  echo "CONTROL_PLANE_API_KEY is required." >&2
  exit 2
fi
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "Install tunnel-client from OpenAI Platform > Tunnels or the latest openai/tunnel-client release, then rerun." >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$UNIT_DIR"
chmod 700 "$CONFIG_DIR"
printf 'CONTROL_PLANE_API_KEY=%s\n' "$API_KEY" > "$CONFIG_DIR/tunnel.env"
chmod 600 "$CONFIG_DIR/tunnel.env"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile "$PROFILE" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-server-url "http://127.0.0.1:8787/mcp"

tunnel-client doctor --profile "$PROFILE" --explain

cat > "$UNIT_DIR/mcp-free-tunnel.service" <<UNIT
[Unit]
Description=OpenAI Secure MCP Tunnel for MCP Free
After=mcp-free.service network-online.target
Requires=mcp-free.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$CONFIG_DIR/tunnel.env
ExecStart=$(command -v tunnel-client) run --profile $PROFILE
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$CONFIG_DIR ${XDG_STATE_HOME:-$HOME/.local/state}

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now mcp-free-tunnel.service
sleep 2
systemctl --user --no-pager --full status mcp-free-tunnel.service || true

echo "Tunnel service enabled. In ChatGPT developer mode, create an app, choose Connection: Tunnel, and select/paste: $TUNNEL_ID"
