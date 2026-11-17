#!/usr/bin/env python3
"""Turn one raw session capture (session.ts) into the pipeline goldens.

    characterize.py <capture.json> <context.json> <out_dir>

Writes, into out_dir:
  ws_handshake.txt  every client's connect burst, in order, payloads normalised
  ws_events.txt     per step, the event-like frames (everything but the streams below), in order
  ws_streams.txt    the streaming types (sensor_update, historical_data, connection_status,
                    board_status_update, board_log): channel set, values where the sim fixes them,
                    rates bucketed, distinct normalised payloads
  ws_schema.txt     per message type: every key path with the JSON types seen under it
  http.txt          every request: status, content-type and the headers that matter, body
  csv.txt           the CSV-format bodies the backend serves (see README "The CSV")

Generic normalisation is normalize.py's (README N1..N8). The rules here are per message type /
per route and are listed in README "Per-type rules" (P1..P9); a new one goes in both places.
"""
import json
import math
import os
import re
import sys
from collections import Counter, OrderedDict, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize import Normalizer  # noqa: E402

STREAM_TYPES = {
    "sensor_update",
    "historical_data",
    "connection_status",
    "board_status_update",
    "board_log",
}


# P1. Board-health notifications are raised by a 1 Hz sweep racing the boards' own 1 Hz
# heartbeat (server.ts markStaleBoards); whether a reset (session start/stop reloads board status
# from config) is seen as "connection lost" depends on which fires first. Recorded as a set over
# the whole run, outside the ordered event log.
def is_board_health(msg):
    if msg.get("type") != "notification":
        return False
    p = msg.get("payload") or {}
    key = str(p.get("key", ""))
    return key.startswith("board_lost_") or (
        "key" not in p and str(p.get("message", "")).endswith(" connected")
    )


# P1b. A status reset (session start/stop reloads every board from config) can make a board that
# never stopped heartbeating read "connection lost" for one 1 Hz sweep: lost, then cleared and
# "connected" on the next sweep. Whether the sweep beats the next heartbeat is a race, so such a
# flap is not recorded at all. A board that really goes silent stays lost (or clears only after
# FLAP_MS) and is recorded.
FLAP_MS = 2500


def flap_ids(frames):
    """ids of the board-health frames that make up a reset flap, in one client's frame order."""
    out, open_lost = set(), {}
    for m in frames:
        if not is_board_health(m):
            continue
        p = m.get("payload") or {}
        key, t = str(p.get("key", "")), p.get("timestampMs", 0)
        if key.startswith("board_lost_") and p.get("ongoing") is True:
            open_lost[key] = m
        elif (
            key.startswith("board_lost_")
            and p.get("ongoing") is False
            and key in open_lost
        ):
            start = open_lost.pop(key)
            if t - start["payload"].get("timestampMs", 0) <= FLAP_MS:
                out.update({id(start), id(m)})
                board = key[len("board_lost_") :]
                for c in frames:  # the "connected" the same sweep raised
                    cp = c.get("payload") or {}
                    if (
                        is_board_health(c)
                        and "key" not in cp
                        and cp.get("timestampMs") == t
                        and f"Board {board} " in str(cp.get("message", ""))
                    ):
                        out.add(id(c))
    return out


