#!/usr/bin/env python3
"""Claude Code PreToolUse hook: show what the agent is doing as a live
Telegram draft (sendMessageDraft) while a Telegram-originated turn runs.

Only acts when the current turn started from a private-chat Telegram channel
message (<channel source="plugin:telegram:telegram" chat_id=... message_id=...>)
and that chat is in access.json allowFrom. Anything else, or any error:
exit 0 silently. Never prints to stdout, so it can never change a tool decision.

Env: TELEGRAM_STATE_DIR (default ~/.claude/channels/telegram, same as server.ts),
TELEGRAM_API_ROOT (default https://api.telegram.org, the tests point it at a mock).
"""
import json
import os
import re
import sys
import time
import urllib.request

MIN_INTERVAL = 1.0      # seconds between two drafts
NET_TIMEOUT = 2.0       # seconds
MAX_STEP = 80           # chars per step line
KEEP_STEPS = 3          # lines shown in the draft
SCAN_SIZES = (256 << 10, 4 << 20, 32 << 20)  # read the transcript tail, growing

CHANNEL_RE = re.compile(
    r'<channel source="plugin:telegram:telegram" chat_id="(-?\d+)" message_id="(\d+)"')

SECRET_RES = [
    (re.compile(r'\b\d{6,12}:[A-Za-z0-9_-]{30,}'), '***'),                 # Telegram bot token
    (re.compile(r'\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}'), '***'),              # sk-..., sk-ant-...
    (re.compile(r'\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}'), '***'),
    (re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}'), '***'),
    (re.compile(r'\bAKIA[0-9A-Z]{16}\b'), '***'),
    (re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+'), '***'),  # JWT
    (re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'), '***'),
    (re.compile(r'(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}'), r'\1 ***'),
    # key=value / key: value / --password value: keep the key, hide the value.
    # Plain prose ("check token expiry") is left alone.
    (re.compile(r'(?i)\b([A-Za-z_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth|cookie)[A-Za-z_]*)'
                r'(["\']?\s*[:=]\s*)["\']?[^\s"\'&]+'), r'\1\2***'),
    (re.compile(r'(?i)(--?[A-Za-z_-]*(?:token|secret|passw(?:or)?d|key|auth)[A-Za-z_-]*\s+)["\']?[^\s"\'-][^\s"\']*'),
     r'\1***'),
    (re.compile(r'[A-Za-z0-9+_=-]{32,}'), '***'),                            # long opaque blobs
]


def mask(s):
    for rx, repl in SECRET_RES:
        s = rx.sub(repl, s)
    return s


def short(s, n=MAX_STEP):
    s = ' '.join(str(s).split())
    s = mask(s)
    return s if len(s) <= n else s[: n - 1] + '…'


def base(p):
    return os.path.basename(str(p).rstrip('/')) or str(p)


def describe(tool, inp):
    """Vietnamese one-liner for a tool call, or None to skip."""
    inp = inp if isinstance(inp, dict) else {}
    if tool.startswith('mcp__plugin_telegram_telegram__'):
        return None  # the reply itself, drafts, reactions: nothing to narrate
    if tool == 'Bash':
        return 'Bash: ' + (inp.get('description') or inp.get('command') or '')
    if tool == 'Read':
        return 'Đọc file: ' + base(inp.get('file_path', ''))
    if tool in ('Edit', 'MultiEdit'):
        return 'Sửa file: ' + base(inp.get('file_path', ''))
    if tool == 'Write':
        return 'Ghi file: ' + base(inp.get('file_path', ''))
    if tool == 'NotebookEdit':
        return 'Sửa notebook: ' + base(inp.get('notebook_path', ''))
    if tool in ('Grep', 'Glob'):
        return 'Tìm: ' + str(inp.get('pattern', ''))
    if tool in ('Agent', 'Task'):
        return 'Agent: ' + str(inp.get('description') or inp.get('subagent_type') or '')
    if tool == 'WebSearch':
        return 'Tìm web: ' + str(inp.get('query', ''))
    if tool == 'WebFetch':
        m = re.match(r'https?://([^/]+)', str(inp.get('url', '')))
        return 'Đọc web: ' + (m.group(1) if m else '')
    if tool == 'Skill':
        return 'Skill: ' + str(inp.get('skill', ''))
    if tool.startswith('mcp__'):
        parts = tool.split('__')
        return 'MCP ' + '.'.join(p for p in parts[1:] if p)
    return tool


def turn_source(path):
    """(chat_id, message_id) if the latest turn started from a Telegram channel
    message, else None. Reads only the tail of the transcript."""
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        for n in SCAN_SIZES:
            f.seek(max(0, size - n))
            lines = f.read().split(b'\n')
            if size > n:
                lines = lines[1:]  # first line is probably cut
            for raw in reversed(lines):
                # cheap byte filter before json.loads: tool results (often MBs)
                # carry tool_use_id; turn starts carry an origin object.
                if b'"type":"user"' not in raw or (b'"tool_use_id"' in raw and b'"origin":{' not in raw):
                    continue
                try:
                    o = json.loads(raw)
                except ValueError:
                    continue
                if o.get('type') != 'user' or o.get('isSidechain'):
                    continue
                origin = o.get('origin')
                content = (o.get('message') or {}).get('content')
                if origin is None:
                    # older/plain prompts: a string that is not a meta injection
                    if not isinstance(content, str) or o.get('isMeta'):
                        continue
                    return None
                if origin.get('kind') != 'channel' or origin.get('server') != 'plugin:telegram:telegram':
                    return None
                m = CHANNEL_RE.search(content if isinstance(content, str) else json.dumps(content))
                return (m.group(1), m.group(2)) if m else None
            if size <= n:
                return None
    return None


def state_dir():
    return os.environ.get('TELEGRAM_STATE_DIR') or os.path.join(
        os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude'), 'channels', 'telegram')


def read_token(sd):
    tok = os.environ.get('TELEGRAM_BOT_TOKEN')
    if tok:
        return tok
    with open(os.path.join(sd, '.env')) as f:
        for line in f:
            m = re.match(r'^TELEGRAM_BOT_TOKEN=(.*)$', line.strip())
            if m:
                return m.group(1).strip().strip('"')
    return None


def main():
    data = json.load(sys.stdin)
    if data.get('hook_event_name', 'PreToolUse') != 'PreToolUse':
        return
    step = describe(str(data.get('tool_name', '')), data.get('tool_input'))
    if step is None:
        return
    src = turn_source(data['transcript_path'])
    if not src:
        return
    chat_id, message_id = src
    if int(chat_id) <= 0 or int(message_id) <= 0:
        return  # groups/channels: drafts are private-chat only

    sd = state_dir()
    with open(os.path.join(sd, 'access.json')) as f:
        if chat_id not in (json.load(f).get('allowFrom') or []):
            return

    # Throttle + rolling step list, per state dir (one bot).
    # ponytail: read-compare-write without a lock; two parallel tool calls can
    # both send once. Harmless for a preview. Add fcntl.flock if it ever matters.
    sfile = os.path.join(sd, 'progress-hook.json')
    try:
        with open(sfile) as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {}
    if st.get('draft_id') != int(message_id):
        st = {'draft_id': int(message_id), 'steps': [], 'last': 0}
    st['steps'] = (st['steps'] + [short(step)])[-KEEP_STEPS:]
    now = time.time()
    due = now - st.get('last', 0) >= MIN_INTERVAL
    if due:
        st['last'] = now
    tmp = sfile + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(st, f)
    os.replace(tmp, sfile)
    if not due:
        return

    token = read_token(sd)
    if not token:
        return
    lines = st['steps']
    text = '⏳ Đang làm:\n' + '\n'.join(('▸ ' if i == len(lines) - 1 else '· ') + s for i, s in enumerate(lines))
    root = (os.environ.get('TELEGRAM_API_ROOT') or 'https://api.telegram.org').rstrip('/')
    req = urllib.request.Request(
        f'{root}/bot{token}/sendMessageDraft',
        data=json.dumps({'chat_id': int(chat_id), 'draft_id': int(message_id), 'text': text}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    urllib.request.urlopen(req, timeout=NET_TIMEOUT).read()


if __name__ == '__main__':
    try:
        main()
    except BaseException:  # never block or break a tool call; never print (token could be in a traceback URL)
        pass
    sys.exit(0)
