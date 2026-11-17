#!/usr/bin/env python3
"""Lifecycle characterization of the DAQ stack: startup handshakes, shutdown, board reconnect,
duplicate subscription, heartbeat loss and the OTA handshake.

Run through run.sh (it takes the stack lock). CHAR_UPDATE=1 rewrites golden/*.txt instead of
comparing. Each golden is plain text built from decoded packets, normalised JSON and named timing
buckets; see normalize.py for what is masked and why.

Loopback only: every service runs against a patched copy of config_base.toml (stack.build_config)
whose every address is 127.0.0.1, from a scratch cwd under .tmp/char_lifecycle_<pid>/. Fixed ports
it cannot move: daq_bridge's FSW socket (UDP 5008) and the OTA board port (TCP 3232). It never
signals a process it did not start.
"""

from __future__ import annotations

import base64
import difflib
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import normalize as N  # noqa: E402
import stack  # noqa: E402
import wire  # noqa: E402
import wsprobe  # noqa: E402

ROOT = stack.ROOT
GOLDEN = os.path.join(HERE, "golden")
UPDATE = os.environ.get("CHAR_UPDATE") == "1"

PORTS = N.Ports(int(os.environ.get("CHAR_LIFECYCLE_PORT_BASE", "26500")))
P = {
    name: PORTS.take(off, name)
    for off, name in [
        (0, "P_ELODIN"),
        (1, "P_DAQ"),
        (2, "P_ACTCMD"),
        (3, "P_HB_BRIDGE"),
        (4, "P_HB_SVC"),
        (5, "P_LOG"),
        (6, "P_WS"),
        (7, "P_OTA"),
        (8, "P_STACK"),
        (9, "P_DEAD_SEQ"),
        (10, "P_DEAD_CTRL"),
        (10 + 1, "P_PT_LISTEN"),
        (12, "P_ACT2_LISTEN"),
        (13, "P_ACT4_LISTEN"),
        (14, "P_STARTUP_LISTEN"),
        (20, "P_SIMCAP"),
        (21, "P_BV_LISTEN"),
        # one capture port per simulator run, so a straggler from the previous run cannot land
        # in the next one's capture
        (22, "P_SIMCAP_SKIP"),
        (23, "P_SIMCAP_BSS"),
        (24, "P_SIMCAP_BV"),
    ]
}
FSW_PORT, OTA_BOARD_PORT = 5008, 3232
BOARDS = {
    "pt_board": P["P_PT_LISTEN"],
    "actuator_board_2": P["P_ACT2_LISTEN"],
    "actuator_board_4": P["P_ACT4_LISTEN"],
    "integration_startup": P["P_STARTUP_LISTEN"],
}
LISTENERS = {
    "pt_board": "P_PT_LISTEN",
    "actuator_board_2": "P_ACT2_LISTEN",
    "actuator_board_4": "P_ACT4_LISTEN",
    "integration_startup": "P_STARTUP_LISTEN",
}

# Timing bounds. Every edge comes from a constant in the code or config under test (cited in the
# label), never from an observed value, with headroom stated; see README.md "Timing assumptions".


def bound(lo: float, hi: float, why: str) -> tuple[float, float, str]:
    return (lo, hi, f"[{lo:g}, {hi:g}] s: {why}")


def periodic(p: float, why: str) -> list:
    """A periodic sender at nominal period p: median gap within [0.75 p, 1.5 p]."""
    return [
        bound(round(0.75 * p, 3), round(1.5 * p, 3), f"period {p * 1000:g} ms, {why}")
    ]


HB_SVC_PERIOD = periodic(0.2, "[heartbeat_service].interval_ms = 200")
BRIDGE_HB_PERIOD = periodic(0.2, "[server_heartbeat].interval_ms = 200")
STACK_PERIOD = periodic(1.0, "[stacklight_service].interval_ms = 1000")
CFG_PERIOD = periodic(1.0, "[config_broadcast_service].interval_ms = 1000")
SIM_HB_PERIOD = periodic(1.0, "board_simulator heartbeat_interval = 1.0")
SIM_DATA_PERIOD = periodic(0.1, "board_simulator sensor_interval = 0.1")
# Board marked lost after its heartbeats stop: BOARD_HEARTBEAT_STALE_MS = 5000 (server.ts), swept
# by markStaleBoards every 1000 ms, last heartbeat up to the sim's 1.0 s heartbeat_interval before
# the stop: [5 - 1, 5 + 1 + 1] = [4, 7] s, + 1 s headroom. A doubled stale time (10 s) lands at
# [9, 12] s, outside.
LOST = bound(
    4.0,
    8.0,
    "BOARD_HEARTBEAT_STALE_MS 5000 - 1 s hb period, + 1 s sweep + 1 s hb + 1 s",
)
SINCE_STOP = [
    (0.0, 2.5, "[0, 2.5) s"),
    (2.5, 4.0, "[2.5, 4) s"),
    LOST,
    (8.0, 30.0, "[8, 30) s"),
]
# A restarted board is seen within: interpreter start-up (assumed <= 3 s, README) + its first
# heartbeat (sent on the first loop pass) + SENSOR_CONFIG within one 1000 ms broadcast interval +
# the 1 Hz board-status broadcast and stale sweep (1 s each) = 6 s.
SINCE_START = [
    bound(0.0, 6.0, "start-up 3 s + config interval 1 s + 1 Hz status/sweep 2 s"),
    (6.0, 30.0, "[6, 30) s"),
]


class Run:
    def __init__(self):
        self.work = os.path.join(ROOT, ".tmp", f"char_lifecycle_{os.getpid()}")
        os.makedirs(self.work)
        self.cwd = os.path.join(self.work, "cwd")
        os.makedirs(self.cwd)
        stack.make_cwd(self.cwd)
        self.bin = stack.bin_dir()
        self.elodin = stack.elodin_bin()
        self.procs: list[stack.Proc] = []
        self.out: dict[str, list[str]] = {}
        self.cfg = stack.build_config(
            os.path.join(self.work, "lifecycle.toml"), P, True, BOARDS
        )
        self.cfg_bridge_hb = stack.build_config(
            os.path.join(self.work, "lifecycle_bridge_hb.toml"), P, False, BOARDS
        )

    def emit(self, golden: str, line: str = ""):
        self.out.setdefault(golden, []).append(
            N.text(line, PORTS, self.work, ROOT).rstrip()
        )

    def start(self, name, argv, cwd=None, env=None) -> stack.Proc:
        pr = stack.Proc(
            name, argv, cwd or self.cwd, os.path.join(self.work, f"{name}.log"), env
        )
        self.procs.append(pr)
        return pr

    def svc(self, name, binary, *args, env=None) -> stack.Proc:
        return self.start(name, [os.path.join(self.bin, binary), *args], env=env)

    def stop(self, pr: stack.Proc, sig=signal.SIGTERM, timeout=30.0):
        """Signal and wait, bounded. A process still alive at the deadline reports exit None
        (the golden goes red) and is then reaped, so it cannot leak into the next scenario.
        """
        pr.signal(sig)
        rc, dt = pr.wait(timeout)
        if rc is None:
            pr.reap()
        return rc, dt

    def ensure_dead(self, *prs: stack.Proc):
        for pr in prs:
            if pr.alive():
                pr.reap()

    def cleanup(self):
        for pr in reversed(self.procs):
            pr.reap()
        if os.path.realpath(self.work).startswith(
            os.path.realpath(os.path.join(ROOT, ".tmp")) + os.sep
        ):
            if os.environ.get("CHAR_LIFECYCLE_KEEP") != "1":
                shutil.rmtree(self.work, ignore_errors=True)


