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
        +-- SHA-256 receipt ledger
```

## Modos

- `observe`: sólo lectura y percepción.
- `workspace`: lectura, archivos y comandos acotados a roots permitidos.
- `full`: shell, procesos, filesystem completo y control GUI con privilegios del usuario.

## Recibos

Cada acción devuelve un ID derivado por SHA-256 y guarda:

- timestamp;
- tool/action;
- tier de riesgo;
- modo;
- target o argv;
- estado y exit code;
- hash del output o bytes resultantes;
- duración y detalles de backend.

Los recibos no equivalen a una firma criptográfica externa, pero fijan una identidad verificable y una bitácora local útil para auditoría.
