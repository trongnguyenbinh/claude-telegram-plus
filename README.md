# telegram-plus: fork of the official Claude Code Telegram plugin

Private fork of `telegram@claude-plugins-official` v0.0.7
([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official),
`external_plugins/telegram`, upstream commit `1e96c6b`), Apache-2.0, see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
The first commit (tag `upstream-0.0.7`, branch `upstream`) is the upstream code, verbatim.

It adds Telegram Bot API 10.x features. **All of them are opt-in.** With none of the new
arguments, every upstream tool sends the exact request it sent before:
`scripts/test-upstream-compat.sh` runs those tests against the pristine upstream server.

| Tool / option | Bot API | Where it works |
|---|---|---|
| `reply` / `edit_message` `format: "rich"`: Rich Messages (plain Markdown: headings, lists, task lists, tables, code, quotes, `<details>`, no escaping, 32768 chars) | `sendRichMessage`, `editMessageText.rich_message` (10.1) | all chats |
| `reply` / `edit_message` `buttons`: inline keyboard with callback, url, copy-text buttons, `style` primary/success/danger. A press arrives in the session as `(button) <data>` with `callback_query_id` | `reply_markup`, `InlineKeyboardButton.style` (9.4), `copy_text` | all chats; presses accepted from the same people the inbound gate allows |
| `reply` `ephemeral_for` (+ `callback_query_id`, `replace_callback_message`, `reply_to_ephemeral`): a message only one group member sees | `ephemeral_message_parameters` (10.2/10.3) | groups/supergroups; within 15s of the user's action, or any time if the bot is admin; delivery not guaranteed |
| `edit_message` / `delete_message` with `ephemeral_for` | `editEphemeralMessageText`, `deleteEphemeralMessage` | groups |
| incoming ephemeral messages and commands: delivered without needing a mention, with `ephemeral_message_id` | `Message.ephemeral_message_id` (10.2) | allowlisted groups |
| `stream_draft`: live typing preview, `''` = "Thinking…", optional Stop button (press arrives as `(stopped generation)`) | `sendMessageDraft`, `sendRichMessageDraft`, `stopped_message_generation` (9.5/10.1/10.3) | private chats; preview lasts about 30s, finish with `reply` |
| `delete_message` | `deleteMessage` | all chats |
| `reply` `effect_id`, `silent`; `react` `big` | `message_effect_id`, `disable_notification`, `is_big` | effects: private chats only |
| `reply` `typewriter` (default from env `TELEGRAM_PLUS_TYPEWRITER=1`, off when unset): replays the first ~600 chars word by word in a draft (4-8 frames, ≤1.5s), then sends the real message unchanged | `sendMessageDraft` / `sendRichMessageDraft` | private chats, no files, not ephemeral; draft errors are ignored |
| Welcome new group members: the server itself greets people who join an allowlisted group, using `<STATE_DIR>/welcome.json` (see below). Claude is not involved | `new_chat_members` service message, `sendMessage` + `text_mention` entities | allowlisted groups; works in privacy mode, no admin needed |
| `TELEGRAM_API_ROOT` env | local Bot API server or the offline test mock | |
| `hooks/telegram-progress.py` (optional Claude Code hook): live draft of what the agent is doing during a Telegram turn | `sendMessageDraft` | private chats; see [hooks/README.md](./hooks/README.md) |

## Welcome new members

Create `<STATE_DIR>/welcome.json` (same directory as `access.json`, default `~/.claude/channels/telegram`):

```json
{ "-1001234567890": "Chào {name}, ..." }
```

- The key is the group's chat_id. The group must also be in `access.json` `groups`.
  No file, no key, or an empty text means no welcome.
- `{name}` becomes `@username`, or the first name for people without one. Each name
  is a clickable mention, sent as a `text_mention` entity: no parse mode, so names never
  need escaping. Several joiners become `A, B và C`. With more than 10 people, the
  first 10 are listed, then `và N người khác`.
- The file is re-read on every join, like `access.json`, so edits apply without a
  restart. It is deliberately separate from `access.json`, which is only edited from the terminal.
- Bots that join are ignored. Joins within 3s are merged into one message, and each group
  gets at most one welcome every 30s. Later joiners are queued for the next message,
  not dropped.
- Telegram sends the join service message to bots in privacy mode too, no admin rights needed
  (core.telegram.org/bots/features#privacy-mode). The `chat_member` update is not used:
  it needs admin rights and an explicit `allowed_updates`.

## Install, restore, update

See [RESTORE.md](./RESTORE.md). In short: `scripts/install-overlay.sh` (dry run), then `--apply`.

## Tests and audit (offline, no real token)

```bash
bun install
bun test                          # mock Bot API + real server.ts over MCP stdio
python3 hooks/test_telegram_progress.py   # progress hook, mock Bot API
scripts/test-upstream-compat.sh   # default behaviour == upstream
gitleaks git --redact . && trufflehog git file://. --no-update --fail
```

---

*Upstream README follows.*

# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@claude-plugins-official
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