def host_ipv4_text() -> str:
    """This host's IPv4 addresses as text, from whatever the platform has: `ip -4 -o addr`
    (Linux with iproute2), `ifconfig` (macOS, net-tools), else the kernel's own table
    /proc/net/fib_trie (any Linux, including a bare ubuntu image). None of them -> refuse: the
    board-LAN check must fail closed, never pass because it could not look."""
    for cmd in (["ip", "-4", "-o", "addr"], ["ifconfig"]):
        if shutil.which(cmd[0]):
            out = subprocess.run(cmd, capture_output=True, text=True).stdout
            if out.strip():
                return out
    try:
        return open("/proc/net/fib_trie").read()
    except OSError:
        raise SystemExit(
            "lifecycle: cannot list this host's addresses (no ip, ifconfig or "
            "/proc/net/fib_trie); refusing to run without the board-LAN check"
        )


def preflight():
    if socket.gethostname().split(".")[0] == "star-rfs":
        raise SystemExit("lifecycle: this is the stand (star-rfs); refusing to run")
    ifc = host_ipv4_text()
    if re.search(r"(?<![\d.])192\.168\.2\.\d", ifc):
        raise SystemExit(
            "lifecycle: host has a 192.168.2.x address (board LAN); refusing to run"
        )
    busy = [
        n
        for n, p in P.items()
        if not stack.port_free(p, udp=True) or not stack.port_free(p)
    ]
    for port, udp, what in [
        (FSW_PORT, True, "daq_bridge FSW 5008/udp"),
        (OTA_BOARD_PORT, False, "OTA 3232/tcp"),
    ]:
        if not stack.port_free(port, udp=udp):
            busy.append(what)
    if busy:
        raise SystemExit(
            f"lifecycle: ports busy, not touching their owners: {', '.join(busy)}"
        )


def decode_first(
    cap: stack.Capture, name: str, since=0.0, ptype=None, timeout=4.0, board_clock=False
) -> list[str]:
    got = cap.wait_for(name, timeout, since, ptype)
    if got is None:
        return ["    (nothing received)"]
    _t, epoch, data = got
    return wire.decode(data, recv_epoch_ms=epoch, board_clock=board_clock)


def period(cap, name, since, until, edges) -> str:
    times = [t for t, _e, _d in cap.get(name, since, until)]
    g = stack.median_gap(times)
    return "n/a (fewer than 2 packets)" if g is None else N.bucket(g, edges)


def wait_until(pred, timeout: float, step=0.05) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(step)
    return bool(pred())


# ── WS observations ──────────────────────────────────────────────────────────────────────────


def board_entry(frame: dict, board_id: int):
    for b in frame.get("payload", {}).get("boards", []):
        if b.get("id") == board_id:
            return b
    return None


def board_connected(
    probe: wsprobe.WsProbe, board_id: int, state: int | None = None
) -> bool:
    for _t, f in reversed(probe.snapshot()):
        if f.get("type") == "board_status_update":
            b = board_entry(f, board_id)
            return bool(
                b
                and b.get("connected")
                and (state is None or b.get("boardState") == state)
            )
    return False


def events(probe: wsprobe.WsProbe, since: float, board_id: int, edges) -> list[str]:
    """Board status transitions (deduplicated) and notifications after `since`, in order."""
    out, last = [], None
    for t, f in probe.snapshot():
        if t < since:
            if f.get("type") == "board_status_update":
                b = board_entry(f, board_id)
                if b:
                    last = (b.get("connected"), b.get("boardState"))
            continue
        dt = N.bucket(t - since, edges)
        if f.get("type") == "board_status_update":
            b = board_entry(f, board_id)
            if b:
                cur = (b.get("connected"), b.get("boardState"))
                if cur != last:
                    out.append(
                        f"  [{dt}] board {board_id}: connected={cur[0]} boardState={cur[1]}"
                    )
                    last = cur
        elif f.get("type") == "notification":
            pl = f.get("payload", {})
            out.append(
                f"  [{dt}] notification {pl.get('category')}: {pl.get('message')!r}"
                f" ongoing={pl.get('ongoing', '-')} key={pl.get('key', '-')}"
            )
    return out


def ws_types_between(probe, since, until=None) -> set:
    return {
        f.get("type")
        for t, f in probe.snapshot()
        if t >= since and (until is None or t < until)
    }


def pt_data_between(probe, since, until=None) -> int:
    return sum(
        1
        for t, f in probe.snapshot()
        if t >= since
        and (until is None or t < until)
        and f.get("type") == "sensor_update"
        and str(f.get("payload", {}).get("entity", "")).startswith("PT1.")
    )


# ── OTA fake board ───────────────────────────────────────────────────────────────────────────


class FakeOtaBoard:
    """espota peer on 127.0.0.1:3232: reads the 4-byte size header and that many bytes, then
    replies per `behavior` ("ok" -> "OK\\n", "silent" -> close, "fail" -> "FAIL\\n")."""

    def __init__(self, behavior: str):
        self.behavior = behavior
        self.header = b""
        self.body = b""
        self.connections = 0
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", OTA_BOARD_PORT))
        self.srv.listen(1)
        self.srv.settimeout(30)
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _recv(self, conn, n):
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(min(65536, n - len(buf)))
            if not chunk:
                break
            buf += chunk
        return buf

    def _run(self):
        try:
            conn, _ = self.srv.accept()
        except OSError:
            return
        self.connections += 1
        with conn:
            # A real board waits for the size it was told; a wrong header strands it, which is
            # what the report then shows (received != file). Short timeout keeps that case cheap.
            conn.settimeout(5)
            try:
                self.header = self._recv(conn, 4)
                if len(self.header) == 4:
                    self.body = self._recv(conn, struct.unpack(">I", self.header)[0])
                if self.behavior == "ok":
                    conn.sendall(b"OK\n")
                elif self.behavior == "fail":
                    conn.sendall(b"FAIL\n")
            except OSError:
                pass
        self.srv.close()

    def report(self, expected: bytes) -> list[str]:
        self.thread.join(timeout=25)
        try:
            self.srv.close()
        except OSError:
            pass
        if not self.connections:
            return ["    board: no connection"]
        size = struct.unpack(">I", self.header)[0] if len(self.header) == 4 else None
        return [
            f"    board: size header [{' '.join(f'{b:02X}' for b in self.header)}] = {size} (big-endian)",
            f"    board: received {len(self.body)} bytes, identical to the file: {self.body == expected}",
        ]


def ota_line(port: int, line: str, timeout=30.0) -> str:
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s.sendall(line.encode() + b"\n")
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    s.close()
    return buf.decode("utf-8", "replace").strip() or "<connection closed, no reply>"


# ── scenarios ────────────────────────────────────────────────────────────────────────────────


def bridge_only_heartbeat(r: Run):
    """daq_bridge with [heartbeat_service] disabled sends SERVER_HEARTBEAT itself."""
    g = "startup"
    r.emit(
        g,
        "== daq_bridge alone, [heartbeat_service].enabled = false (no Elodin running)",
    )
    cap = stack.Capture()
    for key, pname in LISTENERS.items():
        cap.listen(key, P[pname])
    cap.listen("hb_bridge", P["P_HB_BRIDGE"])
    t0 = time.monotonic()
    br = r.svc("bridge_hb", "daq_bridge", r.cfg_bridge_hb)
    r.emit(g, "  first packet on [server_heartbeat] broadcast port:")
    for ln in decode_first(cap, "hb_bridge", t0, timeout=30):
        r.emit(g, ln)
    time.sleep(2.0)
    r.emit(
        g,
        f"  SERVER_HEARTBEAT period: {period(cap, 'hb_bridge', t0, None, BRIDGE_HB_PERIOD)}",
    )
    for key in LISTENERS:
        r.emit(g, f"  packets to {key}'s listen_port: {len(cap.get(key, t0))}")
    rc, _dt = r.stop(br)
    r.emit(g, f"  SIGTERM -> exit {rc}")
    br.reap()
    cap.close()
    r.emit(g)


