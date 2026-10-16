#!/usr/bin/env python3
"""Set an env var in a Claude Code settings file, keeping a .bak copy.

usage: scripts/set-env.py <project dir> KEY VALUE
"""
import json
import shutil
import sys

proj, key, val = sys.argv[1:4]
p = f"{proj.rstrip('/')}/.claude/settings.local.json"
shutil.copy(p, p + ".bak-" + key.lower())
d = json.load(open(p))
d.setdefault("env", {})[key] = val
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("ok", p)
