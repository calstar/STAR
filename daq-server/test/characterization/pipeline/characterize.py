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
import hashlib
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


def dumps(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False)


def bucket_rate(n, seconds):
    """P2. Rates in three wide classes. Event streams (self-test, controller state) sit well under
    0.25/s; everything the GUI streams (1 Hz periodics, the 2-windows/s envelope after the outbox
    has had its say, 10 Hz raw) sits in 0.25-5/s; only an unthrottled stream would exceed 5/s.
    """
    if n == 0:
        return "none"
    r = n / max(seconds, 1e-3)
    return (
        "event(<0.25/s)"
        if r < 0.25
        else ("stream(0.25-5/s)" if r <= 5 else "fast(>5/s)")
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

    # ── ws_handshake.txt ────────────────────────────────────────────────────
    hs = []
    first_frames = OrderedDict()
    for st, frames in steps:
        for client, fs in frames.items():
            if client not in first_frames:
                first_frames[client] = (st["name"], fs)
    health = set()
    for client, (sname, fs) in first_frames.items():
        hs.append(f"## client {client} (connected in step {sname})")
        for m in replay_by_board(handshake_frames(fs)):
            if is_board_health(m):
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
            for m in fs:
                if id(m) in hs_ids or m["type"] in STREAM_TYPES:
                    continue
                if is_board_health(m):
                    health.add(dumps(n.value(m["payload"])))
                    continue
                ev.append(f"< {client} {dumps(norm_event(n, m))}")
        ev.append("")
    ev.append("## board-health notifications seen (any step, any client; P1)")
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
    out = ["## sensor_update (client A, whole session; P2 rate per stream, P7 values)"]
    for (ent, comp), s in sorted(sens.items()):
        vals = sorted(s["vals"])
        v = (
            vals[0]
            if len(vals) == 1
            else ("{" + ", ".join(vals) + "}" if len(vals) <= 4 else "<varies>")
        )
        out.append(f"{ent}.{comp}  rate={bucket_rate(s['n'], total_s)}  value={v}")
    out.append("")
    out.append("## periodic types (client A, whole session; P2)")
    for t in sorted(periodic_n):
        out.append(f"{t}  rate={bucket_rate(periodic_n[t], total_s)}")
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
        out.append(f"# {sname} client {client}: {len(keys)} series")
        for k in sorted(keys):
            vals = sorted(keys[k])
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
    out, csv_out, first_body = [], [], {}
    for st, _ in steps:
        if not st["http"]:
            continue
        out.append(f"## {st['name']}")
        for h in st["http"]:
            who = h["reqHeaders"].get("X-Auth-Email")
            line = f"{h['method']} {n.text(h['path'])}" + (
                f"  [as {who}]" if who else ""
            )
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
                if path in schema_only or path.startswith("/api/board-logs"):
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
                elif path == "/api/cubic_calibration":
                    # The committed store, read via __dirname (it ignores DAQ_CALIBRATIONS_DIR).
                    rendered = (
                        f"sha256={hashlib.sha256(body.encode()).hexdigest()} keys="
                        + dumps(sorted(obj))
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