def sim_board(r: Run):
    """board_simulator.py and board_startup_sim.py on their own, aimed at a capture port."""
    g = "sim_board"
    sim = os.path.join(ROOT, "sim", "board_simulator.py")
    cfg = stack.build_config(
        os.path.join(r.work, "sim_pt.toml"),
        {**P, "P_DAQ": P["P_SIMCAP"]},
        True,
        # config_broadcast sends nothing at all without a designated-survivor ACTUATOR board
        {"pt_board": P["P_PT_LISTEN"], "actuator_board_2": P["P_ACT2_LISTEN"]},
    )
    cap = stack.Capture()
    cap.listen("daq", P["P_SIMCAP"])
    # in SETUP the sim sends from its bound listen_port (board_simulator.py SimulatedBoard.start)
    cap.only_from("daq", P["P_PT_LISTEN"])

    r.emit(g, "== board_simulator.py, PT board, full lifecycle (no --skip-startup)")
    pr = r.start(
        "sim_pt",
        [
            sys.executable,
            sim,
            "--config",
            cfg,
            "--target",
            "127.0.0.1",
            "--port",
            str(P["P_SIMCAP"]),
            "--low-noise",
            "--only-type",
            "PT",
            "--stats-file",
            os.path.join(r.work, "sim_pt_stats.json"),
        ],
        cwd=ROOT,
    )
    # The 2.5 s window starts at the board's first packet, not at process launch: interpreter
    # start-up is not the board's behaviour, and under load it alone can exceed the window.
    first_pkt = cap.wait_for("daq", 30.0)
    t0 = first_pkt[0] if first_pkt else time.monotonic()
    time.sleep(max(0.0, t0 + 2.5 - time.monotonic()))
    setup = cap.get("daq", t0, t0 + 2.5)
    r.emit(g, "  SETUP, first 2.5 s, packet types in order of first appearance:")
    seen = []
    for _t, _e, d in setup:
        if wire.ptype(d) not in seen:
            seen.append(wire.ptype(d))
    r.emit(g, f"    {seen}")
    r.emit(
        g, f"  SENSOR_DATA while in SETUP: {sum(1 for *_x, d in setup if d[0] == 3)}"
    )
    r.emit(g, "  first BOARD_HEARTBEAT:")
    for ln in decode_first(cap, "daq", t0, ptype=1, board_clock=True):
        r.emit(g, ln)
    r.emit(g, "  first LOGS:")
    for ln in decode_first(cap, "daq", t0, ptype=15, board_clock=True):
        r.emit(g, ln)
    hb_gap = stack.median_gap([t for t, _e, d in setup if d[0] == 1])
    r.emit(
        g,
        f"  BOARD_HEARTBEAT period: {N.bucket(hb_gap if hb_gap is not None else -1, SIM_HB_PERIOD)}",
    )

    # config_broadcast_service supplies the SENSOR_CONFIG, as on the stand.
    t1 = time.monotonic()
    cb = r.svc("sim_cb", "config_broadcast_service", "--config", cfg)
    got = cap.wait_for("daq", 4.0, t1, ptype=12)
    r.emit(g, "  after config_broadcast_service starts:")
    r.emit(g, "    first SELF_TEST:")
    for ln in decode_first(cap, "daq", t1, ptype=12, board_clock=True):
        r.emit(g, "  " + ln)
    time.sleep(1.5)
    r.emit(g, "    first SENSOR_DATA:")
    for ln in decode_first(cap, "daq", t1, ptype=3, board_clock=True):
        r.emit(g, "  " + ln)
    hbs = cap.get("daq", got[0] if got else t1, ptype=1)
    states = sorted({d[40] for _t, _e, d in hbs if len(d) > 40})
    r.emit(g, f"    BOARD_HEARTBEAT board_state after SELF_TEST: {states}")
    data_t = [t for t, _e, _d in cap.get("daq", t1, ptype=3)]
    r.emit(
        g,
        f"    SENSOR_DATA period: {N.bucket(stack.median_gap(data_t) or -1, SIM_DATA_PERIOD)}",
    )
    time.sleep(5.0)
    st = cap.get("daq", t1, ptype=12)
    r.emit(
        g,
        f"    SELF_TEST sends in the 6 s re-send window: {N.bucket(len(st), [(5, 9, "[5, 8] sends: one, then _selftest_resend_until = +6.0 s at 1 Hz")])}",
    )
    log = pr.output()
    for ln in log.splitlines():
        if "SENSOR_CONFIG received" in ln or "SELF_TEST sent" in ln:
            r.emit(
                g,
                "    sim log: "
                + re.sub(r"\('127\.0\.0\.1', \d+\)", "('127.0.0.1', <port>)", ln),
            )
    r.stop(cb)
    rc, dt = r.stop(pr)
    stats = {}
    try:
        stats = json.load(open(os.path.join(r.work, "sim_pt_stats.json")))
    except (OSError, ValueError):
        pass
    r.emit(
        g,
        f"  SIGTERM -> exit {rc} within {N.bucket(dt or 99, [bound(0, 1.0, "_sigterm_handler sleeps 0.1 s")])}",
    )
    r.emit(
        g,
        f"  stats file keys: {sorted(stats)}; boards: {sorted(stats.get('boards', {}))}",
    )
    if stats.get("boards"):
        r.emit(g, f"  stats board keys: {sorted(next(iter(stats['boards'].values())))}")
    r.emit(g)

    r.emit(g, "== board_simulator.py --skip-startup")
    r.ensure_dead(pr, cb)
    cap.listen("skip", P["P_SIMCAP_SKIP"])
    pr = r.start(
        "sim_skip",
        [
            sys.executable,
            sim,
            "--config",
            cfg,
            "--target",
            "127.0.0.1",
            "--port",
            str(P["P_SIMCAP_SKIP"]),
            "--low-noise",
            "--only-type",
            "PT",
            "--skip-startup",
        ],
        cwd=ROOT,
    )
    # With --skip-startup the sim binds port 0, so its source port is learned from its first
    # packet (on a capture port nothing else targets) and pinned from then on. The window is
    # measured from that packet: its first heartbeat goes out on the loop's first pass, at
    # run_started (board_simulator.py _run).
    first_pkt = cap.wait_for("skip", 30.0)
    if first_pkt:
        with cap.lock:
            port = next(p[4] for p in cap.packets if p[0] == "skip")
        cap.only_from("skip", port)
    t0 = first_pkt[0] if first_pkt else time.monotonic()
    time.sleep(max(0.0, t0 + 3.0 - time.monotonic()))
    first = cap.get("skip", t0, t0 + 3.0)
    seen = []
    for _t, _e, d in first:
        if wire.ptype(d) not in seen:
            seen.append(wire.ptype(d))
    r.emit(g, f"  packet types in order of first appearance (3 s): {seen}")
    hb = cap.wait_for("skip", 0.1, t0, ptype=1)
    r.emit(g, f"  first BOARD_HEARTBEAT board_state: {hb[2][40] if hb else None}")
    st = cap.wait_for("skip", 0.1, t0, ptype=12)
    r.emit(
        g,
        f"  one-shot SELF_TEST after: {N.bucket(st[0] - t0, [bound(1.8, 2.6, "now - run_started >= 2.0, from the first heartbeat")]) if st else 'none'}",
    )
    rc, _dt = r.stop(pr, signal.SIGINT)
    r.emit(g, f"  SIGINT -> exit {rc}")
    r.emit(g)

    r.emit(g, "== board_startup_sim.py")
    bss = os.path.join(ROOT, "sim", "board_startup_sim.py")
    r.ensure_dead(pr)
    cap.listen("bss", P["P_SIMCAP_BSS"])
    # board_startup_sim.py sends from the socket it bound to --listen-port
    cap.only_from("bss", P["P_STARTUP_LISTEN"])
    t0 = time.monotonic()
    pr = r.start(
        "bss",
        [
            sys.executable,
            bss,
            "--board-ip",
            "127.0.0.1",
            "--listen-port",
            str(P["P_STARTUP_LISTEN"]),
            "--daq-port",
            str(P["P_SIMCAP_BSS"]),
            "--timeout-s",
            "60",
        ],
        cwd=ROOT,
    )
    r.emit(g, "  first BOARD_HEARTBEAT:")
    for ln in decode_first(
        cap, "bss", t0, ptype=1, timeout=30.0
    ):  # this sim stamps epoch ms, not uptime
        r.emit(g, ln)
    t1 = time.monotonic()
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tx.sendto(
        bytes([5, 0, 0, 0, 0, 0, 1, 2, 1, 0, 3]), ("127.0.0.1", P["P_STARTUP_LISTEN"])
    )
    rc, _ = pr.wait(30)
    tx.close()
    st = cap.get("bss", t1, ptype=12)
    r.emit(
        g,
        f"  SENSOR_CONFIG (mode byte 3) -> {len(st)} SELF_TEST packet(s), then exit {rc}",
    )
    if st:
        for ln in wire.decode(st[0][2], recv_epoch_ms=st[0][1]):
            r.emit(g, ln)
    for ln in pr.output().splitlines():
        if "SENSOR_CONFIG received" in ln:
            r.emit(g, "  log: " + ln)
    pr = r.start(
        "bss_timeout",
        [
            sys.executable,
            bss,
            "--board-ip",
            "127.0.0.1",
            "--listen-port",
            str(P["P_STARTUP_LISTEN"]),
            "--daq-port",
            str(P["P_SIMCAP_BSS"]),
            "--timeout-s",
            "1.5",
        ],
        cwd=ROOT,
    )
    rc, _ = pr.wait(30)
    r.emit(g, f"  no SENSOR_CONFIG within --timeout-s -> exit {rc}")
    cap.close()


