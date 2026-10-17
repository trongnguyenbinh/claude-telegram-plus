#!/usr/bin/env python3
"""Turn on the progress hook + typewriter for one Claude Code project.

usage: scripts/enable-plus.py <project dir> <telegram state dir>
Writes <project>/.claude/settings.local.json, creating it if missing (the first run backs
up an existing file to .bak-plus; later runs keep that original backup). Safe to re-run. Restart the
session afterwards: hooks and env are read at startup.
"""
import json
import os
import shutil
import sys

proj, state = (os.path.expanduser(a).rstrip("/") for a in sys.argv[1:3])
hook = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "telegram-progress.py")
cmd = f"TELEGRAM_STATE_DIR={state} python3 {os.path.realpath(hook)}"

p = f"{proj}/.claude/settings.local.json"
if os.path.exists(p):
    if not os.path.exists(p + ".bak-plus"):
        shutil.copy(p, p + ".bak-plus")
    d = json.load(open(p))
else:
    os.makedirs(os.path.dirname(p), exist_ok=True)
    d = {}
d.setdefault("env", {})["TELEGRAM_PLUS_TYPEWRITER"] = "1"
pre = d.setdefault("hooks", {}).setdefault("PreToolUse", [])
if not any(h.get("command") == cmd for e in pre for h in e.get("hooks", [])):
    pre.append({"matcher": "*", "hooks": [{"type": "command", "timeout": 5, "command": cmd}]})
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("ok", p)