def dumps(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def envelope_check(steps, pps):
    """T1. The GUI envelope (gui-stream.ts) opens a window at a sample and closes it at the first
    sample >= windowMs later, emitting one point per window for a constant stream at the window's
    first sample time. So consecutive history points of a constant 10 Hz stream are spaced by at
    least W = 2000 / points_per_second and, with samples every 100 ms, about W..W+100 ms. Checked on
    sample timestamps (not delivery), so machine load cannot move it: median spacing within
    [0.9 W, 2 W]. Halving the window (doubling the rate) lands at ~W/2 and fails."""
    w = 2000.0 / pps
    # The reply to a narrowed query arrives as several time slices (history-backfill.ts): join
    # every single-series slice of the history step.
    t = set()
    for st, frames in steps:
        if st["name"] != "history":
            continue
        for m in frames.get("A", []):
            if m["type"] != "historical_data" or len(m["payload"]) != 1:
                continue
            series = m["payload"].get("PT1.CH1.raw_adc_counts")
            if series:
                t.update(series["time"])
    t = sorted(t)
    gaps = sorted(b - a for a, b in zip(t, t[1:]))
    if len(gaps) < 5:
        return f"envelope spacing: fewer than 5 gaps in the history reply ({len(t)} points)"
    med = gaps[len(gaps) // 2]
    ok = 0.9 * w <= med <= 2 * w
    return (
        f"envelope spacing of PT1.CH1.raw_adc_counts history (W = 2000/{pps:g} pts/s"
        f" = {w:g} ms): median within [0.9 W, 2 W]: {'yes' if ok else 'NO'}"
        f"{'' if ok else f' (median {med} ms)'}; at least 5 gaps: yes"
    )


def schema_paths(v, prefix, out):
    if isinstance(v, dict):
        if not v:
            out[prefix].add("{}")
        for k, x in v.items():
            schema_paths(x, f"{prefix}.{k}", out)
    elif isinstance(v, list):
        out[prefix].add("[]")
        for x in v:
            schema_paths(x, prefix + "[]", out)
    else:
        t = (
            "null"
            if v is None
            else (
                "bool"
                if isinstance(v, bool)
                else "number" if isinstance(v, (int, float)) else "string"
            )
        )
        out[prefix].add(t)


# historical_data and sensor_update keys are entity.component names — data, not schema. They are
# folded to a placeholder so the schema lists the shape once.
def fold_dynamic_keys(msg):
    t = msg.get("type")
    if t == "historical_data" and isinstance(msg.get("payload"), dict):
        vals = list(msg["payload"].values())
        return {**msg, "payload": {"<key>": vals[0]} if vals else {}}
    return msg


def norm_connection_status(p):
    # P3. A link's own measurements (lag, resolution, throttled) depend on scheduling; their
    # presence and type are frozen, not their value.
    p = dict(p)
    for k in ("lagMs", "resolutionPct", "throttled"):
        if k in p:
            p[k] = f"<{type(p[k]).__name__}>"
    return p


def norm_board_status(p):
    # P4. Heartbeat history is wall-clock: frequencyHz is measured, heartbeatTimes grows.
    boards = []
    for b in p.get("boards", []):
        b = dict(b)
        if "heartbeatTimes" in b:
            b["heartbeatTimes"] = "<ts[]>" if b["heartbeatTimes"] else []
        if "frequencyHz" in b:
            b["frequencyHz"] = "<hz>"
        boards.append(b)
    return {**p, "boards": boards}


def norm_board_log(p):
    # P5. The simulator's log line carries a running counter.
    p = dict(p)
    p["lines"] = [re.sub(r"#\d+", "#<n>", s) for s in p.get("lines", [])]
    if "totals" in p:
        p["totals"] = {k: "<n>" for k in p["totals"]}
    return p


def norm_event(n, msg):
    msg = n.value(msg)
    if msg.get("type") == "connection_status":
        msg["payload"] = norm_connection_status(msg["payload"])
    return msg


# The order server.ts wss.on('connection') sends its burst in. A frame that would step backwards
# (a live commanded-actuator sample after the self-test replay, a second connection_status) is the
# first frame after the burst.
HANDSHAKE_PHASES = [
    "connection_status",
    "control_status",
    "mission_start_time",
    "countdown_target_update",
    "session_update",
    "state_update",
    "board_status_update",
    "snapshot",  # sensor_update actuator_state_commanded for the current state
    "selftest",  # sensor_update SELF_TEST.*
    "notification",
]


def handshake_phase(m):
    t = m["type"]
    if t == "sensor_update":
        p = m["payload"]
        if str(p.get("entity", "")).startswith("SELF_TEST."):
            return HANDSHAKE_PHASES.index("selftest")
        if p.get("component") == "actuator_state_commanded":
            return HANDSHAKE_PHASES.index("snapshot")
        return None
    return HANDSHAKE_PHASES.index(t) if t in HANDSHAKE_PHASES else None


def handshake_frames(frames):
    """The synchronous connect burst: the longest prefix whose phases never step backwards (and
    never repeat a phase that sends exactly one frame)."""
    out, cur = [], -1
    multi = {
        HANDSHAKE_PHASES.index(x) for x in ("snapshot", "selftest", "notification")
    }
    for m in frames:
        ph = handshake_phase(m)
        if ph is None or ph < cur or (ph == cur and ph not in multi):
            break
        cur = ph
        out.append(m)
    return out


def replay_by_board(frames):
    """P10. The self-test replay (server.ts selfTestLatest) is a Map in the order results arrived
    from Elodin, which across boards is a race. The run of SELF_TEST frames is regrouped by board id
    (stable: each board's own frames keep their order); every other frame keeps its place.
    """
    out, run = [], []

    def flush():
        board = lambda m: int(re.sub(r"\D", "", m["payload"]["entity"]) or 0)
        out.extend(sorted(run, key=board))  # sorted() is stable
        run.clear()

    for m in frames:
        if handshake_phase(m) == HANDSHAKE_PHASES.index("selftest"):
            run.append(m)
        else:
            flush()
            out.append(m)
    flush()
    return out


# P11. A command's TCP reply (an `error` from sequencer-client.ts sendToSequencer) and the
# sequencer's own Elodin publish (a `state_update`) reach the client by two independent paths
# (sequencer → TCP → backend, sequencer → elodin-db → backend), so their relative order is a race
# (seen swapped under 1x load). Within a run of consecutive error/state_update frames the two
# kinds are recorded errors first; every other order is kept as it arrived.
CROSS_PATH = ("error", "state_update")


def order_cross_path(lines):
    out, run = [], []
    for kind, text in lines + [(None, None)]:
        if kind in CROSS_PATH:
            run.append((CROSS_PATH.index(kind), len(run), text))
            continue
        out.extend(t for _, _, t in sorted(run))
        run = []
        if text is not None:
            out.append(text)
    return out


# A1. One named alternative: the Fuel Main commanded series may also carry the sequencer's
# boot-time de-energized 1 (ActuatorCommander publishInitialState) -- elodin-db hands a late
# subscriber that row on a loaded Linux box (defect). Exactly {0} or {0, 1}; anything else prints
# as observed and fails.
CH7_KEY = "ACT_CMD.B2.CH7.actuator_state_commanded"
CH7_ALT = (
    "{0} | {0, 1}  # alternative A1: the sequencer's boot-time de-energized row, "
    "replayed by elodin-db on subscribe (defect)"
)


def ch7_render(key, vals):
    """vals: sorted JSON-encoded values. Returns the alternative text, or None."""
    if key == CH7_KEY and vals in (["0"], ["0", "1"]):
        return CH7_ALT
    return None


def selftest_paths(steps):
    """Every path a self-test result reaches a client by, as {path: {board: {sensor: value}}}.

    - "handshake <client>": the connect replay (server.ts selfTestLatest);
    - "history <step> <client>": a full history reply (more than 10 series, i.e. a connect
      backfill or an unnarrowed query; narrowed queries name one key and carry no self-test);
    - "live": self-test sensor_updates outside a handshake.
    Client C (late_client) is left out of the history paths: it connects past the backend's 60 s
    connect-backfill horizon, so its backfill no longer reaches back to the one-shot self-test.
    """
    paths = defaultdict(lambda: defaultdict(dict))
    first = {}
    for st, frames in steps:
        for client, fs in frames.items():
            hs = set()
            if client not in first:
                first[client] = st["name"]
                hs = {id(m) for m in handshake_frames(fs)}
            full = (
                sum(len(m["payload"]) for m in fs if m["type"] == "historical_data")
                > 10
                and client != "C"
            )
            for m in fs:
                if m["type"] == "sensor_update":
                    e, c = m["payload"]["entity"], m["payload"]["component"]
                    if e.startswith("SELF_TEST.BOARD_"):
                        key = f"handshake {client}" if id(m) in hs else "live"
                        paths[key][e[len("SELF_TEST.BOARD_") :]][c] = m["payload"][
                            "value"
                        ]
                elif m["type"] == "historical_data" and full:
                    for k, series in m["payload"].items():
                        if k.startswith("SELF_TEST.BOARD_"):
                            ent, comp = k.rsplit(".", 1)
                            for v in series.get("values", []):
                                paths[f"history {st['name']} {client}"][
                                    ent[len("SELF_TEST.BOARD_") :]
                                ][comp] = v
            if full:
                paths.setdefault(f"history {st['name']} {client}", defaultdict(dict))
    for client in first:
        paths.setdefault(f"handshake {client}", defaultdict(dict))
    return paths


def selftest_section(steps, ctx):
    """P12. Self-test results, one line per board the simulators self-test.

    Each board's line is written as its exact expected result OR not-received: the result is a
    one-shot UDP packet (the simulator's skip-startup burst), and on a loaded Linux box some never
    reach the backend (defect). The golden is the same either way; the rule line below fails when
      (a) any result received by any path differs from the expected one (sensor set, or a value
          other than 1), or comes from a board not expected;
      (b) more than half the boards are not-received (by any path);
      (c) the run is quiet (unloaded) and ANY board is not-received;
      (d) the run is quiet and any handshake replay or full history reply lacks any board: every
          path that carried the self-test in the old golden must carry all of it exactly.
    `under_load` comes from run.sh (CHAR_UNDER_LOAD, set by whoever starts the synthetic load).
    """
    expected = ctx.get("selftest_expected", {})
    want = {b: sorted(f"sensor_{i}" for i in e["sensors"]) for b, e in expected.items()}
    paths = selftest_paths(steps)
    union = defaultdict(dict)
    problems = []
    for path, boards in sorted(paths.items()):
        for board, got in sorted(boards.items()):
            union[board].update(got)
            if board not in want:
                problems.append(f"{path}: board {board} (not expected) {dumps(got)}")
            elif sorted(got) != want[board] or any(v != 1 for v in got.values()):
                problems.append(f"{path}: board {board} received {dumps(got)}")
    out = [
        "## self-test (P12): per board, the exact expected result | not-received (one-shot UDP"
        " self-test, defect)"
    ]
    missing = []
    for board in sorted(expected, key=int):
        out.append(
            f"board {board} ({expected[board]['type']}): {', '.join(want[board])} all 1"
            " | not-received (one-shot UDP self-test, defect)"
        )
        if board not in union:
            missing.append(board)
    under_load = bool(ctx.get("under_load"))
    if not under_load and missing:
        problems.append(f"quiet run, not-received: {', '.join(missing)}")
    if 2 * len(missing) > len(expected):
        problems.append(f"more than half not-received: {', '.join(missing)}")
    order = [st["name"] for st, _ in steps]
    startup_step = (
        order.index("startup_board") if "startup_board" in order else len(order)
    )
    first_step = {}
    for i, (st, frames) in enumerate(steps):
        for client in frames:
            first_step.setdefault(client, i)
    path_step = {}
    for path in paths:
        parts = path.split()
        if parts[0] == "handshake":
            path_step[path] = first_step.get(parts[1], 0)
        elif parts[0] == "history":
            path_step[path] = order.index(parts[1])
    if not under_load:
        for path, boards in sorted(paths.items()):
            if path == "live":
                continue
            # The startup board (60) self-tests during the startup_board step; a path that
            # closed before it is not expected to carry it.
            lack = [
                b
                for b in sorted(expected, key=int)
                if b not in boards
                and not (
                    expected[b]["type"] == "PT (startup)"
                    and path_step.get(path, 0) < startup_step
                )
            ]
            if lack:
                problems.append(f"quiet run, {path} lacks: {', '.join(lack)}")
    checked = sorted(p for p in paths if p != "live")
    out.append("paths checked: " + "; ".join(checked))
    out.append(
        "self-test rule (a) exact if received, (b) at most half not-received, (c) all"
        " received when quiet, (d) every replay/full-history path complete when quiet: "
        + ("ok" if not problems else "VIOLATED: " + "; ".join(problems))
    )
    out.append("")
    return out


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def log_lines(ctx, name):
    """A service's log from the run (run.sh keeps them under ctx['logs']), colour codes off."""
    try:
        with open(os.path.join(ctx["logs"], name + ".log"), errors="replace") as f:
            return [ANSI.sub("", ln.rstrip("\n")) for ln in f]
    except FileNotFoundError:
        return []


def show_values(vals):
    """P7 rendering of a value set: one value, up to four in braces, else <varies>."""
    vals = sorted(vals)
    if len(vals) == 1:
        return vals[0]
    return "{" + ", ".join(vals) + "}" if len(vals) <= 4 else "<varies>"


def stalesub_report(steps, ctx):
    """stalesub.txt: the D-SUB window (README "The stalesub session"), channel by channel.

    run.sh arranged it: registrar A (calibration_service on a config holding only the slot-10
    startup board) re-registered [0x20,0x31] as PT10_Cal.CH1; the backend subscribed; the real
    calibration_service re-registered it as PT2_Cal.CH1 and board 22's rows flowed. Frozen: what
    each registrar logged, how often elodin-db saw each table inserted, that the backend never
    gave the pair up, and -- per channel of board 22 -- what reached client A live and from
    history over 2 x RESUBSCRIBE_MIN_MS + 2 s. Channel 2 is the control: the startup board never
    touched its tables. A channel's calibrated line reads `absent` when no frame carried it.
    """
    out = [
        "## D-SUB: a VTableStream accepted while its table was being re-registered (D41)"
    ]
    rega = log_lines(ctx, "registrar_a")
    slot10 = any("[Config] ERROR" in ln and "maps to slot 10" in ln for ln in rega)
    registered = lambda lines, kind: "; ".join(  # noqa: E731
        ln.split("] ", 1)[1]
        for ln in lines
        if "Registered" in ln and f"{kind} VTables" in ln
    )
    out.append(
        "registrar A (calibration_service, [boards.integration_startup] only): "
        f"slot-10 config error logged: {'yes' if slot10 else 'no'}; "
        + registered(rega, "CALIBRATED")
    )
    out.append("daq_bridge: " + registered(log_lines(ctx, "daq_bridge"), "CALIBRATED"))
    out.append(
        "calibration_service: "
        + registered(log_lines(ctx, "calibration"), "CALIBRATED")
    )
    el = log_lines(ctx, "elodin")
    for vid, what in (
        ("[32, 49]", "[0x20,0x31]: PT10_Cal.CH1 / PT2_Cal.CH1"),
        ("[32, 50]", "[0x20,0x32]: PT2_Cal.CH2, the control"),
    ):
        k = sum(1 for ln in el if f"inserting vtable id={vid}" in ln)
        out.append(f"elodin-db: vtable {vid} inserted {k} times ({what})")
    be = log_lines(ctx, "backend")
    out.append(
        "backend: gave up on [0x20, 0x31] (refusals exhausted): "
        f"{sum(1 for ln in be if 'giving up on [0x20, 0x31]' in ln)} time(s)"
    )
    out.append("")

    # Client A's frames for board 22. Raw rows come from daq_bridge ([0x20,0x21..]), whose
    # tables the window never touched; calibrated rows from calibration_service.
    live = defaultdict(set)
    hist = {"connect": {}, "history": {}}
    for st, frames in steps:
        for m in frames.get("A", []):
            if m["type"] == "sensor_update":
                p = m["payload"]
                if str(p["entity"]).startswith("PT2"):
                    live[(p["entity"], p["component"])].add(dumps(p["value"]))
            elif m["type"] == "historical_data" and st["name"] in hist:
                for k, series in m["payload"].items():
                    if k.startswith("PT2"):
                        hist[st["name"]].setdefault(k, set()).update(
                            dumps(v) for v in series.get("values", [])
                        )
    chans = sorted(
        int(ent.split(".CH")[1]) for (ent, comp) in live if ent.startswith("PT2.CH")
    )
    cal_comps = sorted({comp for (ent, comp) in live if ent.startswith("PT2_Cal.")})
    out.append(
        "## sensor_update, client A, 2 x RESUBSCRIBE_MIN_MS (server.ts 5000) + 2 s from "
        "PT2_Cal.CH2's first sample; board 22 channel by channel (P7 values)"
    )
    for ch in chans:
        for comp in ("raw_adc_counts",):
            out.append(
                f"PT2.CH{ch}.{comp}  value={show_values(live[('PT2.CH%d' % ch, comp)])}"
            )
        for comp in cal_comps:
            vals = live.get((f"PT2_Cal.CH{ch}", comp))
            out.append(
                f"PT2_Cal.CH{ch}.{comp}  "
                + (
                    f"value={show_values(vals)}"
                    if vals
                    else "absent (no frame carried it)"
                )
            )
    out.append("")
    out.append(
        "## historical_data, client A: board 22 series on connect, then the 12 s query"
    )
    for name, keys in hist.items():
        out.append(f"# {name}: {len(keys)} PT2* series")
        for ch in chans:
            for k in [f"PT2.CH{ch}.raw_adc_counts"] + [
                f"PT2_Cal.CH{ch}.{c}" for c in cal_comps
            ]:
                if name == "history" and k not in (
                    "PT2.CH1.raw_adc_counts",
                    "PT2_Cal.CH1.pressure_psi",
                    "PT2_Cal.CH2.pressure_psi",
                ):
                    continue  # the query asked for these three
                out.append(
                    f"  {k} "
                    + (
                        "{" + ", ".join(sorted(keys[k])) + "}"
                        if k in keys
                        else "absent"
                    )
                )
    out.append("")
    return "\n".join(out)


def main():
    cap_path, ctx_path, out_dir = sys.argv[1:4]
    cap = json.load(open(cap_path))
    ctx = json.load(open(ctx_path))
    ctx.setdefault("paths", {})
    n = Normalizer(ctx.get("now_ms"), ctx["paths"], ctx.get("ports"))
    os.makedirs(out_dir, exist_ok=True)

    # Parse every frame once; P6: a client's frames are attributed to the step they arrived in.
    steps = []
    for st in cap["steps"]:
        frames = defaultdict(list)
        for f in st["frames"]:
            frames[f["client"]].append(json.loads(f["raw"]))
        steps.append((st, frames))

    if ctx.get("mode") == "stalesub":
        open(os.path.join(out_dir, "stalesub.txt"), "w").write(
            stalesub_report(steps, ctx)
        )
        return

    # ── ws_handshake.txt ────────────────────────────────────────────────────
    hs = []
    first_frames = OrderedDict()
    for st, frames in steps:
        for client, fs in frames.items():
            if client not in first_frames:
                first_frames[client] = (st["name"], fs)
    health = set()
    flaps = set()
    for client in first_frames:
        seq = [m for _, frames in steps for m in frames.get(client, [])]
        flaps |= flap_ids(seq)
    for client, (sname, fs) in first_frames.items():
        hs.append(f"## client {client} (connected in step {sname})")
        marked = False
        for m in replay_by_board(handshake_frames(fs)):
            if handshake_phase(m) == HANDSHAKE_PHASES.index("selftest"):
                if not marked:
                    hs.append(
                        "<self-test replay: see ws_streams.txt self-test section (P12)>"
                    )
                    marked = True
                continue
            if is_board_health(m):
                if id(m) not in flaps:
                    health.add(dumps(n.value(m["payload"])))
                continue
            m = norm_event(n, m)
            if m["type"] == "board_status_update":
                m["payload"] = norm_board_status(m["payload"])
            hs.append(dumps(m))
        hs.append("")
    open(os.path.join(out_dir, "ws_handshake.txt"), "w").write("\n".join(hs))

    # ── ws_events.txt ───────────────────────────────────────────────────────
    ev = []
    for st, frames in steps:
        ev.append(f"## {st['name']}")
        for s in st["sent"]:
            ev.append(f"> {s['client']} {n.text(s['raw'])}")
        for client, fs in frames.items():
            hs_ids = (
                {id(m) for m in handshake_frames(fs)}
                if first_frames.get(client, (None,))[0] == st["name"]
                else set()
            )
            lines = []
            for m in fs:
                if id(m) in hs_ids or m["type"] in STREAM_TYPES:
                    continue
                if is_board_health(m):
                    if id(m) not in flaps:
                        health.add(dumps(n.value(m["payload"])))
                    continue
                lines.append((m["type"], f"< {client} {dumps(norm_event(n, m))}"))
            ev.extend(order_cross_path(lines))
        # P13. A step's own notes: categorical lines the session derived from its stamps (a reply
        # inside its bound or not). Only the holds session writes any; a capture without the key
        # (every other session) prints nothing here.
        for text in st.get("notes", []):
            ev.append(f"= {text}")
        ev.append("")
    ev.append(
        "## board-health notifications seen (any step, any client; P1, reset flaps P1b)"
    )
    ev.extend(sorted(health))
    ev.append("")
    open(os.path.join(out_dir, "ws_events.txt"), "w").write("\n".join(ev))

    # ── ws_streams.txt ──────────────────────────────────────────────────────
    sens = defaultdict(lambda: {"n": 0, "vals": set(), "steps": set()})
    periodic = defaultdict(set)
    periodic_n = Counter()
    hist = []
    total_s = 0.0
    for st, frames in steps:
        dur = (st["t1"] - st["t0"]) / 1000.0
        for client, fs in frames.items():
            if client == "A":
                total_s += dur
            for m in fs:
                t = m["type"]
                if t == "sensor_update" and client == "A":
                    p = m["payload"]
                    s = sens[(p["entity"], p["component"])]
                    s["n"] += 1
                    s["vals"].add(dumps(p["value"]))
                elif t == "historical_data":
                    keys = {}
                    for k, series in m["payload"].items():
                        keys[k] = sorted({dumps(v) for v in series.get("values", [])})
                        assert set(series) == {"time", "values"}, series.keys()
                    if client != "C":  # late_client: see selftest_paths
                        hist.append((st["name"], client, keys))
                elif t in ("connection_status", "board_status_update", "board_log"):
                    p = n.value(m["payload"])
                    p = {
                        "connection_status": norm_connection_status,
                        "board_status_update": norm_board_status,
                        "board_log": norm_board_log,
                    }[t](p)
                    periodic[(client, t)].add(dumps(p))
                    if client == "A":
                        periodic_n[t] += 1
    out = ["## sensor_update (client A, whole session; P7 values)"]
    for (ent, comp), s in sorted(sens.items()):
        if ent.startswith("SELF_TEST."):
            continue  # P12
        vals = sorted(s["vals"])
        alt = ch7_render(f"{ent}.{comp}", vals)
        if alt:
            out.append(f"{ent}.{comp}  value={alt}")
            continue
        v = (
            vals[0]
            if len(vals) == 1
            else ("{" + ", ".join(vals) + "}" if len(vals) <= 4 else "<varies>")
        )
        out.append(f"{ent}.{comp}  value={v}")
    out.append("")
    out.extend(selftest_section(steps, ctx))
    out.append("## timing bounds (from config, not observed; README T1)")
    out.append(envelope_check(steps, ctx.get("gui_points_per_second", 4)))
    out.append("")
    for (client, t), ps in sorted(periodic.items()):
        out.append(f"## {t} distinct payloads, client {client}")
        out.extend(sorted(ps))
        out.append("")
    out.append(
        "## historical_data (P8: series keys per step, the distinct values each carries)"
    )
    by_req = OrderedDict()
    for sname, client, keys in hist:
        acc = by_req.setdefault((sname, client), {})
        for k, v in keys.items():
            acc.setdefault(k, set()).update(v)
    for (sname, client), keys in by_req.items():
        keys = {k: v for k, v in keys.items() if not k.startswith("SELF_TEST.")}  # P12
        out.append(f"# {sname} client {client}: {len(keys)} series (self-test: P12)")
        for k in sorted(keys):
            vals = sorted(keys[k])
            alt = ch7_render(k, vals)
            if alt:
                out.append(f"  {k} {alt}")
                continue
            # P7 applied to history: a stream with more than four values is "<varies>".
            shown = "{" + ", ".join(vals) + "}" if len(vals) <= 4 else "<varies>"
            out.append(f"  {k} {shown}")
    out.append("")
    open(os.path.join(out_dir, "ws_streams.txt"), "w").write("\n".join(out))

    # ── ws_schema.txt ───────────────────────────────────────────────────────
    sch = defaultdict(lambda: defaultdict(set))
    for st, frames in steps:
        for client, fs in frames.items():
            for m in fs:
                schema_paths(fold_dynamic_keys(m), "", sch[m["type"]])
    out = []
    for t in sorted(sch):
        out.append(f"## {t}")
        for path in sorted(sch[t]):
            out.append(f"{path or '.'}: {'|'.join(sorted(sch[t][path]))}")
        out.append("")
    open(os.path.join(out_dir, "ws_schema.txt"), "w").write("\n".join(out))

    # ── http.txt / csv.txt ──────────────────────────────────────────────────
    # P9. Routes whose bodies are counters or wall-clock measurements: frozen as a schema.
    schema_only = ("/stats", "/api/debug", "/api/board-logs")
    keep_headers = (
        "content-type",
        "content-disposition",
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-expose-headers",
        "location",
        "cache-control",
    )
    out, csv_out, first_body, file_seen, last_req = [], [], {}, {}, ""
    for st, _ in steps:
        if not st["http"]:
            continue
        out.append(f"## {st['name']}")
        for h in st["http"]:
            if "file" in h:
                # A fixture file read by session.ts at this point (H1): what a write left on disk,
                # normalised like a body. A content already printed is named by the FILE line
                # that first showed it (its path and the request it followed), not repeated.
                out.append(f"FILE {h['file']}")
                if h["content"] is None:
                    out.append("  (absent)")
                    continue
                text = n.text(h["content"])
                if text in file_seen:
                    out.append(f"  content: same as FILE {file_seen[text]}")
                else:
                    file_seen[text] = f"{h['file']} after {last_req}"
                    out.append("  content:")
                    out.extend("    | " + ln for ln in text.rstrip("\n").split("\n"))
                continue
            who = h["reqHeaders"].get("X-Auth-Email")
            line = f"{h['method']} {n.text(h['path'])}" + (
                f"  [as {who}]" if who else ""
            )
            last_req = line
            if h["reqBody"] is not None:
                line += f"  body={n.text(h['reqBody'])!r}"
            out.append(line)
            out.append(f"  status {h['status']}")
            for k in keep_headers:
                if k in h["headers"]:
                    out.append(f"  {k}: {n.text(str(h['headers'][k]))}")
            ctype = str(h["headers"].get("content-type", ""))
            body = h["body"]
            path = h["path"].split("?")[0]
            if body == "":
                rendered = "(empty)"
            elif ctype.startswith("application/json"):
                obj = json.loads(body)
                if path == "/api/debug" and h["path"].endswith("?values"):
                    # P14. The same body as P9's schema, plus the values of the keys that say how
                    # the backend is wired rather than how much it has counted (D64(3)).
                    sp = defaultdict(set)
                    schema_paths(obj, "", sp)
                    ws = obj.get("wsClients")
                    rendered = (
                        "schema "
                        + dumps({k: sorted(v) for k, v in sp.items()})
                        + " values "
                        + dumps(
                            {
                                "ingestConnected": obj.get("ingestConnected"),
                                "useRelay": obj.get("useRelay"),
                                "wsClients": (
                                    ">=1"
                                    if isinstance(ws, (int, float)) and ws >= 1
                                    else ws
                                ),
                            }
                        )
                    )
                elif path in schema_only or path.startswith("/api/board-logs"):
                    sp = defaultdict(set)
                    schema_paths(obj, "", sp)
                    if path.startswith("/api/board-logs"):
                        # keys of the per-board stats map are board ids — data
                        rendered = "schema " + dumps(
                            {
                                k: sorted(v)
                                for k, v in sp.items()
                                if not k.startswith(".stats.2")
                            }
                        )
                    else:
                        rendered = "schema " + dumps(
                            {k: sorted(v) for k, v in sp.items()}
                        )
                else:
                    rendered = dumps(n.value(obj))
            else:
                rendered = n.text(body)
                if "csv" not in ctype:
                    rendered = "\n" + "\n".join(
                        "    | " + ln for ln in rendered.split("\n")
                    )
                if "csv" in ctype:
                    csv_out.append(f"## {h['method']} {h['path']}  ({ctype})")
                    csv_out.append(rendered.rstrip("\n"))
                    csv_out.append("")
                    rendered = f"(csv, {len(body.splitlines())} lines, see csv.txt)"
            sig = (h["method"], h["path"], who, h["reqBody"])
            if sig in first_body and first_body[sig] == (h["status"], rendered):
                out.append("  body: same as the earlier identical request")
            else:
                first_body.setdefault(sig, (h["status"], rendered))
                out.append(f"  body: {rendered}")
        out.append("")
    open(os.path.join(out_dir, "http.txt"), "w").write("\n".join(out))
    # Each CSV once: they are identical before and during the session (asserted by http.txt).
    seen, dedup = set(), []
    for block in "\n".join(csv_out).split("\n## "):
        if block and block not in seen:
            seen.add(block)
            dedup.append(block if block.startswith("## ") else "## " + block)
    open(os.path.join(out_dir, "csv.txt"), "w").write("\n".join(dedup))


if __name__ == "__main__":
    main()