def ball_valve_heartbeat_loss(r: Run):
    """The simulated ball valve's server-heartbeat failsafe, driven by hand on loopback."""
    g = "hbloss"
    r.emit(g, "== board_simulator.py ball valve: SERVER_HEARTBEAT loss failsafe")
    sim = os.path.join(ROOT, "sim", "board_simulator.py")
    cfg = stack.build_config(
        os.path.join(r.work, "sim_bv.toml"),
        {**P, "P_DAQ": P["P_SIMCAP_BV"]},
        True,
        {"ball_valve_board": P["P_BV_LISTEN"]},
    )
    cap = stack.Capture()
    cap.listen("daq", P["P_SIMCAP_BV"])
    # a ball valve always binds its listen_port, so that is its source (SimulatedBoard.start)
    cap.only_from("daq", P["P_BV_LISTEN"])
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dest = ("127.0.0.1", P["P_BV_LISTEN"])
    pr = r.start(
        "sim_bv",
        [
            sys.executable,
            sim,
            "--config",
            cfg,
            "--target",
            "127.0.0.1",
            "--port",
            str(P["P_SIMCAP_BV"]),
            "--low-noise",
            "--skip-startup",
        ],
        cwd=ROOT,
    )
    # interpreter start-up is not the valve's behaviour: begin once it is streaming
    cap.wait_for("daq", 30.0, ptype=3)
    hb_on = threading.Event()
    hb_on.set()
    stop = threading.Event()

    def heartbeats():
        while not stop.is_set():
            if hb_on.is_set():
                tx.sendto(wire.server_heartbeat(), dest)
            time.sleep(0.2)

    th = threading.Thread(target=heartbeats, daemon=True)
    th.start()

    def position(since):
        pts = cap.get("daq", since, ptype=3)
        if not pts:
            return None
        s = wire.sensor_data_summary(pts[-1][2])
        return s["values"].get(1)

    def label(counts):
        # 4-20 mA across 100 ohm into 12-bit 3.3 V: 4 mA = 496 counts (closed), 20 mA = 2482 (open)
        if counts is None:
            return "no data"
        if counts <= 520:
            return f"closed ({counts})"
        if counts >= 2460:
            return f"open ({counts})"
        return "moving"

    time.sleep(2.0)
    r.emit(
        g, f"  boot, heartbeats flowing: ch1 {label(position(time.monotonic() - 0.3))}"
    )
    tx.sendto(wire.actuator_command([(1, 1)]), dest)
    time.sleep(3.6)
    r.emit(g, f"  OPEN command + 3.6 s: ch1 {label(position(time.monotonic() - 0.3))}")
    tx.sendto(wire.actuator_command([(1, 0)]), dest)
    time.sleep(3.6)
    r.emit(g, f"  CLOSE command + 3.6 s: ch1 {label(position(time.monotonic() - 0.3))}")
    hb_on.clear()
    t_stop = time.monotonic()
    opened_at = None
    while time.monotonic() - t_stop < 12:
        pts = cap.get("daq", t_stop, ptype=3)
        rising = [
            t
            for t, _e, d in pts
            if (wire.sensor_data_summary(d)["values"].get(1) or 0) > 520
        ]
        if rising:
            opened_at = rising[0] - t_stop
            break
        time.sleep(0.05)
    r.emit(
        g,
        "  heartbeats stopped: valve starts opening after "
        + (
            N.bucket(
                # BALL_VALVE_HEARTBEAT_TIMEOUT_S = 5 counts from the last heartbeat heard, and
                # this harness sends one every 200 ms, so the earliest legal start is 4.8 s.
                opened_at,
                [
                    bound(
                        4.8,
                        6.0,
                        "BALL_VALVE_HEARTBEAT_TIMEOUT_S 5 - 0.2 s sender period,"
                        " + 0.1 s data period + 0.9 s",
                    )
                ],
            )
            if opened_at is not None
            else "never (12 s)"
        ),
    )
    time.sleep(3.5)
    r.emit(g, f"  + 3.5 s: ch1 {label(position(time.monotonic() - 0.3))}")
    tx.sendto(wire.actuator_command([(1, 0)]), dest)
    time.sleep(1.0)
    r.emit(
        g,
        f"  CLOSE while heartbeats stale, + 1 s: ch1 {label(position(time.monotonic() - 0.3))}",
    )
    hb_on.set()
    time.sleep(0.6)
    tx.sendto(wire.actuator_command([(1, 0)]), dest)
    time.sleep(3.6)
    r.emit(
        g,
        f"  heartbeats back, CLOSE + 3.6 s: ch1 {label(position(time.monotonic() - 0.3))}",
    )
    stop.set()
    th.join()
    tx.close()
    r.stop(pr)
    cap.close()
    r.emit(g)


