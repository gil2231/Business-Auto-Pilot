#!/usr/bin/env python3
"""Append JSON records (one per line on stdin) to data/jobs.jsonl or, with -x, data/excluded.jsonl.
Adds an ET timestamp to records that lack 'ver' and warns about likely duplicates."""
import json, sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_workbook import norm_company, norm_title, load_jsonl

root = Path(__file__).resolve().parent
target = root / "data" / ("excluded.jsonl" if "-x" in sys.argv else "jobs.jsonl")
now = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d %H:%M ET")
existing = {(norm_company(r["co"]), norm_title(r["title"])) for r in load_jsonl(root / "data" / "jobs.jsonl")}
suppress = {norm_company(l) for l in (root / "suppression.txt").read_text().splitlines() if l.strip()}
n = 0
with target.open("a") as f:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        r.setdefault("ver", now)
        key = (norm_company(r["co"]), norm_title(r["title"]))
        if target.name == "jobs.jsonl":
            if key in existing:
                print(f"SKIP duplicate: {r['co']} / {r['title']}")
                continue
            if key[0] in suppress and not r.get("revisit"):
                print(f"NOTE suppressed company: {r['co']}")
            existing.add(key)
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
        n += 1
print(f"added {n} -> {target.name}")
