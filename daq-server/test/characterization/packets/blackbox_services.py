"""Characterization, black box: the board-bound bytes each service actually emits.

Each mode starts the real binary from <bin> against a loopback copy of a committed config and
captures its datagrams (see bb.py). Goldens in packets/golden/:

  config_broadcast  service_config_broadcast.txt  config_broadcast_service's first cycle of
                    SENSOR_CONFIG / ACTUATOR_CONFIG, per destination board, for config_base, the
                    default and digital-twin profiles and variants (thresholds file, stale threshold,
                    physics model, no CSV, no designated survivor)
  heartbeat         service_heartbeat.txt   heartbeat_service SERVER_HEARTBEAT, and how it follows
                    each SequencerState row fed to it by a stand-in elodin-db
  stacklight        service_stacklight.txt  stacklight_service STACKLIGHT_COMMAND per state, likewise
  daq_bridge        service_daq_bridge.txt  daq_bridge SERVER_HEARTBEAT (with and without
                    heartbeat_service enabled) and the backend log envelope it forwards for LOGS
                    datagrams from board addresses
  abort             service_abort.txt       sequencer_service ABORT / ABORT_DONE after a
                    TRANSITION into an abort state over its TCP command port, and what leaving it sends
  pwm               service_pwm.txt         controller_service PWM_ACTUATOR_COMMAND on FIRE_START and
                    FIRE_STOP over its TCP control port

Timestamps stamped from a clock are printed as [<clock> ms, LE u32] after checking they lie
between readings taken around the capture. Usage:
  blackbox_services.py <mode> <bin dir> <daq-server dir> <work dir>
"""

from __future__ import annotations

import shutil
import socket
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bb  # noqa: E402

GOLDEN = Path(__file__).resolve().parent / "golden"
BOARD_PORT = 5005  # the boards' listen_port in every committed config


def ts_masked(b: bytes, off: int, lo: int, hi: int, clock: str) -> str:
    if len(b) < off + 4:
        return bb.hexs(b)
    ok = bb.clock_ok(b[off:], lo, hi)
    tag = f"[<{clock} ms, LE u32>]" if ok else f"[OUT OF RANGE ({clock})]"
    rest = b[off + 4 :]
    return bb.hexs(b[:off]) + " " + tag + ((" " + bb.hexs(rest)) if rest else "")


