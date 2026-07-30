# Arquitectura

```text
ChatGPT web (developer-mode app)
        |
        | OpenAI-hosted tunnel endpoint
        v
OpenAI Secure MCP Tunnel
        |
        | outbound HTTPS / long polling
        v
tunnel-client (systemd --user)
        |
        | http://127.0.0.1:8787/mcp
        v
MCP Free Streamable HTTP server
        |
        +-- policy/risk classifier
        +-- path and secret boundary
        +-- filesystem/process/shell tools
        +-- KDE/Wayland adapters
        +-- Gentle AI / developer command integration
        +-- SHA-256 tamper-evident receipt chain
```

## Modos

- `observe`: sólo lectura y percepción.
- `workspace`: lectura, archivos y comandos acotados a roots permitidos.
- `full`: shell, procesos, filesystem completo y control GUI con privilegios del usuario.

## Cadena de recibos

Cada acción devuelve un ID derivado por SHA-256 y guarda:

- versión y número secuencial;
- hash del recibo anterior;
- hash propio;
- timestamp;
- tool/action;
- tier de riesgo;
- modo;
- target o argv;
- estado y exit code;
- hash del output o bytes resultantes;
- duración y detalles de backend.

La aplicación crea cada archivo con exclusión, agrega una línea al audit, sincroniza el descriptor y actualiza `chain-head.json` mediante rename atómico. Antes de aceptar otra acción, verifica la cadena completa, los archivos individuales y el chain head.

`execution_receipts_verify` detecta edición, eliminación, reordenamiento, archivos faltantes y archivos huérfanos. Una alteración bloquea nuevas escrituras hasta que el operador investigue.

Esta cadena es evidencia **tamper-evident**, no una firma externa ni almacenamiento físicamente inmutable. Un usuario local completamente comprometido puede borrar todo el estado; para resistir ese escenario se necesita exportación a almacenamiento append-only/WORM fuera del equipo.
