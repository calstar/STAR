"""Process, port and capture plumbing for the lifecycle characterization.

Everything here is loopback-only and scratch-only:
  - every service runs against a patched copy of config/config_base.toml in which every board,
    broadcast and bind address is 127.0.0.1 (build_config asserts no 192.168.2.x survives);
  - C++ services run from a scratch cwd holding a copy of the tracked calibration files, because
    calibration_service, daq_bridge and config_broadcast_service resolve
    scripts/calibration/calibrations/... against cwd and calibration_service writes there;
  - only processes this harness started are ever signalled (own process groups).
"""

from __future__ import annotations

import os
import re
import select
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))  # daq-server/
BACKEND_DIR = os.path.join(ROOT, "diablo_server", "backend")


def bin_dir() -> str:
    b = os.environ.get("CHAR_BUILD_DIR")
    for cand in ([os.path.join(b, "bin")] if b else []) + [
        os.path.join(ROOT, "build", "bin")
    ]:
        if os.path.isfile(os.path.join(cand, "daq_bridge")):
            return cand
    raise SystemExit(
        "lifecycle: no built binaries (bash scripts/build.sh, or set CHAR_BUILD_DIR)"
    )


def elodin_bin() -> str:
    """elodin-db at the version setup.sh and CI pin. Another version is refused, not tolerated:
    0.14.2 rejects every VTable registration this stack sends (Postcard SerdeDeCustom), so nothing
    reaches the backend and every golden here would freeze a dead pipeline."""
    pinned = re.search(
        r'ELODIN_VERSION="v([0-9.]+)"', open(os.path.join(ROOT, "setup.sh")).read()
    ).group(1)
    cands = [os.environ.get("ELODIN_DB_BIN", "")]
    cands += [
        os.path.expanduser("~/.cargo/bin/elodin-db"),
        shutil.which("elodin-db") or "",
    ]
    seen = []
    for c in cands:
        if not c or not os.path.isfile(c):
            continue
        ver = subprocess.run(
            [c, "--version"], capture_output=True, text=True
        ).stdout.split()
        got = ver[-1] if ver else "?"
        if got == pinned:
            return c
        seen.append(f"{c} is {got}")
    raise SystemExit(
        f"lifecycle: need elodin-db {pinned} (pinned in setup.sh and CI); "
        f"found: {'; '.join(seen) or 'none'}. Set ELODIN_DB_BIN to a {pinned} binary."
    )


# ── config ────────────────────────────────────────────────────────────────────────────────────


def _split_sections(text: str) -> list[list[str]]:
    sections: list[list[str]] = [[]]
    for line in text.splitlines():
        if re.match(r"^\[\[?[^\]]+\]\]?\s*(#.*)?$", line):
            sections.append([])
        sections[-1].append(line)
    return sections


def _set_key(lines: list[str], key: str, value: str) -> list[str]:
    pat = re.compile(rf"^{re.escape(key)}\s*=")
    out, done = [], False
    for ln in lines:
        if pat.match(ln):
            out.append(f"{key} = {value}")
            done = True
        else:
            out.append(ln)
    if not done:
        # insert after the header (and keep trailing blank lines at the end)
        out.insert(1, f"{key} = {value}")
    return out


