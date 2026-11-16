"""Characterization, black box: the Elodin schema the services register, as they send it.

daq_bridge, calibration_service, sequencer_service, controller_service, t7_bridge --fake,
heartbeat_service and stacklight_service are each started against a loopback copy of a committed
config whose [database] points at a stand-in elodin-db (packets/bb.py FakeElodin). Their MSG
packets (VTableMsg, SetComponentMetadata, SetEntityMetadata, VTableStream subscriptions) up to the
first quiet 1.5 s are decoded here with an independent postcard reader and printed with their raw
bytes. TABLE rows are data, not schema: only which tables a service sends rows for is listed.
A service that never connects (no T7 in the config; a config elodin_port that overrides the CLI)
is recorded as such.

Golden: elodin/golden/schema_<config>.txt. Usage:
  blackbox_schema.py <bin dir> <daq-server dir> <work dir> <config_base|profile_default>
"""

from __future__ import annotations

import shutil
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "packets"))
import bb  # noqa: E402

GOLDEN = HERE / "golden"
PRIM = ["U8", "U16", "U32", "U64", "I8", "I16", "I32", "I64", "Bool", "F32", "F64"]


# ── Elodin ids (FNV-1a, as db.hpp / ElodinProtocol.hpp define them) ──────────


def fnv32(s: str) -> int:
    h = 0x811C9DC5
    for i, c in enumerate(s.encode()):
        if i + 1 >= 32:
            break
        h = ((h ^ c) * 0x01000193) & 0xFFFFFFFF
    return h