def wait_tcp(port: int, svc: bb.Service, timeout: float = 15.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end and svc.alive():
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def tcp_command(port: int, line: str, timeout: float = 5.0) -> str:
    with socket.create_connection(("127.0.0.1", port), timeout) as s:
        s.sendall(line.encode() + b"\n")
        s.settimeout(timeout)
        chunks = []
        try:
            while True:
                b = s.recv(4096)
                if not b:
                    break
                chunks.append(b)
                if b.endswith(b"\n"):
                    break
        except socket.timeout:
            pass
    return b"".join(chunks).decode(errors="replace").strip()


# ── config_broadcast ─────────────────────────────────────────────────────────


def rd32(b: bytes, o: int) -> int:
    return struct.unpack_from("<I", b, o)[0] if o + 4 <= len(b) else 0


def config_packet_fields(b: bytes) -> list[tuple[str, int]]:
    v = [("header.packet_type", 1), ("header.version", 1), ("header.timestamp", 4)]
    if not b:
        return v
    if b[0] == 6 and len(b) > 7:
        v += [("is_abort_controller", 1), ("num_abort_actuators", 1)]
        n = b[7]
        for i in range(n):
            p = f"abort_actuator[{i}]"
            v += [(p + ".ip_address", 4), (p + ".actuator_id", 1)]
            v += [(p + ".vent_state", 1), (p + ".abort_state", 1)]
        v.append(("num_abort_pts", 1))
        xo = 8 + n * 7
        x = b[xo] if xo < len(b) else 0
        for i in range(x):
            p = f"abort_pt[{i}]"
            v += [(p + ".ip_address", 4), (p + ".sensor_id", 1)]
            v.append((p + ".pressure_threshold_adc", 4))
        v.append(("enable_serial_printing", 1))
    elif b[0] == 5 and len(b) > 6:
        n = b[6]
        v.append(("num_sensors", 1))
        v += [(f"sensor_id[{i}]", 1) for i in range(n)]
        v += [("reference_voltage", 1), ("necessary_for_abort", 1)]
        if 7 + n + 1 < len(b) and b[7 + n + 1]:
            v.append(("controller_ip", 4))
        v.append(("enable_serial_printing", 1))
    return v


def cb_case(out, binp, work, cap, name, toml, csv, thresholds):
    d = work / f"cb_{name}"
    shutil.rmtree(d, ignore_errors=True)
    (d / "config").mkdir(parents=True)
    (d / "config" / "config.toml").write_text(toml)
    if csv:
        (d / "config" / "state_machine_actuators.csv").write_text(csv)
    if thresholds:
        t = d / "scripts" / "calibration" / "calibrations"
        t.mkdir(parents=True)
        (t / "abort_thresholds.txt").write_text(thresholds)
    argv = [str(binp / "config_broadcast_service"), "--config", "config/config.toml"]
    argv += ["--interval-ms", "2000"]
    with bb.Service(argv, d, d / "service.log"):
        got = cap.collect(until_quiet=0.8, max_s=8, first_s=3.0)
    out.append(f"## {name}: {len(got)} packets")
    for dst, _src, data, _t in got:
        out.append(
            f"# -> {dst}:{cap.port} type={data[0] if data else -1} len={len(data)}"
        )
        out += bb.fields(data, config_packet_fields(data))
        if data and data[0] == 6 and len(data) > 7:
            for i in range(data[7]):
                v = rd32(data, 8 + i * 7)
                out.append(f"    abort_actuator[{i}].ip as LE u32 = {bb.hexu(v, 8)}")
    return got


def do_config_broadcast(binp, src, work):
    rd = lambda p: (src / p).read_text()  # noqa: E731
    base = bb.patched(rd("config/config_base.toml"))
    dflt = bb.patched(rd("config/profiles/default/config.toml"))
    twin = bb.patched(rd("config/profiles/digital-twin/config.toml"))
    dflt_csv = rd("config/profiles/default/state_machine_actuators.csv")
    twin_csv = rd("config/profiles/digital-twin/state_machine_actuators.csv")
    bb.require_aliases(
        [f"127.0.0.{n}" for n in (11, 12, 13, 14, 21, 22, 31, 42, 51, 61, 71)]
    )
    out = [
        "# config_broadcast_service buildPackets(), one block per destination board.",
        "# Configs are copies with every 192.168.2. rewritten to 127.0.0.; the actuator CSV is",
        "# the profile's, found through the service's config/ fallback; no abort_thresholds.txt",
        "# unless the case says so.",
    ]
    cap = bb.UdpCapture(BOARD_PORT)
    try:
        # How a board address in config reaches the wire in ACTUATOR_CONFIG: two probe actuators,
        # channel 11 on board 11 (127.0.0.11, disabled, so it only appears as an address) and
        # channel 12 on board 13 whose ip is the malformed "not-an-ip". The address each gets in
        # the packet sent to board 12 is printed first; the whole probe case is printed last.
        probe = bb.set_key(base, "boards.actuator_board_3", "ip", '"not-an-ip"')
        probe = probe.replace(
            "[actuator_roles]\n",
            '[actuator_roles]\n"Probe Eleven" = ["NC", 11, 11]\n"Probe Bad Ip" = ["NC", 12, 13]\n',
            1,
        )
        probe_out: list[str] = []
        got = cb_case(
            probe_out, binp, work, cap, "config_base+ip_probe", probe, dflt_csv, ""
        )
        ips = {}
        for dst, _s, data, _t in got:
            if dst == "127.0.0.12" and data and data[0] == 6 and len(data) > 7:
                for i in range(data[7]):
                    ips[data[8 + i * 7 + 4]] = rd32(data, 8 + i * 7)
        for label, ch in (("127.0.0.11", 11), ("not-an-ip", 12)):
            v = ips.get(ch)
            out.append(
                f"ipToU32Le({label}) = "
                + (bb.hexu(v, 8) if v is not None else "<absent>")
            )
        cb_case(out, binp, work, cap, "config_base", base, dflt_csv, "")
        cb_case(
            out,
            binp,
            work,
            cap,
            "config_base+thresholds",
            base,
            dflt_csv,
            "# test thresholds\n2101 400 858993460\n2105 400.4 123456789\n2199 10 1\n",
        )
        cb_case(
            out,
            binp,
            work,
            cap,
            "config_base+stale_threshold",
            base,
            dflt_csv,
            "2101 410 858993460\n",
        )
        phys = base.replace(
            '"Fuel Upstream" = "cubic"', '"Fuel Upstream" = "physics"', 1
        )
        cb_case(
            out,
            binp,
            work,
            cap,
            "config_base+physics_fuel_upstream",
            phys,
            dflt_csv,
            "",
        )
        cb_case(out, binp, work, cap, "config_base_no_csv", base, "", "")
        none = base.replace("designated_survivor = true", "designated_survivor = false")
        cb_case(out, binp, work, cap, "config_base_no_survivor", none, dflt_csv, "")
        cb_case(out, binp, work, cap, "profile_default", dflt, dflt_csv, "")
        cb_case(out, binp, work, cap, "profile_digital-twin", twin, twin_csv, "")
        out += probe_out
    finally:
        cap.close()
    return bb.finish(GOLDEN, "service_config_broadcast.txt", "\n".join(out) + "\n")


# ── state followers: heartbeat_service and stacklight_service ────────────────

STATES = list(range(0, 26)) + [254, 255]


def state_follower(binp, src, work, name, argv_tail, ts_off, clock_name):
    d = work / name
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    (d / "config.toml").write_text(
        bb.patched((src / "config/config_base.toml").read_text())
    )
    db = bb.FakeElodin()
    cap = bb.UdpCapture(bb.free_port(), host="127.0.0.1")
    argv = [str(binp / name), "--config", "config.toml", "--elodin-host", "127.0.0.1"]
    argv += ["--elodin-port", str(db.port), "--interval-ms", "100"]
    argv += [a.replace("{PORT}", str(cap.port)) for a in argv_tail]
    out = []
    try:
        with bb.Service(argv, d, d / "service.log"):
            db.wait_conn(1)
            db.wait_quiet(0.5, 5)
            frames, tail = bb.elodin_frames(db.stream())
            out.append(f"## Elodin traffic it sends on connect: {len(frames)} packets")
            for ln, ty, a, b, req, payload, raw in frames:
                out.append(
                    f"  len={ln} ty={ty} id=[{bb.hexu(a, 2)},{bb.hexu(b, 2)}] req={req}"
                )
                out.append(f"    payload: {bb.hexs(payload)}")
            if tail:
                out.append(f"  UNFRAMED TAIL: {bb.hexs(tail)}")
            while (
                cap.recv(0.0) is not None
            ):  # sent while the subscription was being read
                pass
            lo = bb.sys_ms()
            first = cap.collect(until_quiet=0.01, max_s=2, first_s=2)
            first = first[:1]
            hi = bb.sys_ms()
            out.append("## before any SequencerState row")
            for _d, _s, data, _t in first:
                out.append(
                    f"  len={len(data)}: {ts_masked(data, ts_off, lo, hi, clock_name)}"
                )
            out.append(
                "## after a SequencerState [0x50,0x00] row with current_state = s"
            )
            for s in STATES:
                db.push(bb.sequencer_state_frame(s))
                time.sleep(0.35)
                while (
                    cap.recv(0.0) is not None
                ):  # drain what was sent before the row landed
                    pass
                lo = bb.sys_ms()
                got = cap.recv(2.0)
                hi = bb.sys_ms()
                if got is None:
                    out.append(f"  {s}: nothing within 2 s")
                else:
                    data = got[2]
                    out.append(
                        f"  {s}: len={len(data)}: {ts_masked(data, ts_off, lo, hi, clock_name)}"
                    )
    finally:
        cap.close()
        db.close()
    return out


def do_heartbeat(binp, src, work):
    out = ["# heartbeat_service (black box): SERVER_HEARTBEAT datagrams it sends to"]
    out.append(
        "# --broadcast-ip 127.0.0.1, following SequencerState rows from a stand-in elodin-db."
    )
    out += state_follower(
        binp,
        src,
        work,
        "heartbeat_service",
        ["--broadcast-ip", "127.0.0.1", "--broadcast-port", "{PORT}"],
        2,
        "system_clock",
    )
    return bb.finish(GOLDEN, "service_heartbeat.txt", "\n".join(out) + "\n")


def do_stacklight(binp, src, work):
    out = ["# stacklight_service (black box): STACKLIGHT_COMMAND datagrams it sends to"]
    out.append(
        "# --target-ip 127.0.0.1, following SequencerState rows from a stand-in elodin-db."
    )
    out += state_follower(
        binp,
        src,
        work,
        "stacklight_service",
        ["--target-ip", "127.0.0.1", "--target-port", "{PORT}"],
        2,
        "system_clock",
    )
    return bb.finish(GOLDEN, "service_stacklight.txt", "\n".join(out) + "\n")


# ── daq_bridge ───────────────────────────────────────────────────────────────


def logs_packet(flags: int, text: bytes, text_len: int | None = None) -> bytes:
    n = len(text) if text_len is None else text_len
    return struct.pack("<BBIBH", 15, 0, 0x12345678, flags, n) + text


def do_daq_bridge(binp, src, work):
    bb.require_aliases(["127.0.0.21", "127.0.0.71"])
    out = [
        "# daq_bridge (black box), config_base on loopback; sensor port, Elodin and the"
    ]
    out.append("# backend log port moved to free ports on 127.0.0.1.")
    for variant, hb_enabled in (
        ("heartbeat_service enabled (as committed)", None),
        ("heartbeat_service disabled", "false"),
    ):
        d = work / ("daq_bridge_" + ("default" if hb_enabled is None else "hb_off"))
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
        db = bb.FakeElodin()
        hb = bb.UdpCapture(bb.free_port(), host="127.0.0.1")
        logs = bb.UdpCapture(bb.free_port(), host="127.0.0.1")
        sensor = bb.free_port()
        sets = {
            "database__port": str(db.port),
            "network__sensor_port": str(sensor),
            "server_heartbeat__broadcast_ip": '"127.0.0.1"',
            "server_heartbeat__broadcast_port": str(hb.port),
            "logs__backend_udp_port": str(logs.port),
        }
        if hb_enabled is not None:
            sets["heartbeat_service__enabled"] = hb_enabled
        (d / "config.toml").write_text(
            bb.patched((src / "config/config_base.toml").read_text(), **sets)
        )
        argv = [str(binp / "daq_bridge"), "config.toml", "127.0.0.1", str(sensor)]
        out.append(f"## {variant}")
        try:
            with bb.Service(argv, d, d / "service.log"):
                db.wait_conn(1)
                db.wait_quiet(1.0, 10)
                while (
                    hb.recv(0.0) is not None
                ):  # sent while registration was being read
                    pass
                lo = bb.steady_ms()
                got = hb.collect(until_quiet=0.01, max_s=1.5, first_s=1.5)[:1]
                hi = bb.steady_ms()
                if not got:
                    out.append("  SERVER_HEARTBEAT: none within 1.5 s")
                for _d, _s, data, _t in got:
                    out.append(
                        f"  SERVER_HEARTBEAT len={len(data)}: {ts_masked(data, 2, lo, hi, 'steady_clock')}"
                    )
                if hb_enabled is None:
                    cases = [
                        ("127.0.0.21", logs_packet(1, b"hello\nworld\n")),
                        ("127.0.0.1", logs_packet(0, b"")),
                        ("127.0.0.71", logs_packet(2, b"x" * 300)),
                        ("127.0.0.21", logs_packet(1, b"short", text_len=9)),
                    ]
                    for src_ip, pkt in cases:
                        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                        s.bind((src_ip, 0))
                        s.sendto(pkt, ("127.0.0.1", sensor))
                        s.close()
                        r = logs.recv(1.0)
                        out.append(
                            f"  LOGS from {src_ip} len={len(pkt)} -> backend envelope:"
                        )
                        if r is None:
                            out.append("    none within 1 s")
                            continue
                        g = r[2]
                        out.append(f"    len={len(g)}")
                        out += [
                            "  " + x
                            for x in bb.fields(
                                g,
                                [
                                    ("board_id", 1),
                                    ("flags", 1),
                                    ("text_len", 2),
                                    ("text", len(g) - 4),
                                ],
                            )
                        ]
        finally:
            hb.close()
            logs.close()
            db.close()
    return bb.finish(GOLDEN, "service_daq_bridge.txt", "\n".join(out) + "\n")


# ── sequencer_service: ABORT / ABORT_DONE ────────────────────────────────────


def sequencer_dir(src, work, name, **sets):
    d = work / name
    shutil.rmtree(d, ignore_errors=True)
    (d / "config").mkdir(parents=True)
    prof = src / "config/profiles/default"
    for f in (
        "state_transitions.csv",
        "state_machine_actuators.csv",
        "state_machine_actuator_delays.csv",
    ):
        shutil.copy(prof / f, d / "config" / f)
    (d / "config" / "config.toml").write_text(
        bb.patched((src / "config/config_base.toml").read_text(), **sets)
    )
    return d


def do_abort(binp, src, work):
    db = bb.FakeElodin()
    cap = bb.UdpCapture(bb.free_port(), host="127.0.0.1")
    tcp = bb.free_port(socket.SOCK_STREAM)
    d = sequencer_dir(
        src,
        work,
        "sequencer_abort",
        database__port=str(db.port),
        server_heartbeat__broadcast_ip='"127.0.0.1"',
        server_heartbeat__broadcast_port=str(cap.port),
    )
    argv = [
        str(binp / "sequencer_service"),
        "--config",
        "config/config.toml",
        "--port",
        str(tcp),
    ]
    out = [
        "# sequencer_service (black box): datagrams to [server_heartbeat] broadcast_ip:port"
    ]
    out.append("# (127.0.0.1) around TRANSITIONs sent to its TCP command port.")
    try:
        with bb.Service(argv, d, d / "service.log") as svc:
            if not wait_tcp(tcp, svc):
                out.append("!! command port never opened")
            else:
                pre = cap.collect(until_quiet=0.5, max_s=1.0, first_s=1.0)
                out.append(f"## at start-up: {len(pre)} datagrams")
                steps = (
                    ("TRANSITION:GSE Abort", 4.5),
                    ("TRANSITION:Idle", 1.5),
                    ("TRANSITION:Armed", 1.0),
                    ("TRANSITION:Engine Abort", 4.5),
                    ("TRANSITION:Emergency Abort", 4.5),
                )
                for step, wait in steps:
                    lo = bb.steady_ms()
                    reply = tcp_command(tcp, step)
                    got = cap.collect(until_quiet=wait, max_s=wait + 1, first_s=wait)
                    hi = bb.steady_ms()
                    out.append(f"## {step} -> reply {reply!r}: {len(got)} datagrams")
                    t0 = got[0][3] if got else 0
                    for _d, _s, data, t in got:
                        gap = "+3s" if t - t0 >= 2500 else "+0s"
                        out.append(
                            f"  [{gap}] len={len(data)}: {ts_masked(data, 2, lo, hi, 'steady_clock')}"
                        )
    finally:
        cap.close()
        db.close()
    return bb.finish(GOLDEN, "service_abort.txt", "\n".join(out) + "\n")


# ── controller_service: PWM on FIRE_START / FIRE_STOP ────────────────────────


def pwm_fields(g: bytes):
    fs = [("header.packet_type", 1), ("header.version", 1)]
    fs += [("header.timestamp (zeroed here, checked above)", 4), ("num_commands", 1)]
    n = g[6] if len(g) > 6 else 0
    for i in range(n):
        p = f"cmd[{i}]"
        fs += [(p + ".actuator_id", 1), (p + ".duration_ms", 4)]
        fs += [(p + ".duty_cycle", 4), (p + ".frequency", 4)]
    return fs


def pwm_session(out, binp, work, name, cfg_text, db):
    """FIRE_START then FIRE_STOP to one controller_service; append what reaches the boards."""
    tcp = bb.free_port(socket.SOCK_STREAM)
    d = work / name
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    (d / "config.toml").write_text(cfg_text)
    cap = bb.UdpCapture(BOARD_PORT)
    argv = [str(binp / "controller_service"), "--config", "config.toml"]
    argv += ["--elodin-host", "127.0.0.1", "--elodin-port", str(db.port)]
    argv += ["--control-port", str(tcp)]
    try:
        with bb.Service(argv, d, d / "service.log") as svc:
            if not wait_tcp(tcp, svc):
                out.append("!! control port never opened")
                return
            pre = cap.collect(until_quiet=0.5, max_s=1.0, first_s=1.0)
            out.append(f"## before FIRE_START: {len(pre)} datagrams")
            open_cmds: set[bytes] = set()
            for cmd in ("FIRE_START", "FIRE_STOP"):
                # While the gate is open the control loop repeats the open command every tick.
                # Take the clock reading first, then drop what is already queued (sent before it),
                # so every packet kept was stamped after `lo`.
                lo = bb.sys_ms()
                while cap.recv(0.0) is not None:
                    pass
                reply = tcp_command(tcp, cmd)
                got = cap.collect(until_quiet=0.6, max_s=1.5, first_s=1.0)
                hi = bb.sys_ms()
                out.append(f"## {cmd} -> reply {reply!r}")
                # How many repeats arrive is timing; which distinct packets arrive, in
                # first-seen order, is not. After FIRE_STOP, repeats of the open command are the
                # control loop's last ticks racing the stop on another thread, so they are
                # skipped wherever they land.
                seen = []
                for dst, _s, g, _t in got:
                    ok = bb.clock_ok(g[2:], lo, hi) if len(g) >= 6 else False
                    masked = g[:2] + b"\0\0\0\0" + g[6:] if len(g) >= 6 else g
                    if cmd == "FIRE_STOP" and masked in open_cmds:
                        continue
                    if cmd == "FIRE_START":
                        open_cmds.add(masked)
                    key = (dst, masked, ok)
                    if key not in seen:
                        seen.append(key)
                for dst, masked, ok in seen:
                    ts = "<system_clock ms, LE u32>" if ok else "OUT OF RANGE"
                    out.append(f"  -> {dst} len={len(masked)} timestamp {ts}")
                    out += bb.fields(masked, pwm_fields(masked))
    finally:
        cap.close()


def do_pwm(binp, src, work):
    bb.require_aliases(["127.0.0.12", "127.0.0.14"])
    db = bb.FakeElodin()
    out = [
        "# controller_service (black box), config_base with fallback duty 0.1/0.1: what reaches"
    ]
    out.append(
        "# the boards' port on FIRE_START / FIRE_STOP sent to its TCP control port."
    )
    try:
        cfg = bb.patched(
            (src / "config/config_base.toml").read_text(),
            database__port=str(db.port),
            controller__fallback_fuel_duty_cycle="0.1",
            controller__fallback_ox_duty_cycle="0.1",
        )
        pwm_session(out, binp, work, "controller_pwm", cfg, db)
        # The PWM actuators on different boards: one single-command packet per board.
        split = cfg.replace(
            '"LOX Press" = ["NO", 8, 12, "pwm_ox"]',
            '"LOX Press" = ["NO", 8, 14, "pwm_ox"]',
            1,
        )
        assert split != cfg, "config_base no longer declares LOX Press on board 12"
        out.append("")
        out.append(
            '# variant: "LOX Press" (pwm_ox) moved to board 14, fuel stays on board 12'
        )
        pwm_session(out, binp, work, "controller_pwm_split", split, db)
    finally:
        db.close()
    return bb.finish(GOLDEN, "service_pwm.txt", "\n".join(out) + "\n")


MODES = {
    "config_broadcast": do_config_broadcast,
    "heartbeat": do_heartbeat,
    "stacklight": do_stacklight,
    "daq_bridge": do_daq_bridge,
    "abort": do_abort,
    "pwm": do_pwm,
}


def _guarded(fn):
    """A clock-stamped field outside its window is a failure even when the golden says so."""

    def run(*a):
        r = fn(*a)
        name = {v: k for k, v in MODES.items()}[fn]
        text_file = GOLDEN / GOLDEN_OF[name]
        if text_file.exists() and "OUT OF RANGE" in text_file.read_text():
            print(
                f"{text_file.name}: a clock-stamped field was OUT OF RANGE",
                file=sys.stderr,
            )
            return 1
        return r

    return run


GOLDEN_OF = {
    "config_broadcast": "service_config_broadcast.txt",
    "heartbeat": "service_heartbeat.txt",
    "stacklight": "service_stacklight.txt",
    "daq_bridge": "service_daq_bridge.txt",
    "abort": "service_abort.txt",
    "pwm": "service_pwm.txt",
}

if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] not in MODES:
        sys.exit(
            "usage: blackbox_services.py <"
            + "|".join(MODES)
            + "> <bin> <daq-server> <work>"
        )
    work = Path(sys.argv[4])
    work.mkdir(parents=True, exist_ok=True)
    sys.exit(_guarded(MODES[sys.argv[1]])(Path(sys.argv[2]), Path(sys.argv[3]), work))
