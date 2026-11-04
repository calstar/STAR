#!/usr/bin/env python3
"""LabJack T7 end to end, hermetically: t7_bridge -> calibration_service -> calibrated tables.

Runs the real binaries against a stand-in Elodin that relays what t7_bridge publishes to
calibration_service, the way elodin-db's subscriptions do, and records what calibration_service
publishes back. Everything happens in a temporary directory with its own config and calibration
store, on OS-assigned ports: nothing here touches hardware, the live calibration store, or a
running stack (unlike test_integration.sh — see daq-server/CLAUDE.md).

  1. chain   t7_bridge --fake streams a PT (4-20 mA), a TC and an LC. calibration_service must
             publish psi / °C / kg in the ranges the fake signals sit in, take Zero All and a
             tare on the T7 inputs, and file them as microvolt channels / under T7<n>_Cal.AIN<a>.
  2. cubic   Packets injected directly, at exact voltages: two capture points per input put
             2.5 V at 500 psi and 10 mV at 250 kg, and the fit survives a service restart.
  3. restart t7_bridge --fake-state: kill -9 one bridge (its stand-in T7 keeps streaming, as a
             real one does), start another; it must stop the leftover stream, reconfigure and
             stream. A clean SIGTERM must leave the device idle.
  4. mixed   (needs elodin-db; skipped without it) The real database, an ESP32 PT board
             (board_simulator -> daq_bridge) streaming, calibration_service subscribed, and only
             THEN t7_bridge registering its tables. Elodin does not deliver a table that did not
             exist at subscribe time, so the T7 tables must be re-subscribed — while ESP32 packets
             keep arriving. Both boards' calibrated tables must be recorded, and the run exports.

Usage (ctest runs it with both paths):
  t7_integration.py --bridge build/bin/t7_bridge --cal build/bin/calibration_service
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

T7 = 0x26
SLOT = 1  # board_id 81
CJC_OFFSET = 0x0F

CONFIG = """
[database]
host = "127.0.0.1"
port = {port}

[boards.labjack_1]
type = "T7"
ip = "192.168.2.81"
board_id = 81
scan_rate_hz = 100.0

[[boards.labjack_1.channels]]
ain = 1
kind = "PT"
role = "T7 PT"
signal = "4-20mA"
shunt_ohms = 250.0
full_scale = 1000.0

[[boards.labjack_1.channels]]
ain = 2
kind = "TC"
tc_type = "K"
role = "T7 TC"

