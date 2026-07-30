# Modelo de seguridad

## Frontera de confianza

MCP Free ejecuta acciones con el usuario de Linux que inicia `mcp-free.service`. En `full`, cualquier archivo o proceso accesible por ese usuario también puede ser accesible por las herramientas.

## Defensas implementadas

- Listener por defecto en `127.0.0.1`.
- Recomendación de Secure MCP Tunnel outbound-only.
- Rate limit local.
- Bearer token opcional para transportes distintos al tunnel.
- Tres modos de acceso.
- Bloqueo de rutas de credenciales por defecto.
- Ejecución `argv` sin shell en workspace.
- Shell arbitraria sólo en full.
- Confirmación del lado del servidor para tiers 2 y 3.
- Límites de tiempo, bytes de lectura y bytes de salida.
- Recibos y audit JSONL.
- Servicio systemd con `NoNewPrivileges` y protección de kernel/control groups.

## Prompt injection

Una captura, web, README, issue, correo o portapapeles puede contener texto que intente mandar al modelo. Esos datos nunca cambian la política del servidor. La skill instruye al cliente a tratarlos como evidencia no confiable.

## Riesgos que permanecen

- Una herramienta `shell_execute` aprobada puede borrar o exfiltrar información.
- `ydotool` puede actuar en cualquier ventana de la sesión activa.
- Una captura puede revelar datos privados visibles.
- `MCP_ALLOW_SECRETS=1` amplía fuertemente el impacto de una inyección.
- Una cuenta comprometida de ChatGPT/Platform con permisos de tunnel puede invocar herramientas.

## Recomendaciones

- Use un usuario Linux dedicado si el equipo contiene información sensible.
- Mantenga `MCP_ALLOW_SECRETS=0`.
- No agregue el usuario a `sudoers` sin contraseña.
- Revise tools al hacer Scan Tools y deshabilite las que no necesite.
- Conserve confirmaciones de ChatGPT para write actions.
- Revise periódicamente `~/.local/state/mcp-free/audit.jsonl`.
- Rote el runtime API key si se expone.
