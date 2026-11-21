#!/usr/bin/env python3
"""Diff two oracle outputs: print every per-configuration event that changed, then whether anything else did."""
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
names = {c["id"]: c.get("name") for c in a.get("components", [])} if isinstance(a.get("components"), list) else {}
ca = {c["id"]: c for c in a["configs"]}; cb = {c["id"]: c for c in b["configs"]}
print("configs:", list(ca) == list(cb), list(ca))
for cid in ca:
    ea = {(e["id"], e["kind"]): e for e in ca[cid]["events"]}
    eb = {(e["id"], e["kind"]): e for e in cb[cid]["events"]}
    assert ea.keys() == eb.keys()
    for k in ea:
        if ea[k] != eb[k]:
            print(cid[:8], names.get(k[0], k[0][:8]), k[1], ":", {x: eb[k][x] for x in eb[k] if x not in ("id","kind")}, "->", {x: ea[k][x] for x in ea[k] if x not in ("id","kind")})
# everything else
for key in a:
    if key == "configs": continue
    print(key, "same" if a[key] == b[key] else "DIFFERS")
for cid in ca:
    for k in ("launch", "burnout"):
        print(cid[:8], k, "same" if ca[cid].get(k) == cb[cid].get(k) else "DIFFERS")