[[boards.labjack_1.channels]]
ain = 4
kind = "LC"
role = "T7 LC"
differential = true
range = 0.1
full_scale = 500.0
sensitivity_mv_per_v = 2.0
excitation_v = 10.0
{extra}
"""

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("  ok   " if ok else "  FAIL ") + what, flush=True)
    if not ok:
        failures.append(what)


def frame(hi: int, lo: int, body: bytes) -> bytes:
    """ElodinClient framing: u32 len (body + 4) | ty | id hi | id lo | req | body."""
    return struct.pack("<IBBBB", 4 + len(body), 1, hi, lo, 0) + body


def raw_body(lo: int, value: float, ms: int = 0) -> bytes:
    return struct.pack("<QB3xfIB", time.time_ns(), lo & 0x1F, value, ms, 0)


class FakeElodin:
    """Accepts any number of clients. A T7 raw packet from one is relayed to all the others
    (elodin-db fanning a table out to its subscribers); every T7 calibrated packet is recorded."""

    def __init__(self) -> None:
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen()
        self.port = self.srv.getsockname()[1]
        self.clients: list[socket.socket] = []
        self.lock = threading.Lock()
        self.calibrated: list[tuple[int, float, int, int]] = []  # (lo, value, code, status)
        self.raw_seen: set[int] = set()
        self.raw_count = 0
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            with self.lock:
                self.clients.append(c)
            threading.Thread(target=self._read, args=(c,), daemon=True).start()

    def _read(self, c: socket.socket) -> None:
        buf = b""
        while True:
            try:
                d = c.recv(65536)
            except OSError:
                break
            if not d:
                break
            buf += d
            while len(buf) >= 8:
                (ln,) = struct.unpack_from("<I", buf)
                if len(buf) < 4 + ln:
                    break
                pkt, buf = buf[: 4 + ln], buf[4 + ln :]
                hi, lo, body = pkt[5], pkt[6], pkt[8:]
                if hi != T7 or len(body) != 21:
                    continue
                if (lo & 0x1F) >= 0x10:
                    _, _, value, code, status = struct.unpack("<QB3xfiB", body)
                    with self.lock:
                        self.calibrated.append((lo, value, code, status))
                else:
                    with self.lock:
                        self.raw_seen.add(lo)
                        self.raw_count += 1
                        others = [o for o in self.clients if o is not c]
                    for o in others:
                        try:
                            o.sendall(pkt)
                        except OSError:
                            pass
        with self.lock:
            if c in self.clients:
                self.clients.remove(c)

    def send_all(self, data: bytes) -> None:
        with self.lock:
            targets = list(self.clients)
        for c in targets:
            try:
                c.sendall(data)
            except OSError:
                pass

    def command(self, cmd: int, uid: int, ref: float) -> None:
        """A CalibrationCommand [0x46,0x00]: ts | cmd @8 | pad | uid (u16 LE) @10 | ref f32 @12."""
        self.send_all(frame(0x46, 0x00, struct.pack("<QBBHf", time.time_ns(), cmd, 0, uid, ref)))

    def latest(self, ain: int, n: int = 20) -> list[tuple[int, float, int, int]]:
        lo = (SLOT - 1) * 0x20 + 0x10 + ain
        with self.lock:
            return [x for x in self.calibrated if x[0] == lo][-n:]

    def wait_clients(self, n: int, timeout: float = 10.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                if len(self.clients) >= n:
                    return True
            time.sleep(0.05)
        return False

    def close(self) -> None:
        self.srv.close()
        with self.lock:
            for c in self.clients:
                c.close()


def start_cal(cal: str, work: Path, port: int) -> subprocess.Popen:
    return subprocess.Popen(
        [cal, "--config", "config/config.toml", "--elodin-port", str(port), "--adjustments", "adj.json"],
        cwd=work, stdout=open(work / "cal.log", "a"), stderr=subprocess.STDOUT)


def stop(p: subprocess.Popen) -> None:
    p.terminate()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()


def setup(root: Path, port: int, extra: str = "") -> Path:
    (root / "scripts/calibration/calibrations").mkdir(parents=True)
    (root / "config").mkdir()
    (root / "config/config.toml").write_text(CONFIG.format(port=port, extra=extra))
    return root


def store(work: Path, name: str) -> dict:
    try:
        return json.loads((work / "scripts/calibration/calibrations" / name).read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def values(rows) -> list[float]:
    return [r[1] for r in rows]


def scenario_chain(bridge: str, cal: str, root: Path) -> None:
    print("=== chain: t7_bridge --fake -> calibration_service ===", flush=True)
    db = FakeElodin()
    work = setup(root / "chain", db.port)
    calp = start_cal(cal, work, db.port)
    check(db.wait_clients(1), "calibration_service connects")
    br = subprocess.Popen([bridge, "--config", str(work / "config/config.toml"), "--fake"],
                          stdout=open(work / "bridge.log", "w"), stderr=subprocess.STDOUT)
    try:
        check(db.wait_clients(2), "t7_bridge connects")
        time.sleep(4.0)
        base = (SLOT - 1) * 0x20
        check({base + 1, base + 2, base + 4, base + 14, base + CJC_OFFSET} <= db.raw_seen,
              "bridge publishes AIN1/2/4, AIN14 and the cold junction (0x0F) raw")
        check(not any(lo & 0x1F >= 0x10 for lo in db.raw_seen),
              "bridge publishes no calibrated table (that is calibration_service's)")

        # The --fake signals: PT 30 % of full scale ±3 %, LC 20 % of rated ±2 %, TC 60 ±10 °C.
        pt, tc, lc = db.latest(1), db.latest(2), db.latest(4)
        check(len(pt) > 0 and all(260 <= v <= 340 for v in values(pt)) and all(r[3] == 1 for r in pt),
              f"PT 4-20 mA -> psi, physics (default model): {values(pt)[-1:] if pt else 'none'}")
        check(len(tc) > 0 and all(48 <= v <= 72 for v in values(tc)),
              f"TC volts + cold junction -> °C: {values(tc)[-1:] if tc else 'none'}")
        check(len(lc) > 0 and all(85 <= v <= 115 for v in values(lc)),
              f"LC volts -> kg: {values(lc)[-1:] if lc else 'none'}")
        # 4-20 mA across 250 ohm: psi = (V - 1) / 4 * 1000. The PT output is smoothed (EMA), so
        # the code and the value agree to within the fake signal's few psi of wobble.
        check(len(pt) > 0 and abs((pt[-1][2] / 1e6 - 1.0) / 4.0 * 1000.0 - pt[-1][1]) < 15.0,
              f"calibrated table carries the µV code it was converted from: "
              f"{(pt[-1][2], round(pt[-1][1], 1)) if pt else 'none'}")

        db.command(0, 0, 0.0)  # Zero All
        time.sleep(0.5)
        db.command(8, 8104, 0.0)  # tare the T7 load cell
        time.sleep(1.0)
    finally:
        stop(br)
        stop(calp)
        db.close()
    cs = store(work, "cubic_calibration.json").get("cubic_state", {})
    check(set(cs) == {"8101", "8104"}, f"store holds the T7 PT and LC by uid: {sorted(cs)}")
    check(all(cs[u].get("rawUnit") == "uV" for u in cs), "filed as microvolt channels")
    check(cs.get("8101", {}).get("logicalCh") == 129 and cs.get("8104", {}).get("logicalCh") == 132,
          "on logical channels 128 + ain, clear of the ESP32 boards")
    check(all(cs[u].get("numPoints") == 1 for u in cs), "Zero All captured a point on each")
    tares = store(work, "lc_tare.json").get("tares", [])
    check(len(tares) == 1 and tares[0].get("entity") == "T71_Cal.AIN4" and 85 <= tares[0].get("offset_kg", 0) <= 115,
          f"tare filed under the T7 entity at the load it held: {tares}")


def scenario_cubic(cal: str, root: Path) -> None:
    print("=== cubic: captured points on T7 inputs ===", flush=True)
    models = '\n[calibration_model_labjack_1]\n"T7 PT" = "cubic"\n"T7 LC" = "cubic"\n'
    signal = {1: 2.5 * 0.4, 2: 0.005259, 4: 0.005}  # PT in volts across the 250 ohm shunt
    stop_stream = threading.Event()

    def stream(db: FakeElodin) -> None:
        k = 0
        while not stop_stream.is_set():
            pkts = frame(T7, CJC_OFFSET, raw_body(CJC_OFFSET, 22.0, k * 10))
            for ain, v in list(signal.items()):
                pkts += frame(T7, (SLOT - 1) * 0x20 + ain, raw_body(ain, v, k * 10))
            db.send_all(pkts)
            k += 1
            time.sleep(0.01)

    def run(db: FakeElodin, work: Path, steps) -> None:
        calp = start_cal(cal, work, db.port)
        try:
            check(db.wait_clients(1), "calibration_service connects")
            stop_stream.clear()
            t = threading.Thread(target=stream, args=(db,), daemon=True)
            t.start()
            steps(db)
            stop_stream.set()
            t.join()
        finally:
            stop(calp)

    db = FakeElodin()
    work = setup(root / "cubic", db.port, models)

    def captures(db: FakeElodin) -> None:
        time.sleep(2.0)
        pt = db.latest(1)
        check(len(pt) > 0 and pt[-1][1] == 0.0 and pt[-1][3] == 0,
              "an uncalibrated cubic T7 PT reads 0 with cal_status 0, like an ESP32 one")
        # 4-20 mA across 250 ohm: 1 V is 0 psi, 5 V is 1000 psi.
        signal[1], signal[4] = 1.0, 0.0
        time.sleep(1.5)
        db.command(5, 8101, 0.0)
        db.command(5, 8104, 0.0)
        time.sleep(0.3)
        signal[1], signal[4] = 5.0, 0.020
        time.sleep(1.5)
        db.command(5, 8101, 1000.0)
        db.command(5, 8104, 500.0)
        time.sleep(0.3)
        signal[1], signal[4] = 3.0, 0.010
        time.sleep(2.0)
        pt, lc, tc = db.latest(1, 5), db.latest(4, 5), db.latest(2, 5)
        check(len(pt) > 0 and abs(pt[-1][1] - 500.0) < 1.0 and pt[-1][3] == 1,
              f"PT captured at 1 V->0, 5 V->1000 reads 3 V as 500 psi: {values(pt)[-1:]}")
        check(len(lc) > 0 and abs(lc[-1][1] - 250.0) < 0.5 and lc[-1][3] == 1,
              f"LC captured at 0->0, 20 mV->500 reads 10 mV as 250 kg: {values(lc)[-1:]}")
        check(len(tc) > 0 and abs(tc[-1][1] - 150.0) < 0.5,
              f"TC at a 22 °C junction reads 150 °C: {values(tc)[-1:]}")

    run(db, work, captures)
    cs = store(work, "cubic_calibration.json").get("cubic_state", {})
    check([round(p["adc"]) for p in cs.get("8101", {}).get("points", [])] == [1_000_000, 5_000_000],
          "the PT's points are stored in µV")

    def after_restart(db: FakeElodin) -> None:
        time.sleep(2.0)
        pt = db.latest(1, 5)
        check(len(pt) > 0 and abs(pt[-1][1] - 500.0) < 1.0 and pt[-1][3] == 1,
              f"the fit survives a calibration_service restart: {values(pt)[-1:]}")

    run(db, work, after_restart)
    db.close()


def free_port(kind: int = socket.SOCK_STREAM) -> int:
    s = socket.socket(socket.AF_INET, kind)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def find_elodin_db(given: str | None) -> str | None:
    for cand in (given, os.path.expanduser("~/.cargo/bin/elodin-db"), shutil.which("elodin-db")):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


MIXED_EXTRA = """
[network]
bind_ip = "127.0.0.1"
sensor_port = {udp}

