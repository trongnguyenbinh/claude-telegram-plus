#!/usr/bin/env python3
"""Offline checks for tg-watchdog.py screen parsing. Fixtures are copied from
real claude TUI screens (herdr pane read). Run: python3 scripts/test_tg_watchdog.py"""
import importlib.util, os, sys

spec = importlib.util.spec_from_file_location('wd', os.path.join(os.path.dirname(__file__), 'tg-watchdog.py'))
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

R = '─' * 60
E = '\x1b'
prompt = lambda line: f'old output\n❯ /mcp\n  ⎿  Reconnected to x.\n\n{R}\n{line}\n{R}\n  Opus 5.5 (high) │ ctx 5%\n  ⏵⏵ auto mode on\n'

# dim placeholder / auto-mode suggestion is not a draft
assert wd.input_box(prompt(f'{E}[39m❯ {E}[0m{E}[2mTry "fix lint errors"{E}[0m')) == ''
assert wd.input_box(prompt(f'❯ {E}[2mrun the tests{E}[22m')) == ''
assert wd.input_box(prompt('❯ ')) == ''
# real typed text is a draft
assert wd.input_box(prompt(f'{E}[39m❯ {E}[0mhalf typed{E}[2m suggestion{E}[0m')) == 'half typed'
assert wd.input_box(prompt('❯ /mcp')) == '/mcp'
# menu open: no prompt box at the bottom
menu = f'❯ /mcp\n\n{R}\n  Manage MCP servers\n  2 servers\n\n  ❯ ◯ computer-use\n    ✘ faketg\n ↑/↓ to navigate'
assert wd.input_box(menu) is None

servers = f'''❯ /mcp
{R}
  Manage MCP servers
  15 servers

    ↑ 5 more
    ◯ computer-use
    ✔ faketg                                       1 tool
    ✔ plugin:playwright:playwright                 25 tools
  ❯ ✘ plugin:telegram:telegram
    ✔ claude.ai Claude Docs                        8 tools
  ※ Run claude --debug to see error logs
'''
s = wd.section(servers, r'Manage MCP servers')
assert wd.cursor_row(s) == 'plugin:telegram:telegram', wd.cursor_row(s)
assert wd.cursor_row(wd.section(servers.replace('  ❯ ✘ plugin:tel', '    ✘ plugin:tel').replace('    ✔ claude.ai', '  ❯ ✔ claude.ai'), 'Manage MCP servers')) == 'claude.ai Claude Docs'
assert wd.section('nothing here', 'Manage MCP servers') is None

sub = '''  Manage MCP servers
  Plugin:telegram:telegram MCP Server

  Status:           ✘ failed
  Config location:  Dynamically configured

  ❯ 1. View tools
    2. Reconnect
    3. Disable

  ↑/↓ to navigate · Enter to select · Esc to back
'''
s = wd.section(sub, r'MCP Server\s*$')
assert wd.options(s) == ['View tools', 'Reconnect', 'Disable']
assert wd.cursor_option(s) == 'View tools'

agents = [{'agent': 'claude', 'name': 'lead', 'cwd': '/a', 'pane_id': 'w1:p1'},
          {'agent': 'claude', 'cwd': '/m', 'pane_id': 'w1:p2'},
          {'agent': 'agy', 'cwd': '/m', 'pane_id': 'w1:p3'},
          {'agent': 'claude', 'cwd': '/dup', 'pane_id': 'w1:p4'}, {'agent': 'claude', 'cwd': '/dup', 'pane_id': 'w1:p5'}]
assert wd.find_agent({'herdr': 'lead'}, agents)[0]['pane_id'] == 'w1:p1'
assert wd.find_agent({'cwd': '/m'}, agents)[0]['pane_id'] == 'w1:p2'
assert wd.find_agent({'cwd': '/dup'}, agents)[1].endswith('ambiguous')
assert wd.find_agent({'herdr': 'gone'}, agents) == (None, 'no claude session')

