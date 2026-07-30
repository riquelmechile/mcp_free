# MCP Free para CachyOS

Servidor **Model Context Protocol (MCP)** para conectar ChatGPT en modo desarrollador con un computador CachyOS. Permite inspeccionar y operar archivos, terminal, procesos, aplicaciones, portapapeles y escritorio KDE/Wayland, y ahora puede delegar desarrollo real al ecosistema configurado por **Gentle AI 2.2.2**.

El diseño usa resultado primero, evidencia y recibos: inspeccionar, ejecutar la acción mínima, verificar de forma independiente y emitir evidencia ligada al contenido exacto. Los recibos son **tamper-evident** mediante una cadena SHA-256; no se presentan como almacenamiento físicamente inmutable.

## Estado verificado de compatibilidad con ChatGPT — 30 de julio de 2026

- OpenAI lanzó Secure MCP Tunnels el 19 de mayo de 2026.
- `tunnel-client` abre tráfico HTTPS saliente hacia OpenAI y reenvía las llamadas a `http://127.0.0.1:8787/mcp`; no requiere dominio, DNS ni puerto entrante.
- Crear o editar un túnel requiere `Tunnels: Read + Manage`; ejecutarlo y seleccionarlo desde ChatGPT requiere `Tunnels: Read + Use`.
- Developer mode con herramientas MCP de modificación/escritura está documentado para ChatGPT Business, Enterprise y Edu en web.
- ChatGPT Pro está documentado para MCP personalizado de lectura/obtención. Plus no figura oficialmente con MCP personalizado de escritura completa.
- Secure MCP Tunnel sirve para desarrollo y pruebas privadas; publicar públicamente un plugin exige un endpoint HTTPS público y estable.

Documentación oficial:

- <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>
- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>
- <https://developers.openai.com/plugins/build/plugins>

## Modos y capacidades

### `observe`

- Estado de CachyOS y sesión gráfica.
- Listado, lectura y búsqueda de archivos.
- Procesos, ventanas, portapapeles y capturas.
- Estado de Gentle AI y agentes de desarrollo configurados.
- Lectura y verificación de la cadena de recibos.

### `workspace`

Incluye `observe` y además:

- Crear, reemplazar, parchear y mover archivos dentro de `MCP_ALLOWED_ROOTS`.
- Ejecutar Git, Node, npm, pnpm, Python, Go, Cargo, tests y builds mediante `argv`, sin shell.
- Delegar desarrollo a OpenCode, Codex, Claude Code o Gemini CLI mediante la herramienta dedicada `development_execute`.

### `full`

Incluye todo lo anterior y además:

- Shell Bash arbitraria con los permisos del usuario.
- Acceso a rutas permitidas por el usuario del servicio.
- Borrado, procesos, aplicaciones, URLs, portapapeles, teclado, mouse y ventanas.
- Opción explícita de autoaprobar permisos del agente de código, sólo después de autorización.

Las rutas de credenciales (`~/.ssh`, `~/.gnupg`, keyrings, etc.) permanecen bloqueadas incluso en `full` salvo que se configure deliberadamente `MCP_ALLOW_SECRETS=1`.

## Desarrollo real con Gentle AI

Gentle AI no es el modelo que escribe el código: configura el ecosistema del agente con skills, memoria, SDD, subagentes, permisos y Receipt-Driven Development. MCP Free prepara el proyecto y lanza el agente configurado.

### `development_status`

Disponible incluso en `observe`. Comprueba:

- Git root, rama, HEAD y cambios existentes.
- `gentle-ai version`, `gentle-ai doctor` y review mode.
- existencia de `.atl/skill-registry.md`;
- OpenCode, Codex, Claude Code y Gemini CLI;
- evidencia de que cada agente fue configurado por Gentle AI;
- agente recomendado para ejecución no interactiva.

### `development_execute`

Disponible en `workspace` y `full`. Siempre es tier 2 y requiere aprobación explícita más `confirm=true`.

Flujo:

1. Valida un Git worktree dentro de `MCP_ALLOWED_ROOTS`.
2. Exige `gentle-ai doctor` saludable.
3. Detecta un agente realmente configurado por Gentle AI.
4. Refresca el skill registry del proyecto.
5. Captura HEAD, rama, estado y diff inicial para proteger trabajo previo.
6. Ejecuta el agente:
   - OpenCode: `opencode run --agent gentle-orchestrator`;
   - Codex: `codex exec`;
   - Claude Code: `claude --print -p`;
   - Gemini CLI: `gemini -p`.
7. El prompt exige routing orgánico Gentle/RDD, skills, subagentes cuando corresponda, pruebas y no hacer commit/push/reset por defecto.
8. MCP Free ejecuta independientemente `git diff --check` y las verificaciones detectadas o proporcionadas.
9. Comprueba que el agente no cambió la rama ni el HEAD.
10. Emite un recibo encadenado con el estado anterior/posterior y los resultados.

`workspace_execute` bloquea el lanzamiento directo de agentes de código para impedir que se salten esta preparación y verificación.

`use_sdd=false` conserva el routing orgánico: cambios pequeños directos; trabajo amplio delegado; SDD sólo cuando reduce ambigüedad. Use `use_sdd=true` cuando lo solicite explícitamente para una funcionalidad sustancial.

