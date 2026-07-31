# MCP Free para CachyOS

Servidor privado **Model Context Protocol (MCP)** para que ChatGPT inspeccione y opere un computador CachyOS mediante herramientas locales gobernadas, OpenAI Secure MCP Tunnel y recibos tamper-evident.

En desarrollo, **ChatGPT es el único modelo y orquestador**. El servidor no lanza OpenCode, Codex CLI, Claude Code, Gemini CLI, Ollama ni otro LLM. Los llamados “subagentes” son tres carriles lógicos de recopilación de evidencia; no son tres modelos independientes.

```text
inspeccionar → dividir → despachar → observar → sintetizar → aplicar → verificar → finalizar
```

## Qué cambió en 0.5.0

- `workspace` ya no expone una terminal ni un ejecutor genérico.
- Lecturas y escrituras validan raíces físicas, rechazan symlinks y usan `O_NOFOLLOW`.
- Hasta tres workers continúan después de responder `development_parallel_inspect`.
- Los procesos se ejecutan en grupos completos; timeout y cancelación terminan también los descendientes.
- Cada carril terminal genera un hash de evidencia y un receipt encadenado.
- Un lock compartido evita pérdidas de actualización entre coordinador, reportes y estado central.
- Un lease persistente protege el worktree desde el parche hasta la verificación/finalización.
- La verificación compara fingerprints completos antes y después de los tests.
- Se añadieron listado, reanudación, cancelación, aborto y limpieza de orquestaciones.
- La instalación falla seguro en `observe` por defecto.

## Arquitectura de los tres carriles

```text
ChatGPT despacha una sola vez
        │
        └── development_parallel_inspect responde inmediatamente
                 │
                 ├── lane-1 / explore: queued → running → completed
                 ├── lane-2 / design:  queued → running → completed
                 └── lane-3 / review:  queued → running → completed

ChatGPT vuelve mediante status/wait/result, registra cada reporte y sintetiza.
```

El que permanece ejecutándose es `mcp-free.service`, no ChatGPT. El coordinador persiste progreso comando por comando y expone estados:

- `queued`
- `running`
- `completed`
- `failed`
- `interrupted`
- `cancelled`

Un reinicio o pérdida de worker nunca se presenta como éxito. El carril debe reanudarse explícitamente.

## Modos

### `observe` — predeterminado

- estado del sistema y procesos;
- archivos dentro de `MCP_ALLOWED_ROOTS`;
- pantalla, ventanas y portapapeles;
- estado, lista y resultados de orquestaciones;
- receipts y verificación de la cadena.

No permite escritura.

### `workspace`

Incluye `observe` y añade únicamente:

- crear/reemplazar un archivo regular;
- parchear una coincidencia exacta;
- mover archivos/directorios sin seguir symlinks;
- el flujo gobernado de desarrollo.

**No existe `workspace_execute`.** Node, Python, npm, npx, Git mutante, `find -delete`, `sed -i` y lanzadores de agentes no pueden saltarse el flujo mediante una herramienta genérica.

### `full`

Añade shell arbitraria, procesos, aplicaciones y control de escritorio con los permisos del usuario Linux. Cada shell/proceso requiere aprobación explícita y los leases activos bloquean esas acciones salvo override deliberado.

`full` debe tratarse como control remoto completo. Úselo sólo con una cuenta dedicada, VM o equipo aislado.

## Herramientas de desarrollo

| Herramienta | Propósito |
|---|---|
| `development_status` | Inspeccionar Git, contexto, verificaciones y política. |
| `development_orchestration_list` | Recuperar IDs persistidos. |
| `development_orchestration_start` | Congelar baseline y crear 1–3 carriles. |
| `development_parallel_inspect` | Validar, encolar y retornar inmediatamente. |
| `development_orchestration_status` | Leer estado central y workers. |
| `development_orchestration_wait` | Esperar un cambio de revisión hasta 30 s. |
| `development_lane_result` | Leer progreso/output con evidencia validada. |
| `development_lane_report` | Registrar síntesis de un carril completado. |
| `development_orchestration_resume` | Reanudar carriles failed/interrupted/cancelled. |
| `development_orchestration_cancel` | Cancelar grupos de procesos o abortar todo. |
| `development_apply_patch` | Aplicar parche acotado bajo lease. |
| `development_verify` | Ejecutar checks bajo lease y fingerprint estable. |
| `development_finalize` | Revalidar bytes, cerrar y liberar lease. |
| `development_orchestration_cleanup` | Limpiar estado antiguo sin borrar receipts. |

## Flujo recomendado

```text
1. development_status
2. development_orchestration_start (3 carriles)
3. development_parallel_inspect
4. development_orchestration_wait/status
5. development_lane_result + development_lane_report por carril completed
6. development_orchestration_resume si uno falla o se interrumpe
7. sintetizar un único parche
8. pedir aprobación → development_apply_patch(confirm=true)
9. pedir aprobación → development_verify(confirm=true)
10. development_finalize
```

