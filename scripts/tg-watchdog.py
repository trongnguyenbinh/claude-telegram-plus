#!/usr/bin/env python3
"""Telegram channel watchdog for Claude Code sessions running in herdr panes.

The channel (bun server.ts) sometimes dies while the claude session lives on:
bot.pid is gone or points at a dead process and /mcp shows the telegram server
as failed. This script notices that and does what a human would: in the
agent's herdr pane, /mcp -> the telegram row -> Reconnect, then checks that a
new bot.pid is alive and reports to Telegram via the Bot API.

  python3 tg-watchdog.py --config watchdog.json            # loop forever
  python3 tg-watchdog.py --config watchdog.json --once     # one round
  python3 tg-watchdog.py --config watchdog.json --dry-run  # detect + log, no keys, no message

Config (JSON):
  {
    "notify": {"env_file": "/abs/state/.env", "chat_id": "123"},   # optional
    "interval_s": 60, "cooldown_s": 600, "confirm_s": 20, "idle_wait_s": 600, "heartbeat_stale_s": 180,
    "state_file": "~/.cache/tg-watchdog.json",
    "agents": [
      {"label": "main", "cwd": "/abs/project", "state_dir": "/abs/project/.claude/telegram"},
      {"label": "lead", "herdr": "lead", "state_dir": "/abs/lead/.claude/channels/telegram",
       "mcp_name": "plugin:telegram:telegram", "proc_match": "server.ts",
       "notify": {"env_file": "/abs/lead/.claude/channels/telegram/.env", "chat_id": "123"}}
    ]
  }
An agent is found by herdr name ("herdr") or, if unnamed, by the claude pane
whose cwd equals "cwd". The token is read from notify.env_file
(TELEGRAM_BOT_TOKEN=...) and never logged. An agent's own "notify" overrides
the top-level one, e.g. to report through that agent's bot.
"""
import argparse, json, os, re, subprocess, sys, time, urllib.parse, urllib.request

MCP_NAME = 'plugin:telegram:telegram'
RECONNECT_WAIT_S = 90  # after Reconnect, how long to wait for a new pid with its own heartbeat
ANSI = re.compile(r'\x1b\[([0-9;?]*)([A-Za-z])')
RULE = re.compile(r'^─{20,}$')


def log(msg):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), msg, file=sys.stderr, flush=True)


