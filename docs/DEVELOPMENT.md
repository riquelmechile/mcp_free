# Desarrollo delegado con Gentle AI

`development_execute` es la ruta especializada para tareas de software. Gentle AI no es el modelo que escribe el código: configura OpenCode, Codex, Claude Code o Gemini CLI con skills, memoria, SDD, permisos y reglas de delegación. MCP Free prepara el proyecto y lanza uno de esos agentes no interactivos.

## Configuración reproducible en CachyOS

Instale y autentique primero el agente elegido. Después ejecute:

```bash
cd ~/code/mcp_free
./scripts/setup-gentle-development.sh opencode ~/code/MI_PROYECTO
systemctl --user restart mcp-free.service
```

También acepta `codex`, `claude-code` o `gemini-cli`.

El script:

1. verifica el binario del agente;
2. instala Go desde `pacman` cuando falta y exige Go 1.25.10 o superior;
3. instala exactamente Gentle AI `v2.2.2` en `~/.local/bin`;
4. ejecuta `gentle-ai install --agent ... --preset full-gentleman`;
5. sincroniza el agente con `--include-permissions`;
6. refresca el skill registry del proyecto;
7. termina con `gentle-ai doctor`.

Puede cambiar el pin de forma explícita mediante `GENTLE_AI_VERSION`, pero esta versión del MCP está validada contra `v2.2.2`.

## Flujo de ejecución

1. Resuelve y valida un Git worktree dentro de `MCP_ALLOWED_ROOTS`.
2. Lee la fuente autoritativa `~/.gentle-ai/state.json`; el agente debe aparecer en `installed_agents` y no puede existir `pending_sync=true`.
3. Ejecuta `gentle-ai doctor` y consulta `gentle-ai review mode status --cwd`.
4. Comprueba los archivos gestionados del agente, no sólo la existencia de su ejecutable.
5. Refresca `.atl/skill-registry.md` con `gentle-ai skill-registry refresh --cwd ... --quiet`.
6. Captura HEAD, rama, estado y diff inicial para proteger cambios previos.
7. Delega:
   - OpenCode: `opencode run --agent gentle-orchestrator`.
   - Codex: `codex exec`.
   - Claude Code: `claude --print -p`.
   - Gemini CLI: `gemini -p`.
8. El prompt exige routing orgánico Gentle/RDD, skills, subagentes cuando corresponda, pruebas y no hacer commit/push/reset por defecto.
9. MCP Free ejecuta independientemente `git diff --check` y verificaciones detectadas o indicadas.
10. Comprueba que rama y HEAD no cambiaron y registra un recibo encadenado con toda la evidencia.

## Seguridad

La herramienta es tier 2 y siempre exige `confirm=true`. `auto_approve_agent=false` es el valor normal. Para OpenCode, `--auto` sólo se habilita con `MCP_MODE=full` y aprobación explícita, porque acepta permisos que el agente habría preguntado. Las reglas `deny` del agente siguen aplicándose.

`workspace_execute` ya no permite iniciar OpenCode, Codex, Claude Code o Gemini CLI directamente. Esto evita saltarse la preparación Gentle, el estado autoritativo, la captura Git y la verificación.

El agente de código sigue ejecutándose con los permisos del usuario Linux del servicio. Para proyectos sensibles use un usuario dedicado, contenedor o VM; esta integración no afirma proporcionar un sandbox del sistema operativo.

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