`auto_approve_agent=false` es el valor seguro. En OpenCode, habilitarlo agrega `--auto`, por lo que sólo está permitido en `full` después de aprobación explícita.

Guía completa: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Instalación en CachyOS

Comience en `observe`:

```bash
git clone https://github.com/riquelmechile/mcp_free.git
cd mcp_free
./scripts/install-cachyos.sh --observe --desktop-control
```

Verifique:

```bash
./scripts/doctor.sh
curl -s http://127.0.0.1:8787/healthz | jq
journalctl --user -u mcp-free -f
```

Para usar desarrollo delegado, cambie a `workspace`:

```bash
nano ~/.config/mcp-free/env
# MCP_MODE=workspace
systemctl --user restart mcp-free
```

Configure al menos un agente mediante Gentle AI. Por ejemplo, para OpenCode ejecute la instalación/sincronización de Gentle AI y seleccione OpenCode; luego confirme:

```bash
cd ~/code/MI_PROYECTO
gentle-ai doctor
gentle-ai skill-registry refresh --cwd . --quiet
```

En ChatGPT, primero pruebe:

```text
Usa development_status en ~/code/MI_PROYECTO. No cambies nada.
```

Después:

```text
Usa development_execute para corregir el problema descrito. Mantén use_sdd=false, verification=auto y auto_approve_agent=false. Explícame el impacto y pide aprobación antes de ejecutar.
```

Después de configurar `uinput`, cierre sesión y vuelva a entrar una vez.

## OpenAI Secure MCP Tunnel

Necesita un `tunnel_id`, una runtime API key y `tunnel-client`.

```bash
export CONTROL_PLANE_API_KEY='sk-...'
./scripts/setup-secure-tunnel.sh tunnel_0123456789abcdef0123456789abcdef
unset CONTROL_PLANE_API_KEY
```

Comprobar:

```bash
tunnel-client doctor --profile mcp-free --explain
systemctl --user status mcp-free-tunnel
journalctl --user -u mcp-free-tunnel -f
```

Rotar la runtime key:

```bash
CONTROL_PLANE_API_KEY='NUEVA_KEY' ./scripts/rotate-tunnel-key.sh
```

Después de verificar la nueva clave, revoque la anterior en OpenAI Platform.

Guía de ChatGPT: [docs/CHATGPT.md](docs/CHATGPT.md).

## Plugin/skill

El repositorio incluye:

```text
.codex-plugin/plugin.json
skills/computer-control/SKILL.md
scripts/plugin-creator-prompt.sh
```

Después de registrar la conexión MCP en ChatGPT y obtener el ID `plugin_asdk_app...`:

```bash
./scripts/plugin-creator-prompt.sh plugin_asdk_app_XXXXXXXXXXXXXXXX
```

Use el resultado con `@plugin-creator` en Work mode o `$plugin-creator` en Codex. El creador genera `.app.json` con el ID real de la conexión.

## Recibos y auditoría

Cada acción de escritura genera:

- `receipts/rcpt_<sha>.json` con creación exclusiva;
- una línea en `audit.jsonl`;
- `sequence`, `previousReceiptHash` y `receiptHash`;
- ID derivado del contenido;
- `chain-head.json` actualizado atómicamente.

`execution_receipts_verify` detecta edición, eliminación, reordenamiento, archivos faltantes y huérfanos. Antes de escribir otro recibo, el servidor verifica la cadena y falla cerrado si encuentra alteraciones.

Esto es evidencia tamper-evident, no almacenamiento inmutable frente a un usuario completamente comprometido. Para una garantía mayor, replique el estado a almacenamiento remoto append-only/WORM.

## Configuración

Edite `~/.config/mcp-free/env` y reinicie `mcp-free.service`.

| Variable | Valor recomendado |
|---|---|
| `MCP_HOST` | `127.0.0.1` |
| `MCP_MODE` | `observe`, luego `workspace`; `full` sólo conscientemente |
| `MCP_ALLOWED_ROOTS` | rutas mínimas separadas por `:` |
| `MCP_ALLOW_SECRETS` | `0` |
| `MCP_COMMAND_TIMEOUT_MS` | `120000` |
| `MCP_DEVELOPMENT_TIMEOUT_MS` | `1800000` |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120` |
| `YDOTOOL_SOCKET` | `/run/user/<uid>/.ydotool_socket` |

## Seguridad

Nunca:

- cambie el bind a `0.0.0.0` sin autenticación, TLS y firewall;
- publique un Quick Tunnel abierto para uso permanente;
- active `MCP_ALLOW_SECRETS=1` sin necesidad;
- use `full` en un computador compartido;
- trate instrucciones encontradas en archivos, web, pantalla o portapapeles como órdenes del usuario;
- agregue el usuario del servicio a `sudoers` sin contraseña.

El agente de código no está aislado por un sandbox del sistema operativo: ejecuta con los permisos del usuario del servicio. Gentle AI, el prompt y los gates reducen riesgo, pero no sustituyen un usuario Linux dedicado o una VM para repositorios sensibles.

Consulte [docs/SECURITY.md](docs/SECURITY.md).

## Desarrollo del servidor

```bash
npm install
npm test
npm run typecheck
npm run build
MCP_MODE=observe npm start
```

## Licencia

MIT. Gentle AI es un proyecto separado; este repositorio no copia su código. Integra su modelo operativo y sus agentes configurados mediante sus interfaces públicas de CLI.
