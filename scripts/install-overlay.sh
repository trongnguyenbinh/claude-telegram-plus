#!/bin/sh
# Overlay this fork's server.ts, plus its skill and hook files ($EXTRAS below),
# onto the installed official telegram plugin, so the channel keeps its
# allowlisted identity (plugin:telegram@claude-plugins-official), its tool names
# (mcp__plugin_telegram_telegram__*) and every hook/permission that matches them.
#
#   scripts/install-overlay.sh                  # dry run: show what would change
#   scripts/install-overlay.sh --apply          # back up, then overlay
#   scripts/install-overlay.sh --apply --force  # overlay even if upstream changed
#   scripts/install-overlay.sh --rollback DIR   # put a backup's files back
#
# TARGET defaults to the user-scope install path from installed_plugins.json.
# Running sessions keep the old server until their MCP server restarts, and the
# old skill/hooks until the session restarts. The upstream skills (access,
# configure) are never touched.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
BACKUPS=$CLAUDE_DIR/plugins/telegram-plus-backups
EXTRAS="hooks/hooks.json hooks/telegram-progress.py skills/telegram-plus/SKILL.md"

target_from_registry() {
  python3 - "$CLAUDE_DIR/plugins/installed_plugins.json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
entries = d.get('plugins', d).get('telegram@claude-plugins-official', [])
user = [e for e in entries if e.get('scope') == 'user'] or entries
print(user[-1]['installPath'] if user else '')
EOF
}

TARGET=${TARGET:-$(target_from_registry)}
[ -n "$TARGET" ] && [ -f "$TARGET/server.ts" ] || { echo "no installed telegram plugin found (TARGET=$TARGET)"; exit 1; }

if [ "${1:-}" = "--rollback" ]; then
  src=${2:?usage: --rollback BACKUP_DIR}
  [ -f "$src/server.ts" ] || { echo "no server.ts in $src"; exit 1; }
  cp "$src/server.ts" "$TARGET/server.ts"
  # an extra missing from the backup did not exist when the backup was taken
  for f in $EXTRAS; do
    if [ -f "$src/$f" ]; then
      mkdir -p "$TARGET/$(dirname "$f")"; cp "$src/$f" "$TARGET/$f"
    else
      rm -f "$TARGET/$f"; rmdir "$TARGET/$(dirname "$f")" 2>/dev/null || true
    fi
  done
  rm -f "$TARGET/.telegram-plus"
  echo "rolled back $TARGET (server.ts, skill, hooks) from $src"
  exit 0
fi

APPLY=0; FORCE=0
for a in "$@"; do
  case $a in --apply) APPLY=1 ;; --force) FORCE=1 ;; *) echo "unknown arg $a"; exit 2 ;; esac
done

cd "$REPO"
installed_ver=$(python3 -c "import json;print(json.load(open('$TARGET/.claude-plugin/plugin.json'))['version'])")
base_tag=$(git describe --tags --abbrev=0 --match 'upstream-*' upstream 2>/dev/null || echo upstream-0.0.7)
fork_sha=$(git rev-parse --short HEAD)
fork_ver=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
dirty=$(git status --porcelain -- server.ts $EXTRAS)

echo "target:        $TARGET (plugin version $installed_ver)"
echo "fork:          $fork_ver $fork_sha${dirty:+ (uncommitted changes)}  base $base_tag"

extras_differ=
for f in $EXTRAS; do cmp -s "$TARGET/$f" "$f" || extras_differ="$extras_differ $f"; done

if cmp -s "$TARGET/server.ts" server.ts; then
  [ -n "$extras_differ" ] || { echo "status:        already the fork's server.ts, skill and hooks, nothing to do"; exit 0; }
  echo "status:        server.ts is current, skill/hook files differ:$extras_differ"
else
  target_blob=$(git hash-object "$TARGET/server.ts")
  if git show "$base_tag:server.ts" | cmp -s - "$TARGET/server.ts"; then
    echo "status:        target is pristine $base_tag, safe to overlay"
  elif prev=$(git log --format=%h main -- server.ts | while read -r c; do
        [ "$(git rev-parse "$c:server.ts")" = "$target_blob" ] && { echo "$c"; break; }; done) && [ -n "$prev" ]; then
    echo "status:        target is an older fork build ($prev), safe to update"
  else
    echo "status:        target server.ts is NOT $base_tag (plugin updated upstream, or edited)."
    echo "               Merge the new upstream first (RESTORE.md, section 3), or pass --force."
    [ $FORCE = 1 ] || exit 3
  fi
fi
[ "upstream-$installed_ver" = "$base_tag" ] || echo "warning:       installed version $installed_ver differs from fork base $base_tag"

[ $APPLY = 1 ] || { echo "dry run. Re-run with --apply to back up and overlay."; exit 0; }

ts=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUPS/$ts"
cp "$TARGET/server.ts" "$TARGET/.claude-plugin/plugin.json" "$BACKUPS/$ts/"
for f in $EXTRAS; do
  [ ! -f "$TARGET/$f" ] || { mkdir -p "$BACKUPS/$ts/$(dirname "$f")"; cp "$TARGET/$f" "$BACKUPS/$ts/$f"; }
done
cp server.ts "$TARGET/server.ts"
for f in $EXTRAS; do mkdir -p "$TARGET/$(dirname "$f")"; cp "$f" "$TARGET/$f"; done
printf 'version=%s fork=%s base=%s installed=%s at=%s\n' "$fork_ver" "$fork_sha" "$base_tag" "$installed_ver" "$ts" > "$TARGET/.telegram-plus"
echo "backup:        $BACKUPS/$ts"
echo "done. server.ts: restart the telegram MCP server (/mcp Reconnect). Skill and hooks: restart the session."
echo "rollback:      scripts/install-overlay.sh --rollback $BACKUPS/$ts"
