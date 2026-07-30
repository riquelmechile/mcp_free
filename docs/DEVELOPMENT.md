# Desarrollo nativo: ChatGPT como orquestador

MCP Free no ejecuta OpenCode, Codex, Claude Code, Gemini CLI ni otro modelo. **ChatGPT es el único cerebro**: decide, divide, interpreta evidencia, sintetiza el cambio y genera el parche. El servidor MCP aporta acceso local controlado, workers deterministas, estado persistente, verificación y recibos.

```text
inspeccionar → dividir → despachar → observar → sintetizar → aplicar → verificar → finalizar
```

## Qué permanece corriendo

ChatGPT no queda pensando como proceso de fondo después de responder. Quien permanece activo es el servicio local `mcp-free.service` y su coordinador de carriles.

El ciclo es:

```text
ChatGPT despacha 3 carriles
        │
        └── development_parallel_inspect devuelve inmediatamente
                 │
                 ├── worker lane-1: queued → running → completed
                 ├── worker lane-2: queued → running → completed
                 └── worker lane-3: queued → running → completed

ChatGPT consulta status/wait/result y sintetiza cada carril disponible.
```

El coordinador ejecuta hasta tres workers al mismo tiempo y persiste su progreso después de cada comando en:

```text
~/.local/state/mcp-free/orchestration-workers/<orchestration_id>/workers.json
```

Estados por carril:

- `queued`: validado y esperando capacidad;
- `running`: ejecutando comandos locales;
- `completed`: todos los comandos terminaron correctamente;
- `failed`: un comando falló o agotó el tiempo;
- `interrupted`: el servicio se reinició o perdió al worker antes de terminar.

Un reinicio no presenta un carril inconcluso como exitoso. Debe reencolarse explícitamente.

## Qué significa “tres subagentes”

Son tres carriles lógicos administrados por la misma conversación:

1. `explore`: arquitectura, archivos, dependencias y evidencia;
2. `design`: solución mínima, interfaces, invariantes y pruebas;
3. `review`: revisión adversarial de regresiones, seguridad y compatibilidad.

No son tres modelos independientes. La concurrencia real ocurre en los workers locales y sus comandos; ChatGPT sigue siendo el único razonamiento y la síntesis central.

## Herramientas de coordinación

### `development_orchestration_start`

Congela rama, HEAD y estado inicial, y crea uno a tres carriles.

### `development_parallel_inspect`

Valida y **encola** los carriles. No espera a que terminen. Devuelve un `revision` y un resumen del coordinador.

### `development_orchestration_status`

Devuelve inmediatamente el estado central y un resumen de carriles `queued`, `running`, `completed`, `failed` e `interrupted`.

### `development_orchestration_wait`

Hace long-poll acotado por hasta 30 segundos. Use `after_revision` con la última revisión conocida. Retorna cuando un carril inicia, avanza, termina, falla o se interrumpe. No detiene a los workers.

### `development_lane_result`

Lee un carril completo o el resultado de un comando concreto. Permite consumir `lane-1` cuando termina aunque `lane-2` y `lane-3` sigan ejecutándose.

### `development_lane_report`

Registra la síntesis de ChatGPT para un carril que terminó correctamente. Puede llamarse mientras otros workers continúan.

### `development_apply_patch`

Sólo permite aplicar cuando todos los workers configurados están `completed` y todos los carriles tienen reporte. Exige aprobación, baseline Git intacto y `git apply --check`.

### `development_verify` y `development_finalize`

Ejecutan comprobaciones aprobadas, ligan la verificación a los bytes del worktree y sólo finalizan si no cambió nada después.

## Flujo obligatorio

1. Llame `development_status` y lea el contexto relevante.
2. Cree la orquestación con `development_orchestration_start`.
3. Despache los tres carriles mediante una sola llamada a `development_parallel_inspect`.
4. Guarde el `revision` retornado.
5. Use `development_orchestration_wait` o `development_orchestration_status` para observar progreso.
6. Cuando aparezca un carril en `completed`, lea `development_lane_result`, razone sobre su evidencia y registre `development_lane_report`. Los otros pueden seguir corriendo.
7. Si un carril queda `failed` o `interrupted`, inspeccione el error y vuelva a encolarlo. No sintetice ese carril antes de completarlo.
8. Cuando los tres reportes estén listos, sintetice un único parche mínimo.
9. Explique archivos y riesgos y solicite aprobación antes de `development_apply_patch`.
10. Solicite otra aprobación antes de ejecutar scripts con `development_verify`.
11. Finalice con `development_finalize` y entregue todos los receipts.

## Prompt recomendado

```text
Actúa tú como orquestador de desarrollo en ~/code/Msl.
No uses OpenCode, Codex, Claude, Gemini ni ningún otro modelo.

1. Ejecuta development_status e inicia tres carriles.
2. Despáchalos con development_parallel_inspect y vuelve inmediatamente al rol de coordinador.
3. Conserva el revision retornado y usa development_orchestration_wait/status para observar avances.
4. Cuando termine un carril, lee development_lane_result y registra su development_lane_report aunque los otros sigan corriendo.
5. No apliques nada hasta que los tres workers estén completed y los tres reportes existan.
6. Sintetiza tú mismo un único parche mínimo.
7. Pide aprobación para aplicarlo y otra para tests/builds.
8. Finaliza y entrega todos los receipts.

No hagas commit ni push.
```

## SDD

`use_sdd=true` no inicia otro agente. Exige a ChatGPT producir propuesta, especificación, diseño y tareas durables antes del parche. Para correcciones pequeñas use `false`; para funcionalidades amplias o ambiguas use `true`.

## Límites reales

- ChatGPT no sigue razonando fuera de una ejecución del chat.
- El coordinador MCP y los workers locales sí continúan después de que la llamada de despacho responde.
- Los resultados persisten, pero los procesos no se reanudan automáticamente tras reiniciar el servicio: se marcan `interrupted` y deben reencolarse.
- Los carriles son roles lógicos del mismo ChatGPT, no contextos de modelo independientes.
- El MCP no contiene API keys de modelos ni invoca proveedores de IA.
- El flujo no hace commit, push ni PR automáticamente.
