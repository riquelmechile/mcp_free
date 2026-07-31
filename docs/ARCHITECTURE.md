# Arquitectura

```text
ChatGPT
  │
  │ Secure MCP Tunnel (HTTPS saliente)
  ▼
tunnel-client --user
  │ http://127.0.0.1:8787/mcp
  ▼
MCP Free
  ├── frontera física de rutas + bloqueo de secretos
  ├── herramientas específicas observe/workspace/full
  ├── coordinador persistente de hasta 3 workers
  ├── lock compartido por orquestación
  ├── leases persistentes por worktree
  ├── grupos de procesos cancelables
  ├── fingerprint completo de Git/worktree
  ├── adaptadores KDE/Wayland
  └── cadena SHA-256 de receipts
```

## Autoridades separadas

- **ChatGPT:** razonamiento, planificación, síntesis y juicio.
- **Coordinador MCP:** cola, ejecución determinista, persistencia y cancelación.
- **Estado central:** objetivo, baseline, carriles, reportes, parche y verificación.
- **Receipts:** evidencia encadenada de acciones y resultados terminales.

Los workers no son modelos. Ejecutan comandos de lectura acotados y persisten resultados.

## Concurrencia

Todas las mutaciones de una orquestación pasan por un lock único, también visible entre procesos. Esto evita que dos reportes o materializaciones simultáneas sobrescriban cambios anteriores.

Los workers usan una cola global de máximo tres ejecuciones. Cada comando se ejecuta en su propio grupo de procesos; timeout/cancelación terminan el grupo completo.

## Persistencia

```text
~/.local/state/mcp-free/
├── orchestrations/<id>/state.json
├── orchestrations/<id>/verification-fingerprint.json
├── orchestration-workers/<id>/workers.json
├── orchestration-locks/<id>.lock/
├── worktree-leases/<sha256(root)>.json
├── receipts/rcpt_<hash>.json
├── audit.jsonl
└── chain-head.json
```

Los archivos de estado se escriben mediante temporal + fsync + rename. Los receipts forman una cadena tamper-evident.

## Modos

- `observe`: percepción y lectura.
- `workspace`: archivos específicos y orquestación; sin ejecutor genérico.
- `full`: control arbitrario explícito; requiere confirmaciones y debe aislarse.
