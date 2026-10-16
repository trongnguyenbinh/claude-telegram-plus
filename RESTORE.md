# Restoring telegram-plus after a plugin update

The fork runs by **overlaying its `server.ts` onto the installed official plugin**
(`telegram@claude-plugins-official`). The overlay keeps everything that depends
on the official identity:

- channels allowlist: `--channels plugin:telegram@claude-plugins-official` works with no
  `--dangerously-load-development-channels` dialog;
- tool names `mcp__plugin_telegram_telegram__*`, so existing hooks and permissions still match;
- state dir, `access.json`, `.env`: the fork reads the same files and changes none of them.

When Claude Code updates the plugin, it writes a fresh cache directory, which drops
the overlay. These steps put it back.

## 1. Check whether the overlay is still active

```bash
cd ~/Code/claude-telegram-plus
scripts/install-overlay.sh            # dry run, changes nothing
cat "$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json')));print([e for e in d['plugins']['telegram@claude-plugins-official'] if e['scope']=='user'][-1]['installPath'])")/.telegram-plus"
```

- `already the fork's server.ts`: the overlay is active, nothing to do.
- `target is pristine upstream-X`: the plugin was reinstalled at the same version. Go to step 2.
- `target server.ts is NOT upstream-X`: upstream shipped a new version. Go to step 3 first.

## 2. Re-apply (same upstream version)

```bash
scripts/install-overlay.sh --apply
```

The script backs up the current `server.ts` and `plugin.json` to
`~/.claude/plugins/telegram-plus-backups/<timestamp>/`, copies the fork's
`server.ts` in, and writes a `.telegram-plus` marker.

Sessions pick up the change only after their telegram MCP server restarts
(`/mcp` reconnect, or a session restart).

Rollback:

```bash
scripts/install-overlay.sh --rollback ~/.claude/plugins/telegram-plus-backups/<timestamp>
```

## 3. Upstream released a new version: merge it

```bash
scripts/sync-upstream.sh       # imports ~/.claude/plugins/marketplaces/.../external_plugins/telegram
git merge upstream             # conflicts, if any, are in server.ts
bun install && bun test        # offline suite against a mock Bot API
scripts/test-upstream-compat.sh  # default behaviour == pristine upstream
scripts/install-overlay.sh --apply
git push origin main upstream --tags
```

`sync-upstream.sh` commits the new upstream verbatim on the `upstream` branch and
tags it `upstream-<version>`. `main` holds the fork changes. Every fork addition in
`server.ts` sits in a block marked `telegram-plus`, which makes conflicts easy to
spot. To see exactly what the fork changes:

```bash
git diff upstream main -- server.ts
```

## 4. Fallback: run the fork as its own plugin

This path is not recommended for the main sessions. It works, but:

- Claude Code only accepts approved channel plugins on `--channels`. A self-hosted
  marketplace needs `--dangerously-load-development-channels plugin:telegram@<marketplace>`,
  which shows a confirmation dialog at startup. That blocks unattended herdr restores.
- The tool names stay `mcp__plugin_telegram_telegram__*` only if the plugin is still named
  `telegram`.

## Never

- Commit `.env`, `access.json`, a bot token or a chat id. The audit in the README
  (gitleaks + trufflehog) must be clean before every push.
- Test against the main bot. Use a separate test bot with its own `TELEGRAM_STATE_DIR`.
