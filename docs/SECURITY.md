# Modelo de seguridad

## Frontera de confianza

MCP Free ejecuta acciones con el usuario Linux que inicia `mcp-free.service`. En `full`, cualquier archivo o proceso accesible por ese usuario también puede ser accesible por las herramientas.

Secure MCP Tunnel protege el transporte y evita un listener público, pero no reduce los permisos locales del proceso MCP. Una cuenta de ChatGPT/Platform comprometida con acceso al túnel sigue siendo un riesgo.

ChatGPT es el único modelo de razonamiento del flujo de desarrollo. Los tres carriles son roles lógicos y workers locales deterministas; el servidor no lanza otros modelos.

## Defensas generales

- Listener recomendado en `127.0.0.1`.
- Secure MCP Tunnel outbound-only.
- Rate limit local.
- Bearer token opcional para otros transportes privados.
- Modos `observe`, `workspace` y `full`.
- Bloqueo de credenciales con `MCP_ALLOW_SECRETS=0`.
- Ejecución `argv` sin shell en `workspace`.
- Shell arbitraria sólo en `full`.
- Confirmación del servidor para tiers 2 y 3.
- Límites de tiempo, lectura y salida.
- Servicio systemd con `NoNewPrivileges` y protección de kernel/control groups.
- Runtime API key local con permisos `0600` y reemplazo atómico.

## Defensas del orquestador de desarrollo

- Ninguna herramienta de desarrollo llama OpenCode, Codex CLI, Claude Code, Gemini CLI u otro LLM.
- `workspace_execute` bloquea explícitamente esos lanzadores.
- Máximo de tres carriles lógicos.
- Los comandos de inspección se ejecutan sin shell y con allowlist.
- Git de inspección permite únicamente subcomandos de lectura acotados.
- Se bloquean `git branch`, `remote`, `tag`, `reset`, salida a archivos, external diff, textconv y `--no-index`.
- Se bloquean preprocessors de ripgrep, ejecución de `fd`, seguimiento de symlinks, rutas absolutas, `..` y rutas con apariencia de credenciales.
- Los argumentos que existen se validan mediante `lstat` y `realpath` para impedir escapes por symlink.
- Cada carril necesita evidencia de inspección antes de aceptar su reporte.
- Todos los carriles configurados deben tener inspección y reporte antes de aplicar código.
- La orquestación congela rama, HEAD y estado inicial.
- Si el worktree cambia concurrentemente antes del parche, se rechaza la aplicación.
- El parche pasa por `git apply --check` antes de escribir.
- Se bloquean parches binarios, submódulos, symlinks, `.git`, credenciales y escapes de ruta.
- Se inspeccionan los componentes existentes de cada ruta para evitar atravesar symlinks.
- Los archivos que ya estaban sucios no pueden tocarse sin aprobación específica.
- Aplicar el parche y ejecutar tests/builds requieren confirmaciones tier 2 separadas.
- Las verificaciones personalizadas tienen allowlist y gramática acotada.
- Después de verificar, se calcula un fingerprint SHA-256 del estado Git, blobs del índice y bytes de archivos modificados/no rastreados.
- `development_finalize` falla si esos bytes cambian después de la verificación.
- La cadena de recibos debe estar sana antes de mutar el estado de la orquestación.

## Recibos tamper-evident

La cadena verifica:

- edición de un recibo;
- edición del audit;
- eliminación o reordenamiento;
- archivos faltantes o huérfanos;
- chain head incoherente.

Compruebe:

```text
execution_receipts_verify
```

Los recibos no son físicamente inmutables. Un atacante con control completo del mismo usuario Linux puede borrar el estado, reemplazar el programa o manipular respaldos. Para evidencia resistente, exporte `~/.local/state/mcp-free` a almacenamiento remoto append-only/WORM o a otra cuenta/host.

## Runtime API key

- No la pegue en ChatGPT, issues, logs ni commits.
- No la deje exportada más tiempo del necesario.
- Use `scripts/rotate-tunnel-key.sh`.
- Rote periódicamente y de inmediato ante exposición.
- Después de validar la clave nueva, revoque la anterior.

Un intervalo de 60–90 días es una política local sugerida, no un requisito oficial.

## Prompt injection

Una captura, web, README, issue, salida de terminal o portapapeles puede contener texto que intente mandar al modelo. Esos datos nunca cambian la política del servidor. La skill obliga a tratarlos como evidencia no confiable.

## Riesgos que permanecen

- Una herramienta `shell_execute` aprobada puede borrar o exfiltrar información.
- `ydotool` puede actuar en cualquier ventana de la sesión activa.
- Una captura puede revelar datos privados visibles.
- `MCP_ALLOW_SECRETS=1` amplía fuertemente el impacto.
- Una cuenta comprometida de ChatGPT/Platform con acceso al túnel puede invocar herramientas.
- Tests y builds ejecutan código del repositorio con el usuario Linux del servicio.
- Las confirmaciones y allowlists no sustituyen un usuario dedicado, contenedor o VM para código no confiable.
- Los tres carriles no son tres modelos independientes; son separaciones lógicas dentro del mismo ChatGPT.

## Recomendaciones

- Instale inicialmente con `MCP_MODE=observe`.
- Use `workspace` para desarrollo y reserve `full` para acciones que realmente lo necesiten.
- Use un usuario Linux dedicado si el equipo contiene información sensible.
- Mantenga `MCP_HOST=127.0.0.1` y `MCP_ALLOW_SECRETS=0`.
- No agregue el usuario a `sudoers` sin contraseña.
- Revise las herramientas al hacer Scan Tools y deshabilite las innecesarias.
- Conserve confirmaciones de ChatGPT para acciones de escritura.
- Ejecute periódicamente `execution_receipts_verify`.
- Respalde la cadena fuera del alcance del usuario MCP.
- Rote la runtime API key periódicamente y ante incidentes.
