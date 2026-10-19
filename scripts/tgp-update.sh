#!/bin/sh
# Pull the latest fork and overlay it onto the installed official telegram
# plugin when it moved on. Running sessions keep their server until the
# telegram MCP server restarts (tg-watchdog "reload_on_update" does that once
# the agent is idle).
#   scripts/tgp-update.sh
# exit 0: up to date, or updated (backup kept, see install-overlay.sh)
# exit 3: the installed server.ts is neither upstream nor a fork build (the
#         official plugin updated itself, or it was edited): nothing written,
#         merge the new upstream first (RESTORE.md)
set -eu
# braces: sh parses the whole body before git pull may rewrite this file
{
cd "$(dirname "$0")/.."
git pull --ff-only -q
rc=0
out=$(sh scripts/install-overlay.sh) || rc=$?
echo "$out" | grep -E '^(fork|status|warning):' || true
[ $rc = 0 ] || exit $rc
case $out in *"nothing to do"*) exit 0 ;; esac
sh scripts/install-overlay.sh --apply | grep -E '^(backup|rollback):'
exit 0
}