def build_config(
    path: str,
    p: dict,
    heartbeat_service_enabled: bool = True,
    boards: dict | None = None,
    keep_t7: bool = False,
):
    """Write the lifecycle config. `boards` maps board key -> listen_port for the boards kept
    enabled (all on 127.0.0.1); every other board is disabled. `keep_t7` leaves the LabJack T7
    section's `enabled` as config_base has it (a T7 has no listen_port, and `t7_bridge --fake`
    exits 0 at once with no enabled T7); its address still lands on loopback below."""
    base = open(os.path.join(ROOT, "config", "config_base.toml")).read()
    boards = boards or {}
    sections = _split_sections(base)
    out_sections = []
    for sec in sections:
        head = sec[0] if sec else ""
        m = re.match(r"^\[boards\.([A-Za-z0-9_]+)\]", head)
        if m:
            key = m.group(1)
            if key in boards:
                sec = _set_key(sec, "enabled", "true")
                sec = _set_key(sec, "ip", '"127.0.0.1"')
                sec = _set_key(sec, "listen_port", str(boards[key]))
            elif keep_t7 and any(re.match(r'^type\s*=\s*"T7"', ln) for ln in sec):
                pass
            else:
                sec = _set_key(sec, "enabled", "false")
        elif head.startswith("[network]"):
            sec = _set_key(sec, "bind_ip", '"127.0.0.1"')
            sec = _set_key(sec, "sensor_port", str(p["P_DAQ"]))
            sec = _set_key(sec, "actuator_cmd_port", str(p["P_ACTCMD"]))
        elif head.startswith("[server_heartbeat]"):
            sec = _set_key(sec, "broadcast_ip", '"127.0.0.1"')
            sec = _set_key(sec, "broadcast_port", str(p["P_HB_BRIDGE"]))
        elif head.startswith("[heartbeat_service]"):
            sec = _set_key(
                sec, "enabled", "true" if heartbeat_service_enabled else "false"
            )
            sec = _set_key(sec, "broadcast_ip", '"127.0.0.1"')
            sec = _set_key(sec, "broadcast_port", str(p["P_HB_SVC"]))
            sec = _set_key(sec, "elodin_port", str(p["P_ELODIN"]))
        elif head.startswith("[database]"):
            sec = _set_key(sec, "port", str(p["P_ELODIN"]))
        elif head.startswith("[logs]"):
            sec = _set_key(sec, "backend_udp_port", str(p["P_LOG"]))
        elif head.startswith("[state_machine]"):
            prof = os.path.join(ROOT, "config", "profiles", "default")
            sec = _set_key(sec, "actuator_csv", f'"{prof}/state_machine_actuators.csv"')
            sec = _set_key(
                sec, "actuator_delay_csv", f'"{prof}/state_machine_actuator_delays.csv"'
            )
            sec = _set_key(sec, "transitions_csv", f'"{prof}/state_transitions.csv"')
        elif head.startswith("[actuator_service]"):
            sec = _set_key(sec, "port", str(p["P_DEAD_SEQ"]))
            sec = _set_key(sec, "bind_address", '"127.0.0.1"')
        elif head.startswith("[controller_service]"):
            sec = _set_key(sec, "port", str(p["P_DEAD_CTRL"]))
        out_sections.append(sec)
    text = "\n".join("\n".join(s) for s in out_sections) + "\n"
    # Every address left from the stand's subnet goes to loopback: disabled boards land on
    # 127.0.0.<n>, which nothing here sends to and nothing on this host can bind.
    text = text.replace("192.168.2.255", "127.0.0.1").replace("192.168.2.", "127.0.0.")
    if "integration_startup" in boards:
        text += (
            '\n[boards.integration_startup]\nenabled = true\ntype = "PT"\nboard_id = 60\n'
            f'ip = "127.0.0.1"\nsend_port = {p["P_DAQ"]}\nlisten_port = {boards["integration_startup"]}\n'
            "num_sensors = 1\nactive_connectors = [1]\nvoltage_reference = 1\n"
            "necessary_for_abort = false\nenable_serial_printing = 0\ndesignated_survivor = false\n"
        )
    text += (
        "\n[stacklight_service]\n"
        f'target_ip = "127.0.0.1"\ntarget_port = {p["P_STACK"]}\ninterval_ms = 1000\n'
        f'elodin_host = "127.0.0.1"\nelodin_port = {p["P_ELODIN"]}\n'
    )
    assert "192.168.2." not in text, "lifecycle config still names the stand's subnet"
    assert '"0.0.0.0"' not in text.split("[network]")[1].split("\n[")[0]
    with open(path, "w") as f:
        f.write(text)
    return path


