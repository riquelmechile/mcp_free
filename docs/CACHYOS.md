# Notas específicas de CachyOS

## KDE Plasma y Wayland

CachyOS suele usar KDE Plasma sobre Wayland. En ese entorno:

- `spectacle` captura pantalla.
- `wl-copy`/`wl-paste` operan el portapapeles.
- `kdotool` consulta y activa ventanas mediante KWin.
- `ydotool` inyecta mouse y teclado mediante `/dev/uinput`.
- `xdotool` sólo es fallback útil en una sesión X11.

`ydotool` requiere el daemon persistente `ydotoold` y permisos sobre `/dev/uinput`. El script `setup-desktop-control.sh` crea un grupo dedicado `uinput`, una regla udev y activa el servicio de usuario incluido por el paquete Arch. La pertenencia al grupo requiere cerrar sesión y volver a entrar.

## Variables de sesión gráfica

El servicio MCP corre como servicio systemd de usuario, no como root. El instalador importa:

- `DISPLAY`
- `WAYLAND_DISPLAY`
- `XDG_CURRENT_DESKTOP`
- `XDG_SESSION_TYPE`
- `DBUS_SESSION_BUS_ADDRESS`

Tras cambiar de sesión gráfica, ejecute:

```bash
systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE DBUS_SESSION_BUS_ADDRESS
systemctl --user restart mcp-free
```

## Gentle AI 2.2.2

Instalación exacta reproducible:

```bash
go install github.com/gentleman-programming/gentle-ai/v2/cmd/gentle-ai@v2.2.2
gentle-ai version
```

Después configure Gentle AI normalmente para OpenCode/Codex y ejecute `gentle-ai doctor`. MCP Free no sustituye esos agentes; les agrega una ruta para que ChatGPT web pueda invocar herramientas del computador y aplica el mismo enfoque de evidencia/recibos.
