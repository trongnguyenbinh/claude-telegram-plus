#!/bin/sh
# Runs the "default ..." / "upstream ..." tests against the pristine upstream
# server.ts (latest upstream-* tag on the upstream branch), patched only to honour TELEGRAM_API_ROOT so it
# talks to the offline mock. Same expectations must pass on both servers.
set -e
cd "$(dirname "$0")/.."
base=$(git describe --tags --abbrev=0 --match "upstream-*" upstream)
git show "$base:server.ts" \
  | sed 's|^const bot = new Bot(TOKEN)$|const bot = new Bot(TOKEN, { client: { apiRoot: process.env.TELEGRAM_API_ROOT } })|' \
  > .upstream-server.ts
grep -q 'apiRoot: process.env.TELEGRAM_API_ROOT' .upstream-server.ts || { echo "patch failed"; exit 1; }
trap 'rm -f .upstream-server.ts' EXIT
TG_SERVER=.upstream-server.ts bun test --timeout 20000 -t '^(default |upstream |permission-relay|normal group message|outbound gate)' "$@"
