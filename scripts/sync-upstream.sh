#!/bin/sh
# Import a newer official telegram plugin onto the `upstream` branch so it can be
# merged into main. Source: the local marketplace checkout Claude Code keeps
# up to date (or pass another directory).
#
#   scripts/sync-upstream.sh [SRC_DIR]
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
SRC=${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/marketplaces/claude-plugins-official/external_plugins/telegram}
[ -f "$SRC/server.ts" ] || { echo "no server.ts in $SRC"; exit 1; }
ver=$(python3 -c "import json;print(json.load(open('$SRC/.claude-plugin/plugin.json'))['version'])")
cd "$REPO"
if git rev-parse -q --verify "refs/tags/upstream-$ver" >/dev/null; then
  echo "upstream-$ver already imported. Differences between that tag and $SRC (none = in sync):"
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  git archive "upstream-$ver" | tar -x -C "$tmp"
  diff -rq --exclude=node_modules --exclude=.in_use "$tmp" "$SRC" || true
  exit 0
fi
wt=$(mktemp -d)
trap 'git worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT
git worktree add -q "$wt" upstream
rsync -a --delete --exclude node_modules --exclude .in_use --exclude .git "$SRC/" "$wt/"
(cd "$wt" && git add -A && git commit -q -m "upstream: telegram plugin v$ver from anthropics/claude-plugins-official" && git tag "upstream-$ver")
echo "imported upstream-$ver on branch upstream:"
git diff --stat "upstream-$ver~1" "upstream-$ver"
echo
echo "next: git merge upstream   (resolve conflicts in server.ts, keep the telegram-plus blocks)"
echo "      bun test && scripts/test-upstream-compat.sh"
