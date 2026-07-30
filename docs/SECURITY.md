# Modelo de seguridad

## Frontera de confianza

MCP Free ejecuta acciones con el usuario de Linux que inicia `mcp-free.service`. En `full`, cualquier archivo o proceso accesible por ese usuario también puede ser accesible por las herramientas.

Secure MCP Tunnel protege el transporte y evita un listener público, pero no reduce los permisos locales del proceso MCP. Una cuenta de ChatGPT/Platform comprometida con acceso al túnel sigue siendo un riesgo.

## Defensas implementadas

- Listener por defecto y recomendado en `127.0.0.1`.
- Secure MCP Tunnel outbound-only para acceso privado.
- Rate limit local.
- Bearer token opcional para transportes privados distintos al tunnel.
- Modos `observe`, `workspace` y `full`.
- Bloqueo de rutas de credenciales por defecto con `MCP_ALLOW_SECRETS=0`.
- Ejecución `argv` sin shell en `workspace`.
- Shell arbitraria sólo en `full`.
- Confirmación del lado del servidor para tiers 2 y 3.
- Límites de tiempo, bytes de lectura y bytes de salida.
- Recibos ligados al contenido mediante cadena SHA-256.
- Verificación de secuencia, hash previo, hash propio, ID, archivo individual, audit log y chain head.
- Falla cerrada: no se agrega otro recibo cuando la cadena no verifica.
- Archivo de recibo creado con exclusión (`O_EXCL`) para impedir sobreescritura accidental.
- `audit.jsonl` abierto sólo en append por la aplicación y sincronizado antes de avanzar el chain head.
- Servicio systemd con `NoNewPrivileges` y protección de kernel/control groups.
- Runtime API key local guardada con permisos `0600` y reemplazo atómico.

## Qué significa tamper-evident

La cadena detecta:

- edición de un recibo;
- edición de una línea del audit;
- eliminación o reordenamiento de entradas;
- archivos de recibo faltantes;
- archivos huérfanos no presentes en el audit;
- chain head incoherente.

Compruebe desde MCP con:

```text
execution_receipts_verify
```

Los recibos **no son físicamente inmutables**. Un atacante que controle completamente el mismo usuario Linux puede borrar todo el directorio de estado, reemplazar el programa o manipular respaldos. Para evidencia resistente a ese escenario, exporte periódicamente `~/.local/state/mcp-free` a almacenamiento remoto append-only/WORM o a otra cuenta/host que el usuario del MCP no pueda modificar.

Si actualiza desde una versión con recibos antiguos sin cadena, la verificación los marcará como legado y bloqueará nuevas escrituras. Respalde el directorio antiguo y comience un estado nuevo; no lo borre sin conservar la evidencia que necesite.

## Runtime API key

La runtime API key permite que `tunnel-client` use el túnel asociado. Trátela como secreto:

- no la pegue en ChatGPT, issues, logs ni commits;
- no la deje exportada más tiempo del necesario;
- use `scripts/rotate-tunnel-key.sh` para reemplazarla localmente;
- rote periódicamente conforme a la política de su organización;
- rote inmediatamente si se expone, cambia el responsable o se pierde control del equipo;
- después de validar la clave nueva, revoque la anterior en OpenAI Platform.

Un intervalo de 60–90 días es una política local razonable, no un requisito oficial impuesto por OpenAI.

## Prompt injection

Una captura, web, README, issue, correo o portapapeles puede contener texto que intente mandar al modelo. Esos datos nunca cambian la política del servidor. La skill instruye al cliente a tratarlos como evidencia no confiable.

## Riesgos que permanecen

- Una herramienta `shell_execute` aprobada puede borrar o exfiltrar información.
- `ydotool` puede actuar en cualquier ventana de la sesión activa.
- Una captura puede revelar datos privados visibles.
- `MCP_ALLOW_SECRETS=1` amplía fuertemente el impacto de una inyección.
- Una cuenta comprometida de ChatGPT/Platform con `Tunnels: Read + Use` puede invocar herramientas.
- La confirmación del modelo no sustituye una cuenta Linux dedicada ni permisos mínimos.

## Recomendaciones

- Instale inicialmente con `MCP_MODE=observe`.
- Use un usuario Linux dedicado si el equipo contiene información sensible.
- Mantenga `MCP_HOST=127.0.0.1`.
- Mantenga `MCP_ALLOW_SECRETS=0`.
- No agregue el usuario a `sudoers` sin contraseña.
- Revise las herramientas al hacer Scan Tools y deshabilite las que no necesite.
- Conserve confirmaciones de ChatGPT para write actions.
- Ejecute periódicamente `execution_receipts_verify`.
- Respalde la cadena fuera del alcance del usuario MCP.
- Rote la runtime API key periódicamente y ante cualquier incidente.