# heartbeat_service owns the server heartbeat, so daq_bridge sends none (no broadcast here).
[heartbeat_service]
enabled = true

[boards.pt_board]
type = "PT"
pt_type = "0-5V ratiometric"
ip = "127.0.0.21"
board_id = 21
enabled = true
voltage_reference = 1
active_connectors = [1, 2]

[sensor_roles_pt_board]
"ESP PT" = 1

[calibration_model_pt_board]
"ESP PT" = "physics"
"""


def export_rows(elodin: str, db: Path, out: Path, component: str) -> int:
    """Rows elodin-db holds for one component, via its own CSV export."""
    subprocess.run([elodin, "export", str(db), "-o", str(out), "--format", "csv", "--flatten",
                    "--pattern", component], capture_output=True, check=False)
    files = list(out.glob(f"{component}*.csv"))
    if not files:
        return 0
    return max(0, len(files[0].read_text().splitlines()) - 1)


def scenario_mixed(bridge: str, cal: str, daq_bridge: str, simulator: str, elodin: str,
                   root: Path) -> None:
    print("=== mixed: real elodin-db, ESP32 streaming, T7 registering late ===", flush=True)
    port, udp = free_port(), free_port(socket.SOCK_DGRAM)
    work = setup(root / "mixed", port, MIXED_EXTRA.format(udp=udp))
    cfg = str(work / "config/config.toml")
    db_dir = work / "db"
    procs: list[subprocess.Popen] = []

    def spawn(args, log, cwd=work):
        p = subprocess.Popen(args, cwd=cwd, stdout=open(work / log, "w"), stderr=subprocess.STDOUT)
        procs.append(p)
        return p

    try:
        spawn([elodin, "run", f"127.0.0.1:{port}", str(db_dir)], "elodin.log")
        time.sleep(2.0)
        spawn([daq_bridge, cfg], "daq_bridge.log")
        spawn([sys.executable, simulator, "--config", cfg, "--port", str(udp), "--only-type", "PT",
               "--skip-startup", "--sensor-hz", "50", "--duration", "30"], "simulator.log")
        time.sleep(2.0)
        procs.append(start_cal(cal, work, port))
        time.sleep(4.0)  # ESP32 data flowing and calibrated before the T7 exists
        spawn([bridge, "--config", cfg, "--fake"], "bridge.log")
        time.sleep(14.0)
    finally:
        for p in reversed(procs):
            stop(p)
    out = work / "export"
    esp = export_rows(elodin, db_dir, out, "PT1_Cal.CH1.pressure_psi")
    t7_raw = export_rows(elodin, db_dir, out, "T71.AIN1.volts")
    t7_cal = export_rows(elodin, db_dir, out, "T71_Cal.AIN1.pressure_psi")
    cjc = export_rows(elodin, db_dir, out, "T71.CJC.temperature_c")
    check(esp > 100, f"ESP32 PT calibrated rows recorded: {esp}")
    check(t7_raw > 500 and cjc > 500, f"T7 raw and cold-junction rows recorded: {t7_raw}, {cjc}")
    check(t7_cal > 300,
          f"T7 calibrated rows recorded though the T7 registered after the subscribe: {t7_cal}")


def state(path: Path) -> dict[str, str]:
    """The stand-in T7's state file: 'streaming 1', 'stops 0', ... as a dict."""
    out: dict[str, str] = {}
    try:
        for line in path.read_text().splitlines():
            k, _, v = line.partition(" ")
            if k != "reg":
                out[k] = v
    except OSError:
        pass
    return out


