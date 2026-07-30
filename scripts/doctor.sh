#!/usr/bin/env bash
set -u

fail=0
check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then printf 'OK   %s\n' "$label"
  else printf 'FAIL %s\n' "$label"; fail=1
  fi
}

check "Node >=22" bash -lc '[[ $(node -p "Number(process.versions.node.split(\".\")[0])") -ge 22 ]]'
check "npm" command -v npm
check "MCP service" systemctl --user is-active mcp-free.service
check "MCP health" curl -fsS http://127.0.0.1:8787/healthz
check "Screenshot backend" bash -lc 'command -v spectacle || command -v grim || command -v gnome-screenshot || command -v scrot'
check "Clipboard backend" bash -lc 'command -v wl-copy && command -v wl-paste'
check "Desktop input backend" bash -lc 'command -v ydotool || command -v xdotool'
check "Window backend" bash -lc 'command -v kdotool || command -v wmctrl || command -v hyprctl'
check "Gentle AI" command -v gentle-ai

if command -v tunnel-client >/dev/null 2>&1; then
  check "Tunnel profile" tunnel-client doctor --profile mcp-free
else
  printf 'WARN tunnel-client is not installed yet\n'
fi

exit "$fail"
