#!/usr/bin/env python3
"""Black-box characterization of the services that parse config in their own main (area "config").

Run by check.sh as `bin_dump.py <bin dir> <out dir>`, from this directory, under the stack lock
(it starts service binaries and binds UDP listeners on 127.0.0.1). Each service is observed only
through what survives a refactor of its main: its startup log and the datagrams it sends.

Every input config is rewritten into a scratch directory first so nothing is ever addressed to the
board LAN: 192.168.2.N becomes 127.0.0.N (config_broadcast: 127.0.0.1, so one listener receives
every board's packet). Nothing else in the file changes.

  daq_bridge        its log up to "[System] Mode" (the board routing table), then it is stopped
                    before it opens Elodin or starts heartbeats
  stacklight        its startup lines, run with --force-state (no Elodin), then stopped
  config_broadcast  its log and every datagram of its first cycle (--interval-ms 60000), received
                    per destination port, then stopped
"""

import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.normpath(os.path.join(HERE, "..", "..", "..", "config"))
BAD = os.path.join(HERE, "fixtures", "bad")
BIN, OUT = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])


def inputs():
    tracked = [
        os.path.join(CFG, f)
        for f in [
            "config_base.toml",
            "config_flight_daq.toml",
            "config_ground_daq.toml",
            "config_sitl.toml",
        ]
    ]
    tracked += [
        os.path.join(CFG, "profiles", p, "config.toml")
        for p in sorted(os.listdir(os.path.join(CFG, "profiles")))
    ]
    bad = [os.path.join(BAD, f) for f in sorted(os.listdir(BAD)) if f.endswith(".toml")]
    return tracked + bad + [os.path.join(BAD, "does_not_exist.toml")]


def name_of(p):
    if p.startswith(CFG + os.sep):
        return os.path.relpath(p, CFG).replace(os.sep, "__")
    return "bad__" + os.path.relpath(p, BAD).replace(os.sep, "__")


def csv_dir_for(p):
    prof = os.path.join(CFG, "profiles") + os.sep
    return os.path.dirname(p) if p.startswith(prof) else os.path.join(CFG, "profiles", "default")


def normalize(line):
    # The loopback interface is lo0 on macOS and lo on Linux.
    line = re.sub(r"pinned to \S+ (127\.\d+\.\d+\.\d+)", r"pinned to <iface> \1", line)
    # An uncaught exception is reported by the C++ runtime, differently per platform.
    m = re.match(r"libc\+\+abi: terminating due to uncaught exception of type ([^:]+): (.*)", line)
    if m:
        return f"UNCAUGHT {m.group(1)}: {m.group(2)}"
    return line


class Run:
    """A service started with stdout+stderr on one pipe, read line by line."""

    def __init__(self, argv, cwd):
        self.p = subprocess.Popen(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.lines = []
        self.buf = b""

    def read_until(self, pred, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            r, _, _ = select.select([self.p.stdout], [], [], 0.05)
            if r:
                chunk = os.read(self.p.stdout.fileno(), 65536)
                if not chunk:
                    return False
                self.buf += chunk
                while b"\n" in self.buf:
                    raw, self.buf = self.buf.split(b"\n", 1)
                    self.lines.append(raw.decode("utf-8", "replace"))
                    if pred(self.lines[-1]):
                        return True
            elif self.p.poll() is not None:
                return False
        return False

    def finish(self):
        """Stop it if it is still running; return the closing line for the golden."""
        if self.p.poll() is None:
            try:
                os.killpg(self.p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                self.p.kill()
            self.p.wait()
            return "=== stopped"
        rest = self.p.stdout.read()
        if self.buf or rest:
            for raw in (self.buf + rest).split(b"\n"):
                if raw:
                    self.lines.append(raw.decode("utf-8", "replace"))
        return f"=== exit {self.p.returncode}"

    def text(self, closing):
        lines = []
        for ln in self.lines:
            n = normalize(ln)
            if n.startswith("UNCAUGHT ") and lines and lines[-1].startswith("terminate called"):
                lines.pop()
            lines.append(n)
        return "\n".join(lines) + "\n" + closing + "\n"


def stage(src, work, ip_map):
    """Copy src (if it exists) into work/config/config.toml with board addresses rewritten."""
    os.makedirs(os.path.join(work, "config"), exist_ok=True)
    dst = os.path.join(work, "config", "config.toml")
    if os.path.exists(src):
        with open(src, encoding="utf-8", errors="surrogateescape") as f:
            text = f.read()
        with open(dst, "w", encoding="utf-8", errors="surrogateescape") as f:
            f.write(re.sub(r"192\.168\.2\.(\d+)", ip_map, text))
        return text
    return ""


def emit(rel, body):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(body)


def daq_bridge(src, work):
    stage(src, work, r"127.0.0.\1")
    r = Run([os.path.join(BIN, "daq_bridge"), "config/config.toml"], work)
    r.read_until(lambda ln: ln.startswith("[System] Mode"), 15)
    return r.text(r.finish())


def stacklight(src, work):
    stage(src, work, r"127.0.0.\1")
    argv = [os.path.join(BIN, "stacklight_service"), "--config", "config/config.toml"]
    argv += ["--force-state", "1", "--target-ip", "127.0.0.1"]
    r = Run(argv, work)
    r.read_until(lambda ln: "--force-state" in ln, 15)
    return r.text(r.finish())


def config_broadcast(src, work):
    text = stage(src, work, "127.0.0.1")
    shutil.copy(
        os.path.join(csv_dir_for(src), "state_machine_actuators.csv"),
        os.path.join(work, "config", "state_machine_actuators.csv"),
    )
    ports = {5005}
    for m in re.finditer(r"(?m)^\s*listen_port\s*=\s*(\d+)\s*$", text):
        if 1 <= int(m.group(1)) <= 65535:
            ports.add(int(m.group(1)))
    socks = {}
    for port in sorted(ports):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.1", port))
        socks[port] = s
    got = {port: [] for port in socks}
    argv = [os.path.join(BIN, "config_broadcast_service"), "--config", "config/config.toml"]
    argv += ["--interval-ms", "60000"]
    try:
        r = Run(argv, work)
        started = r.read_until(lambda ln: "packet types" in ln, 15)
        # The first cycle follows the startup lines at once; collect until the ports go quiet.
        quiet_until = time.monotonic() + (1.0 if started else 0.2)
        while time.monotonic() < quiet_until:
            ready, _, _ = select.select(list(socks.values()), [], [], 0.05)
            for port, s in socks.items():
                if s in ready:
                    data, _ = s.recvfrom(65536)
                    got[port].append(data)
                    quiet_until = time.monotonic() + 0.5
        closing = r.finish()
    finally:
        for s in socks.values():
            s.close()
    body = r.text(closing)
    for port in sorted(got):
        body += f"=== port {port}: {len(got[port])} datagram(s)\n"
        for i, data in enumerate(got[port]):
            body += f"packet[{i}] type={data[0] if data else -1} len={len(data)}\n"
            for off in range(0, len(data), 16):
                body += f"  {off:04x}:" + "".join(f" {b:02x}" for b in data[off : off + 16])
                body += "\n"
    return body


def main():
    for src in inputs():
        name = name_of(src)
        for svc, fn in [
            ("daq_bridge", daq_bridge),
            ("stacklight", stacklight),
            ("config_broadcast", config_broadcast),
        ]:
            work = tempfile.mkdtemp(prefix="char-config-bin.")
            try:
                emit(f"{svc}/{name}.txt", fn(src, work))
            finally:
                shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