Prompt sugerido:

```text
Trabaja en ~/code/Msl como único modelo y orquestador.
No uses OpenCode, Codex, Claude, Gemini, Ollama ni otro modelo.

Crea tres carriles: explore, design y review. Despáchalos con
`development_parallel_inspect`, conserva la revisión y coordina mediante
`status/wait/result`. Registra cada reporte al terminar su worker, aunque los
otros sigan. Reanuda cualquier carril fallido o interrumpido. Sintetiza tú
mismo un parche mínimo. Pide una aprobación para aplicarlo y otra para tests.
No hagas commit ni push.
```

## Protección del worktree

Antes de aplicar:

- rama, HEAD y estado deben coincidir con el baseline;
- todos los workers deben estar `completed` y sus receipts válidos;
- todos los reportes deben existir;
- `git apply --check` debe pasar;
- no se aceptan binarios, symlinks, submódulos, `.git`, credenciales ni escapes;
- archivos previamente sucios requieren aprobación específica.

Al aplicar se adquiere un lease persistente. Las otras herramientas de escritura lo respetan. La verificación calcula un fingerprint de:

- rama y HEAD;
- estado Git;
- índice completo;
- bytes y modos de todos los archivos rastreados;
- bytes y modos de archivos no rastreados no ignorados.

Los fingerprints pre/post deben coincidir. Una verificación fallida libera el lease para corregir; una exitosa lo conserva hasta `development_finalize`.

## Instalación

```bash
git clone https://github.com/riquelmechile/mcp_free.git
cd mcp_free
./scripts/install-cachyos.sh --observe --desktop-control
```

Compruebe:

```bash
./scripts/doctor.sh
curl -s http://127.0.0.1:8787/healthz | jq
journalctl --user -u mcp-free -n 100 --no-pager
```

Para habilitar desarrollo:

```bash
./scripts/install-cachyos.sh --workspace --desktop-control
```

Después actualice/escanee nuevamente las herramientas de la app MCP en ChatGPT.

La salud de 0.5.0 incluye:

```json
{
  "reasoningModel": "ChatGPT",
  "externalModels": false,
  "persistentLaneCoordinator": true,
  "maximumParallelLanes": 3,
  "arbitraryWorkspaceExecution": false,
  "evidenceBoundLaneReceipts": true,
  "persistentWorktreeLeases": true,
  "processGroupTermination": true
}
```

## Secure MCP Tunnel

El servidor escucha por defecto sólo en:

```text
http://127.0.0.1:8787/mcp
```

Configure el túnel con:

```bash
export CONTROL_PLANE_API_KEY='sk-...'
./scripts/setup-secure-tunnel.sh tunnel_0123456789abcdef0123456789abcdef
unset CONTROL_PLANE_API_KEY
```

Un bind no-loopback sin `MCP_AUTH_TOKEN` es rechazado al iniciar.

## Seguridad y receipts

Cada acción gobernada crea un receipt con:

- secuencia;
- hash del receipt anterior;
- ID derivado del contenido;
- hash propio;
- acción, riesgo, resultado y duración;
- hash del output cuando corresponde.

`execution_receipts_verify` detecta edición, eliminación, reordenamiento, archivos faltantes/huérfanos y chain head incoherente. Es evidencia tamper-evident, no almacenamiento físicamente inmutable. Para resistir a un usuario local comprometido, replique el estado a almacenamiento append-only/WORM fuera del host.

Mantenga:

```text
MCP_HOST=127.0.0.1
MCP_MODE=observe o workspace
MCP_ALLOW_SECRETS=0
```

Consulte [docs/SECURITY.md](docs/SECURITY.md) y [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Desarrollo del servidor

```bash
npm ci
npm run check
npm run build
MCP_MODE=observe npm start
```

## Licencia

MIT. El flujo adopta ideas operativas de desarrollo guiado por evidencia, pero no depende de Gentle AI ni de sus modelos/agentes.

## Command and test isolation (0.6.0)

Workspace and observe development tools accept logical executable names only. The server resolves them to root-owned, non-writable binaries below `/usr` or `/usr/local`; inputs such as `/tmp/git`, `./git`, and user-controlled PATH replacements are rejected. Each supported command has a closed argument grammar, and path-bearing options cannot escape the project.

Inspection commands run in a read-only Bubblewrap namespace. Verification commands run in a writable worktree namespace with an empty environment, a temporary HOME, no MCP state mount, no credentials, no network by default, and no access to the rest of the user's home. Workspace mode refuses to start if sandbox bypass is requested. Networked or unsandboxed verification is available only in full mode and remains equivalent to arbitrary code execution.

The local receipt chain is an operational tamper detector, not protection against a hostile process already controlling the same Linux account. Receipt appends are serialized across service instances and fsynced, while stronger adversarial guarantees still require a dedicated OS user or external append-only storage.