def session(r: Run):
    """The full stack in its production order, then reconnect, heartbeat loss, duplicate
    subscription, OTA and shutdown against that same stack."""
    g = "startup"
    cap = stack.Capture()
    for key, pname in LISTENERS.items():
        cap.listen(key, P[pname])
    for name in ("P_HB_BRIDGE", "P_HB_SVC", "P_STACK"):
        cap.listen(name, P[name])

    r.emit(
        g,
        "== full stack, [heartbeat_service].enabled = true, started in production order",
    )
    el = r.start(
        "elodin",
        [r.elodin, "run", f"127.0.0.1:{P['P_ELODIN']}", os.path.join(r.work, "db")],
    )
    r.emit(g, f"elodin-db: accepting TCP: {stack.wait_tcp(P['P_ELODIN'], 15)}")

    t0 = time.monotonic()
    br = r.svc("daq_bridge", "daq_bridge", r.cfg)
    ok = br.wait_log(r"Listening for DiabloAvionics packets", 20)
    time.sleep(0.5)
    r.emit(g, f"daq_bridge: ready: {ok}")
    for key in LISTENERS:
        r.emit(g, f"  packets to {key}'s listen_port: {len(cap.get(key, t0))}")
    r.emit(g, f"  SERVER_HEARTBEAT from daq_bridge: {len(cap.get('P_HB_BRIDGE', t0))}")
    proactive = re.search(r"Proactive SENSOR_CONFIG sent to (\d+)", br.output())
    r.emit(
        g,
        f"  log claims 'Proactive SENSOR_CONFIG sent to N sense boards': N={proactive.group(1) if proactive else None}",
    )

    t1 = time.monotonic()
    hb = r.svc(
        "heartbeat_service",
        "heartbeat_service",
        "--config",
        r.cfg,
        "--elodin-host",
        "127.0.0.1",
        "--elodin-port",
        str(P["P_ELODIN"]),
    )
    r.emit(g, "heartbeat_service: first packet:")
    for ln in decode_first(cap, "P_HB_SVC", t1):
        r.emit(g, ln)

    t2 = time.monotonic()
    sl = r.svc("stacklight_service", "stacklight_service", "--config", r.cfg)
    r.emit(g, "stacklight_service: first packet (no sequencer, state UNKNOWN):")
    for ln in decode_first(cap, "P_STACK", t2):
        r.emit(g, ln)

    t3 = time.monotonic()
    cb = r.svc("config_broadcast", "config_broadcast_service", "--config", r.cfg)
    first_cfg = {}
    for key in LISTENERS:
        got = cap.wait_for(key, 4.0, t3)
        first_cfg[key] = got[2] if got else None
        r.emit(g, f"config_broadcast_service: first packet to {key}:")
        for ln in (
            wire.decode(got[2], recv_epoch_ms=got[1])
            if got
            else ["    (nothing received)"]
        ):
            r.emit(g, ln)

    t4 = time.monotonic()
    cal = r.svc(
        "calibration_service",
        "calibration_service",
        "--config",
        r.cfg,
        "--adjustments",
        os.path.join(r.work, "adjustments.json"),
        "--elodin-host",
        "127.0.0.1",
        "--elodin-port",
        str(P["P_ELODIN"]),
    )
    cal_ok = cal.wait_log(r"Elodin|subscrib", 15)
    time.sleep(2.5)
    r.emit(g, f"calibration_service: up: {cal_ok and cal.alive()}")
    for key in LISTENERS:
        later = cap.get(key, time.monotonic() - 1.2)
        same = bool(later) and later[-1][2] == first_cfg[key]
        r.emit(
            g,
            f"  config_broadcast to {key} after calibration_service start: {'unchanged' if same else 'CHANGED'}",
        )
        if later and not same:
            for ln in wire.decode(later[-1][2], recv_epoch_ms=later[-1][1]):
                r.emit(g, ln)

    ota_env = {
        "PATH": os.path.join(r.work, "fakebin")
        + os.pathsep
        + os.environ.get("PATH", ""),
        "FAKE_FW": os.path.join(r.work, "fw_build.bin"),
    }
    make_fake_pio(r)
    ota = r.svc(
        "ota_service",
        "ota_service",
        "--port",
        str(P["P_OTA"]),
        "--config",
        r.cfg,
        env=ota_env,
    )
    r.emit(g, f"ota_service: accepting TCP: {stack.wait_tcp(P['P_OTA'], 10)}")

    benv = {
        "WS_PORT": str(P["P_WS"]),
        "ELODIN_HOST": "127.0.0.1",
        "ELODIN_PORT": str(P["P_ELODIN"]),
        "ACTUATOR_SERVICE_PORT": str(P["P_DEAD_SEQ"]),
        "CONTROLLER_SERVICE_PORT": str(P["P_DEAD_CTRL"]),
        "CONFIG_PATH": r.cfg,
        "LOG_INGEST_PORT": str(P["P_LOG"]),
        "OTA_SERVICE_PORT": str(P["P_OTA"]),
        "GUI_PORT": "0",
    }
    be = r.start(
        "backend",
        ["node", "--import", "tsx", "src/server.ts"],
        cwd=stack.BACKEND_DIR,
        env=benv,
    )
    up = stack.wait_tcp(P["P_WS"], 60)
    r.emit(g, f"backend: accepting TCP: {up}")
    st, body = stack.http("GET", P["P_WS"], "/stats")
    r.emit(g, f"  GET /stats -> {st} keys={sorted(json.loads(body))}")
    st, _body = stack.http("GET", P["P_WS"], "/no-such-path")
    r.emit(g, f"  GET /no-such-path -> {st}")
    mon = wsprobe.WsProbe("127.0.0.1", P["P_WS"])
    r.emit(g, f"  WS upgrade: {mon.status_line}")
    # Its connect-time board_status_update is the baseline every later transition is diffed from.
    wait_until(
        lambda: any(f.get("type") == "board_status_update" for _t, f in mon.snapshot()),
        5,
    )

    # Board 21 comes up: the PT board's listen_port goes to the simulator.
    r.emit(g)
    r.emit(g, "== board_simulator.py (PT board 21) joins the running stack")
    cap.release("pt_board", P["P_PT_LISTEN"])
    sim_argv = [
        sys.executable,
        os.path.join(ROOT, "sim", "board_simulator.py"),
        "--config",
        r.cfg,
        "--target",
        "127.0.0.1",
        "--port",
        str(P["P_DAQ"]),
        "--low-noise",
        "--only-type",
        "PT",
    ]
    t5 = time.monotonic()
    sim = r.start("sim", sim_argv, cwd=ROOT)
    wait_until(lambda: board_connected(mon, 21, 2), 15)
    time.sleep(2.0)
    for ln in events(mon, t5, 21, SINCE_START):
        r.emit(g, ln)
    for ln in sim.output().splitlines():
        if "received" in ln or "SELF_TEST sent" in ln:
            r.emit(
                g,
                "  sim log: "
                + re.sub(r"\('127\.0\.0\.1', \d+\)", "('127.0.0.1', <port>)", ln),
            )
    wait_until(
        lambda: json.loads(stack.http("GET", P["P_WS"], "/stats")[1]).get(
            "rawPrimarySamplesIngested", 0
        )
        > 0,
        10,
    )

    r.emit(g)
    r.emit(g, "== WebSocket handshake of a client connecting to the running stack")
    hs = wsprobe.WsProbe("127.0.0.1", P["P_WS"])
    wait_until(
        lambda: any(f.get("type") == "historical_data" for _t, f in hs.snapshot()), 10
    )
    for _t, f in hs.snapshot():
        t = f.get("type")
        if t == "historical_data":
            keys = sorted(f.get("payload", {}))
            r.emit(g, f"  historical_data: {len(keys)} series")
            for k in keys:
                r.emit(g, f"    {k}")
            break
        if t == "board_log":
            continue  # forwarded board text, arrives whenever the sim's 1 Hz log does
        r.emit(g, f"  {t} {N.dumps(f.get('payload'))}")
    hs.close()
    r.emit(g)
    r.emit(g, "== periodic traffic on the long-lived client, 3 s window")
    w0 = time.monotonic()
    time.sleep(3.0)
    r.emit(g, f"  message types: {sorted(ws_types_between(mon, w0))}")
    r.emit(
        g,
        f"  heartbeat_service period: {period(cap, 'P_HB_SVC', t1, None, HB_SVC_PERIOD)}",
    )
    r.emit(g, f"  stacklight period: {period(cap, 'P_STACK', t2, None, STACK_PERIOD)}")
    r.emit(
        g,
        f"  config_broadcast period (actuator_board_2): {period(cap, 'actuator_board_2', t3, None, CFG_PERIOD)}",
    )
    r.emit(
        g,
        f"  SERVER_HEARTBEAT from daq_bridge over the whole startup: {len(cap.get('P_HB_BRIDGE', t0))}",
    )

    reconnect(r, mon, sim_argv)
    sim = [p for p in r.procs if p.name == "sim_restart"][-1]
    heartbeat_loss(r, mon, sim, cap, hb)
    hb = [p for p in r.procs if p.name.startswith("heartbeat_service")][-1]
    dup_subscription(r)
    ota_handshake(r)
    shutdown(r, cap, mon, sim, cb, sl, cal, ota, el, br, hb, be)
    cap.close()


