#!/usr/bin/env bash
set -euo pipefail
systemctl --user disable --now mcp-free-tunnel.service 2>/dev/null || true
systemctl --user disable --now mcp-free.service 2>/dev/null || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/mcp-free.service"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/mcp-free-tunnel.service"
systemctl --user daemon-reload
printf 'Services removed. Configuration and receipts were preserved under ~/.config/mcp-free and ~/.local/state/mcp-free.\n'
