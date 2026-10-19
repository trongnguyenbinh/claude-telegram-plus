#!/usr/bin/env python3
"""Turn on the typewriter for one Claude Code project. (The progress hook now ships
in the plugin, see hooks/hooks.json; this no longer adds it to settings.)

usage: scripts/enable-plus.py <project dir> [<telegram state dir>, ignored]
Writes <project>/.claude/settings.local.json, creating it if missing (the first run backs
up an existing file to .bak-plus; later runs keep that original backup). Safe to re-run. Restart the
session afterwards: env is read at startup.
"""
import json
import os
import shutil
import sys

proj = os.path.expanduser(sys.argv[1]).rstrip("/")

p = f"{proj}/.claude/settings.local.json"
if os.path.exists(p):
    if not os.path.exists(p + ".bak-plus"):
        shutil.copy(p, p + ".bak-plus")
    d = json.load(open(p))
else:
    os.makedirs(os.path.dirname(p), exist_ok=True)
    d = {}
d.setdefault("env", {})["TELEGRAM_PLUS_TYPEWRITER"] = "1"
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("ok", p)
