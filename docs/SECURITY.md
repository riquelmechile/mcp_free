# Modelo de seguridad

## Frontera de confianza

MCP Free actúa con el usuario Linux de `mcp-free.service`. Secure MCP Tunnel protege el transporte, pero no reduce permisos locales. Mantenga el listener en loopback; un bind no-loopback sin bearer token es rechazado.

ChatGPT es el único modelo del flujo de desarrollo. Los workers no interpretan código ni llaman proveedores de IA.

## `observe`, `workspace` y `full`

- `observe`: lectura/percepción; es el modo predeterminado.
- `workspace`: herramientas de archivo específicas y flujo de desarrollo. No existe terminal genérica.
- `full`: shell y procesos arbitrarios. Es equivalente a control remoto del usuario Linux y sólo debe usarse en aislamiento.

## Frontera física de archivos

Las rutas se comparan lexical y físicamente contra `MCP_ALLOWED_ROOTS`.

- se valida el ancestro existente mediante `realpath`;
- se rechazan componentes symlink debajo de la raíz;
- lectura/escritura de archivos usa `O_NOFOLLOW`;
- el descriptor abierto se compara con `/proc/self/fd` antes de cambiar bytes;
- movimientos se anclan a descriptores de directorio;
- rutas de credenciales se rechazan lexical y físicamente;
- un lease activo bloquea otras escrituras sobre el worktree.

`MCP_ALLOW_SECRETS=1` desactiva una barrera importante y no debe usarse normalmente.

## Desarrollo gobernado

- máximo tres workers;
- comandos de inspección sin shell y con allowlist;
- Git sólo de lectura;
- `rg --pre`, seguimiento de symlinks y acciones `fd --exec` bloqueadas;
- cada terminal genera SHA-256 de evidencia y receipt encadenado;
- el estado terminal se rechaza si su hash/receipt no coincide;
- lock único por orquestación, incluso entre procesos;
- baseline de rama, HEAD y worktree;
- parche restringido y `git apply --check`;
- archivos previamente sucios requieren aprobación específica;
- lease persistente desde apply hasta finalize;
- fingerprint pre/post de todos los archivos rastreados y no ignorados;
- tests que modifican bytes gobernados hacen fallar la verificación;
- cancelación y timeout terminan el grupo completo de procesos.

## Confirmaciones

- tier 0: observación y evidencia.
- tier 1: metadatos y acciones reversibles acotadas.
- tier 2: parche, tests/builds, reemplazos, Trash, shell/proceso full.
- tier 3: borrado permanente y operaciones destructivas/privilegiadas.

Tier 2/3 requiere aprobación explícita y `confirm=true`. Shell/proceso en `full` siempre exige confirmación, incluso si el clasificador considera inocuo el texto.

## Receipts

La cadena verifica identidad, secuencia, enlace anterior, archivos individuales, audit y chain head. Los resultados terminales de carriles se enlazan a la misma cadena.

```text
execution_receipts_verify
```

La cadena no es una firma externa ni WORM. Un atacante que controla el usuario y binario puede borrar todo. Exporte el estado a otro host/cuenta append-only para resistencia adicional.

## Riesgos residuales

- tests/builds ejecutan código del repositorio con el usuario del servicio;
- `full` permite operaciones arbitrarias aprobadas;
- editores externos no obedecen leases, aunque el fingerprint detecta sus cambios;
- GUI puede actuar sobre una ventana equivocada si no se verifica foco/captura;
- un host o cuenta ChatGPT comprometidos superan la protección de aplicación.

Para código no confiable use un usuario dedicado, contenedor o VM. No agregue sudo sin contraseña.

## Command and test isolation (0.6.0)

Workspace and observe development tools accept logical executable names only. The server resolves them to root-owned, non-writable binaries below `/usr` or `/usr/local`; inputs such as `/tmp/git`, `./git`, and user-controlled PATH replacements are rejected. Each supported command has a closed argument grammar, and path-bearing options cannot escape the project.

Inspection commands run in a read-only Bubblewrap namespace. Verification commands run in a writable worktree namespace with an empty environment, a temporary HOME, no MCP state mount, no credentials, no network by default, and no access to the rest of the user's home. Workspace mode refuses to start if sandbox bypass is requested. Networked or unsandboxed verification is available only in full mode and remains equivalent to arbitrary code execution.

The local receipt chain is an operational tamper detector, not protection against a hostile process already controlling the same Linux account. Receipt appends are serialized across service instances and fsynced, while stronger adversarial guarantees still require a dedicated OS user or external append-only storage.

