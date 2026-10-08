#!/usr/bin/env bash
# Install the opencode `bg` background-command tool into a user's opencode config,
# and install the "long-running commands" convention into instructions.md as a
# managed block (re-runs update it in place).
# Idempotent and non-interactive: safe to run from an AI agent or CI.
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
FORCE=0
SKIP_INSTRUCTIONS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --skip-instructions) SKIP_INSTRUCTIONS=1; shift ;;
    -h|--help)
      echo "Usage: install.sh [--config-dir <dir>] [--force] [--skip-instructions]"
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

# ---- 1. Install bg.js ----
CHANGED=0
if [ -f "$TARGET" ] && cmp -s "$SOURCE" "$TARGET"; then
  info "bg.js is already up to date."
else
  if [ -f "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
    BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$TARGET" "$BACKUP"
    warn "Existing bg.js backed up to: $BACKUP"
    warn "Pass --force to overwrite without a backup."
  fi
  cp "$SOURCE" "$TARGET"
  CHANGED=1
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
fi

# ---- 2. Install (or update) the convention in instructions.md ----
# The snippet is wrapped in BEGIN/END markers. On re-run we replace just that
# block, so snippet updates stay in sync. A legacy unmarked section is migrated
# once; otherwise we append a fresh block.
if [ "$SKIP_INSTRUCTIONS" -ne 1 ]; then
  SNIPPET="$SCRIPT_DIR/instructions-snippet.md"
  INSTRUCTIONS="$CONFIG_DIR/instructions.md"
  BEGIN="<!-- BEGIN opencode-bg convention -->"
  END="<!-- END opencode-bg convention -->"
  LEGACY="长时命令后台执行约定"

  if [ ! -f "$SNIPPET" ]; then
    warn "instructions-snippet.md not found; skipped instructions.md update."
  elif [ -f "$INSTRUCTIONS" ] && grep -qF "$BEGIN" "$INSTRUCTIONS" && grep -qF "$END" "$INSTRUCTIONS"; then
    TMP="$INSTRUCTIONS.tmp.$$"
    awk -v begin="$BEGIN" -v end="$END" -v snip="$SNIPPET" '
      $0 == begin { while ((getline line < snip) > 0) print line; close(snip); skip = 1; next }
      skip && $0 == end { skip = 0; next }
      skip { next }
      { print }
    ' "$INSTRUCTIONS" > "$TMP"
    if cmp -s "$TMP" "$INSTRUCTIONS"; then
      rm -f "$TMP"
      info "instructions.md convention block is already up to date."
    else
      mv "$TMP" "$INSTRUCTIONS"
      CHANGED=1
      info "Updated the managed convention block in instructions.md."
    fi
  elif [ -f "$INSTRUCTIONS" ] && grep -qF "$LEGACY" "$INSTRUCTIONS"; then
    TMP="$INSTRUCTIONS.tmp.$$"
    awk -v legacy="$LEGACY" -v snip="$SNIPPET" '
      index($0, legacy) && $0 ~ /^#/ {
        while ((getline line < snip) > 0) print line
        close(snip); print ""; inblock = 1; next
      }
      inblock && /^#/ { inblock = 0 }
      inblock { next }
      { print }
    ' "$INSTRUCTIONS" > "$TMP"
    mv "$TMP" "$INSTRUCTIONS"
    CHANGED=1
    info "Migrated the legacy convention in instructions.md to a managed block."
  else
    if [ ! -f "$INSTRUCTIONS" ] || [ ! -s "$INSTRUCTIONS" ]; then
      printf '' > "$INSTRUCTIONS"
    else
      printf '\n\n' >> "$INSTRUCTIONS"
    fi
    cat "$SNIPPET" >> "$INSTRUCTIONS"
    CHANGED=1
    info "Appended the long-running-commands convention to instructions.md."
  fi
fi

info ""
if [ "$CHANGED" -eq 1 ]; then
  info "Done. Restart opencode for the tool to take effect."
else
  info "Nothing changed. If opencode is running, restart it to (re)load the tool."
fi
info "After restart you get five tools: bg_start, bg_logs, bg_list, bg_restart, bg_stop."
