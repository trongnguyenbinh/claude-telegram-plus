#!/bin/sh
# One-command install of telegram-plus. Safe to re-run.
#
#   scripts/install.sh                                   # overlay the fork onto the installed plugin
#   scripts/install.sh --project DIR [--state-dir DIR]   # also turn on the progress hook +
#                                                        # typewriter for that project
#
# Needs the official plugin first: /plugin install telegram@claude-plugins-official
# Undo: the rollback command printed below (scripts/install-overlay.sh --rollback ...).
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
REGISTRY=$CLAUDE_DIR/plugins/installed_plugins.json

PROJECT=; STATE_DIR=
while [ $# -gt 0 ]; do
  case $1 in
    --project) PROJECT=${2:?--project needs a directory}; shift 2 ;;
    --state-dir) STATE_DIR=${2:?--state-dir needs a directory}; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown arg $1 (see --help)"; exit 2 ;;
  esac
done
[ -z "$STATE_DIR" ] || [ -n "$PROJECT" ] || { echo "--state-dir only makes sense with --project"; exit 2; }

echo "== 1/4 requirements"
missing=
for c in bun python3 git; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
[ -z "$missing" ] || { echo "missing:$missing (install them, then re-run)"; exit 1; }
echo "ok: bun python3 git"

echo "== 2/4 official telegram plugin"
if ! [ -f "$REGISTRY" ] || ! python3 - "$REGISTRY" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if d.get('plugins', d).get('telegram@claude-plugins-official') else 1)
EOF
then
  echo "telegram@claude-plugins-official is not installed. In Claude Code, run:"
  echo
  echo "  /plugin install telegram@claude-plugins-official"
  echo
  echo "then re-run this script."
  exit 1
fi
echo "ok: found in $REGISTRY"

echo "== 3/4 overlay server.ts"
"$REPO/scripts/install-overlay.sh"
"$REPO/scripts/install-overlay.sh" --apply
last=$(ls -1d "$CLAUDE_DIR/plugins/telegram-plus-backups"/*/ 2>/dev/null | tail -n 1)
if [ -n "$last" ]; then
  echo "latest backup: ${last%/}"
  echo "rollback:      $REPO/scripts/install-overlay.sh --rollback ${last%/}"
fi

echo "== 4/4 project settings"
if [ -n "$PROJECT" ]; then
  python3 "$REPO/scripts/enable-plus.py" "$PROJECT" "${STATE_DIR:-${TELEGRAM_STATE_DIR:-$CLAUDE_DIR/channels/telegram}}"
else
  echo "skipped (pass --project DIR to turn on the progress hook + typewriter)"
fi

echo
echo "Done. Restart each Telegram session so it loads the new server (and hooks):"
echo
echo "  claude --channels plugin:telegram@claude-plugins-official"
echo
echo "To keep a conversation, add --resume <session id>. /mcp reconnect reloads the server only, not hooks."
