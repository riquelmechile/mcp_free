#!/usr/bin/env bash
set -euo pipefail

if ! command -v ydotool >/dev/null 2>&1; then
  sudo pacman -S --needed --noconfirm ydotool
fi

sudo groupadd --force uinput
sudo usermod --append --groups uinput "$USER"
sudo tee /etc/udev/rules.d/80-mcp-free-uinput.rules >/dev/null <<'RULE'
KERNEL=="uinput", GROUP="uinput", MODE="0660", OPTIONS+="static_node=uinput"
RULE
sudo tee /etc/modules-load.d/mcp-free-uinput.conf >/dev/null <<'MODULE'
uinput
MODULE
sudo modprobe uinput
sudo udevadm control --reload-rules
sudo udevadm trigger --name-match=uinput || true

systemctl --user daemon-reload
systemctl --user enable --now ydotool.service || {
  echo "The packaged ydotool user service could not start yet." >&2
  echo "Log out and back in after the uinput group change, then run: systemctl --user enable --now ydotool.service" >&2
}

echo "Desktop input setup complete. A logout/login is required for the new uinput group membership."
echo "Expected socket: /run/user/$UID/.ydotool_socket"