def make_cwd(path: str):
    """Scratch cwd with the tracked calibration files as committed (never the checkout's live
    store, and not the working tree's copy either: a dirty abort_thresholds.txt, which the
    calibration service rewrites in place, moved the startup golden — LEDGER D103)."""
    try:
        files = subprocess.run(
            ["git", "-C", ROOT, "ls-files", "scripts/calibration/calibrations"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        files = []
    from_head = bool(files)
    if not files:
        # Not a git checkout (a `git archive` export, as the Linux gate runs): the directory then
        # holds exactly the tracked files, so take all of them.
        base = os.path.join(ROOT, "scripts", "calibration", "calibrations")
        for d, _dirs, names in os.walk(base):
            for n in names:
                files.append(os.path.relpath(os.path.join(d, n), ROOT))
    for rel in files:
        dst = os.path.join(path, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if from_head:
            # HEAD's blob, bytes as committed ("HEAD:./rel" is relative to -C ROOT, a subdirectory).
            blob = subprocess.run(
                ["git", "-C", ROOT, "show", f"HEAD:./{rel}"],
                capture_output=True,
                check=True,
            ).stdout
            with open(dst, "wb") as f:
                f.write(blob)
        else:
            shutil.copyfile(os.path.join(ROOT, rel), dst)
    os.makedirs(
        os.path.join(path, "scripts", "calibration", "calibrations"), exist_ok=True
    )


# ── ports ─────────────────────────────────────────────────────────────────────────────────────


def port_free(port: int, udp: bool = False) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def wait_tcp(port: int, timeout: float) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def http(
    method: str,
    port: int,
    path: str,
    body: bytes | None = None,
    timeout: float = 30,
    headers: dict | None = None,
):
    # headers: extra request headers (the identity header X-Auth-Email a viewer carries); none by
    # default, so every existing call sends exactly what it sent before.
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        headers=dict(headers or {}),
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# ── processes ─────────────────────────────────────────────────────────────────────────────────


class Proc:
    def __init__(
        self, name: str, argv: list[str], cwd: str, log: str, env: dict | None = None
    ):
        self.name = name
        self.log = log
        full_env = dict(os.environ)
        full_env.update(env or {})
        self.logf = open(log, "wb")
        self.p = subprocess.Popen(
            argv,
            cwd=cwd,
            env=full_env,
            stdout=self.logf,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.pid = self.p.pid
        self.signalled_at: float | None = None

    def alive(self) -> bool:
        return self.p.poll() is None

    def signal(self, sig: int):
        self.signalled_at = time.monotonic()
        if self.alive():
            os.kill(self.pid, sig)

    def wait(self, timeout: float) -> tuple[int | None, float | None]:
        try:
            rc = self.p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, None
        return rc, time.monotonic() - (self.signalled_at or time.monotonic())

    def output(self) -> str:
        if not self.logf.closed:  # reap() closes it; the file on disk is complete then
            self.logf.flush()
        try:
            return open(self.log, "rb").read().decode("utf-8", "replace")
        except OSError:
            return ""

    def wait_log(self, pattern: str, timeout: float) -> bool:
        end = time.monotonic() + timeout
        rx = re.compile(pattern)
        while time.monotonic() < end:
            if rx.search(self.output()):
                return True
            if not self.alive():
                return bool(rx.search(self.output()))
            time.sleep(0.05)
        return False

    def reap(self):
        """Stop this process and its group (only ever our own group)."""
        if self.alive():
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                self.p.wait(timeout=4)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.pid, signal.SIGKILL)
                except OSError:
                    pass
                self.p.wait(timeout=4)
        else:
            try:  # stragglers a dead leader left behind in its group
                os.killpg(self.pid, signal.SIGKILL)
            except OSError:
                pass
        self.logf.close()


# ── UDP capture ───────────────────────────────────────────────────────────────────────────────


class Capture:
    """Listens on named loopback UDP ports and records every datagram with its arrival time."""

    def __init__(self):
        self.socks: dict[str, socket.socket] = {}
        # name, mono, epoch_ms, data, source port
        self.packets: list[tuple[str, float, int, bytes, int]] = []
        # name -> the one source port accepted there (only_from); a process left over from an
        # earlier scenario, or another board on 127.0.0.1, can never be mistaken for the sender
        self.sources: dict[str, int] = {}
        self.passes = 0  # capture-loop passes started (release() waits on it)
        self.lock = threading.Lock()
        self._stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def listen(self, name: str, port: int):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.1", port))
        s.setblocking(False)
        with self.lock:
            self.socks[name] = s

    def only_from(self, name: str, port: int | None):
        with self.lock:
            if port is None:
                self.sources.pop(name, None)
            else:
                self.sources[name] = port

    def release(self, name: str, port: int | None = None, timeout: float = 10.0):
        """Stop listening on `name` and give its port back.

        On Linux a socket closed while another thread sits in select() on it stays bound until
        that select returns, so a simulator started right after the close can fail its bind
        (EADDRINUSE -> board_simulator.py exits 1). Close only once the capture thread has
        finished a full pass without this socket, then (with `port`) wait, bounded, until the
        port can actually be bound."""
        with self.lock:
            s = self.socks.pop(name, None)
            seen = self.passes
        if s:
            end = time.monotonic() + timeout
            while (
                self.passes < seen + 2
                and self.thread.is_alive()
                and time.monotonic() < end
            ):
                time.sleep(0.01)
            s.close()
        if port is not None:
            end = time.monotonic() + timeout
            while not port_free(port, udp=True) and time.monotonic() < end:
                time.sleep(0.05)
            if not port_free(port, udp=True):
                raise RuntimeError(
                    f"capture port {port} still bound {timeout}s after release"
                )

    def sock(self, name: str) -> socket.socket:
        return self.socks[name]

    def _run(self):
        while not self._stop:
            with self.lock:
                self.passes += (
                    1  # a pass that starts here cannot see a socket popped before
                )
                items = list(self.socks.items())
            if not items:
                time.sleep(0.01)
                continue
            try:
                r, _, _ = select.select([s for _, s in items], [], [], 0.05)
            except (OSError, ValueError):
                continue
            now, epoch = time.monotonic(), int(time.time() * 1000)
            for name, s in items:
                if s in r:
                    while True:
                        try:
                            data, addr = s.recvfrom(65536)
                        except (BlockingIOError, OSError):
                            break
                        with self.lock:
                            self.packets.append((name, now, epoch, data, addr[1]))

    def get(
        self,
        name: str,
        since: float = 0.0,
        until: float | None = None,
        ptype: int | None = None,
    ):
        with self.lock:
            src = self.sources.get(name)
            return [
                (t, e, d)
                for n, t, e, d, sp in self.packets
                if n == name
                and (src is None or sp == src)
                and t >= since
                and (until is None or t < until)
                and (ptype is None or (d and d[0] == ptype))
            ]

    def wait_for(
        self, name: str, timeout: float, since: float = 0.0, ptype: int | None = None
    ):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            got = self.get(name, since, ptype=ptype)
            if got:
                return got[0]
            time.sleep(0.02)
        return None

    def close(self):
        self._stop = True
        self.thread.join(timeout=2)
        for s in self.socks.values():
            s.close()
        self.socks.clear()


def median_gap(times: list[float]) -> float | None:
    gaps = sorted(b - a for a, b in zip(times, times[1:]))
    return gaps[len(gaps) // 2] if gaps else None
