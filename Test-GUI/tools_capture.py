"""Headless capture + noise characterisation for one LC connector.

Drives the board directly (no GUI): broadcasts SERVER_HEARTBEAT so the board
locks an address and stays out of no-connection abort, sends SENSOR_CONFIG to
activate it, then records connector-1 samples and reports the Allan deviation.

Broadcast rather than unicast is deliberate: while the zeroconf firmware is
hunting it alternates between 192.168.2.<id> and a link-local 169.254.x, so a
unicast to the static address misses it half the time.

Usage:  python tools_capture.py <seconds> <label>
"""

import json
import pathlib
import socket
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from boardgui import filters as F          # noqa: E402
from boardgui import protocol as P         # noqa: E402

CTRL, LISTEN = 5005, 5006
TARGETS = [("192.168.2.21", CTRL), ("192.168.2.255", CTRL), ("255.255.255.255", CTRL)]
VREF = 5.0          # ratiometric: reference is the bridge excitation (AVDD)
FS_CODES = 2147483648.0


def capture(seconds: float, connector: int = 1):
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    rx.bind(("0.0.0.0", LISTEN))
    rx.settimeout(0.3)
    tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    tx.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)

    stop = threading.Event()

    def beat():
        while not stop.is_set():
            for t in TARGETS:
                try:
                    tx.sendto(P.build_server_heartbeat(P.EngineState.SAFE), t)
                except OSError:
                    pass
            time.sleep(0.2)

    threading.Thread(target=beat, daemon=True).start()
    cfg = P.build_sensor_config([connector], reference_voltage=1,
                                necessary_for_abort=False, controller_ip=None,
                                enable_serial_printing=True)

    # After a flash the board reboots and spends ~4 s in Ethernet init (three
    # 1 s delays in hotfire_config.h) plus a failed DHCP attempt, so a config
    # sent once up front is simply missed. Resend until data actually flows.
    def configure():
        while not stop.is_set():
            for t in TARGETS:
                try:
                    tx.sendto(cfg, t)
                except OSError:
                    pass
            time.sleep(2.0)

    threading.Thread(target=configure, daemon=True).start()

    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            d, _ = rx.recvfrom(4096)
        except socket.timeout:
            continue
        h = P.parse_header(d)
        if h and h.packet_type == P.PacketType.SENSOR_DATA:
            break
    else:
        print("  (board never started streaming within 30 s)")

    codes, stamps = [], []
    t0 = time.time()
    while time.time() - t0 < seconds:
        try:
            d, _ = rx.recvfrom(4096)
        except socket.timeout:
            continue
        h = P.parse_header(d)
        if not h or h.packet_type != P.PacketType.SENSOR_DATA:
            continue
        sd = P.parse_sensor_data(d)
        if not sd:
            continue
        for ch in sd.chunks:
            for dp in ch.datapoints:
                if dp.sensor_id == connector:
                    codes.append(P.raw_to_signed(dp.raw))
                    stamps.append(ch.timestamp_ms)
    stop.set()
    rx.close()
    return codes, stamps


def report(codes, stamps, label):
    if len(codes) < 64:
        print(f"{label}: only {len(codes)} samples — not enough")
        return None
    span = (stamps[-1] - stamps[0]) / 1000.0
    fs = (len(stamps) - 1) / span
    volts = [c * VREF / FS_CODES for c in codes]
    mean = sum(volts) / len(volts)
    pp = max(volts) - min(volts)
    curve = F.allan_deviation(volts, 1 / fs)
    best = F.optimal_averaging(curve)
    slope = F.drift_slope(curve)
    # sigma at ~1 s of averaging, the practical comparison point for a scale
    one_s = min(curve, key=lambda p: abs(p[0] - 1.0)) if curve else (0, 0)
    print(f"\n===== {label} =====")
    print(f"  samples {len(codes)} over {span:.1f} s -> {fs:.1f} Hz")
    print(f"  mean {mean * 1e6:.2f} uV   peak-to-peak {pp * 1e6:.2f} uV")
    print(f"  sigma @1 sample  {curve[0][1] * 1e9:8.1f} nV  (tau {curve[0][0]:.2f} s)")
    print(f"  sigma @~1 s avg  {one_s[1] * 1e9:8.1f} nV")
    print(f"  best  {best[1] * 1e9:8.1f} nV at tau {best[0]:.1f} s")
    print(f"  long-tau slope {slope:+.2f} "
          f"({'white-noise limited' if slope < -0.35 else 'flicker' if slope < 0.15 else 'RANDOM WALK'})")
    return dict(label=label, n=len(codes), fs=fs, mean=mean, pp=pp,
                sigma1=curve[0][1], sigma_1s=one_s[1], best=best, slope=slope,
                curve=curve)


if __name__ == "__main__":
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    label = sys.argv[2] if len(sys.argv) > 2 else "capture"
    print(f"capturing {secs:.0f} s ({label}) — leave the scale undisturbed...")
    codes, stamps = capture(secs)
    r = report(codes, stamps, label)
    out = pathlib.Path("logs") / f"capture_{label}.json"
    out.write_text(json.dumps({"codes": codes, "ts": stamps}))
    print(f"  saved {out}")
