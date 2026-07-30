# MCP Free para CachyOS

Servidor **Model Context Protocol (MCP)** para conectar ChatGPT en modo desarrollador con un computador CachyOS y permitirle inspeccionar y operar archivos, terminal, procesos, aplicaciones, portapapeles y escritorio KDE/Wayland.

El diseño toma de Gentle AI 2.2.2 su enfoque de **resultado primero + evidencia + recibos**: inspeccionar antes de actuar, ejecutar la acción mínima, verificar el resultado y emitir evidencia ligada al contenido exacto. Los recibos son **tamper-evident** mediante una cadena SHA-256; no se presentan como físicamente inmutables.

## Estado verificado de compatibilidad con ChatGPT — 30 de julio de 2026

- OpenAI lanzó **Secure MCP Tunnels el 19 de mayo de 2026**.
- El túnel mantiene el MCP privado: `tunnel-client` abre tráfico HTTPS saliente y reenvía las llamadas al endpoint local. No requiere dominio, DNS ni puerto entrante.
- Crear o editar un túnel requiere `Tunnels: Read + Manage`; ejecutarlo y seleccionarlo desde ChatGPT requiere `Tunnels: Read + Use`.
- La documentación oficial específica de Developer mode ofrece MCP completo con herramientas de modificación/escritura a **ChatGPT Business, Enterprise y Edu en web**.
- **ChatGPT Pro** está documentado para MCP personalizado de lectura/obtención. La documentación oficial no incluye Plus entre los planes con MCP personalizado de escritura completa.
- Ver una sección general de Apps o Plugins en Plus no demuestra que el workspace permita registrar y ejecutar herramientas MCP de escritura. La comprobación práctica es revisar Developer mode y, al escanear herramientas, confirmar que ChatGPT admite las acciones `write` del servidor.
- Secure MCP Tunnel es adecuado para desarrollo y pruebas privadas. Para distribuir públicamente un plugin, OpenAI exige un endpoint HTTPS público y estable.

Documentación oficial:

- <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>
- <https://developers.openai.com/changelog>
- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>
- <https://developers.openai.com/plugins/build/plugins>

El endpoint local es:

```text
http://127.0.0.1:8787/mcp
```

## Capacidades

### Lectura (`observe`)

- Estado de CachyOS, sesión gráfica y backends disponibles.
- Listar, leer y buscar archivos.
- Listar procesos.
- Capturar pantalla como imagen MCP.
- Listar ventanas y leer portapapeles.
- Consultar Gentle AI.
- Listar, leer y verificar la cadena de recibos.

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

Comience en `observe`; no instale directamente en `full` salvo que ya haya probado el servidor y revisado sus herramientas.

```bash
git clone https://github.com/riquelmechile/mcp_free.git
cd mcp_free
./scripts/install-cachyos.sh --observe --desktop-control
```

Cuando esté conforme:

```bash
nano ~/.config/mcp-free/env
# Cambie MCP_MODE=observe por workspace o full.
systemctl --user restart mcp-free
```

El instalador:

1. Instala dependencias con `pacman` y opcionalmente `kdotool` desde AUR.
2. Instala dependencias Node, ejecuta pruebas y compila TypeScript.
3. Crea `~/.config/mcp-free/env`.
4. Crea y habilita `~/.config/systemd/user/mcp-free.service`.
5. Configura `uinput`/`ydotool` para automatización de teclado y mouse cuando se solicita.
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

### 1. Requisitos

- Workspace compatible con Developer mode y las acciones MCP que necesita.
- `Tunnels: Read + Manage` para crear el túnel.
- `Tunnels: Read + Use` para ejecutar/asociar el túnel.
- `tunnel_id` y runtime API key creados en OpenAI Platform.
- `tunnel-client` instalado desde OpenAI Platform o su release oficial.

### 2. Crear el servicio del túnel

No pegue la runtime API key en ChatGPT ni la guarde en el repositorio.