def reconnect(r: Run, mon, sim_argv):
    g = "reconnect"
    sim = [p for p in r.procs if p.name == "sim"][-1]
    r.emit(g, "== board_simulator.py stopped (SIGTERM) mid-session")
    t0 = time.monotonic()
    rc, _ = r.stop(sim)
    r.emit(g, f"  sim exit {rc}")
    wait_until(lambda: not board_connected(mon, 21), 12)
    time.sleep(1.5)
    for ln in events(mon, t0, 21, SINCE_STOP):
        r.emit(g, ln)
    r.emit(
        g,
        f"  PT1.* sensor updates on the WS after the stop (+1 s on): {pt_data_between(mon, t0 + 1.0)}",
    )
    r.emit(g)
    r.emit(g, "== board_simulator.py restarted (boots in SETUP again)")
    t1 = time.monotonic()
    sim2 = r.start("sim_restart", sim_argv, cwd=ROOT)
    wait_until(lambda: board_connected(mon, 21, 2), 15)
    time.sleep(2.0)
    for ln in events(mon, t1, 21, SINCE_START):
        r.emit(g, ln)
    for ln in sim2.output().splitlines():
        if "received" in ln or "SELF_TEST sent" in ln:
            r.emit(
                g,
                "  sim log: "
                + re.sub(r"\('127\.0\.0\.1', \d+\)", "('127.0.0.1', <port>)", ln),
            )
    r.emit(
        g, f"  PT1.* sensor updates resumed on the WS: {pt_data_between(mon, t1) > 0}"
    )
    selftest = sorted(
        {
            f["payload"]["component"]
            for t, f in mon.snapshot()
            if t >= t1
            and f.get("type") == "sensor_update"
            and f.get("payload", {}).get("entity") == "SELF_TEST.BOARD_21"
        },
        key=lambda c: int(c.split("_")[-1]),
    )
    r.emit(g, f"  SELF_TEST.BOARD_21 components re-delivered: {selftest}")
    subs = re.findall(
        r"subscriptions sent", open(os.path.join(r.work, "backend.log")).read()
    )
    r.emit(
        g,
        f"  backend Elodin (re)subscription announcements over the session: {len(subs)}",
    )


def heartbeat_loss(r: Run, mon, sim, cap, hb):
    g = "hbloss"
    r.emit(
        g,
        "== board heartbeats stop: simulator frozen (SIGSTOP) for 9 s; a stand-in sends SENSOR_DATA",
    )
    r.emit(g, "   from 127.0.0.1 meanwhile, so data keeps arriving without heartbeats")
    t0 = time.monotonic()
    os.kill(sim.pid, signal.SIGSTOP)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tx.bind(("127.0.0.1", 0))
    stop = threading.Event()

    def data_only():
        while not stop.is_set():
            ms = int(time.time() * 1000) & 0xFFFFFFFF
            body = struct.pack("<I", ms) + b"".join(
                struct.pack("<BI", ch, 1_000_000_000) for ch in range(1, 11)
            )
            tx.sendto(
                struct.pack("<BBIBB", 3, 0, ms, 1, 10) + body, ("127.0.0.1", P["P_DAQ"])
            )
            time.sleep(0.1)

    th = threading.Thread(target=data_only, daemon=True)
    time.sleep(1.0)
    th.start()
    time.sleep(8.0)
    stop.set()
    th.join()
    tx.close()
    for ln in events(mon, t0, 21, SINCE_STOP):
        r.emit(g, ln)
    r.emit(
        g,
        f"  PT1.* sensor updates on the WS while heartbeats were stopped: {pt_data_between(mon, t0 + 2.0, t0 + 9.0) > 0}",
    )
    r.emit(g, f"  board 21 connected at +9 s: {board_connected(mon, 21)}")
    t1 = time.monotonic()
    os.kill(sim.pid, signal.SIGCONT)
    wait_until(lambda: board_connected(mon, 21), 10)
    time.sleep(1.5)
    r.emit(g, "  SIGCONT (no reboot, no SETUP):")
    for ln in events(mon, t1, 21, SINCE_START):
        r.emit(g, ln)
    r.emit(g)

    r.emit(
        g,
        "== server heartbeat stops: heartbeat_service SIGTERM; board 21 is a sensor board",
    )
    t2 = time.monotonic()
    rc, _ = r.stop(hb)
    r.emit(g, f"  heartbeat_service exit {rc}")
    time.sleep(7.0)
    r.emit(
        g,
        f"  SERVER_HEARTBEAT on the broadcast port after +0.5 s: {len(cap.get('P_HB_SVC', t2 + 0.5))}",
    )
    r.emit(
        g,
        f"  daq_bridge takes over sending SERVER_HEARTBEAT: {len(cap.get('P_HB_BRIDGE', t2)) > 0}",
    )
    r.emit(g, f"  board 21 connected at +7 s: {board_connected(mon, 21)}")
    evs = events(mon, t2, 21, SINCE_STOP)
    r.emit(g, f"  board status changes / notifications in those 7 s: {len(evs)}")
    for ln in evs:
        r.emit(g, ln)
    t3 = time.monotonic()
    r.svc(
        "heartbeat_service_restart",
        "heartbeat_service",
        "--config",
        r.cfg,
        "--elodin-host",
        "127.0.0.1",
        "--elodin-port",
        str(P["P_ELODIN"]),
    )
    got = cap.wait_for("P_HB_SVC", 3.0, t3)
    r.emit(
        g,
        f"  heartbeat_service restarted: first SERVER_HEARTBEAT after {N.bucket(got[0] - t3, [bound(0, 2.0, "first send precedes the first 200 ms sleep; + process start-up")]) if got else 'never'}",
    )
    r.emit(g)


def dup_subscription(r: Run):
    g = "dupsub"
    r.emit(
        g,
        "== test/test_duplicate_subscription.ts against the running stack (PT1.CH1 [0x20,0x01])",
    )
    pr = r.start(
        "dupsub",
        [
            "node",
            "--import",
            "tsx",
            os.path.join(ROOT, "test", "test_duplicate_subscription.ts"),
            str(P["P_ELODIN"]),
        ],
        cwd=stack.BACKEND_DIR,
    )
    rc, _ = pr.wait(60)
    r.emit(g, f"  exit {rc}")
    # Every line the script prints about its measurements is kept; only values are masked.
    #   verdicts: the delivery ratio is rounded to a whole multiple (the script's own 20 %
    #     tolerance is far finer than run-to-run rate noise needs);
    #   packet counts and rates: wall-clock, masked to <count>/<rate>;
    #   "max burst" lines: the count, the per-ms average and the script's own burst verdict
    #     (icon + wording) are a scheduling heuristic that flips run to run, so all three are
    #     masked and only the line's shape and its phase label stay.
    for ln in pr.output().splitlines():
        s = ln.strip()
        m = re.match(r"^(✅|❌|⚠️)\s+(\d+) subscriptions: (.*?)\(ratio=([\d.]+)x", s)
        b = re.match(r"^(?:✅|❌|⚠️)\s+(after-\d+x): max burst", s)
        if m:
            r.emit(
                g,
                f"  {m.group(1)} {m.group(2)} subscriptions: {m.group(3).strip()} (ratio ~{round(float(m.group(4)))}x)",
            )
        elif b:
            r.emit(
                g,
                f"  <burst-verdict> {b.group(1)}: max burst <count> packets/ms"
                " (avg <rate>/ms) — <burst-verdict>",
            )
        elif s.startswith("Received "):
            s = re.sub(r"^Received \d+ packets", "Received <count> packets", s)
            r.emit(g, "  " + re.sub(r"\([\d.]+ pkt/s\)", "(<rate> pkt/s)", s))
        elif s.startswith("Rates:"):
            r.emit(g, "  " + re.sub(r"=[\d.]+", "=<rate>", s))
        elif s.startswith(
            ("✅ Baseline", "❌ No packets", "✅ Connected", "❌ Failed")
        ):
            r.emit(g, "  " + re.sub(r"[\d.]+ pkt/s", "<rate> pkt/s", s))
        elif re.match(r"^\d+ passed, \d+ failed$", s):
            r.emit(g, "  " + s)