# ---- herdr
def herdr(*args, timeout=30):
    r = subprocess.run(['herdr', *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f'herdr {args[0]} {args[1]}: {r.stderr.strip()[:200]}')
    return r.stdout


def find_agent(spec, agents):
    """Return (agent, why_not). Only claude agents count as a live session."""
    hits = [a for a in agents if a.get('agent') == 'claude' and (
        a.get('name') == spec['herdr'] if spec.get('herdr') else a.get('cwd') == spec.get('cwd'))]
    if len(hits) == 1:
        return hits[0], None
    return None, 'no claude session' if not hits else f'{len(hits)} claude sessions match, ambiguous'


def screen(pane, ansi=False):
    args = ['pane', 'read', pane, '--source', 'visible'] + (['--format', 'ansi'] if ansi else [])
    return herdr(*args)


def keys(pane, *k):
    for key in k:
        herdr('pane', 'send-keys', pane, key)
        time.sleep(0.35)  # the TUI drops/merges fast arrow presses


# ---- screen parsing (pure, tested in test_tg_watchdog.py)
def visible_text(ansi_line):
    """Text on a line that is not dim. Placeholder/suggestion text in the
    claude prompt is rendered dim (SGR 2), real typed input is not."""
    out, dim, pos = [], False, 0
    for m in ANSI.finditer(ansi_line):
        if not dim:
            out.append(ansi_line[pos:m.start()])
        pos = m.end()
        if m.group(2) == 'm':
            ps = (m.group(1) or '0').split(';')
            i = 0
            while i < len(ps):
                p = ps[i]
                if p in ('38', '48', '58'):  # extended colour: 5;n or 2;r;g;b, not dim
                    i += 3 if ps[i + 1:i + 2] == ['5'] else 5
                    continue
                if p in ('0', '', '22'):
                    dim = False
                elif p == '2':
                    dim = True
                i += 1
    if not dim:
        out.append(ansi_line[pos:])
    return ''.join(out)


def input_box(ansi_screen):
    """Real (non-dim) text in the bottom prompt box, or None if no prompt box
    is on screen (a menu or dialog is open). '' means empty."""
    lines = ansi_screen.rstrip('\n').split('\n')
    plain = [ANSI.sub('', l).strip() for l in lines]
    rules = [i for i, l in enumerate(plain) if RULE.match(l)]
    for top, bot in zip(rules[-2::-1], rules[:0:-1]):  # bottom-most pair first
        if bot <= top + 1 or not plain[top + 1].startswith('❯'):
            continue
        text = ' '.join(visible_text(l).strip() for l in lines[top + 1:bot])
        return text.strip().removeprefix('❯').strip()
    return None


def section(text, header):
    """Lines after the last line matching header (the open menu, not scrollback)."""
    lines = text.split('\n')
    idx = [i for i, l in enumerate(lines) if re.search(header, l)]
    return lines[idx[-1]:] if idx else None


def cursor_row(lines):
    """Name under the ❯ cursor in the /mcp server list: '  ❯ ✘ name   detail'."""
    for l in lines[1:]:
        m = re.match(r'^\s*❯\s+\S\s+(.+?)(\s{2,}.*)?$', l)
        if m:
            return m.group(1)
    return None


def cursor_option(lines):
    """Label under the cursor in a server's submenu: '  ❯ 1. Reconnect'."""
    for l in lines[1:]:
        m = re.match(r'^\s*❯\s+\d+\.\s+(.+?)\s*$', l)
        if m:
            return m.group(1)
    return None


def options(lines):
    return [m.group(1) for l in lines[1:] if (m := re.match(r'^\s*(?:❯\s+)?\d+\.\s+(.+?)\s*$', l))]


# ---- channel state
def bot_pid(state_dir, proc='server.ts'):
    """Live channel pid from bot.pid (its args contain proc), else None."""
    # An unreadable state dir (macOS TCC on ~/Documents under launchd, wrong
    # path) must raise, not look like a dead channel and trigger reconnects.
    os.listdir(state_dir)
    try:
        pid = int(open(os.path.join(state_dir, 'bot.pid')).read().strip())
        os.kill(pid, 0)
    except PermissionError:
        pass  # EPERM from kill: alive, owned by another user
    except (FileNotFoundError, ProcessLookupError, ValueError):
        return None
    r = subprocess.run(['ps', '-p', str(pid), '-o', 'args='], capture_output=True, text=True)
    return pid if proc in r.stdout else None


def read_heartbeat(state_dir):
    """(age_s, {pid, state, at}) from bot.heartbeat, or None when the server
    is too old to write one."""
    path = os.path.join(state_dir, 'bot.heartbeat')
    try:
        age = time.time() - os.stat(path).st_mtime
        with open(path) as f:
            hb = json.loads(f.read() or '{}')
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        hb = {}
    return age, hb if isinstance(hb, dict) else {}


def health(state_dir, proc='server.ts', stale_s=180):
    """('ok' | 'dead' | 'deaf' | 'conflict', pid).
    dead: bot.pid missing or not a live server. deaf: alive, but no getUpdates
    completed for stale_s (server.ts refreshes bot.heartbeat after each one).
    conflict: the server reports 409, another poller holds the token; a
    reconnect would not help. No heartbeat file: judged by bot.pid alone."""
    pid = bot_pid(state_dir, proc)
    if not pid:
        return 'dead', None
    beat = read_heartbeat(state_dir)
    if beat is None:
        return 'ok', pid
    age, hb = beat
    if hb.get('pid') != pid:
        # this server has not completed its first getUpdates yet: give it
        # stale_s from when it took bot.pid
        age = time.time() - os.stat(os.path.join(state_dir, 'bot.pid')).st_mtime
    elif hb.get('state') == 'conflict':
        return 'conflict', pid
    return ('deaf' if age > stale_s else 'ok'), pid


# ---- notify
def notify(cfg, text, dry, spec=None):
    n = (spec or {}).get('notify') or cfg.get('notify')
    if not n:
        return
    if dry:
        log(f'dry-run: would notify via {n.get("env_file")}: {text}')
        return
    token = None
    try:
        for line in open(os.path.expanduser(n['env_file'])):
            if line.startswith('TELEGRAM_BOT_TOKEN='):
                token = line.split('=', 1)[1].strip()
    except OSError as e:
        log(f'notify: cannot read env_file ({e.strerror})')
        return
    if not token:
        log('notify: TELEGRAM_BOT_TOKEN missing in env_file')
        return
    data = urllib.parse.urlencode({'chat_id': n['chat_id'], 'text': text}).encode()
    try:
        urllib.request.urlopen(f'https://api.telegram.org/bot{token}/sendMessage', data, timeout=15).read()
    except urllib.error.HTTPError as e:
        log(f'notify: HTTP {e.code}')  # never the URL: it holds the token
    except Exception as e:
        log(f'notify: {type(e).__name__}')


# ---- reconnect
class Abort(Exception):
    pass


def wait_for(pane, header, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        s = section(screen(pane), header)
        if s:
            return s
        time.sleep(0.4)
    raise Abort(f'"{header}" did not appear')


def walk(pane, header, target, current, limit=80):
    """Arrow through a menu until current(lines) == target, re-reading the
    screen after every key. Down first, then up; never assumes positions."""
    for key in ('down', 'up'):
        prev = None
        for _ in range(limit):
            lines = section(screen(pane), header)
            if not lines:
                raise Abort(f'menu "{header}" closed')
            now = current(lines)
            if now == target:
                return
            if now == prev:
                break  # hit the end in this direction
            prev = now
            keys(pane, key)
    raise Abort(f'"{target}" not found in menu')


def reconnect(pane, mcp_name):
    herdr('pane', 'send-text', pane, '/mcp')
    time.sleep(0.8)
    box = input_box(screen(pane, ansi=True))
    if box != '/mcp':
        raise Abort(f'prompt shows {box!r} after typing /mcp')
    keys(pane, 'enter')
    wait_for(pane, r'Manage MCP servers')
    walk(pane, r'Manage MCP servers', mcp_name, cursor_row)
    keys(pane, 'enter')
    sub = wait_for(pane, r'MCP Server\s*$')
    if 'Reconnect' not in options(sub):
        raise Abort(f'no Reconnect in submenu: {options(sub)}')
    walk(pane, r'MCP Server\s*$', 'Reconnect', cursor_option, limit=10)
    keys(pane, 'enter')


def leave_menus(pane):
    """Esc out of /mcp if we left it open; Esc on an empty prompt is harmless,
    but a second one opens rewind, so stop as soon as the prompt is back."""
    for _ in range(3):
        s = screen(pane, ansi=True)
        box = input_box(s)
        if box is not None:
            if box.endswith('/mcp'):  # ours; any draft before it stays
                keys(pane, *['backspace'] * 4)
            return
        keys(pane, 'esc')
        time.sleep(0.5)


def check(spec, cfg, st, dry):
    label = spec.get('label') or spec.get('herdr') or spec.get('cwd')
    state_dir = os.path.expanduser(spec['state_dir'])
    stale_s = cfg['heartbeat_stale_s']
    state = lambda: health(state_dir, spec.get('proc_match', 'server.ts'), stale_s)
    agents = json.loads(herdr('agent', 'list'))['result']['agents']
    agent, why = find_agent(spec, agents)
    if not agent:
        log(f'{label}: {why}, skip')
        return
    kind, pid = state()
    if kind == 'ok':
        if dry:
            log(f'{label}: ok, {agent["pane_id"]} bot.pid={pid}')
        return
    if kind == 'conflict':
        log(f'{label}: 409 conflict, another poller holds the token; not reconnecting')
        key = f'{label}:conflict'
        if time.time() - st.get(key, 0) >= cfg['cooldown_s']:
            st[key] = time.time()
            save_state(cfg, st)
            notify(cfg, f'⚠️ tg-watchdog: {label} bị 409 Conflict: có poller khác giữ token bot (máy hoặc session khác). '
                        f'Reconnect không giúp được; tìm tiến trình bun server.ts thừa.', dry, spec)
        return
    what = 'bot.pid missing or dead' if kind == 'dead' else f'deaf: bot.pid={pid} alive but no getUpdates for >{stale_s}s'
    log(f'{label}: {what}, confirming in {cfg["confirm_s"]}s')
    time.sleep(cfg['confirm_s'])
    if state()[0] == 'ok':
        log(f'{label}: came back by itself')
        return
    old = pid

    def recovered():
        """New pid, healthy, and (if this server writes one) its own heartbeat:
        it has really completed a getUpdates."""
        k, p = state()
        beat = read_heartbeat(state_dir)
        return p if k == 'ok' and p != old and (beat is None or beat[1].get('pid') == p) else None

    last = st.get(label, 0)
    if time.time() - last < cfg['cooldown_s']:
        log(f'{label}: in cooldown ({int(time.time() - last)}s since last attempt), skip')
        return
    pane = agent['pane_id']
    status = agent.get('agent_status')
    if dry:
        box = input_box(screen(pane, ansi=True))
        log(f'{label}: dry-run: would reconnect {spec.get("mcp_name", MCP_NAME)} in {pane} '
            f'(status={status}, prompt={"menu open" if box is None else repr(box)})')
        return
    if status == 'working':
        log(f'{label}: working, waiting up to {cfg["idle_wait_s"]}s for idle')
        try:
            herdr('agent', 'wait', pane, '--until', 'idle', '--until', 'done',
                  '--timeout', str(cfg['idle_wait_s'] * 1000), timeout=cfg['idle_wait_s'] + 30)
        except Exception:
            log(f'{label}: still busy, retry next round')
            return
        if state()[0] == 'ok':
            return
        status = json.loads(herdr('agent', 'get', pane))['result']['agent'].get('agent_status')
    if status not in ('idle', 'done'):
        log(f'{label}: status={status}, not typing, retry next round')
        return
    box = input_box(screen(pane, ansi=True))
    if box is None or box:
        log(f'{label}: prompt is {"covered by a menu" if box is None else "holding a draft"}, retry next round')
        return

    st[label] = time.time()
    save_state(cfg, st)
    pid = None
    try:
        reconnect(pane, spec.get('mcp_name', MCP_NAME))
        # The new server's first heartbeat comes after its first 30s long poll,
        # plus `bun install` at start: 35-38s measured, so 45s was too tight.
        end = time.time() + RECONNECT_WAIT_S
        while time.time() < end and not (pid := recovered()):
            time.sleep(1)
        result = next((l.strip(' ⎿') for l in screen(pane).split('\n')[::-1]
                       if re.search(r'Reconnected to|[Ff]ailed to reconnect', l)), '')
    except Abort as e:
        result = f'aborted: {e}'
    except Exception as e:
        result = f'error: {type(e).__name__}: {str(e)[:150]}'
    finally:
        leave_menus(pane)
    sick = 'chết' if kind == 'dead' else 'điếc (sống mà không nhận tin)'
    if pid:
        log(f'{label}: reconnected, bot.pid={pid}')
        notify(cfg, f'🔌 tg-watchdog: {label} kênh Telegram {sick}, đã reconnect, bot.pid={pid} sống.', dry, spec)
    else:
        log(f'{label}: reconnect FAILED: {result}')
        notify(cfg, f'⚠️ tg-watchdog: {label} kênh Telegram {sick}, reconnect KHÔNG thành công ({result}). '
                    f'Vào pane {pane}: /mcp → {spec.get("mcp_name", MCP_NAME)} → Reconnect.', dry, spec)


def load_state(cfg):
    try:
        return json.load(open(cfg['state_file']))
    except (OSError, ValueError):
        return {}


def save_state(cfg, st):
    os.makedirs(os.path.dirname(cfg['state_file']), exist_ok=True)
    json.dump(st, open(cfg['state_file'], 'w'))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--config', required=True)
    ap.add_argument('--once', action='store_true', help='one round, then exit')
    ap.add_argument('--dry-run', action='store_true', help='detect and log only: no keys, no message')
    a = ap.parse_args()
    cfg = {'interval_s': 60, 'cooldown_s': 600, 'confirm_s': 20, 'idle_wait_s': 600, 'heartbeat_stale_s': 180,
           'state_file': '~/.cache/tg-watchdog.json', **json.load(open(a.config))}
    cfg['state_file'] = os.path.expanduser(cfg['state_file'])
    while True:
        st = load_state(cfg)
        for spec in cfg['agents']:
            try:
                check(spec, cfg, st, a.dry_run)
            except Exception as e:
                log(f'{spec.get("label")}: check error {type(e).__name__}: {str(e)[:200]}')
        if a.once:
            return
        time.sleep(cfg['interval_s'])


if __name__ == '__main__':
    main()
