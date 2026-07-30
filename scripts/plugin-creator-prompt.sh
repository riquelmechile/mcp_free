#!/usr/bin/env bash
set -euo pipefail
ID="${1:-}"
if [[ ! "$ID" =~ ^plugin_asdk_app_[A-Za-z0-9]+$ ]]; then
  echo "Usage: $0 plugin_asdk_app_..." >&2
  exit 2
fi
cat <<PROMPT
@plugin-creator create a plugin for ChatGPT and Codex using my MCP server connection $ID. Name it MCP Free CachyOS. Use the existing repository https://github.com/riquelmechile/mcp_free, preserve skills/computer-control/SKILL.md exactly as the governing workflow, and point the compatibility apps field to ./.app.json. ChatGPT must remain the sole reasoning model: the plugin must never launch OpenCode, Codex CLI, Claude Code, Gemini CLI, Ollama, or another LLM. Expose the ChatGPT-native development tools, including the three logical parallel lanes, bounded patch application, independent verification, and receipt finalization. Include a personal marketplace entry for local testing.
PROMPT