def scenario_restart(bridge: str, root: Path) -> None:
    """A T7 keeps streaming after the bridge that started it dies, and refuses configuration
    until that stream is stopped. --fake-state makes the stand-in T7 a file that outlives the
    process, so kill -9 leaves it streaming exactly as a server torn down mid-run leaves a real
    one, and the next bridge has to take it over."""
    print("=== restart: kill -9 the bridge, start another on the same T7 ===", flush=True)
    db = FakeElodin()
    work = setup(root / "restart", db.port)
    devdir = work / "t7state"
    devdir.mkdir()
    unit = devdir / "boards.labjack_1.state"
    cfg = str(work / "config/config.toml")

    def spawn(log: str) -> subprocess.Popen:
        return subprocess.Popen([bridge, "--config", cfg, "--fake", "--fake-state", str(devdir)],
                                stdout=open(work / log, "w"), stderr=subprocess.STDOUT)

    def flowing(after: int, timeout: float = 8.0) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            with db.lock:
                if db.raw_count > after + 50:
                    return True
            time.sleep(0.1)
        return False

    def count() -> int:
        with db.lock:
            return db.raw_count

    procs: list[subprocess.Popen] = []
    try:
        a = spawn("bridge_a.log")
        procs.append(a)
        check(flowing(0), "first bridge streams")
        a.kill()  # SIGKILL: no stop reaches the device
        a.wait()
        st = state(unit)
        check(st.get("streaming") == "1" and st.get("stops") == "0",
              f"killed with -9, the T7 is left streaming to nobody ({st})")

        n = count()
        b = spawn("bridge_b.log")
        procs.append(b)
        check(flowing(n), "the next bridge streams from the same T7")
        log_b = (work / "bridge_b.log").read_text(errors="replace")
        check("stopped a stream already running" in log_b,
              "and says it stopped the stream the killed one left")
        check("retrying" not in log_b, "without a failed start first")
        st = state(unit)
        check(st.get("starts") == "2" and st.get("stops") == "1" and st.get("streaming") == "1",
              f"one stop, a second start ({st})")

        b.terminate()  # SIGTERM: a clean shutdown stops the stream
        b.wait(timeout=10)
        check(state(unit).get("streaming") == "0", "a clean shutdown leaves the T7 idle")

        n = count()
        c = spawn("bridge_c.log")
        procs.append(c)
        check(flowing(n), "a bridge after a clean shutdown streams")
        check("stopped a stream already running" not in
              (work / "bridge_c.log").read_text(errors="replace"),
              "and finds nothing to stop")
    finally:
        for p in procs:
            if p.poll() is None:
                stop(p)
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", required=True)
    ap.add_argument("--cal", required=True)
    ap.add_argument("--daq-bridge", help="daq_bridge, for the mixed (real elodin-db) scenario")
    ap.add_argument("--simulator", help="sim/board_simulator.py, for the mixed scenario")
    ap.add_argument("--elodin-db", help="elodin-db binary (default: ~/.cargo/bin, then PATH)")
    a = ap.parse_args()
    bridge, cal = os.path.abspath(a.bridge), os.path.abspath(a.cal)
    with tempfile.TemporaryDirectory(prefix="t7_integration_") as d:
        root = Path(d)
        scenario_chain(bridge, cal, root)
        scenario_cubic(cal, root)
        scenario_restart(bridge, root)
        elodin = find_elodin_db(a.elodin_db)
        if elodin and a.daq_bridge and a.simulator:
            scenario_mixed(bridge, cal, os.path.abspath(a.daq_bridge), os.path.abspath(a.simulator),
                           elodin, root)
        else:
            print("=== mixed: SKIPPED (needs elodin-db, --daq-bridge and --simulator) ===", flush=True)
        if failures:
            for log in sorted(root.glob("*/*.log")):
                print(f"--- {log.relative_to(root)} (tail) ---")
                print("\n".join(log.read_text(errors="replace").splitlines()[-15:]))
    print("FAILED: " + str(len(failures)) if failures else "PASSED", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
