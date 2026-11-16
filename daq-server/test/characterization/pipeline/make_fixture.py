#!/usr/bin/env python3
"""Build the private fixture tree one pipeline characterization run reads and writes.

    make_fixture.py <daq_root> <fixture_dir> <ports.json>

Everything a service writes lands under <fixture_dir>; nothing in the checkout is moved or
touched (the integration harness parks the live calibration store instead — this does not).

Layout (the C++ services run with cwd = <fixture_dir>; every path they hard-code is relative):

  config/config.toml                   services config (also the backend's CONFIG_PATH)
  config/*.csv                         state-machine CSVs (config.toml's relative paths)
  char/backend/                        the backend's cwd: its CSV loaders look in cwd/../../config,
                                       and its OTA root search walks up from cwd (6 levels) to the
                                       repo's firmware/, both as from diablo_server/backend
  config/profiles/default/             the active profile (identical to config.toml)
  config/.active_profile
  scripts/calibration/calibrations/    copy of the committed store, minus the operator files
  sim_config.toml                      the simulator's view: only pt_board enabled
  home/                                HOME for the backend (~/.local/share/elodin run dirs)

Config is config_base.toml with every 192.168.2.x rewritten to 127.0.0.x (as
service-controller.ts ensureSimConfig does), pt_board moved to 127.0.0.1, and every port moved
into the private range. See README.md "Why one board".
"""
import json
import os
import re
import shutil
import sys


def sub_line(text, pattern, repl, count=0, section=None):
    """Regex-substitute whole lines (re.M); with section, only inside that [section] block."""
    if section is None:
        new, n = re.subn(pattern, repl, text, count=count, flags=re.M)
    else:
        m = re.search(r"^\[" + re.escape(section) + r"\]\n(?:(?!\[).*\n)*", text, re.M)
        if not m:
            raise SystemExit(f"make_fixture: config has no [{section}]")
        block, n = re.subn(pattern, repl, m.group(0), count=count, flags=re.M)
        new = text[: m.start()] + block + text[m.end() :]
    if n == 0:
        raise SystemExit(
            f"make_fixture: pattern {pattern!r} matched nothing ({section})"
        )
    return new


def main():
    daq_root, fx, ports_path = sys.argv[1:4]
    ports = json.load(open(ports_path))
    root = fx
    cfg_dir = os.path.join(root, "config")
    prof_dir = os.path.join(cfg_dir, "profiles", "default")
    cal_dir = os.path.join(root, "scripts", "calibration", "calibrations")
    os.makedirs(prof_dir, exist_ok=True)
    os.makedirs(os.path.join(fx, "home"), exist_ok=True)

    # Calibration store: the committed tree, without the operator's live files. "Absent" is what
    # test_integration.sh arranges by parking them; here they were simply never copied.
    src_cal = os.path.join(daq_root, "scripts", "calibration", "calibrations")
    skip = {"cubic_calibration.json", "lc_tare.json", "adjustments.json"}
    shutil.copytree(
        src_cal, cal_dir, ignore=lambda d, names: [n for n in names if n in skip]
    )

    text = open(os.path.join(daq_root, "config", "config_base.toml")).read()
    # Hardware safety: no address on the board LAN survives into a config anything runs against.
    text = text.replace("192.168.2.", "127.0.0.")
    # The one routed sensor board sends from 127.0.0.1, the only loopback address every host has.
    text = sub_line(
        text, r'^ip = "127\.0\.0\.21"$', 'ip = "127.0.0.1"', 1, "boards.pt_board"
    )
    text = sub_line(text, r"^port = 2240$", f"port = {ports['elodin']}", 1, "database")
    text = sub_line(
        text, r"^sensor_port = 5006$", f"sensor_port = {ports['daq_udp']}", 1
    )
    text = sub_line(
        text,
        r"^actuator_cmd_port = 5005$",
        f"actuator_cmd_port = {ports['act_udp']}",
        1,
    )
    text = sub_line(
        text, r"^backend_udp_port = .*$", f"backend_udp_port = {ports['log_udp']}"
    )
    text = sub_line(text, r"^bind_ip = .*$", 'bind_ip = "127.0.0.1"')
    text = sub_line(text, r"^broadcast_ip = .*$", 'broadcast_ip = "127.0.0.1"')
    text = sub_line(
        text, r"^broadcast_port = 5005$", f"broadcast_port = {ports['hb_udp']}"
    )
    text = sub_line(text, r"^listen_port = 5005$", f"listen_port = {ports['act_udp']}")
    text = sub_line(text, r"^send_port = 5005$", f"send_port = {ports['act_udp']}")
    text = sub_line(
        text, r"^port = .*$", f"port = {ports['sequencer']}", 1, "actuator_service"
    )
    text = sub_line(
        text, r"^port = .*$", f"port = {ports['controller']}", 1, "controller_service"
    )
    # The backend's GUI downsampler: pinned like test_integration.sh so envelope decimation is
    # observable (10 Hz in, 2 windows/s out) and independent of the shipped [gui] toggle.
    text = sub_line(
        text, r"^downsample_mode = .*$", 'downsample_mode = "envelope"', 1, "gui"
    )
    text = sub_line(
        text, r"^points_per_second = .*$", "points_per_second = 4", 1, "gui"
    )
    # No heartbeat_service in this stack: daq_bridge emits SERVER_HEARTBEAT itself.
    text = sub_line(
        text, r"^enabled = true$", "enabled = false", 1, "heartbeat_service"
    )
    # [state_machine] keeps production's relative "config/<name>.csv" paths. The C++ services
    # resolve them against cwd (the fixture); the backend against its cwd's ../.. (run.sh starts
    # it in char/backend). An absolute path is NOT equivalent: the backend's legacy loaders join
    # the configured path onto other directories, so an absolute one is never found.
    os.makedirs(os.path.join(root, "char", "backend"), exist_ok=True)
    assert "192.168.2." not in text

    for name in os.listdir(os.path.join(daq_root, "config", "profiles", "default")):
        if name.endswith(".csv"):
            src = os.path.join(daq_root, "config", "profiles", "default", name)
            shutil.copy(src, os.path.join(cfg_dir, name))
            shutil.copy(src, os.path.join(prof_dir, name))
    for path in (
        os.path.join(cfg_dir, "config.toml"),
        os.path.join(prof_dir, "config.toml"),
    ):
        open(path, "w").write(text)
    open(os.path.join(cfg_dir, ".active_profile"), "w").write("default\n")
    # The operator allowlist the WS/HTTP gates read: one operator, so both answers are reachable.
    open(os.path.join(fx, "operators.txt"), "w").write("operator@example.com\n")

    # The simulator's view: every board but pt_board disabled, so it never tries to bind a
    # 127.0.0.x it cannot have.
    sim = text
    out, pos = [], 0
    for m in re.finditer(r"^\[boards\.([A-Za-z0-9_]+)\]\n(?:(?!\[).*\n)*", sim, re.M):
        out.append(sim[pos : m.start()])
        block = m.group(0)
        if m.group(1) != "pt_board":
            block = re.sub(r"^enabled = true$", "enabled = false", block, flags=re.M)
        out.append(block)
        pos = m.end()
    out.append(sim[pos:])
    open(os.path.join(fx, "sim_config.toml"), "w").write("".join(out))


if __name__ == "__main__":
    main()