import tempfile
d = tempfile.mkdtemp()
assert wd.bot_pid(d) is None                      # no bot.pid
open(os.path.join(d, 'bot.pid'), 'w').write('999999')
assert wd.bot_pid(d) is None                      # dead pid
open(os.path.join(d, 'bot.pid'), 'w').write(str(os.getpid()))
assert wd.bot_pid(d, proc='test_tg_watchdog') == os.getpid()
assert wd.bot_pid(d) is None                      # alive but not server.ts
try:
    wd.bot_pid('/nonexistent/state')              # unreadable dir must not look dead
    raise SystemExit('expected FileNotFoundError')
except FileNotFoundError:
    pass
# heartbeat: dead / ok / deaf / conflict
import json, time
me = os.getpid()
proc = 'test_tg_watchdog'
d = tempfile.mkdtemp()
assert wd.health(d, proc) == ('dead', None)
open(os.path.join(d, 'bot.pid'), 'w').write(str(me))
assert wd.health(d, proc) == ('ok', me)                       # no heartbeat file: older server
hb = os.path.join(d, 'bot.heartbeat')
open(hb, 'w').write(json.dumps({'pid': me, 'state': 'polling'}))
assert wd.health(d, proc, stale_s=180) == ('ok', me)
old = time.time() - 600
os.utime(hb, (old, old))
assert wd.health(d, proc, stale_s=180) == ('deaf', me)        # alive, no getUpdates for 10 min
open(hb, 'w').write(json.dumps({'pid': me, 'state': 'conflict'}))
os.utime(hb, (old, old))
assert wd.health(d, proc, stale_s=180) == ('conflict', me)    # 409: reconnect would not help
open(hb, 'w').write(json.dumps({'pid': 1, 'state': 'polling'}))  # heartbeat of a previous server
assert wd.health(d, proc, stale_s=180) == ('ok', me)          # new bot.pid: still in its grace period
os.utime(os.path.join(d, 'bot.pid'), (old, old))
assert wd.health(d, proc, stale_s=180) == ('deaf', me)        # ...which ran out
open(hb, 'w').write('not json')
os.utime(os.path.join(d, 'bot.pid'), None)
assert wd.health(d, proc, stale_s=180)[0] == 'ok'
assert wd.RECONNECT_WAIT_S >= 90  # first heartbeat after Reconnect took 35-38s in the field
# per-agent notify overrides the top-level one (dry run only logs, sends nothing)
import contextlib, io
buf = io.StringIO()
with contextlib.redirect_stderr(buf):
    wd.notify({'notify': {'env_file': '/main/.env', 'chat_id': '1'}}, 'x', True, {'notify': {'env_file': '/lead/.env', 'chat_id': '1'}})
    wd.notify({'notify': {'env_file': '/main/.env', 'chat_id': '1'}}, 'y', True, {'label': 'no own notify'})
    wd.notify({}, 'z', True)
out = buf.getvalue()
assert 'via /lead/.env: x' in out and 'via /main/.env: y' in out and ': z' not in out, out
# narrow pane: /mcp cuts the name with "…" (company machine 19/10)
narrow = servers.replace('  ❯ ✘ plugin:telegram:telegram', '  ❯ ✘ plugin:telegram:te…')
assert wd.cursor_row(wd.section(narrow, r'Manage MCP servers')) == 'plugin:telegram:te…'
assert wd.same_item('plugin:telegram:te…', 'plugin:telegram:telegram')
assert wd.same_item('plugin:telegram:te...', 'plugin:telegram:telegram')
assert wd.same_item('plugin:telegram:telegram', 'plugin:telegram:telegram')
assert not wd.same_item('plugin:playwright:pl…', 'plugin:telegram:telegram')
assert not wd.same_item('plu…', 'plugin:telegram:telegram')  # too short to trust
assert not wd.same_item('plugin:telegram:tel', 'plugin:telegram:telegram')  # cut without … is another name
assert not wd.same_item(None, 'Reconnect')

print('tg-watchdog parsing: OK')
