# Conectar MCP Free a ChatGPT web

Información verificada el **30 de julio de 2026** contra documentación oficial de OpenAI.

## Disponibilidad por plan

La documentación específica de Developer mode indica:

- MCP completo con herramientas de modificación/escritura: **ChatGPT Business, Enterprise y Edu**, en web.
- ChatGPT Pro: MCP personalizado limitado a lectura/obtención.
- Plus no aparece entre los planes con soporte oficial para MCP personalizado de escritura completa.

Fuente: <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>

## Modelo de ejecución

ChatGPT es el único modelo de razonamiento. MCP Free no necesita Gentle AI, OpenCode, Codex CLI, Claude Code, Gemini CLI ni API keys de otros modelos.

Los tres carriles de desarrollo son roles lógicos administrados por ChatGPT. El servidor puede ejecutar sus comandos locales de inspección simultáneamente, pero no crea tres copias de ChatGPT. El multi-agent real de GPT-5.6 está documentado como beta de la Responses API, no como una capacidad garantizada de una app MCP en un chat normal.

Fuente: <https://developers.openai.com/api/docs/guides/latest-model>

## Preparar el servidor

```bash
cd ~/code/mcp_free
git pull origin main
./scripts/install-cachyos.sh --observe --desktop-control
./scripts/doctor.sh
curl -s http://127.0.0.1:8787/healthz | jq
```

El endpoint debe permanecer en:

```text
http://127.0.0.1:8787/mcp
```

## Crear OpenAI Secure MCP Tunnel

1. Cree el túnel en OpenAI Platform.
2. Use `Tunnels: Read + Manage` para crear/editar.
3. Cree una runtime API key con `Tunnels: Read + Use`.
4. Instale `tunnel-client` desde la fuente oficial.
5. Ejecute:

```bash
export CONTROL_PLANE_API_KEY='sk-...'
./scripts/setup-secure-tunnel.sh tunnel_...
unset CONTROL_PLANE_API_KEY
```

Validación:

```bash
tunnel-client doctor --profile mcp-free --explain
systemctl --user is-active mcp-free.service
systemctl --user is-active mcp-free-tunnel.service
```

Fuente: <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>

## Habilitar Developer mode

### Business

Los administradores/owners pueden usar **Workspace Settings → Apps → Create** y habilitar Developer mode.

### Enterprise/Edu

El administrador concede acceso mediante RBAC. Después, el usuario lo activa en **Settings → Apps → Advanced Settings**.

La UI está en beta y puede cambiar.

## Registrar o actualizar la app

1. Cree una app personalizada llamada `MCP Free CachyOS`.
2. Connection: `Tunnel`.
3. Seleccione `tunnel_...`.
4. Ejecute **Scan Tools**.
5. Revise las acciones de escritura.
6. Pruebe primero en `observe`.

ChatGPT utiliza una instantánea aprobada de las herramientas. Después de actualizar MCP Free a v0.3.0 debe usar **Refresh/Scan Tools**, actualizar la app o volver a crearla según los controles de su workspace; las herramientas nuevas no aparecen automáticamente.

## Cambiar a workspace

```bash
sed -i 's/^MCP_MODE=.*/MCP_MODE=workspace/' ~/.config/mcp-free/env
systemctl --user restart mcp-free.service
```

Vuelva a escanear herramientas. Deben aparecer:

```text
development_status
development_orchestration_status
development_orchestration_start
development_parallel_inspect
development_lane_report
development_apply_patch
development_verify
development_finalize
```

## Prueba de lectura

```text
Usa computer_status y development_status en ~/code/MI_PROYECTO. No cambies nada. Confirma que reasoningModel sea ChatGPT, externalModelLaunchers sea false y maximumParallelLanes sea 3.
```

## Prueba de desarrollo

```text
Actúa tú como orquestador de desarrollo en ~/code/MI_PROYECTO.
No lances OpenCode, Codex, Claude, Gemini ni otro modelo.

Crea tres carriles lógicos: exploración, diseño y revisión.
Ejecuta sus inspecciones locales en paralelo.
Registra sus reportes por separado.
Sintetiza tú mismo un parche mínimo.
Pide mi aprobación antes de aplicar y antes de ejecutar tests/builds.
No hagas commit ni push.
Finaliza con recibos.
```

Flujo esperado:

1. `development_status`.
2. `development_orchestration_start`.
3. Una llamada a `development_parallel_inspect` con hasta tres carriles.
4. Un `development_lane_report` por carril.
5. Confirmación y `development_apply_patch`.
6. Confirmación y `development_verify`.
7. `development_finalize`.
8. `execution_receipts_verify`.

## Workspace Agent

Business y Enterprise pueden crear Workspace Agents conectados a apps y herramientas. Use [WORKSPACE_AGENT.md](WORKSPACE_AGENT.md) como instrucciones del agente y añada la app `MCP Free CachyOS` con confirmación obligatoria para aplicar parches y ejecutar verificaciones.

Fuente: <https://help.openai.com/en/articles/20001143>

## Rotar la runtime API key

```bash
CONTROL_PLANE_API_KEY='NUEVA_RUNTIME_KEY' ./scripts/rotate-tunnel-key.sh
```

Después de verificar el túnel, revoque la clave anterior en Platform.

## Plugin

Después de registrar la conexión MCP y obtener el ID `plugin_asdk_app_...`:

```bash
./scripts/plugin-creator-prompt.sh plugin_asdk_app_...
```

Use el resultado con `@plugin-creator` en Work mode o `$plugin-creator` en Codex. El plugin debe conservar `skills/computer-control/SKILL.md`, que obliga a mantener a ChatGPT como único modelo.
