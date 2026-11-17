#!/usr/bin/env python3
"""Build the private fixture tree one pipeline characterization run reads and writes.

    make_fixture.py <daq_root> <fixture_dir> <ports.json> [pt|boards|stalesub|unrecognized]

Everything a service writes lands under <fixture_dir>; nothing in the checkout is moved or
touched (the integration harness parks the live calibration store instead — this does not).

Layout (the C++ services run with cwd = <fixture_dir>; every path they hard-code is relative):

  config/config.toml                   services config (also the backend's CONFIG_PATH)
  config/*.csv                         state-machine CSVs (config.toml's relative paths)
  char/backend/                        the backend's cwd: its CSV loaders look in cwd/../../config,
                                       as from diablo_server/backend
  firmware/Hotfire_Code/               a fixed project tree the OTA project search finds first
  config/profiles/default/             the active profile (identical to config.toml)
  config/.active_profile
  scripts/calibration/calibrations/    copy of the committed store, minus the operator files
  sim_config.toml                      the simulator's view: pt — only pt_board enabled;
                                       boards — every board config enables but the T7,
                                       at 127.0.0.<id>; stalesub — only pt_board_2 (board 22,
                                       the slot the startup board's ids wrap onto);
                                       unrecognized — pt_board
  config_backend/                      unrecognized only: the backend's CONFIG_PATH -- a copy of
                                       config/ in which pt_board's `board_id = 21` is spelled
                                       `id = 21`. The VTable registry still subscribes to it
                                       (elodin-vtable-registry.ts: b.board_id ?? b.id) while
                                       loadBoardsFromConfig (server.ts, numeric board_id only)
                                       leaves it out, so its heartbeats arrive from a board the
                                       backend does not expect (G3). The services keep config/.
  registrar_a.toml                     stalesub only: the services config with every board but
                                       [boards.integration_startup] disabled -- what a
                                       calibration_service run on it registers is exactly the
                                       slot-10 table set ([0x20,0x31] as PT10_Cal.CH1)
  regA/                                stalesub only: that registrar's cwd (its own copy of the
                                       store and config, so it touches nothing the stack reads)
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
    mode = sys.argv[4] if len(sys.argv) > 4 else "pt"
    assert mode in ("pt", "boards", "stalesub", "unrecognized"), mode
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
    if mode in ("pt", "unrecognized"):
        # The one routed sensor board sends from 127.0.0.1, the only loopback address every host
        # has.
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
    # it in char/backend). An absolute path is NOT equivalent: the backend's state-CSV loaders join
    # the configured path onto other directories, so an absolute one is never found.
    os.makedirs(os.path.join(root, "char", "backend"), exist_ok=True)
    if mode in ("boards", "stalesub"):
        # The SETUP -> SELF_TEST startup board, exactly as test_integration.sh declared it;
        # board_startup_sim.py plays it (session.ts boards), board_simulator.py skips it by name.
        # Its board_id 60 is PT slot 10, whose uint8 table ids wrap onto PT2.CH1 (README
        # "Registrars before the backend"); the goldens freeze that, so it stays.
        text += f"""
[boards.integration_startup]
enabled = true
type = "PT"
board_id = 60
ip = "127.0.0.60"
send_port = {ports['daq_udp']}
listen_port = {ports['startup_udp']}
num_sensors = 1
active_connectors = [1]
voltage_reference = 1
necessary_for_abort = false
enable_serial_printing = 0
designated_survivor = false
"""
    # The OTA project list (ota-build.ts discoverProjects) walks up from the backend's cwd to the
    # first firmware/Hotfire_Code. Without one here it found the repo's, which the Linux gate's
    # `git archive` export does not contain (and which changes with every firmware project). A
    # fixed tree one level above cwd's parent makes it the same everywhere: two flashable
    # projects, one nested, one non-flashable (Hotfire_Tests) and a .pio dir, both skipped.
    hc = os.path.join(root, "firmware", "Hotfire_Code")
    for d in ("PT_Hotfire", "Group/LC_Hotfire", "Hotfire_Tests", "PT_Hotfire/.pio/x"):
        os.makedirs(os.path.join(hc, d), exist_ok=True)
    for d in ("PT_Hotfire", "Group/LC_Hotfire", "Hotfire_Tests", "PT_Hotfire/.pio/x"):
        open(os.path.join(hc, d, "platformio.ini"), "w").write("[env]\n")
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
    if mode == "unrecognized":
        # G3: the backend's own copy of the config, pt_board's id spelled so that the registry
        # subscribes to its tables but the board list does not expect it. Not an empty
        # [boards]: that trips the registry's 1..255 heartbeat fallback.
        be_text = sub_line(text, r"^board_id = 21$", "id = 21", 1, "boards.pt_board")
        be_dir = os.path.join(root, "config_backend")
        shutil.copytree(cfg_dir, be_dir)
        for path in (
            os.path.join(be_dir, "config.toml"),
            os.path.join(be_dir, "profiles", "default", "config.toml"),
        ):
            open(path, "w").write(be_text)
    # The operator allowlist the WS/HTTP gates read: one operator, so both answers are reachable.
    open(os.path.join(fx, "operators.txt"), "w").write("operator@example.com\n")

    # The simulator's view. pt: every board but pt_board disabled, so it never tries to bind a
    # 127.0.0.x it cannot have. boards: every board but the LabJack T7 (t7_bridge's, not the
    # simulator's: board_simulator.py has no T7 model and refuses its address). stalesub: only
    # pt_board_2, the board whose channel 1 shares its table ids with the startup board.
    def only(keep):
        out, pos = [], 0
        for m in re.finditer(
            r"^\[boards\.([A-Za-z0-9_]+)\]\n(?:(?!\[).*\n)*", text, re.M
        ):
            out.append(text[pos : m.start()])
            block = m.group(0)
            if not keep(m.group(1), block):
                block = re.sub(
                    r"^enabled = true$", "enabled = false", block, flags=re.M
                )
            out.append(block)
            pos = m.end()
        out.append(text[pos:])
        return "".join(out)

    def not_t7(_name, block):
        return re.search(r'^type = "T7"$', block, re.M) is None

    sim = only(
        {
            "pt": lambda name, _b: name == "pt_board",
            "boards": not_t7,
            "stalesub": lambda name, _b: name == "pt_board_2",
            "unrecognized": lambda name, _b: name == "pt_board",
        }[mode]
    )
    open(os.path.join(fx, "sim_config.toml"), "w").write(sim)
    if mode == "stalesub":
        reg = only(lambda name, _b: name == "integration_startup")
        open(os.path.join(fx, "registrar_a.toml"), "w").write(reg)
        rega = os.path.join(fx, "regA")
        shutil.copytree(
            cal_dir, os.path.join(rega, "scripts", "calibration", "calibrations")
        )
        shutil.copytree(cfg_dir, os.path.join(rega, "config"))


if __name__ == "__main__":
    main()
