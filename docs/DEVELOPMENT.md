# Desarrollo nativo: ChatGPT como orquestador

ChatGPT planifica, interpreta y sintetiza. MCP Free sólo ejecuta herramientas deterministas, guarda estado y verifica evidencia.

```text
status → start → dispatch → wait/result → report → apply → verify → finalize
```

## Carriles

- `explore`: arquitectura y archivos.
- `design`: solución, invariantes y pruebas.
- `review`: regresiones, seguridad y carreras.

Son roles lógicos del mismo ChatGPT. La concurrencia real está en los comandos locales, no en tres modelos.

## Ciclo persistente

`development_parallel_inspect` retorna inmediatamente. `mcp-free.service` conserva hasta tres workers, progreso y outputs. ChatGPT vuelve mediante `development_orchestration_wait`, `status` y `lane_result`.

Estados: `queued`, `running`, `completed`, `failed`, `interrupted`, `cancelled`.

Cada estado terminal tiene:

- resultados completos;
- `evidenceSha256`;
- `terminalReceiptId`;
- validación contra la cadena antes de aceptar reportes.

## Recuperación

- `development_orchestration_list`: recuperar IDs.
- `development_orchestration_resume`: nuevo intento para failed/interrupted/cancelled.
- `development_orchestration_cancel`: terminar grupos de procesos; opcionalmente abortar todo.
- `development_orchestration_cleanup`: eliminar estado antiguo completado/abortado; conserva receipts.

## Aplicación y lease

`development_apply_patch` exige workers completados, reportes, baseline intacto, rutas seguras y aprobación. Al aplicar adquiere un lease persistente del worktree.

Las herramientas de archivo y las acciones arbitrarias de `full` respetan el lease. La verificación fallida lo libera para permitir una corrección; la exitosa lo mantiene hasta finalizar.

## Verificación

`development_verify` ejecuta checks aprobados y calcula fingerprint completo antes y después. Deben coincidir. El fingerprint incluye identidad Git, índice, estado y bytes de archivos rastreados/no ignorados.

`development_finalize` vuelve a calcularlo, cierra la orquestación y libera el lease.

## Flujo exacto

1. `development_status`.
2. `development_orchestration_start` con tres carriles.
3. `development_parallel_inspect` una vez.
4. Conservar `revision`.
5. `development_orchestration_wait(after_revision=...)`.
6. Por cada `completed`: `development_lane_result` y `development_lane_report`.
7. Para fallos/interrupciones: revisar y `development_orchestration_resume`.
8. Sintetizar un parche único.
9. Explicar riesgos y pedir aprobación.
10. `development_apply_patch(confirm=true)`.
11. Explicar ejecución de código y pedir aprobación.
12. `development_verify(confirm=true)`.
13. `development_finalize`.

No hacer commit/push/reset/clean/rebase dentro del flujo salvo solicitud separada.
