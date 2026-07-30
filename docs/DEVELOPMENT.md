# Desarrollo nativo: ChatGPT como orquestador

MCP Free no ejecuta OpenCode, Codex, Claude Code, Gemini CLI ni otro modelo. **ChatGPT es el único cerebro**: decide, divide el trabajo, interpreta evidencia, sintetiza el cambio y genera el parche. El servidor MCP aporta acceso local controlado, paralelismo determinista, estado, verificación y recibos.

La inspiración de Gentle AI se implementa como método operativo, no como dependencia de modelos:

```text
inspeccionar → dividir → explorar en paralelo → sintetizar → aplicar → verificar → finalizar
```

## Qué significa “tres subagentes”

En una app MCP de ChatGPT, el servidor no puede crear tres copias independientes de ChatGPT. MCP Free implementa **tres carriles lógicos** administrados por la misma conversación:

1. `explore`: arquitectura, archivos, dependencias y evidencia;
2. `design`: solución mínima, interfaces, invariantes y pruebas;
3. `review`: revisión adversarial de regresiones, seguridad y compatibilidad.

Cada carril conserva un brief, comandos de inspección, resultados y reporte independiente. `development_parallel_inspect` ejecuta los comandos locales de hasta tres carriles simultáneamente mediante concurrencia real del servidor. ChatGPT interpreta esos resultados por separado y luego los sintetiza.

## Flujo obligatorio

### 1. Estado del proyecto

```text
Usa development_status en ~/code/MI_PROYECTO. No cambies nada.
```

Devuelve:

- raíz Git, rama, HEAD y cambios existentes;
- archivos de contexto como `AGENTS.md`, `README.md` y `.atl/skill-registry.md`;
- verificaciones detectadas;
- contrato de orquestación: ChatGPT, cero modelos externos y máximo tres carriles.

### 2. Crear la orquestación

```text
Inicia una orquestación para corregir el problema con tres carriles y sin lanzar otros modelos.
```

ChatGPT llama `development_orchestration_start`. El MCP congela la identidad Git y el estado inicial, pero todavía no modifica el proyecto.

### 3. Inspección paralela

ChatGPT define comandos de lectura diferentes para cada carril y llama una vez a `development_parallel_inspect` con los tres. Sólo se aceptan comandos de inspección acotados y Git de lectura. Se bloquean:

- `git reset`, checkout, clean, commit y push;
- `sed -i`, `find -delete` y acciones `-exec`;
- rutas absolutas o que escapen con `..`;
- rutas con apariencia de credenciales.

### 4. Reportes separados

ChatGPT razona sobre cada resultado y llama `development_lane_report` para cada carril. El parche no puede aplicarse hasta que todos los carriles configurados tengan reporte.

### 5. Síntesis y parche

ChatGPT integra los tres reportes y crea un único parche Git. Antes de aplicar debe explicar los archivos y solicitar aprobación. `development_apply_patch`:

- exige `confirm=true`;
- verifica que rama, HEAD y estado sigan iguales al baseline;
- ejecuta `git apply --check` antes de aplicar;
- bloquea rutas sensibles y escapes;
- no permite tocar archivos que ya estaban sucios salvo aprobación explícita mediante `allow_touch_dirty=true`;
- registra hash SHA-256 del parche y rutas afectadas.

### 6. Verificación independiente

`development_verify` ejecuta siempre `git diff --check` y puede detectar o recibir verificaciones como:

- `npm/pnpm/yarn run check`;
- typecheck, tests y build;
- `go test ./...`;
- `cargo test`;
- `python -m pytest`.

Los scripts del repositorio son código ejecutable, por lo que esta etapa es tier 2 y exige una segunda aprobación con `confirm=true`.

### 7. Finalización

`development_finalize` sólo funciona cuando:

- todos los carriles entregaron reporte;
- la verificación independiente pasó;
- rama y HEAD siguen intactos.

Entrega el recibo gobernante de la ejecución.

## Uso recomendado desde ChatGPT

```text
Actúa tú como orquestador de desarrollo en ~/code/Msl.
No uses OpenCode, Codex, Claude, Gemini ni ningún otro modelo.

1. Inspecciona el proyecto.
2. Crea tres carriles: exploración, diseño y revisión adversarial.
3. Ejecuta sus inspecciones locales en paralelo.
4. Registra cada reporte por separado.
5. Sintetiza un parche mínimo.
6. Antes de aplicarlo, explícame archivos y riesgos y pide aprobación.
7. Verifica con los comandos detectados, pidiendo aprobación para ejecutar scripts.
8. Finaliza y entrégame todos los receipts.

No hagas commit ni push.
```

## SDD

`use_sdd=true` no inicia otro agente. Sólo indica a ChatGPT que debe producir artefactos durables de propuesta, especificación, diseño y tareas antes del parche. Para correcciones pequeñas use `false`; para funcionalidades amplias o ambiguas use `true`.

## Límites reales

- Los carriles son roles lógicos del mismo ChatGPT, no tres contextos de modelo independientes.
- La concurrencia garantizada ocurre en los comandos locales enviados en una sola llamada a `development_parallel_inspect`.
- El MCP no contiene API keys de modelos ni invoca proveedores de IA.
- El servidor no hace commit, push ni PR dentro del flujo de implementación.
- Para subagentes de modelo realmente independientes sería necesaria una superficie de producto/API que ofrezca multi-agent; no es una capacidad que el MCP pueda inventar por sí solo.
