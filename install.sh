#!/usr/bin/env bash
# Install the opencode `bg` background-command tool into a user's opencode config.
# Idempotent and non-interactive: safe to run from an AI agent or CI.
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: install.sh [--config-dir <dir>] [--force]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

info() { printf '\033[36m[bg-install] %s\033[0m\n' "$1"; }
warn() { printf '\033[33m[bg-install] %s\033[0m\n' "$1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/tools/bg.js"
TARGET_DIR="$CONFIG_DIR/tools"
TARGET="$TARGET_DIR/bg.js"

if [ ! -f "$SOURCE" ]; then
  echo "Source file not found: $SOURCE. Run this script from the repository root." >&2
  exit 1
fi

info "Config dir : $CONFIG_DIR"
info "Source     : $SOURCE"
info "Target     : $TARGET"

mkdir -p "$TARGET_DIR"

if [ -f "$TARGET" ] && cmp -s "$SOURCE" "$TARGET"; then
  info "bg.js is already up to date. Nothing to do."
  info "If opencode is running, restart it to (re)load the tool."
  exit 0
fi

if [ -f "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
  BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$TARGET" "$BACKUP"
  warn "Existing bg.js backed up to: $BACKUP"
  warn "Pass --force to overwrite without a backup."
fi

cp "$SOURCE" "$TARGET"
info "Installed bg.js."

if command -v node >/dev/null 2>&1; then
  if node --check "$TARGET" >/dev/null 2>&1; then
    info "Syntax check passed."
  else
    warn "Syntax check failed. The file may not load correctly."
  fi
else
  warn "node not found; skipped syntax check."
fi

info ""
info "Done. Restart opencode for the tool to take effect."
info "After restart you get two tools: bg_start and bg_stop."
