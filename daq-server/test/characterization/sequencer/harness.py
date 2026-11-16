"""Process, network and config plumbing for the sequencer characterization suite.

Everything here binds 127.0.0.1 only and every config it writes has had each board, broadcast and
heartbeat address rewritten to 127.0.0.1 (``patch_config`` asserts no 192.168.x.x survives).
Run it under ``test/characterization/with_stack_lock.sh`` (``run.sh`` does).
"""

from __future__ import annotations

import csv
import os
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DAQ = HERE.parents[2]  # daq-server/
REPO = DAQ.parent

# Private port range for this area (test_integration.sh uses 5014-5016, 8181-8192, 9997-9998,
# 2241). Nothing here is shared with another characterization area.
ACT_PORT = 26301  # actuator UDP + abort broadcast + PWM: the one capture port
SEQ_PORT = 26302  # sequencer_service TCP
CTL_PORT = 26303  # controller_service TCP (FIRE_START / FIRE_STOP)
DB_PORT = 26304  # [database].port: dead, or the fake pressure feed when one is running
SENSOR_PORT = (
    26306  # board send_port / [network].sensor_port: nothing listens; never used here
)


def build_dir() -> Path:
    env = os.environ.get("CHAR_BUILD_DIR")
    if env:
        return Path(env)
    for b in (DAQ / "build-gate", DAQ / "build"):
        if (b / "bin" / "sequencer_service").exists():
            return b
    raise SystemExit("sequencer char: no build dir with bin/sequencer_service")


# ── config ─────────────────────────────────────────────────────────────────────────────────────


def _section_sub(text: str, section: str, key: str, value: str) -> str:
    """Replace ``key = ...`` inside ``[section]`` only. Asserts it was there."""
    pat = re.compile(
        r"(^\["
        + re.escape(section)
        + r"\]\n(?:(?!\[).*\n)*?)^"
        + re.escape(key)
        + r" = .*$",
        re.M,
    )
    new, n = pat.subn(lambda m: m.group(1) + f"{key} = {value}", text, count=1)
    assert n == 1, f"[{section}] {key} not found"
    return new


def _section_set(text: str, section: str, key: str, value: str) -> str:
    """Set ``key`` in ``[section]``, adding it under the header when absent."""
    try:
        return _section_sub(text, section, key, value)
    except AssertionError:
        new, n = re.subn(
            r"^\[" + re.escape(section) + r"\]\n",
            f"[{section}]\n{key} = {value}\n",
            text,
            count=1,
            flags=re.M,
        )
        assert n == 1, f"[{section}] not found"
        return new


def patch_config(text: str, workdir: Path, overrides=None) -> str:
    """Point a profile config at loopback, the private ports and this run's CSV copies."""
    text = text.replace('subnet = "192.168.2.0/24"', 'subnet = "127.0.0.0/24"')
    text = re.sub(r"192\.168\.\d+\.\d+", "127.0.0.1", text)
    text = re.sub(r"^bind_ip = .*$", 'bind_ip = "127.0.0.1"', text, flags=re.M)
    text = re.sub(
        r"^(actuator_cmd_port|broadcast_port|listen_port|target_port) = \d+",
        rf"\1 = {ACT_PORT}",
        text,
        flags=re.M,
    )
    text = re.sub(
        r"^(send_port|sensor_port) = \d+", rf"\1 = {SENSOR_PORT}", text, flags=re.M
    )
    text = re.sub(r"^(elodin_port) = \d+", rf"\1 = {DB_PORT}", text, flags=re.M)
    text = _section_sub(text, "database", "port", str(DB_PORT))
    text = _section_sub(text, "controller_service", "port", str(CTL_PORT))
    text = _section_sub(text, "actuator_service", "port", str(SEQ_PORT))
    for key, name in (
        ("transitions_csv", "state_transitions.csv"),
        ("actuator_csv", "state_machine_actuators.csv"),
        ("actuator_delay_csv", "state_machine_actuator_delays.csv"),
    ):
        text = _section_sub(text, "state_machine", key, f'"{workdir / name}"')
    for (section, key), value in (overrides or {}).items():
        text = _section_set(text, section, key, value)
    # The point of all the above. Anything still naming the stand's subnet or ports is a bug here.
    assert "192.168." not in text, "a 192.168.x.x address survived patching"
    live = "\n".join(ln for ln in text.splitlines() if not ln.lstrip().startswith("#"))
    for bad in (r"= 5005\b", r"= 2240\b", r"^\s*port = 999[89]\b"):
        assert not re.search(bad, live, re.M), f"stand port survived patching: {bad}"
    return text


def read_csv(path: Path):
    with open(path, newline="") as f:
        return [row for row in csv.reader(f)]


def write_csv(path: Path, rows) -> None:
    with open(path, "w", newline="") as f:
        csv.writer(f, lineterminator="\n").writerows(rows)


