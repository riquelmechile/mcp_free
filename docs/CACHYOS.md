# Notas específicas de CachyOS

## KDE Plasma y Wayland

- `spectacle`: capturas.
- `wl-copy` / `wl-paste`: portapapeles.
- `kdotool`: consulta/foco de ventanas en KWin.
- `ydotool`: mouse y teclado mediante `/dev/uinput`.
- `xdotool`: fallback para X11.

`setup-desktop-control.sh` configura `ydotoold`, grupo y regla udev. Tras añadir el usuario al grupo, cierre sesión y vuelva a entrar.

## Variables de sesión

```bash
systemctl --user import-environment \
  DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE DBUS_SESSION_BUS_ADDRESS
systemctl --user restart mcp-free.service
```

## Instalación segura

La instalación predeterminada es `observe`:

```bash
./scripts/install-cachyos.sh --observe --desktop-control
```

Después de revisar `/healthz` y las herramientas expuestas, habilite desarrollo:

```bash
./scripts/install-cachyos.sh --workspace --desktop-control
```

No instale ni configure Gentle AI, OpenCode, Codex CLI, Claude Code o Gemini CLI para este flujo. ChatGPT es el único modelo; los tres carriles son workers locales deterministas.
