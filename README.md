# MCP Free para CachyOS

Servidor **Model Context Protocol (MCP)** para conectar ChatGPT con un computador CachyOS mediante OpenAI Secure MCP Tunnel. Permite inspeccionar y operar archivos, terminal, procesos, aplicaciones, portapapeles y KDE/Wayland.

Para desarrollo, **ChatGPT es el único modelo y el orquestador**. MCP Free no lanza OpenCode, Codex, Claude Code, Gemini, Ollama ni otro LLM. Implementa localmente un flujo inspirado en Gentle AI:

```text
inspeccionar → dividir → despachar → observar → sintetizar → aplicar → verificar → finalizar
```

La versión 0.4.0 incorpora un coordinador persistente: `development_parallel_inspect` encola hasta tres workers y devuelve inmediatamente; `mcp-free.service` continúa ejecutándolos y guardando progreso después de cada comando.

Los recibos son tamper-evident mediante una cadena SHA-256. No se presentan como almacenamiento físicamente inmutable.

## Compatibilidad con ChatGPT — 30 de julio de 2026

- Secure MCP Tunnel mantiene el servidor privado en `127.0.0.1`; `tunnel-client` crea una conexión HTTPS saliente.
- El soporte MCP completo con escritura está documentado para ChatGPT Business, Enterprise y Edu en web.
- ChatGPT Pro está documentado para MCP personalizado de lectura/obtención; Plus no figura oficialmente con escritura MCP completa.
- Una app MCP puede permitir orquestaciones complejas, pero el protocolo no crea por sí solo copias independientes de ChatGPT.
- ChatGPT no permanece razonando en segundo plano. Quien queda activo es el coordinador local del MCP.

Documentación oficial:

- <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>
- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>
- <https://developers.openai.com/api/docs/guides/latest-model>
- <https://developers.openai.com/plugins/build/plugins>

Endpoint local:

```text
http://127.0.0.1:8787/mcp
```

## Modos

### `observe`

- Estado de CachyOS y sesión gráfica.
- Lectura y búsqueda de archivos.
- Procesos, ventanas, portapapeles y capturas.
- `development_status`, estados de orquestación y resultados de carriles.
- Lectura y verificación de recibos.

### `workspace`

Incluye `observe` y además:

- Escritura, parcheo y movimiento dentro de `MCP_ALLOWED_ROOTS`.
- Git, Node, npm, pnpm, Python, Go, Cargo, tests y builds mediante `argv`, sin shell.
- Flujo completo de desarrollo nativo dirigido por ChatGPT.

### `full`

Incluye lo anterior y además shell, procesos, aplicaciones, URLs, portapapeles, teclado, mouse y ventanas con los permisos del usuario Linux.

Las credenciales (`~/.ssh`, `~/.gnupg`, keyrings, etc.) permanecen bloqueadas salvo que se configure deliberadamente `MCP_ALLOW_SECRETS=1`.

## Desarrollo: ChatGPT como orquestador

### Qué son los tres “subagentes”

Son **tres carriles lógicos del mismo ChatGPT**, no tres modelos:

1. `explore`: arquitectura, archivos y evidencia;
2. `design`: solución mínima, interfaces y pruebas;
3. `review`: revisión adversarial de seguridad y regresiones.

Los workers locales sí corren de forma concurrente y persistente. ChatGPT entra y sale del ciclo mediante herramientas de observación y conserva la síntesis central.

```text
ChatGPT: dispatch
     │
     └── MCP responde de inmediato
           ├── lane-1 queued/running/completed
           ├── lane-2 queued/running/completed
           └── lane-3 queued/running/completed

ChatGPT: status/wait → lane_result → lane_report
```

El progreso vive en:

```text
~/.local/state/mcp-free/orchestration-workers/<orchestration_id>/workers.json
```

Estados: `queued`, `running`, `completed`, `failed` e `interrupted`. Tras un reinicio, un worker inconcluso queda `interrupted` y debe reencolarse; nunca se informa como exitoso.

### Herramientas

#### `development_status`

Disponible en `observe`. Devuelve raíz Git, rama, HEAD, cambios existentes, archivos de contexto, verificaciones detectadas y el contrato `reasoningModel=ChatGPT`, `externalModelLaunchers=false`, máximo tres carriles.

#### `development_orchestration_start`

Congela el baseline Git y crea entre uno y tres carriles. No modifica el proyecto ni lanza modelos.

#### `development_parallel_inspect`