class Profile:
    """A profile's config and CSVs, copied into a private work dir and patched."""

    def __init__(self, name: str, config_src: Path, csv_dir: Path, workroot: Path):
        self.name = name
        self.config_src = config_src
        self.csv_dir = csv_dir
        self.dir = workroot / name
        self.config_text = config_src.read_text()

    def materialise(
        self, overrides=None, scripts=None, extra_toml="", csv_edit=None
    ) -> Path:
        if self.dir.exists():
            shutil.rmtree(self.dir)
        self.dir.mkdir(parents=True)
        for name in (
            "state_transitions.csv",
            "state_machine_actuators.csv",
            "state_machine_actuator_delays.csv",
        ):
            shutil.copy(self.csv_dir / name, self.dir / name)
        src_scripts = self.config_src.parent / "scripts"
        (self.dir / "scripts").mkdir()
        if src_scripts.is_dir():
            for p in src_scripts.iterdir():
                shutil.copy(p, self.dir / "scripts" / p.name)
        for name, body in (scripts or {}).items():
            (self.dir / "scripts" / name).write_text(body)
        if csv_edit:
            csv_edit(self.dir)
        text = patch_config(self.config_text, self.dir, overrides) + extra_toml
        cfg = self.dir / "config.toml"
        cfg.write_text(text)
        return cfg

    def matrix(self):
        rows = read_csv(self.csv_dir / "state_transitions.csv")
        return rows[0][1:], {r[0]: r[1:] for r in rows[1:] if r and r[0]}


# ── UDP recorder ───────────────────────────────────────────────────────────────────────────────


class Recorder:
    """Every datagram to ACT_PORT, with a monotonic arrival time. One socket for the whole run."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", ACT_PORT))
        self.sock.settimeout(0.05)
        self.lock = threading.Lock()
        self.packets: list[tuple[int, bytes]] = []
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                data, _ = self.sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError:
                return
            t = time.monotonic_ns()
            with self.lock:
                self.packets.append((t, data))

    def mark(self) -> int:
        return len(self.packets)

    def since(self, mark: int):
        with self.lock:
            return list(self.packets[mark:])

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()


# ── processes ──────────────────────────────────────────────────────────────────────────────────


def _wait_port(port: int, proc: subprocess.Popen, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"process exited early (rc={proc.returncode})")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.02)
    raise RuntimeError(f"port {port} never opened")


def _port_free(port: int, kind=socket.SOCK_STREAM) -> bool:
    s = socket.socket(socket.AF_INET, kind)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


LIVE: list["Service"] = (
    []
)  # everything started and not yet stopped, for cleanup on error


class Service:
    """One binary we started. Only ever kills its own PID."""

    def __init__(self, argv, log: Path, port: int):
        if not _port_free(port):
            raise RuntimeError(
                f"port {port} is busy — another run holding it? (not killing it)"
            )
        self.log = log
        self.logf = open(log, "w")
        self.proc = subprocess.Popen(
            argv, cwd=DAQ, stdout=self.logf, stderr=subprocess.STDOUT
        )
        LIVE.append(self)
        try:
            _wait_port(port, self.proc)
        except Exception:
            self.stop()
            raise

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                # A clean exit takes well under a second; a process that is still up after this
                # (a deadlocked worker the destructor joins, the controller's blocked reader) is
                # killed — its logs are already on disk.
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.logf.close()
        if self in LIVE:
            LIVE.remove(self)

    def log_text(self) -> str:
        if not self.logf.closed:
            self.logf.flush()
        return self.log.read_text(errors="replace")


def start_sequencer(cfg: Path, log: Path) -> Service:
    exe = build_dir() / "bin" / "sequencer_service"
    return Service(
        [str(exe), "--config", str(cfg), "--port", str(SEQ_PORT)], log, SEQ_PORT
    )


def start_controller(cfg: Path, log: Path) -> Service:
    exe = build_dir() / "bin" / "controller_service"
    argv = [
        str(exe),
        "--config",
        str(cfg),
        "--elodin-host",
        "127.0.0.1",
        "--elodin-port",
        str(DB_PORT),
        "--control-port",
        str(CTL_PORT),
    ]
    return Service(argv, log, CTL_PORT)


class Client:
    """One persistent TCP connection to a newline-command service."""

    def __init__(self, port: int):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=15)
        self.buf = b""

    def cmd(self, line: str) -> str:
        self.sock.sendall(line.encode() + b"\n")
        return self._line()

    def raw(self, data: bytes, lines: int = 1) -> list[str]:
        self.sock.sendall(data)
        return [self._line() for _ in range(lines)]

    def _line(self) -> str:
        while b"\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("peer closed")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return line.decode(errors="replace")

    def until(self, terminator: str) -> list[str]:
        out = []
        while True:
            line = self._line()
            out.append(line)
            if line == terminator:
                return out

    def close(self) -> None:
        self.sock.close()


def one_shot(port: int, payload: bytes, timeout: float = 2.0) -> str:
    """Connect, send, read until close: how the sequencer talks to the controller."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        if payload:
            s.sendall(payload)
        s.shutdown(
            socket.SHUT_WR
        )  # so a payload with no newline ends at once, not on a timeout
        out = b""
        while True:
            try:
                chunk = s.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            out += chunk
    return out.decode(errors="replace")


def u32(b: bytes, off: int) -> int:
    return struct.unpack_from("<I", b, off)[0]
