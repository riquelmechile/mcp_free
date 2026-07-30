#!/usr/bin/env bash
set -euo pipefail
exec npx @modelcontextprotocol/inspector@latest "http://127.0.0.1:${MCP_PORT:-8787}${MCP_PATH:-/mcp}"