def make_fake_pio(r: Run):
    fb = os.path.join(r.work, "fakebin")
    os.makedirs(fb, exist_ok=True)
    with open(os.path.join(r.work, "fw_build.bin"), "wb") as f:
        f.write(bytes((i * 7 + 3) & 0xFF for i in range(9000)))
    script = """#!/bin/sh
{
  echo "args=$*"
  echo "PLATFORMIO_BUILD_FLAGS=${PLATFORMIO_BUILD_FLAGS-<unset>}"
  echo "cwd=$(basename "$PWD")"
} > "$PWD/fakepio.record"
if [ -f "$PWD/FAIL" ]; then echo "boom: build failed"; exit 3; fi
env=$(sed -n 's/^\\[env:\\(.*\\)\\]/\\1/p' platformio.ini | head -1)
mkdir -p ".pio/build/$env"
cp "$FAKE_FW" ".pio/build/$env/firmware.bin"
echo "fake build ok"
"""
    p = os.path.join(fb, "pio")
    with open(p, "w") as f:
        f.write(script)
    os.chmod(p, 0o755)
    for name, fail in (("proj_ok", False), ("proj_fail", True)):
        d = os.path.join(r.work, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "platformio.ini"), "w") as f:
            f.write("[platformio]\n\n[env:fake_env]\nplatform = none\n\n[env:second]\n")
        if fail:
            open(os.path.join(d, "FAIL"), "w").close()


def ota_handshake(r: Run):
    g = "ota"
    fw = bytes((i * 31 + 17) & 0xFF for i in range(10000))  # 3 chunks of <= 4096
    fw_path = os.path.join(r.work, "fw.bin")
    open(fw_path, "wb").write(fw)
    empty = os.path.join(r.work, "empty.bin")
    open(empty, "wb").close()
    build_fw = open(os.path.join(r.work, "fw_build.bin"), "rb").read()
    port = P["P_OTA"]

    def case(title, line, behavior, expected=fw, record_dir=None):
        r.emit(g, f"== ota_service: {title}")
        r.emit(g, f"  command: {line}")
        board = FakeOtaBoard(behavior) if behavior else None
        reply = ota_line(port, line)
        r.emit(g, f"  reply: {reply}")
        if board:
            for ln in board.report(expected):
                r.emit(g, ln)
        if record_dir:
            rec = os.path.join(record_dir, "fakepio.record")
            if os.path.exists(rec):
                for ln in open(rec).read().splitlines():
                    r.emit(g, f"  pio saw: {ln}")
                os.remove(rec)
            else:
                r.emit(g, "  pio saw: (not run)")

    case("flash, board answers OK", f"OTA_FLASH:127.0.0.1:{fw_path}", "ok")
    case(
        "flash, board closes without answering",
        f"OTA_FLASH:127.0.0.1:{fw_path}",
        "silent",
    )
    case("flash, board answers FAIL", f"OTA_FLASH:127.0.0.1:{fw_path}", "fail")
    case("flash, nothing listening on 3232", f"OTA_FLASH:127.0.0.1:{fw_path}", None)
    case(
        "flash, missing file",
        f"OTA_FLASH:127.0.0.1:{os.path.join(r.work, 'missing.bin')}",
        None,
    )
    case("flash, empty file", f"OTA_FLASH:127.0.0.1:{empty}", None)
    case("flash, malformed", "OTA_FLASH:127.0.0.1", None)
    case("unknown command", "HELLO", None)
    ok_dir, fail_dir = os.path.join(r.work, "proj_ok"), os.path.join(
        r.work, "proj_fail"
    )
    case(
        "build+flash, board_id 21",
        f"OTA_BUILD_FLASH|127.0.0.1|{ok_dir}|21",
        "ok",
        build_fw,
        ok_dir,
    )
    case(
        "build+flash, board_id 0",
        f"OTA_BUILD_FLASH|127.0.0.1|{ok_dir}|0",
        "ok",
        build_fw,
        ok_dir,
    )
    case(
        "build+flash, build fails",
        f"OTA_BUILD_FLASH|127.0.0.1|{fail_dir}|5",
        None,
        record_dir=fail_dir,
    )
    case(
        "build+flash, no platformio.ini",
        f"OTA_BUILD_FLASH|127.0.0.1|{r.work}/nowhere|5",
        None,
    )
    case("build+flash, malformed", f"OTA_BUILD_FLASH|127.0.0.1|{ok_dir}", None)

    def post(title, body: dict, behavior=None, expected=fw, headers=None):
        r.emit(g, f"== backend POST /api/ota-flash: {title}")
        board = FakeOtaBoard(behavior) if behavior else None
        st, resp = stack.http(
            "POST",
            P["P_WS"],
            "/api/ota-flash",
            json.dumps(body).encode(),
            timeout=60,
            headers=headers,
        )
        try:
            shown = N.dumps(json.loads(resp))
        except ValueError:
            shown = resp.decode("utf-8", "replace")
        r.emit(g, f"  -> {st} {shown}")
        if board:
            for ln in board.report(expected):
                r.emit(g, ln)

    b64 = base64.b64encode(fw).decode()
    post(
        "firmwareBase64, board answers OK",
        {"ip": "127.0.0.1", "firmwareBase64": b64},
        "ok",
    )
    post(
        "firmwareBase64, nothing listening", {"ip": "127.0.0.1", "firmwareBase64": b64}
    )
    post(
        "projectPath + boardId 21",
        {"ip": "127.0.0.1", "projectPath": ok_dir, "boardId": 21},
        "ok",
        build_fw,
    )
    post(
        "port other than 3232", {"ip": "127.0.0.1", "port": 1234, "firmwareBase64": b64}
    )
    post("no ip", {"firmwareBase64": b64})
    post("neither firmware nor project", {"ip": "127.0.0.1"})
    # H8 (DESIGN-WP7 §7, LEDGER D-OTA / SEC-2): the same flash as the viewer -- a signed-in email
    # that is not in operators.txt. The route has no operator gate, so today the board is flashed
    # and the viewer gets the operator's 200; frozen so the hole stays visible until the team
    # closes it (a 403 here is that fix, a contract change, not a regression).
    post(
        "firmwareBase64, board answers OK, as viewer@example.com (not an operator; no gate)",
        {"ip": "127.0.0.1", "firmwareBase64": b64},
        "ok",
        headers={"X-Auth-Email": "viewer@example.com"},
    )


