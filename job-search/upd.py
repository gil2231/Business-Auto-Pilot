#!/usr/bin/env python3
"""Update fields on an existing record: upd.py "<company>" "<title substring>" key=value [key=value ...]
Values parse as JSON when possible (numbers, true/false), else as strings. Appending to a string field: key+=text"""
import json, sys
from pathlib import Path
p = Path(__file__).resolve().parent / "data" / "jobs.jsonl"
co, frag, pairs = sys.argv[1].lower(), sys.argv[2].lower(), sys.argv[3:]
rows = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
hits = [r for r in rows if r["co"].lower() == co and frag in r["title"].lower()]
if len(hits) != 1:
    sys.exit(f"expected 1 match, got {len(hits)}")
r = hits[0]
for kv in pairs:
    if "+=" in kv:
        k, v = kv.split("+=", 1)
        r[k] = (r.get(k, "") + ("; " if r.get(k) else "") + v)
        continue
    k, v = kv.split("=", 1)
    try:
        r[k] = json.loads(v)
    except json.JSONDecodeError:
        r[k] = v
p.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rows))
print("updated", r["co"], "/", r["title"])