```bash
export CONTROL_PLANE_API_KEY='sk-...'
./scripts/setup-secure-tunnel.sh tunnel_0123456789abcdef0123456789abcdef
unset CONTROL_PLANE_API_KEY
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

### 3. Rotar la runtime API key

OpenAI recomienda rotar las API keys periódicamente. El proyecto no impone un intervalo oficial; adopte el de su organización —por ejemplo, 60–90 días— y rote inmediatamente ante exposición o cambio de responsables.

1. Cree una nueva runtime key en OpenAI Platform.
2. Sustitúyala localmente y reinicie el túnel:

```bash
CONTROL_PLANE_API_KEY='NUEVA_KEY' ./scripts/rotate-tunnel-key.sh
```

3. Verifique que el túnel funciona.
4. Revoque la clave anterior en Platform.

El script escribe el secreto de forma atómica con permisos `0600`, no conserva una copia de la clave anterior y no imprime la nueva clave.

### 4. Activar Developer mode y crear la app

En ChatGPT web:

1. Revise **Settings → Apps → Advanced Settings → Developer mode** o la ruta equivalente administrada por su workspace.
2. En Business, los administradores/owners pueden usar **Workspace Settings → Apps → Create**.
3. En Enterprise/Edu, el administrador debe conceder el acceso mediante RBAC.
4. Abra **ChatGPT Plugins**, pulse `+` y cree `MCP Free CachyOS`.
5. En Connection, seleccione `Tunnel` y el `tunnel_id`.
6. Ejecute **Scan Tools** y revise especialmente `shell_execute`, `filesystem_delete`, `process_stop` y las herramientas de escritorio.
7. Pruebe primero `computer_status`, `execution_receipts_verify` y `desktop_screenshot` en modo `observe`.

Guía completa: [docs/CHATGPT.md](docs/CHATGPT.md).

## Capa oficial de plugin/skill

Esta sección está respaldada por la documentación oficial de OpenAI Plugins; no es una convención inventada por este repositorio.

El repositorio contiene:

```text
.codex-plugin/plugin.json
skills/computer-control/SKILL.md
scripts/plugin-creator-prompt.sh
```

El flujo oficial es:

1. Registrar primero la conexión MCP en ChatGPT.
2. Copiar su ID técnico `plugin_asdk_app...`.
3. Generar el prompt:

```bash
./scripts/plugin-creator-prompt.sh plugin_asdk_app_XXXXXXXXXXXXXXXX
```

4. Usar el resultado con `@plugin-creator` en Work mode o `$plugin-creator` en Codex.
5. El creador genera `.app.json`, que enlaza el plugin con la conexión real de su cuenta.

El ID no puede predefinirse en GitHub porque lo genera la cuenta al registrar el MCP. Secure MCP Tunnel sirve para esta prueba privada; no convierte el endpoint en apto para publicación pública.

## Recibos y auditoría

Cada acción de escritura genera:

- un archivo exclusivo `receipts/rcpt_<sha>.json`;
- una línea append-only a nivel de aplicación en `audit.jsonl`;
- `sequence`;
- `previousReceiptHash`;
- `receiptHash`;
- ID derivado del contenido;
- `chain-head.json` actualizado atómicamente.

Verifique la cadena desde ChatGPT con `execution_receipts_verify`. La verificación detecta edición, eliminación, reordenamiento, archivos faltantes y archivos huérfanos. Antes de escribir otro recibo, el servidor verifica toda la cadena y **falla cerrado** si encuentra una alteración.

Esto aporta evidencia **tamper-evident**, no almacenamiento inmutable frente a un usuario completamente comprometido. Para evidencia más fuerte, copie periódicamente `~/.local/state/mcp-free` a almacenamiento remoto append-only/WORM.

Una instalación de la versión inicial con recibos antiguos sin cadena será marcada como legado y bloqueará nuevas escrituras. Respalde ese directorio y comience un estado nuevo antes de actualizar.

## Configuración

Edite:

```bash
nano ~/.config/mcp-free/env
systemctl --user restart mcp-free
```

| Variable | Valor recomendado |
|---|---|
| `MCP_HOST` | `127.0.0.1` |
| `MCP_MODE` | empezar en `observe`; subir a `workspace` o `full` conscientemente |
| `MCP_ALLOWED_ROOTS` | rutas mínimas separadas por `:` |
| `MCP_ALLOW_SECRETS` | `0` |
| `MCP_AUTH_TOKEN` | vacío con Secure Tunnel; token estático sólo para otro proxy privado |
| `MCP_COMMAND_TIMEOUT_MS` | `120000` |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120` |
| `YDOTOOL_SOCKET` | `/run/user/<uid>/.ydotool_socket` |

## Política Gentle/RDD

- **Inspección primero:** estado, archivos, ventana o screenshot antes de modificar.
- **Ruta mínima:** herramienta específica antes que shell.
- **Riesgo por evidencia:** no por cantidad de líneas.
- **Tier 0–1:** observación o cambio acotado.
- **Tier 2–3:** exige aprobación explícita y `confirm=true`.
- **Recibo exacto:** cada acción de escritura queda ligada a contenido, comando, resultado y cadena previa.
- **Verificación:** el modelo debe inspeccionar el resultado tras actuar.

## Seguridad importante

Este servidor equivale a entregar control remoto de su sesión de usuario. Nunca:

- cambie el bind de `127.0.0.1` a `0.0.0.0` sin diseñar autenticación, TLS y firewall;
- publique un Quick Tunnel abierto para uso permanente;
- active `MCP_ALLOW_SECRETS=1` sin necesidad;
- use `full` en un computador compartido;
- confíe en texto visto en web, archivos o portapapeles como instrucciones del sistema;
- agregue el usuario del servicio a `sudoers` sin contraseña.

Consulte [docs/SECURITY.md](docs/SECURITY.md).

## Desarrollo

```bash
npm install
npm test
npm run typecheck
npm run build
MCP_MODE=observe npm start
```

## Licencia

MIT. Gentle AI es un proyecto separado; este repositorio no copia su código. Adopta su patrón operativo documentado y puede invocar el binario local `gentle-ai` cuando está instalado.
