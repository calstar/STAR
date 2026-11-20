#!/usr/bin/env python3
"""Characterization of the Python config readers (area "config"); run by check.sh from this dir.

- test/check_toml_no_underscore_ints.py: its verdict on the tracked tree (main()), and
  scan_file() on every tracked TOML and every bad fixture, since main() only globs
  config/*.toml and config/profiles/*.toml.
- tools/calibration/calibration_robustness.py SystemConfig.load: the only reader of
  config/system_config.json.
"""

import contextlib
import glob
import importlib.util
import io
import logging
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DAQ = os.path.normpath(os.path.join(HERE, "..", "..", ".."))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rel(p):
    return os.path.relpath(p, DAQ)


chk = load("check_toml", os.path.join(DAQ, "test", "check_toml_no_underscore_ints.py"))
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = chk.main()
print("== check_toml_no_underscore_ints.main()")
print(buf.getvalue(), end="")
print(f"exit {rc}")

files = sorted(
    glob.glob(os.path.join(DAQ, "config", "*.toml"))
    + glob.glob(os.path.join(DAQ, "config", "profiles", "*", "config.toml"))
    + glob.glob(os.path.join(HERE, "fixtures", "bad", "*.toml"))
)
for f in files:
    print(f"== scan_file {rel(f)}")
    for line_no, text in chk.scan_file(f):
        print(f"  {line_no}: {text}")

print("== SystemConfig.load(config/system_config.json)")
try:
    rob = load(
        "calibration_robustness",
        os.path.join(DAQ, "tools", "calibration", "calibration_robustness.py"),
    )
    logging.disable(logging.CRITICAL)
    for path in [
        os.path.join(DAQ, "config", "system_config.json"),
        os.path.join(HERE, "fixtures", "bad", "no_such_system_config.json"),
    ]:
        cfg = rob.SystemConfig.load(path)
        print(f"-- {rel(path)}")
        for k, v in sorted(cfg.to_dict().items()):
            print(f"  {k} = {v!r}")
except ImportError as e:  # calibration_robustness needs numpy (requirements.txt)
    sys.exit(
        f"py_dump: cannot import the SystemConfig reader ({e}); install requirements.txt"
    )
sys.exit(0)