def shutdown(r: Run, cap, mon, sim, cb, sl, cal, ota, el, br, hb, be):
    g = "shutdown"
    # Edges per service: what bounds its exit after the signal.
    IMMEDIATE = [bound(0, 0.6, "exits on its next loop check (<= 100 ms), + 0.5 s")]
    PER = {
        "board_simulator": [bound(0, 1.0, "_sigterm_handler sleeps 0.1 s, + 0.9 s")],
        "config_broadcast_service": IMMEDIATE,
        "stacklight_service": [
            bound(0, 1.2, "kStacklightRecvTimeoutMs 500 + 100 ms loop, + 0.6 s")
        ],
        "calibration_service": [bound(0, 3.5, "timing assumption, README")],
        "ota_service": [bound(0, 1.6, "select timeout 1 s, + 0.6 s")],
        "elodin-db": [bound(0, 5.0, "not our code: timing assumption, README")],
        "daq_bridge": IMMEDIATE,
        "heartbeat_service": [
            bound(0, 3.6, "kElodinRecvTimeoutMs 3000 + 100 ms loop, + 0.5 s")
        ],
        "backend (node server.ts)": [
            bound(0, 0.6, "no signal handler: default action")
        ],
    }
    watch = [
        "pt_board",
        "actuator_board_2",
        "actuator_board_4",
        "integration_startup",
        "P_HB_SVC",
        "P_STACK",
    ]

    def after(t, names):
        counts = {n: len(cap.get(n, t + 0.25)) for n in names}
        return ", ".join(f"{n}={c}" for n, c in counts.items())

    def one(label, pr, extra=None):
        t = time.monotonic()
        rc, dt = r.stop(pr)
        time.sleep(1.5)
        r.emit(g, f"== SIGTERM {label}")
        r.emit(
            g,
            f"  exit {rc} within {N.bucket(dt if dt is not None else 99, PER[label])}",
        )
        if extra:
            for ln in extra(t):
                r.emit(g, ln)
        return t

    # The PT listen port is the simulator's while it runs; take it back to watch it go quiet.
    one("board_simulator", sim)
    cap.listen("pt_board", P["P_PT_LISTEN"])
    t = one(
        "config_broadcast_service",
        cb,
        lambda t: [f"  packets after the signal: {after(t, watch[:4])}"],
    )
    one(
        "stacklight_service",
        sl,
        lambda t: [f"  packets after the signal: {after(t, ['P_STACK'])}"],
    )

    def cal_extra(t):
        log = cal.output()
        return [
            f"  'Saved robust adjustments on shutdown' logged: {'Saved robust adjustments on shutdown' in log}",
            f"  adjustments file written: {os.path.exists(os.path.join(r.work, 'adjustments.json'))}",
            f"  '[Cal] Stopped.' logged: {'[Cal] Stopped.' in log}",
        ]

    one("calibration_service", cal, cal_extra)
    one(
        "ota_service",
        ota,
        lambda t: [
            f"  command port still accepting: {stack.wait_tcp(P['P_OTA'], 0.3)}"
        ],
    )

    def elodin_extra(t):
        time.sleep(2.0)
        status = [
            f
            for tt, f in mon.snapshot()
            # from +1 s: the 1 Hz status tick can land between the signal and the socket close
            if tt >= t + 1.0 and f.get("type") == "connection_status"
        ]
        flags = sorted(
            {
                (f["payload"].get("elodinConnected"), f["payload"].get("dataFresh"))
                for f in status
            }
        )
        return [
            f"  backend connection_status (elodinConnected, dataFresh) after: {flags}",
            f"  heartbeat_service still sending SERVER_HEARTBEAT: {len(cap.get('P_HB_SVC', t + 1.0)) > 0}",
            f"  daq_bridge still running: {br.alive()}",
            f"  backend still running: {be.alive()}",
        ]

    one("elodin-db", el, elodin_extra)
    one(
        "daq_bridge",
        br,
        lambda t: [
            f"  'Shutdown complete' logged: {'[DAQ Bridge] Shutdown complete' in br.output()}"
        ],
    )
    one(
        "heartbeat_service",
        hb,
        lambda t: [
            f"  packets after the signal: {after(t, ['P_HB_SVC'])}",
            f"  '[HeartbeatService] Stopped.' logged: {'[HeartbeatService] Stopped.' in hb.output()}",
        ],
    )

    def be_extra(t):
        wait_until(lambda: mon.closed_at is not None, 3)
        return [f"  WS client sees close code {mon.close_code}"]

    one("backend (node server.ts)", be, be_extra)


def sigint_each(r: Run):
    """SIGINT to each service, all on a fresh Elodin and nothing else: every exit code."""
    g = "shutdown"
    r.emit(g, "== SIGINT, each service started alone against a fresh elodin-db")
    el = r.start(
        "int_elodin",
        [r.elodin, "run", f"127.0.0.1:{P['P_ELODIN']}", os.path.join(r.work, "db_int")],
    )
    stack.wait_tcp(P["P_ELODIN"], 15)
    specs = [
        ("heartbeat_service", ["--config", r.cfg, "--elodin-port", str(P["P_ELODIN"])]),
        ("stacklight_service", ["--config", r.cfg]),
        ("config_broadcast_service", ["--config", r.cfg]),
        ("ota_service", ["--port", str(P["P_OTA"]), "--config", r.cfg]),
        (
            "calibration_service",
            [
                "--config",
                r.cfg,
                "--adjustments",
                os.path.join(r.work, "adj_int.json"),
                "--elodin-port",
                str(P["P_ELODIN"]),
            ],
        ),
        ("daq_bridge", [r.cfg]),
    ]
    procs = [(n, r.svc(f"int_{n}", n, *a)) for n, a in specs]
    time.sleep(2.5)
    for n, pr in procs:
        if not pr.alive():
            r.emit(
                g, f"  {n}: had already exited ({pr.p.returncode}) before the signal"
            )
            continue
        rc, dt = r.stop(pr, signal.SIGINT)
        r.emit(
            g,
            f"  {n}: exit {rc} within {N.bucket(dt if dt is not None else 99, [bound(0, 4.0, 'slowest loop: kElodinRecvTimeoutMs 3000, + 1 s')])}",
        )
    benv = {
        "WS_PORT": str(P["P_WS"]),
        "ELODIN_PORT": str(P["P_ELODIN"]),
        "CONFIG_PATH": r.cfg,
        "GUI_PORT": "0",
        "LOG_INGEST_PORT": str(P["P_LOG"]),
        "ACTUATOR_SERVICE_PORT": str(P["P_DEAD_SEQ"]),
        "CONTROLLER_SERVICE_PORT": str(P["P_DEAD_CTRL"]),
        "OTA_SERVICE_PORT": str(P["P_OTA"]),
    }
    be = r.start(
        "int_backend",
        ["node", "--import", "tsx", "src/server.ts"],
        cwd=stack.BACKEND_DIR,
        env=benv,
    )
    stack.wait_tcp(P["P_WS"], 60)
    rc, dt = r.stop(be, signal.SIGINT)
    r.emit(
        g,
        f"  backend (node server.ts): exit {rc} within {N.bucket(dt if dt is not None else 99, [bound(0, 1.0, 'no signal handler: default action')])}",
    )
    rc, dt = r.stop(el, signal.SIGINT)
    r.emit(
        g,
        f"  elodin-db: exit {rc} within {N.bucket(dt if dt is not None else 99, [bound(0, 5.0, 'not our code: timing assumption, README')])}",
    )


# ── main ─────────────────────────────────────────────────────────────────────────────────────


def compare(out: dict[str, list[str]]) -> int:
    fails = 0
    os.makedirs(GOLDEN, exist_ok=True)
    for name in sorted(out):
        text = "\n".join(out[name]).rstrip() + "\n"
        path = os.path.join(GOLDEN, f"{name}.txt")
        if UPDATE:
            open(path, "w").write(text)
            print(f"  wrote golden/{name}.txt ({len(out[name])} lines)")
            continue
        try:
            want = open(path).read()
        except OSError:
            print(
                f"  FAIL {name}: no golden (run with CHAR_UPDATE=1 on main's behaviour)"
            )
            fails += 1
            continue
        if want == text:
            print(f"  ok   {name}")
        else:
            fails += 1
            print(f"  FAIL {name}")
            sys.stdout.writelines(
                difflib.unified_diff(
                    want.splitlines(True),
                    text.splitlines(True),
                    f"golden/{name}.txt",
                    "actual",
                )
            )
    expected = {
        "startup",
        "sim_board",
        "reconnect",
        "hbloss",
        "dupsub",
        "ota",
        "shutdown",
    }
    missing = expected - set(out)
    for m in sorted(missing):
        print(f"  FAIL {m}: scenario produced nothing")
        fails += 1
    return fails


def main() -> int:
    preflight()
    r = Run()
    t0 = time.monotonic()
    try:
        bridge_only_heartbeat(r)
        session(r)
        sigint_each(r)
        sim_board(r)
        ball_valve_heartbeat_loss(r)
    finally:
        # The work dir is deleted on cleanup: keep the output of every process that exited
        # non-zero on its own (not by our signal), to print if the run fails.
        died = [
            (pr.name, pr.p.returncode, pr.output()[-2000:])
            for pr in r.procs
            if pr.p.poll() is not None and pr.p.returncode > 0
        ]
        r.cleanup()
    print(f"lifecycle: scenarios ran in {time.monotonic() - t0:.0f}s")
    fails = compare(r.out)
    print("LIFECYCLE: " + ("PASS" if fails == 0 else f"FAIL ({fails})"))
    if fails:
        for name, rc, tail in died:
            print(f"── diagnostic: {name} exited {rc}; last output:\n{tail}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
