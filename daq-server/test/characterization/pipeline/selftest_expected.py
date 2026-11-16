#!/usr/bin/env python3
"""The self-test result each board should deliver in a pipeline session (README P12), as JSON.

    selftest_expected.py <sim_config.toml> <services config.toml>

Derived from what the simulators send, not from a run:
  - board_simulator.py --skip-startup sends one pass result per active connector plus adc_good
    (published as sensor_0), for every enabled board except ENVIRONMENTAL and BALL_VALVE (and the
    T7, which it does not simulate; make_fixture.py disables it in the sim config);
  - board_startup_sim.py (board 60, [boards.integration_startup] in the services config) sends
    adc_good and a pass for connector 2.
"""
import json
import sys

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib

sim = tomllib.load(open(sys.argv[1], "rb"))
svc = tomllib.load(open(sys.argv[2], "rb"))
out = {}
for name, b in sim.get("boards", {}).items():
    if not b.get("enabled", True) or name == "integration_startup":
        continue
    kind = str(b.get("type", "PT")).upper()
    if kind in ("ENVIRONMENTAL", "BALL_VALVE", "T7"):
        continue
    out[str(b["board_id"])] = {
        "type": kind,
        "sensors": [0] + list(b.get("active_connectors", [])),
    }
st = svc.get("boards", {}).get("integration_startup")
if st and st.get("enabled", True):
    out[str(st["board_id"])] = {"type": "PT (startup)", "sensors": [0, 2]}
print(json.dumps(out))
