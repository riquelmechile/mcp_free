# MCP Free para CachyOS

Servidor **Model Context Protocol (MCP)** para conectar ChatGPT con un computador CachyOS mediante OpenAI Secure MCP Tunnel. Permite inspeccionar y operar archivos, terminal, procesos, aplicaciones, portapapeles y KDE/Wayland.

Para desarrollo, **ChatGPT es el único modelo y el orquestador**. MCP Free no lanza OpenCode, Codex, Claude Code, Gemini, Ollama ni otro LLM. Implementa localmente un flujo inspirado en Gentle AI:

```text
inspeccionar → dividir → explorar en paralelo → sintetizar → aplicar → verificar → finalizar
```

Los recibos son tamper-evident mediante una cadena SHA-256. No se presentan como almacenamiento físicamente inmutable.

## Compatibilidad con ChatGPT — 30 de julio de 2026

- Secure MCP Tunnel mantiene el servidor privado en `127.0.0.1`; `tunnel-client` crea una conexión HTTPS saliente.
- El soporte MCP completo con escritura está documentado para ChatGPT Business, Enterprise y Edu en web.
- ChatGPT Pro está documentado para MCP personalizado de lectura/obtención; Plus no figura oficialmente con escritura MCP completa.
- Una app MCP puede permitir orquestaciones complejas, pero el protocolo no puede crear por sí solo copias independientes de ChatGPT.
- El multi-agent real de GPT-5.6 está documentado como beta de la Responses API, no como una garantía de las apps MCP dentro de una conversación normal de ChatGPT.

Documentación oficial:

- <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>
- <https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt>
- <https://developers.openai.com/api/docs/guides/latest-model>
- <https://developers.openai.com/plugins/build/plugins>

El endpoint local es:

```text
http://127.0.0.1:8787/mcp
```

## Modos

### `observe`

- Estado de CachyOS y sesión gráfica.
- Lectura y búsqueda de archivos.
- Procesos, ventanas, portapapeles y capturas.
- `development_status` y lectura de orquestaciones.
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

Cada carril conserva brief, comandos, resultados y reporte. `development_parallel_inspect` ejecuta los comandos locales de hasta tres carriles simultáneamente. ChatGPT interpreta cada carril y realiza la síntesis central.

### Herramientas

#### `development_status`

Disponible en `observe`. Devuelve:

- raíz Git, rama, HEAD y cambios existentes;
- archivos de contexto (`AGENTS.md`, `README.md`, `.atl/skill-registry.md`, etc.);
- verificaciones detectadas;
- política explícita: `reasoningModel=ChatGPT`, `externalModelLaunchers=false`, máximo tres carriles.

#### `development_orchestration_start`

Congela el baseline Git y crea entre uno y tres carriles. No modifica el proyecto ni lanza modelos.

#### `development_parallel_inspect`

Ejecuta en paralelo comandos de lectura diferentes por carril. Bloquea comandos mutantes, escapes de ruta y rutas con apariencia de credenciales.

#### `development_lane_report`

Guarda por separado la síntesis de ChatGPT para cada carril. No se puede aplicar el parche hasta que todos los carriles configurados tengan reporte.

#### `development_apply_patch`

Aplica un único parche Git generado por ChatGPT:

- requiere `confirm=true`;
- exige que rama, HEAD y estado no hayan cambiado desde el inicio;
- ejecuta `git apply --check` antes de escribir;
- protege archivos previamente sucios;
- registra hash SHA-256 y rutas afectadas.

#### `development_verify`

Ejecuta `git diff --check` y verificaciones detectadas o explícitas. Como tests/builds ejecutan código del repositorio, requiere otra aprobación con `confirm=true`.

#### `development_finalize`

Sólo finaliza cuando todos los carriles reportaron, la verificación pasó y la identidad Git sigue intacta.

Guía completa: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Prompt recomendado

```text
Actúa tú como orquestador de desarrollo en ~/code/Msl.
No uses OpenCode, Codex, Claude, Gemini ni ningún otro modelo.

1. Ejecuta development_status.
2. Crea tres carriles: exploración, diseño y revisión adversarial.
3. Ejecuta sus inspecciones locales en paralelo.
4. Registra cada reporte por separado.
5. Sintetiza tú mismo un parche mínimo.
6. Explícame archivos y riesgos y pide aprobación antes de aplicarlo.
7. Pide aprobación antes de ejecutar tests/builds.
8. Finaliza y entrégame todos los receipts.

No hagas commit ni push.
```

`use_sdd=true` sólo cambia el método de ChatGPT: exige propuesta, especificación, diseño y tareas durables antes del parche. No inicia otro agente.

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

Después cambie a `workspace`:

```bash
sed -i 's/^MCP_MODE=.*/MCP_MODE=workspace/' ~/.config/mcp-free/env
systemctl --user restart mcp-free.service
```

No necesita instalar Gentle AI ni autenticar otro agente para usar el flujo nativo.

Después de actualizar las herramientas del MCP, use **Refresh/Scan Tools** o vuelva a crear la app según los controles de su workspace: ChatGPT utiliza una instantánea aprobada de las herramientas.

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

La skill obliga a mantener a ChatGPT como único modelo, usar carriles separados, pedir aprobación para el parche y la ejecución de scripts, y finalizar sólo con evidencia.

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

MIT. Gentle AI es un proyecto separado. MCP Free adopta ideas operativas documentadas, pero la versión 0.3.0 no necesita su binario ni sus modelos/agentes para el flujo de desarrollo.
