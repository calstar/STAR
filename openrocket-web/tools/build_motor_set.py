"""Rebuild orweb/data/motors.json from the oracle dumps' "allMotors" (OpenRocket's own curves).

    python3 tools/build_motor_set.py
"""
import glob
import json
import math
from pathlib import Path

root = Path(__file__).resolve().parent.parent
seen = {}
for f in sorted(glob.glob(str(root / "tests/golden/*.json"))):
    g = json.load(open(f))
    for m in g.get("allMotors", []):
        if m["digest"] in seen:
            continue
        seen[m["digest"]] = {
            "manufacturer": m["manufacturer"], "designation": m["designation"],
            "commonName": m["commonName"], "digest": m["digest"], "type": m["motorType"],
            "diameter": m["diameter"], "length": m["length"],
            "delays": [None if (d is None or math.isinf(d)) else d for d in m["delays"]],
            "time": m["time"], "thrust": m["thrust"], "cgx": m["cgx"], "mass": m["mass"],
            "source": "OpenRocket 24.12 motor database, via tools/oracle (" + Path(f).stem + ")",
        }
out = {"about": "Thrust curves of every motor the example rockets use, as OpenRocket 24.12 holds them "
                "(dumped by tools/oracle/Oracle.java, 'allMotors'). Units SI: s, N, m, kg.",
       "motors": list(seen.values())}
(root / "orweb/data/motors.json").write_text(json.dumps(out, indent=1) + "\n")
print(len(seen), "motors")
