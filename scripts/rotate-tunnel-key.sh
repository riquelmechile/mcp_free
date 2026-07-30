#!/usr/bin/env bash
set -euo pipefail

PROFILE="${MCP_TUNNEL_PROFILE:-mcp-free}"
API_KEY="${CONTROL_PLANE_API_KEY:-}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mcp-free"
ENV_FILE="$CONFIG_DIR/tunnel.env"
UNIT="mcp-free-tunnel.service"

if [[ -z "$API_KEY" ]]; then
  echo "CONTROL_PLANE_API_KEY is required. Create a replacement runtime key first." >&2
  echo "Usage: CONTROL_PLANE_API_KEY='sk-...' $0" >&2
  exit 2
fi
if ! command -v tunnel-client >/dev/null 2>&1; then
  echo "tunnel-client is not installed." >&2
  exit 1
fi

umask 077
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
TEMP_FILE="$(mktemp "$CONFIG_DIR/tunnel.env.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT
printf 'CONTROL_PLANE_API_KEY=%s\n' "$API_KEY" > "$TEMP_FILE"
chmod 600 "$TEMP_FILE"
mv -f "$TEMP_FILE" "$ENV_FILE"
trap - EXIT

systemctl --user restart "$UNIT"
sleep 2
if ! systemctl --user is-active --quiet "$UNIT"; then
  echo "$UNIT failed after key rotation." >&2
  systemctl --user --no-pager --full status "$UNIT" >&2 || true
  exit 1
fi

tunnel-client doctor --profile "$PROFILE" --explain
cat <<'MESSAGE'
Runtime key replaced locally and the tunnel service restarted.
Now revoke the previous runtime key in OpenAI Platform. Do not retain old keys in shell history, backups, or notes.
MESSAGE