def fnv64(s: str) -> int:
    h = 0xCBF29CE484222325
    for i, c in enumerate(s.encode()):
        if i + 1 >= 64:
            break
        h = ((h ^ c) * 0x00000100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


def msg_id(s: str) -> tuple[int, int]:
    h = fnv32(s)
    x = ((h >> 16) ^ h) & 0xFFFF
    return x & 0xFF, x >> 8


def component_id(s: str) -> int:
    return fnv64(s) & ~(1 << 63)


KINDS = {
    msg_id(n): n
    for n in ("VTableMsg", "SetComponentMetadata", "SetEntityMetadata", "VTableStream")
}


# ── postcard ─────────────────────────────────────────────────────────────────


class Rd:
    def __init__(self, b: bytes):
        self.b, self.o = b, 0

    def u8(self) -> int:
        v = self.b[self.o]
        self.o += 1
        return v

    def var(self) -> int:
        v, shift = 0, 0
        while True:
            c = self.u8()
            v |= (c & 0x7F) << shift
            if not c & 0x80:
                return v
            shift += 7

    def string(self) -> str:
        n = self.var()
        s = self.b[self.o : self.o + n]
        self.o += n
        return s.decode()


def decode_vtable_msg(p: bytes):
    r = Rd(p)
    tid = (r.u8(), r.u8())
    ops = []
    for _ in range(r.var()):
        tag = r.var()
        if tag in (0, 1):
            ops.append((tag, r.var(), r.var()))
        elif tag == 2:
            ops.append((2,))
        elif tag == 3:
            ops.append((3, r.var()))
        elif tag == 4:
            ops.append((4, r.var(), r.var(), r.var()))
        elif tag == 5:
            ops.append((5, r.var(), r.var()))
        elif tag == 6:
            ops.append((6, r.var(), r.u8(), r.u8(), r.var()))
        else:
            raise ValueError(f"op tag {tag}")
    fields = [(r.var(), r.var(), r.var()) for _ in range(r.var())]
    n = r.var()
    data = p[r.o : r.o + n]
    r.o += n
    return tid, ops, fields, data, r.o


def op_str(op) -> str:
    t = op[0]
    if t == 0:
        return f"Data(off={op[1]},len={op[2]})"
    if t == 1:
        return f"Table(off={op[1]},len={op[2]})"
    if t == 3:
        return f"Component(op={op[1]})"
    if t == 4:
        return f"Schema(ty=op{op[1]},dim=op{op[2]},arg=op{op[3]})"
    if t == 5:
        return f"Timestamp(src=op{op[1]},arg=op{op[2]})"
    if t == 6:
        return "Ext"
    return f"variant#{t}"


def data_u64(data: bytes, op) -> int:
    off, ln = op[1], op[2]
    chunk = data[off : off + min(8, ln)]
    return (
        int.from_bytes(chunk.ljust(8, b"\0"), "little") if off + ln <= len(data) else 0
    )


def field_str(ops, data, f, names) -> str:
    at = lambda i: ops[i] if i < len(ops) else None  # noqa: E731
    a = at(f[2])
    if not a or a[0] != 4:
        return "arg=" + (op_str(a) if a else "<bad op>")
    out = ""
    ty = at(a[1])
    if ty and ty[0] == 0:
        t = data_u64(data, ty)
        out += "type=" + (PRIM[t] if t < 11 else f"prim#{t}")
    dim = at(a[2])
    if dim and dim[0] == 0:
        vals = [
            str(int.from_bytes(data[dim[1] + k : dim[1] + k + 8], "little"))
            for k in range(0, dim[2] - 7, 8)
        ]
        out += " shape=[" + ",".join(vals) + "]"
    arg = at(a[3])
    if arg and arg[0] == 3:
        cid = at(arg[1])
        if cid and cid[0] == 0:
            i = data_u64(data, cid)
            out += f" component={names.get(i, '<unnamed>')} ({bb.hexu(i, 16)})"
    elif arg:
        out += " arg=" + op_str(arg)
    return out


def metadata(r: Rd) -> int:
    n = r.var()
    for _ in range(n):
        r.string()
        r.string()
    return n


def dump(out: list[str], title: str, conns: list[bytes]) -> None:
    frames, tails = [], []
    for c in conns:
        f, t = bb.elodin_frames(c)
        frames += f
        if t:
            tails.append(t)
    msgs = [f for f in frames if f[1] == 0]
    tables: dict[tuple[int, int], int] = {}
    for f in frames:
        if f[1] != 0:
            tables[(f[2], f[3])] = tables.get((f[2], f[3]), 0) + 1
    out.append("")
    out.append(f"## {title}: {len(msgs)} packets, {sum(len(f[6]) for f in msgs)} bytes")
    out.append(f"  connections: {len(conns)} (MSG packets only; TABLE rows are data)")
    if tables:
        out.append(
            "  TABLE rows also sent for: "
            + " ".join(f"{bb.hexu(a, 2)}/{bb.hexu(b, 2)}" for a, b in sorted(tables))
        )
    names = {}
    for f in msgs:
        if KINDS.get((f[2], f[3])) == "SetComponentMetadata":
            r = Rd(f[5])
            i = r.var()
            names[i] = r.string()
    for k, (ln, ty, a, b, req, p, raw) in enumerate(msgs):
        kind = KINDS.get((a, b), "?")
        out.append(
            f"#{k} len={ln} ty={ty} id=[{bb.hexu(a, 2)},{bb.hexu(b, 2)}] req={req} {kind}"
        )
        try:
            if kind == "VTableMsg":
                tid, ops, fields, data, used = decode_vtable_msg(p)
                out.append(
                    f"  table=[{bb.hexu(tid[0], 2)},{bb.hexu(tid[1], 2)}] ops={len(ops)} "
                    f"fields={len(fields)} data_len={len(data)} consumed={used}/{len(p)}"
                )
                for i, f in enumerate(fields):
                    out.append(
                        f"  field[{i}] offset={f[0]} len={f[1]} {field_str(ops, data, f, names)}"
                    )
                out.append(
                    "  ops:" + "".join(f" {i}={op_str(o)}" for i, o in enumerate(ops))
                )
                out.append("  data: " + bb.hexs(data))
            elif kind == "SetComponentMetadata":
                r = Rd(p)
                i, name = r.var(), r.string()
                m = metadata(r)
                asset = r.u8()
                bad = "" if i == component_id(name) else " (id != component_id(name))"
                out.append(
                    f'  component "{name}" id={bb.hexu(i, 16)}{bad} metadata={m} asset={asset}'
                )
            elif kind == "SetEntityMetadata":
                r = Rd(p)
                i, name = r.var(), r.string()
                m = metadata(r)
                out.append(f'  entity "{name}" id={bb.hexu(i, 16)} metadata={m}')
            elif kind == "VTableStream" and len(p) == 2:
                out.append(f"  subscribe table=[{bb.hexu(p[0], 2)},{bb.hexu(p[1], 2)}]")
        except (IndexError, ValueError, UnicodeDecodeError) as e:
            out.append(f"  <decode failed: {e}>")
        out.append("  raw: " + bb.hexs(raw))
    # A partial frame at the end of a stream is a TABLE row cut by the snapshot: not printed.
    del tails


def wait_connected(db, svc, cap_s: float) -> bool:
    import time

    end = time.monotonic() + cap_s
    while time.monotonic() < end:
        if db.wait_conn(1, 0.2):
            return True
        if not svc.alive():
            return db.wait_conn(1, 0.5)
    return False


def wait_msgs_quiet(db, quiet: float, max_s: float) -> list[bytes]:
    """Connection streams once no new MSG packet has arrived for `quiet` s (TABLE rows, which
    some services publish continuously, do not count)."""
    import time

    start = time.monotonic()
    last_n, last_change = -1, start
    while True:
        with db.lock:
            conns = [bytes(x) for x in db.data]
        n = sum(1 for c in conns for f in bb.elodin_frames(c)[0] if f[1] == 0)
        now = time.monotonic()
        if n != last_n:
            last_n, last_change = n, now
        elif n > 0 and now - last_change >= quiet:
            return conns
        if now - start > max_s:
            return conns
        time.sleep(0.05)


ELODIN_CLI = ["--elodin-host", "127.0.0.1", "--elodin-port"]

SERVICES = [
    # (section title, binary, argv builder(bin dir, config, a free port, the stand-in db port)).
    # daq_bridge and sequencer_service read [database] from the config; the rest take it on the
    # command line as well. The first three titles are the ones the registration sections had.
    (
        "daq_bridge",
        lambda b, cfg, f, db: [str(b / "daq_bridge"), cfg, "127.0.0.1", str(f)],
    ),
    (
        "calibration",
        lambda b, cfg, f, db: [str(b / "calibration_service"), "--config", cfg]
        + ELODIN_CLI
        + [str(db)],
    ),
    (
        "sequencer",
        lambda b, cfg, f, db: [
            str(b / "sequencer_service"),
            "--config",
            cfg,
            "--port",
            str(f),
        ],
    ),
    (
        "controller_service",
        lambda b, cfg, f, db: [str(b / "controller_service"), "--config", cfg]
        + ["--control-port", str(f)]
        + ELODIN_CLI
        + [str(db)],
    ),
    (
        "t7_bridge --fake",
        lambda b, cfg, f, db: [str(b / "t7_bridge"), "--config", cfg, "--fake"]
        + ELODIN_CLI
        + [str(db)],
    ),
    (
        "heartbeat_service",
        lambda b, cfg, f, db: [str(b / "heartbeat_service"), "--config", cfg]
        + ["--broadcast-ip", "127.0.0.1", "--broadcast-port", str(f)]
        + ELODIN_CLI
        + [str(db)],
    ),
    (
        "stacklight_service",
        lambda b, cfg, f, db: [str(b / "stacklight_service"), "--config", cfg]
        + ["--target-ip", "127.0.0.1", "--target-port", str(f)]
        + ELODIN_CLI
        + [str(db)],
    ),
]


def main(binp: Path, src: Path, work: Path, which: str) -> int:
    rel = (
        "config/config_base.toml"
        if which == "config_base"
        else f"config/profiles/{which[8:]}/config.toml"
    )
    prof = src / "config/profiles/default"
    out = [
        f"# Elodin MSG traffic each service sends on start-up to a stand-in elodin-db, {which}",
        "# (IPs patched to 127.0.0.x; actuator/transition CSVs from the default profile).",
    ]
    for title, argv_of in SERVICES:
        d = work / f"schema_{which}_{title.split()[0]}"
        shutil.rmtree(d, ignore_errors=True)
        (d / "config").mkdir(parents=True)
        for f in (
            "state_transitions.csv",
            "state_machine_actuators.csv",
            "state_machine_actuator_delays.csv",
        ):
            shutil.copy(prof / f, d / "config" / f)
        db = bb.FakeElodin()
        (d / "config" / "config.toml").write_text(
            bb.patched(
                (src / rel).read_text(),
                database__port=str(db.port),
                network__sensor_port=str(bb.free_port()),
            )
        )
        try:
            with bb.Service(
                argv_of(binp, "config/config.toml", bb.free_port(), db.port),
                d,
                d / "service.log",
            ) as svc:
                # Generous windows: under emulation (amd64 on arm64) calibration_service takes
                # well over 15 s to reach its first connect. A service that exits (t7_bridge with
                # no T7) stops the wait at once; one dialling another port waits out the cap.
                if not wait_connected(db, svc, 60.0):
                    out.append(f"\n## {title}: never connected")
                    continue
                conns = wait_msgs_quiet(db, 3.0, 120)
        finally:
            db.close()
        # Independent clients of one service connect in a racy order; order them by content.
        dump(out, title, sorted(conns))
    return bb.finish(GOLDEN, f"schema_{which}.txt", "\n".join(out) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    w = Path(sys.argv[3])
    w.mkdir(parents=True, exist_ok=True)
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2]), w, sys.argv[4]))
