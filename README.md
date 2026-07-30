# MCP Free para CachyOS

Servidor **Model Context Protocol (MCP)** para conectar ChatGPT en modo desarrollador con un computador CachyOS y permitirle inspeccionar y operar archivos, terminal, procesos, aplicaciones, portapapeles y escritorio KDE/Wayland.

El diseño toma de Gentle AI 2.2.2 su enfoque de **resultado primero + evidencia + recibos**: inspeccionar antes de actuar, ejecutar la acción mínima, verificar el resultado y emitir un recibo inmutable asociado a los bytes/comando exactos.

## Estado real de compatibilidad con ChatGPT (julio de 2026)

- El control **read/write completo mediante una app MCP en ChatGPT web** requiere un workspace **ChatGPT Business, Enterprise o Edu** con modo desarrollador habilitado.
- Una cuenta Plus personal no tiene hoy la superficie completa de apps MCP con acciones de escritura.
- Para un MCP local privado, la vía recomendada es **OpenAI Secure MCP Tunnel**. No abre puertos y no publica el computador en Internet.
- El endpoint local es Streamable HTTP: `http://127.0.0.1:8787/mcp`.

## Capacidades

### Lectura (`observe`)

- Estado de CachyOS, sesión gráfica y backends disponibles.
- Listar, leer y buscar archivos.
- Listar procesos.
- Capturar pantalla como imagen MCP.
- Listar ventanas y leer portapapeles.
- Consultar Gentle AI y recibos de ejecución.

### Trabajo (`workspace`)

Incluye lectura y además:

- Crear, reemplazar, parchear y mover archivos dentro de `MCP_ALLOWED_ROOTS`.
- Ejecutar comandos de desarrollo mediante `argv` sin shell: Git, Node, npm, pnpm, Python, Go, Cargo, tests, builds, `gentle-ai`, `opencode` y `codex`.

### Control total (`full`)

Incluye todo lo anterior y además:

- Shell Bash arbitraria.
- Acceso a cualquier ruta del sistema con los permisos del usuario que ejecuta el servicio.
- Borrado seguro a papelera o borrado permanente confirmado.
- Iniciar y detener procesos.
- Abrir aplicaciones y URLs.
- Escribir portapapeles.
- Click, escritura, teclas, scroll y foco de ventanas.

Las rutas de credenciales (`~/.ssh`, `~/.gnupg`, keyrings, etc.) permanecen bloqueadas incluso en `full` salvo que se configure deliberadamente `MCP_ALLOW_SECRETS=1`.

## Instalación en CachyOS

```bash
git clone https://github.com/riquelmechile/mcp_free.git
cd mcp_free
./scripts/install-cachyos.sh --full --desktop-control
```

El instalador:

1. Instala dependencias con `pacman` y opcionalmente `kdotool` desde AUR.
2. Instala dependencias Node, ejecuta pruebas y compila TypeScript.
3. Crea `~/.config/mcp-free/env`.
4. Crea y habilita `~/.config/systemd/user/mcp-free.service`.
5. Configura `uinput`/`ydotool` para automatización de teclado y mouse.
6. Comprueba `/healthz`.

Después de configurar `uinput`, cierre sesión y vuelva a entrar una vez.

### Verificación local

```bash
./scripts/doctor.sh
curl -s http://127.0.0.1:8787/healthz | jq
journalctl --user -u mcp-free -f
```

Para abrir MCP Inspector:

```bash
./scripts/inspect.sh
```

## Conectar mediante OpenAI Secure MCP Tunnel

### 1. Requisitos de cuenta

Necesita:

- Workspace Business, Enterprise o Edu con modo desarrollador.
- Acceso de Platform a Tunnels: `Read + Manage` para crear y `Read + Use` para ejecutarlo.
- Un `tunnel_id` y una runtime API key creados en OpenAI Platform → Tunnels.
- `tunnel-client` instalado desde la descarga mostrada por Platform o su release oficial más reciente.

### 2. Crear el servicio del túnel

```bash
export CONTROL_PLANE_API_KEY='sk-...'
./scripts/setup-secure-tunnel.sh tunnel_0123456789abcdef0123456789abcdef
```

