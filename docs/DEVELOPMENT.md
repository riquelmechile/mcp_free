# Desarrollo delegado con Gentle AI

`development_execute` es la ruta especializada para tareas de software. Gentle AI no es el modelo que escribe el código: configura OpenCode, Codex, Claude Code o Gemini CLI con skills, memoria, SDD, permisos y reglas de delegación. MCP Free prepara el proyecto y lanza uno de esos agentes no interactivos.

## Flujo

1. Resuelve y valida un Git worktree dentro de `MCP_ALLOWED_ROOTS`.
2. Ejecuta `gentle-ai doctor` y consulta `gentle-ai review mode status --cwd`.
3. Detecta un agente instalado y configurado por Gentle AI.
4. Refresca `.atl/skill-registry.md` con `gentle-ai skill-registry refresh --cwd ... --quiet`.
5. Captura HEAD, rama, estado y diff inicial para proteger cambios previos.
6. Delega:
   - OpenCode: `opencode run --agent gentle-orchestrator`.
   - Codex: `codex exec`.
   - Claude Code: `claude --print -p`.
   - Gemini CLI: `gemini -p`.
7. El prompt exige routing orgánico Gentle/RDD, skills, subagentes cuando corresponda, pruebas y no hacer commit/push/reset por defecto.
8. MCP Free ejecuta independientemente `git diff --check` y verificaciones detectadas o indicadas.
9. Registra un recibo encadenado con estado anterior/posterior, agente, comandos y hashes de salida.

## Seguridad

La herramienta es tier 2 y siempre exige `confirm=true`. `auto_approve_agent=false` es el valor normal. Para OpenCode, `--auto` sólo se habilita con `MCP_MODE=full` y aprobación explícita, porque acepta permisos que el agente habría preguntado.

`workspace_execute` ya no permite iniciar OpenCode, Codex, Claude Code o Gemini CLI directamente. Esto evita saltarse la preparación Gentle, la captura Git y la verificación.

## Ejemplos

Primero:

```text
Usa development_status en ~/code/Msl y dime si Gentle AI, gentle-orchestrator y las verificaciones están listos. No cambies nada.
```

Luego:

```text
Usa development_execute en ~/code/Msl para corregir el error de CI. Mantén use_sdd=false, verification=auto y auto_approve_agent=false. Antes de ejecutar explícame el impacto y pide mi aprobación.
```

Para una funcionalidad grande:

```text
Usa development_execute con use_sdd=true para diseñar e implementar la funcionalidad, preservando mis cambios actuales y sin hacer commit ni push.
```
