# telegram-progress hook

A Claude Code `PreToolUse` hook that shows what the agent is doing as a live
Telegram draft (`sendMessageDraft`). Example:

```
⏳ Đang làm:
· Đọc file: server.ts
· Bash: Kiểm agent rnd
▸ Agent: Soát log herdr
```

## When it acts

- Only when the **current turn started from a Telegram channel message**. It scans the
  transcript tail for the latest turn start (`origin.kind == "channel"`, server
  `plugin:telegram:telegram`). Terminal turns (`origin.kind == "human"`, `!cmd`),
  task notifications and anything else: exit 0, nothing sent.
- Only for **private chats** (chat_id > 0) listed in `allowFrom` of `access.json`.
- `draft_id` = the Telegram `message_id` of that turn, so each request gets its own
  draft. The draft shows the last 3 steps.
- Telegram tools themselves (`mcp__plugin_telegram_telegram__*`) are not narrated.
- The draft disappears by itself when the bot sends the real reply, or after about 30s.
- With the typewriter on (`TELEGRAM_PLUS_TYPEWRITER=1`), `reply` reuses the same draft_id (the
  inbound message_id), so "⏳ Đang làm" turns into the answer being typed out.

## Safety

- Always exits 0 and prints nothing, so it can never block or alter a tool call.
- The step list is updated under a lock (`progress-hook.json.lock`) and each `tool_use_id` is counted once.
- At most one draft per second per bot. The steps still accumulate, so a throttled
  step shows up in the next draft. State lives in `<state dir>/progress-hook.json`.
- Network timeout 2s. Each step is cut to 80 chars, and token-, key- and
  password-like strings are masked.
- The token is read the same way `server.ts` reads it: `TELEGRAM_BOT_TOKEN` env, else
  `$TELEGRAM_STATE_DIR/.env` (default `~/.claude/channels/telegram/.env`). The hook
  never prints it.
- Cost: about 60 ms per tool call (Python start included), measured on a 463 MB transcript, because it reads
  only the tail.

## Install

Nothing to do: `scripts/install-overlay.sh --apply` copies this script and
[`hooks.json`](./hooks.json) into the plugin, which registers it for every session
that has the plugin enabled. It runs with the session's environment, so it uses the
`TELEGRAM_STATE_DIR` from the project's settings `env`, like the server. Restart the
session to load it (`/mcp` Reconnect does not load hooks).

In a session with no Telegram channel it exits after reading the transcript tail
(measured 30-50 ms per tool call, mostly Python start; `urllib` is imported only when a draft is sent).

### Older manual install

Before the plugin shipped it, the hook was added per project to `.claude/settings.local.json`
like this. Remove that entry after the session has restarted with the plugin copy: a running
session picks up settings edits right away (file watcher) but loads plugin hooks only at
startup, so removing it earlier stops the draft until the next restart. While both are
registered both fire, and the hook counts each `tool_use_id` once, so the draft shows no
duplicate steps.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "TELEGRAM_STATE_DIR=/abs/path/to/state python3 /abs/path/to/claude-telegram-plus/hooks/telegram-progress.py",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```


## Remove

Roll back the overlay (`scripts/install-overlay.sh --rollback <backup>`) and restart the session.
`progress-hook.json` in the state dir can be deleted at any time.

## Test (offline)

```bash
python3 hooks/test_telegram_progress.py
```

This uses a mock Bot API on localhost and a fake token in a temp dir.
