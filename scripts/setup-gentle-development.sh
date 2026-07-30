#!/usr/bin/env bash
set -euo pipefail

AGENT="${1:-opencode}"
PROJECT="${2:-}"
GENTLE_VERSION="${GENTLE_AI_VERSION:-v2.2.2}"

case "$AGENT" in
  opencode) AGENT_BINARY="opencode" ;;
  codex) AGENT_BINARY="codex" ;;
  claude-code) AGENT_BINARY="claude" ;;
  gemini-cli) AGENT_BINARY="gemini" ;;
  *)
    echo "Usage: $0 [opencode|codex|claude-code|gemini-cli] [project-directory]" >&2
    exit 2
    ;;
esac

if ! command -v pacman >/dev/null 2>&1; then
  echo "This setup script is only for CachyOS/Arch." >&2
  exit 1
fi

if ! command -v "$AGENT_BINARY" >/dev/null 2>&1; then
  echo "The selected coding agent is not installed or not on PATH: $AGENT_BINARY" >&2
  echo "Install and authenticate it first, then rerun this script." >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  sudo pacman -S --needed --noconfirm go
fi

GO_VERSION="$(go env GOVERSION | sed 's/^go//')"
if [[ "$(printf '%s\n' "1.25.10" "$GO_VERSION" | sort -V | head -n1)" != "1.25.10" ]]; then
  echo "Gentle AI $GENTLE_VERSION requires Go >= 1.25.10; found $GO_VERSION." >&2
  echo "Update CachyOS packages and rerun." >&2
  exit 1
fi

INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"

CURRENT_VERSION=""
if command -v gentle-ai >/dev/null 2>&1; then
  CURRENT_VERSION="$(gentle-ai version 2>/dev/null | awk '{print $2}' || true)"
fi

if [[ "$CURRENT_VERSION" != "${GENTLE_VERSION#v}" ]]; then
  echo "Installing Gentle AI $GENTLE_VERSION into $INSTALL_DIR..."
  GOBIN="$INSTALL_DIR" go install "github.com/gentleman-programming/gentle-ai/v2/cmd/gentle-ai@$GENTLE_VERSION"
fi

export PATH="$INSTALL_DIR:$HOME/go/bin:$PATH"
if ! command -v gentle-ai >/dev/null 2>&1; then
  echo "gentle-ai was installed but cannot be resolved on PATH." >&2
  exit 1
fi

INSTALLED_VERSION="$(gentle-ai version | awk '{print $2}')"
if [[ "$INSTALLED_VERSION" != "${GENTLE_VERSION#v}" ]]; then
  echo "Unexpected gentle-ai version on PATH: $INSTALLED_VERSION (expected ${GENTLE_VERSION#v})." >&2
  echo "Resolved binary: $(command -v gentle-ai)" >&2
  exit 1
fi

echo "Configuring $AGENT with Gentle AI $INSTALLED_VERSION..."
GENTLE_AI_NO_SELF_UPDATE=1 GENTLE_AI_YES=1 \
  gentle-ai install --agent "$AGENT" --preset full-gentleman

GENTLE_AI_NO_SELF_UPDATE=1 GENTLE_AI_YES=1 \
  gentle-ai sync --agent "$AGENT" --include-permissions

if [[ -n "$PROJECT" ]]; then
  PROJECT="$(realpath "$PROJECT")"
  git -C "$PROJECT" rev-parse --show-toplevel >/dev/null
  GENTLE_AI_NO_SELF_UPDATE=1 gentle-ai skill-registry refresh --cwd "$PROJECT" --quiet
fi

GENTLE_AI_NO_SELF_UPDATE=1 gentle-ai doctor

echo
echo "Gentle development configured."
echo "Agent: $AGENT ($AGENT_BINARY)"
echo "Gentle AI: $(command -v gentle-ai) ($INSTALLED_VERSION)"
if [[ -n "$PROJECT" ]]; then
  echo "Project registry: $PROJECT/.atl/skill-registry.md"
fi
echo "Restart mcp-free.service, then call development_status from ChatGPT."