Valida, encola y devuelve inmediatamente. El coordinador residente ejecuta como máximo tres workers y persiste progreso después de cada comando.

#### `development_orchestration_status`

Devuelve al instante el estado central y las listas de workers en cola, ejecución, completados, fallidos o interrumpidos.

#### `development_orchestration_wait`

Long-poll acotado por revisión. Espera hasta 30 segundos por un cambio sin detener los workers.

#### `development_lane_result`

Lee el estado y los resultados de un carril, o un comando específico. Permite procesar un carril completado mientras los otros continúan.

#### `development_lane_report`

Guarda la síntesis de ChatGPT para un carril `completed`. Puede llamarse antes de que terminen los otros.

#### `development_apply_patch`

Aplica un único parche Git generado por ChatGPT:

- exige que todos los workers estén `completed` y todos los reportes existan;
- requiere `confirm=true`;
- verifica rama, HEAD y estado inicial;
- ejecuta `git apply --check`;
- protege archivos previamente sucios;
- registra SHA-256 y rutas afectadas.

#### `development_verify`

Ejecuta `git diff --check` y verificaciones aprobadas. Como tests/builds ejecutan código del repositorio, requiere otra aprobación con `confirm=true`.

#### `development_finalize`

Sólo finaliza cuando los carriles están completos y reportados, la verificación pasó y los bytes del worktree siguen coincidiendo con el fingerprint verificado.

Guía completa: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Prompt recomendado

```text
Actúa tú como orquestador de desarrollo en ~/code/Msl.
No uses OpenCode, Codex, Claude, Gemini ni ningún otro modelo.

1. Ejecuta development_status e inicia tres carriles.
2. Despáchalos con development_parallel_inspect; esa llamada debe volver inmediatamente.
3. Conserva el revision y usa development_orchestration_wait/status para seguir el progreso.
4. Cuando un carril quede completed, lee development_lane_result y registra su development_lane_report aunque los otros sigan running.
5. Reencola cualquier carril failed o interrupted.
6. No apliques nada hasta tener tres workers completed y tres reportes.
7. Sintetiza tú mismo un parche mínimo.
8. Pide aprobación para aplicarlo y otra para tests/builds.
9. Finaliza y entrega todos los receipts.

No hagas commit ni push.
```

`use_sdd=true` exige propuesta, especificación, diseño y tareas durables antes del parche. No inicia otro agente.

## Instalación en CachyOS

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

La salud de 0.4.0 informa:

```json
{
  "reasoningModel": "ChatGPT",
  "externalModels": false,
  "persistentLaneCoordinator": true,
  "maximumParallelLanes": 3
}
```

Después cambie a `workspace`:

```bash
sed -i 's/^MCP_MODE=.*/MCP_MODE=workspace/' ~/.config/mcp-free/env
systemctl --user restart mcp-free.service
```

No necesita instalar Gentle AI ni autenticar otro agente. Tras actualizar el MCP use **Refresh/Scan Tools** para aprobar las herramientas nuevas.

## OpenAI Secure MCP Tunnel

Necesita `tunnel_id`, runtime API key y `tunnel-client`:

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

Guía: [docs/CHATGPT.md](docs/CHATGPT.md).

## Plugin/skill

El repositorio incluye:

```text
.codex-plugin/plugin.json
skills/computer-control/SKILL.md
scripts/plugin-creator-prompt.sh
```

La skill mantiene a ChatGPT como único modelo, define el ciclo dispatch/status/wait/result/report, exige aprobación para parche y scripts, y finaliza sólo con evidencia.

## Recibos y auditoría

Cada acción genera:

- `receipts/rcpt_<sha>.json` con creación exclusiva;
- una línea en `audit.jsonl`;
- `sequence`, `previousReceiptHash` y `receiptHash`;
- ID derivado del contenido;
- `chain-head.json` actualizado atómicamente.

`execution_receipts_verify` detecta edición, eliminación, reordenamiento, archivos faltantes y huérfanos. Antes de escribir otro recibo, el servidor verifica la cadena y falla cerrado ante alteraciones.

Esto es tamper-evident, no inmutable ante un usuario totalmente comprometido. Para mayor garantía, replique el estado a almacenamiento remoto append-only/WORM.

## Configuración

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

Los tests y builds ejecutan código del repositorio con los permisos del usuario Linux. Para repositorios no confiables use un usuario dedicado, contenedor o VM.

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

MIT. Gentle AI es un proyecto separado. MCP Free adopta ideas operativas documentadas, pero la versión 0.4.0 no necesita su binario ni sus modelos/agentes.