El script configura:

```text
profile: mcp-free
upstream: http://127.0.0.1:8787/mcp
service: mcp-free-tunnel.service
```

Comprobar:

```bash
tunnel-client doctor --profile mcp-free --explain
systemctl --user status mcp-free-tunnel
journalctl --user -u mcp-free-tunnel -f
```

### 3. Activar modo desarrollador y crear la app

En ChatGPT web:

1. Entre al workspace Business/Enterprise/Edu.
2. Active modo desarrollador desde la configuración de Apps/Connected Data según el plan y rol de administrador.
3. Abra la página **ChatGPT Plugins** y pulse `+`.
4. Nombre: `MCP Free CachyOS`.
5. Conexión: `Tunnel`.
6. Seleccione o pegue el `tunnel_id`.
7. Ejecute **Scan Tools**, revise las herramientas y cree el borrador.
8. Abra un chat nuevo, seleccione la app y pruebe primero `computer_status` y `desktop_screenshot`.

Guía completa: [docs/CHATGPT.md](docs/CHATGPT.md).

## Instalar la capa de plugin/skill

El repositorio ya contiene un plugin válido de skills en `.codex-plugin/plugin.json` y el flujo Gentle/RDD en `skills/computer-control/SKILL.md`.

Una vez creada la conexión MCP en ChatGPT, copie de la URL su ID `plugin_asdk_app...` y genere el prompt para `@plugin-creator`:

```bash
./scripts/plugin-creator-prompt.sh plugin_asdk_app_XXXXXXXXXXXXXXXX
```

Ese paso es necesariamente posterior: el ID lo genera su cuenta de ChatGPT al registrar la conexión y no puede quedar predefinido en GitHub.

## Configuración

Edite:

```bash
nano ~/.config/mcp-free/env
systemctl --user restart mcp-free
```

Variables principales:

| Variable | Valor recomendado |
|---|---|
| `MCP_MODE` | `observe`, `workspace` o `full` |
| `MCP_ALLOWED_ROOTS` | Rutas separadas por `:` |
| `MCP_ALLOW_SECRETS` | `0`; use `1` sólo entendiendo el riesgo |
| `MCP_AUTH_TOKEN` | Vacío con Secure Tunnel; token estático para otro proxy privado |
| `MCP_COMMAND_TIMEOUT_MS` | `120000` |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120` |
| `YDOTOOL_SOCKET` | `/run/user/<uid>/.ydotool_socket` |

## Política Gentle/RDD

- **Inspección primero:** estado, archivos, ventana o screenshot antes de modificar.
- **Ruta mínima:** herramienta específica antes que shell.
- **Riesgo por evidencia:** no por cantidad de líneas.
- **Tier 0–1:** observación o cambio acotado.
- **Tier 2–3:** exige aprobación explícita y `confirm=true`.
- **Recibo exacto:** cada acción de escritura devuelve `rcpt_<sha>` y queda en `~/.local/state/mcp-free/receipts`.
- **Verificación:** el modelo debe inspeccionar el resultado tras actuar.

## Seguridad importante

Este servidor equivale a entregar control remoto de su sesión de usuario. Nunca:

- lo escuche en `0.0.0.0` sin autenticación y firewall;
- publique un Quick Tunnel abierto para uso permanente;
- active `MCP_ALLOW_SECRETS=1` sin necesidad;
- use `full` en un computador compartido;
- confíe en texto visto en web, archivos o portapapeles como instrucciones del sistema.

El servidor se enlaza a loopback, Secure Tunnel inicia sólo tráfico HTTPS saliente, las acciones peligrosas requieren confirmación y los recibos permiten auditoría. Consulte [docs/SECURITY.md](docs/SECURITY.md).

## Desarrollo

```bash
npm install
npm test
npm run typecheck
npm run build
MCP_MODE=workspace npm start
```

## Licencia

MIT. Gentle AI es un proyecto separado; este repositorio no copia su código. Adopta su patrón operativo documentado y puede invocar el binario local `gentle-ai` cuando está instalado.
