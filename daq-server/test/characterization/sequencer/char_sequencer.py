#!/usr/bin/env python3
"""Golden-master characterization of sequencer_service and controller_service.

Drives both binaries over TCP from scripted sessions, records every datagram they put on the
actuator port, and compares a normalised rendering of each session with golden/<session>.txt.
CHAR_UPDATE=1 rewrites the goldens. CHAR_SEQ_REPEAT=N runs every session N times and fails if
the renderings differ (the determinism check). CHAR_SEQ_ONLY=<regex> limits the sessions run.

Off the stand only, under test/characterization/with_stack_lock.sh — run.sh does both.
See README.md for what is frozen and the normalisation rules N1-N7.
"""

from __future__ import annotations

import difflib
import os
import re
import socket
import sys
import time
import tomllib
import traceback
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import harness as H  # noqa: E402
import wire as W  # noqa: E402
from fake_elodin import FakeElodin  # noqa: E402

GOLDEN = H.HERE / "golden"
# How long after a republish a settled window ends. Must exceed the boundary lookahead (60 ms, 110 ms
# for an abort: wire.BOUNDARY_LOOKAHEAD_NS + wire.ABORT_DONE_STEP_NS) plus the next transition's own
# latency: a tick landing within the lookahead of the next state's
# publish is taken for that state's entry (seen on Linux under load, where the next command's
# publish arrived within 50 ms of the tick). The next tick is still ~0.8 s away.
SETTLE_TAIL = 0.2
# A send can only be classified (republish or entry) once any transition publish it precedes has
# arrived, and the lookahead says that is within 60 ms (110 ms for an abort). While waiting, only sends at
# least this old are counted. Without it a poll landing between a new state's entry sends and its
# publish took the entry (apply + first pass, full column) for two republish rounds of the OLD
# state and ended the window before the new state republished (digital-twin/entry/Flow Test on
# Linux: Ready's entry happened to have Flow Test's column size).
CLASSIFY_AFTER_NS = 150_000_000
WORK = H.DAQ / ".tmp" / f"char_sequencer_{os.getpid()}"
OUT = H.DAQ / ".tmp" / "char_sequencer_out"

# ── profiles ───────────────────────────────────────────────────────────────────────────────────

# Hold windows are shortened so every session finishes in seconds, and chosen so no state's
# actuator loop ends near a republish tick (README, N5): fire 0.5 s (extend: 0.6 s from the call),
# flow 0.6 s requested + its 1.0 s gate stagger = 1.6 s.
PROFILES = {
    "default": dict(
        config=H.DAQ / "config/profiles/default/config.toml",
        csv=H.DAQ / "config/profiles/default",
        overrides={("fire", "duration_ms"): "500", ("fire", "extended_ms"): "600"},
    ),
    "digital-twin": dict(
        config=H.DAQ / "config/profiles/digital-twin/config.toml",
        csv=H.DAQ / "config/profiles/digital-twin",
        overrides={("flow", "duration_ms"): "600"},
    ),
}

# Dynamic states added to digital-twin for the script sessions, the way test_integration.sh adds
# its Script Test: reachable from Press Standby, able to reach Press Standby and Vent.
# Where Script Timeout lands. A dynamic state's timeout is armed twice — as a hold rule and as the
# ScriptRunner's own deadline, same length — and both fire; which one wins is a race, and the loser
# arrives as a second transition. Into a state that may not transition to itself, that second one
# is refused and moves nothing, so the session is deterministic. Into Vent (which may), it was a
# Vent -> Vent re-entry in some runs and not others: see README, "Found while characterizing".
LANDING = "Script Landing"
LANDING_ID = 29

SCRIPT_STATES = [
    # (id, name, script file, body or None, extra toml lines, has actuator column)
    (
        16,
        "Script Seq",
        "seq.script",
        "open_valve(DOME_CTRL)\ndelay(0.25)\nclose_valve(DOME_CTRL)\nopen_valve(LOX_VENT)\n"
        "delay(0.25)\nclose_valve(LOX_VENT)\ntransition_to(PRESS_STANDBY)\n",
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        17,
        "Script End",
        "end.script",
        "open_valve(LOX_VENT)\ndelay(0.5)\n",
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        18,
        "Script Timeout",
        "timeout.script",
        "open_valve(DOME_CTRL)\ndelay(5)\nclose_valve(DOME_CTRL)\n",
        'script_timeout_ms = 600\nscript_return_target = "Press Standby"\n'
        f'script_timeout_target = "{LANDING}"',
        True,
    ),
    (
        19,
        "Script Loop",
        "loop.script",
        "i = 0\nwhile i < 3:\n    open_valve(HIGH_PRESS_CTRL)\n    delay(0.1)\n"
        "    close_valve(HIGH_PRESS_CTRL)\n    delay(0.1)\n    i = i + 1\n",
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        20,
        "Script Long",
        "long.script",
        "open_valve(DOME_CTRL)\ndelay(5)\nclose_valve(DOME_CTRL)\n",
        'script_timeout_ms = 10000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        21,
        "Script BadName",
        "../escape.script",
        None,
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        22,
        "Script Missing",
        "missing.script",
        None,
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        23,
        "Script BadValve",
        "badvalve.script",
        "open_valve(NO_SUCH_VALVE)\n",
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        24,
        "Script BadTarget",
        "badtarget.script",
        "transition_to(IDLE)\n",
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        25,
        "Script NoTimeout",
        "end.script",
        None,
        'script_return_target = "Press Standby"\nscript_timeout_target = "Vent"',
        True,
    ),
    (
        26,
        "Script BigTimeout",
        "end.script",
        None,
        'script_timeout_ms = 700000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
    (
        27,
        "Script NoColumn",
        "end.script",
        None,
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        False,
    ),
    (
        28,
        "Script Syntax",
        "syntax.script",
        "open_valve(\n",
        'script_timeout_ms = 5000\nscript_return_target = "Press Standby"\n'
        'script_timeout_target = "Vent"',
        True,
    ),
]


def _scripts_csv_edit(d: Path) -> None:
    t = H.read_csv(d / "state_transitions.csv")
    a = H.read_csv(d / "state_machine_actuators.csv")
    dl = H.read_csv(d / "state_machine_actuator_delays.csv")
    for _id, name, _f, _b, _x, column in SCRIPT_STATES:
        t[0].append(name)
        for r in t[1:]:
            r.append("1" if r[0] == "Press Standby" else "0")
        t.append(
            [name]
            + ["1" if h in ("Press Standby", "Vent", name) else "0" for h in t[0][1:]]
        )
        if column:
            a[0].append(name)
            for r in a[1:]:
                r.append("CLOSE")
            dl[0].append(name)
            for r in dl[1:]:
                r.append("0")
    t[0].append(LANDING)
    for r in t[1:]:
        r.append("1" if r[0] == "Script Timeout" else "0")
    t.append([LANDING] + ["1" if h == "Press Standby" else "0" for h in t[0][1:]])
    a[0].append(LANDING)
    for r in a[1:]:
        r.append("CLOSE")
    dl[0].append(LANDING)
    for r in dl[1:]:
        r.append("0")
    H.write_csv(d / "state_transitions.csv", t)
    H.write_csv(d / "state_machine_actuators.csv", a)
    H.write_csv(d / "state_machine_actuator_delays.csv", dl)


def _scripts_toml() -> str:
    out = []
    for sid, name, fname, _b, extra, _c in SCRIPT_STATES:
        out.append(
            f'\n[[states]]\nid = {sid}\nname = "{name}"\nscript_file = "{fname}"\n{extra}\n'
        )
    out.append(f'\n[[states]]\nid = {LANDING_ID}\nname = "{LANDING}"\n')
    return "".join(out)


def _scripts_files() -> dict[str, str]:
    return {f: b for _i, _n, f, b, _x, _c in SCRIPT_STATES if b is not None}


# ── config model (navigation and readability only — never a source of expectations) ──────────


class Model:
    def __init__(self, cfg_path: Path, workdir: Path):
        cfg = tomllib.loads(cfg_path.read_text())
        self.cfg = cfg
        self.states = {s["id"]: s for s in cfg.get("states", [])}
        self.names = {s["id"]: s["name"] for s in cfg.get("states", [])}
        self.by_name = {v: k for k, v in self.names.items()}
        self.order = [s["name"] for s in cfg.get("states", [])]
        boot = [s for s in cfg.get("states", []) if s.get("is_boot")]
        self.boot = boot[0]["name"] if boot else self.names[min(self.names)]
        self.aborts = {s["name"] for s in cfg.get("states", []) if s.get("is_abort")}
        self.flow = {s["name"] for s in cfg.get("states", []) if s.get("is_flow")}
        self.dynamic = {
            s["name"] for s in cfg.get("states", []) if s.get("script_file")
        }
        self.fire = cfg.get("fire", {}).get("state", "")
        self.roles = {
            k: (v[0], v[1], v[2])
            for k, v in cfg.get("actuator_roles", {}).items()
            if 1 <= v[1] <= 10
        }
        self.pwm = {
            k for k, v in cfg.get("actuator_roles", {}).items() if len(v) > 3 and v[3]
        }
        self.rolemap = W.RoleMap(self.roles)
        rows = H.read_csv(workdir / "state_transitions.csv")
        header = rows[0][1:]
        self.allowed: dict[str, set[str]] = {}
        for r in rows[1:]:
            if not r or r[0].strip() not in self.by_name:
                continue
            cells = [c.strip() for c in r]
            for col in range(1, len(cells)):
                if (
                    col - 1 < len(header)
                    and cells[col] == "1"
                    and header[col - 1] in self.by_name
                ):
                    self.allowed.setdefault(cells[0], set()).add(header[col - 1])
        acts = H.read_csv(workdir / "state_machine_actuators.csv")
        ah = [c.strip() for c in acts[0]]
        self.column: dict[str, set[str]] = {}
        for r in acts[1:]:
            for col in range(1, min(len(ah), len(r))):
                if r[col].strip().upper() in ("OPEN", "CLOSE", "CLOSED"):
                    self.column.setdefault(ah[col], set()).add(r[0].strip())
        delays = H.read_csv(workdir / "state_machine_actuator_delays.csv")
        dh = [c.strip() for c in delays[0]]
        self.max_delay: dict[str, float] = {}
        self.delay: dict[tuple[str, str], float] = {}
        for r in delays[1:]:
            for col in range(1, min(len(dh), len(r))):
                try:
                    v = float(r[col])
                except ValueError:
                    continue
                self.max_delay[dh[col]] = max(self.max_delay.get(dh[col], 0.0), v)
                self.delay[(dh[col], r[0].strip())] = v

    def full_count(self, state: str, board) -> int:
        """How many pairs a republish of `state` carries to `board`: its column's roles there."""
        roles = {
            r
            for r in self.column.get(state, set())
            if r in self.roles and self.roles[r][2] == board
        }
        if state == self.fire:
            roles -= self.pwm
        return len(roles)

    def path(self, src: str, dst: str, avoid: set[str]) -> list[str] | None:
        """Shortest legal path src -> dst through states not in `avoid` (dst may be in it)."""
        prev = {src: None}
        q = deque([src])
        while q:
            s = q.popleft()
            if s == dst:
                break
            for n in sorted(self.allowed.get(s, ())):
                if n in prev or (n in avoid and n != dst):
                    continue
                prev[n] = s
                q.append(n)
        if dst not in prev:
            return None
        out = [dst]
        while prev[out[-1]] is not None:
            out.append(prev[out[-1]])
        return list(reversed(out))[1:]


# ── session ────────────────────────────────────────────────────────────────────────────────────

# Sequencer/controller log lines worth freezing (N6): what the wire cannot show — the controller
# hand-off, refusals and load-time verdicts. Everything else in the logs is ignored.
# N6. The services log from several threads into one stream with no line atomicity, so a line
# printed while another thread prints can come out spliced. Two things are frozen, both immune:
#  - the load-time verdicts, printed by init() before any other thread of ours is talking;
#  - how many times each run-time message happened, counted by a phrase that is one string
#    literal in the source (one write, so never split).
SEQ_LOAD = re.compile(
    r"\[SequencerService\] (ERROR|WARNING|Fire state|Fire gate|Flow hold|Flow gate|"
    r"Dynamic state)"
)
SEQ_LOAD_END = (
    "[SequencerService] Fire valve ownership"  # PressureFeed's thread starts before
)
SEQ_FACTS = [
    "could not reach controller_service at ",
    "[SequencerService] retrying ",
    "controller_service did not acknowledge ",
    "[SequencerService] controller_service refused ",
    "[SequencerService] no ACK from controller_service for ",
    " (acked)",
    "[HoldTimer] ",
]
CTL_FACTS = [
    "FIRE_START received — PWM gate open",
    "FIRE_STOP received — PWM gate closed",
    "refused — fire gate disabled (sequencer owns the valves)",
    "Unknown control cmd: ",
    "control connection closed with no command (timeout or peer went away)",
    "FIRE close command sent (duty=0)",
]


def norm_log(line: str) -> str:
    return line.replace(str(WORK), "<WORK>").rstrip()


def log_digest(text: str, load: bool, facts: list[str]) -> list[str]:
    out = []
    if load:
        head = text.split(SEQ_LOAD_END, 1)[0]
        out += [norm_log(ln) for ln in head.splitlines() if SEQ_LOAD.search(ln)]
    for f in facts:
        n = text.count(f)
        if n:
            out.append(f"x{n} {f.strip()!r}")
    return out


class Session:
    def __init__(self, run: "Run", name: str):
        self.run = run
        self.name = name
        self.lines: list[str] = [f"# session {name}"]
        self.steps: list[dict] = []
        self.seq: H.Service | None = None
        self.ctl: H.Service | None = None
        self.client: H.Client | None = None
        self.model: Model | None = None
        self.boundaries: list[tuple[int, str]] = []
        self.el_mark = 0
        self.rec_mark = 0
        self.logs = True

    # -- services ---------------------------------------------------------------------------

    def config(
        self, profile: str, overrides=None, scripts=None, extra="", csv_edit=None
    ) -> Path:
        p = PROFILES[profile]
        prof = H.Profile(profile, p["config"], p["csv"], WORK)
        ov = dict(p["overrides"])
        ov.update(overrides or {})
        cfg = prof.materialise(ov, scripts=scripts, extra_toml=extra, csv_edit=csv_edit)
        self.model = Model(cfg, prof.dir)
        return cfg

    def controller_config(self, profile: str, overrides=None) -> Path:
        p = PROFILES[profile]
        prof = H.Profile(profile + "-controller", p["config"], p["csv"], WORK)
        ov = dict(p["overrides"])
        ov.update(overrides or {})
        return prof.materialise(ov)

    def start(self, cfg: Path) -> None:
        # Drain anything still in flight from the previous session (an ABORT_DONE, say).
        time.sleep(0.05)
        self.rec_mark = self.run.rec.mark()
        self.el_mark = self.run.el.mark()
        t = time.monotonic_ns()
        self.seq = H.start_sequencer(cfg, WORK / f"{_slug(self.name)}.seq.log")
        self.boundaries = [(t, self.model.boot)]
        self.client = H.Client(H.SEQ_PORT)

    def start_controller(self, cfg: Path) -> None:
        self.ctl = H.start_controller(cfg, WORK / f"{_slug(self.name)}.ctl.log")

    # -- steps ------------------------------------------------------------------------------
    #
    # A step is a command and its reply, plus a window: everything that reached the capture port
    # from the moment the command was written until the next step began. `summary=True` also
    # prints the window's republish ticks (N5) — only for windows whose tick count and content
    # are fixed by construction (a state held >= 1.7 s, nothing else moving).

    def _add(self, label, reply, mark, t_open, record=True, summary=False):
        self.steps.append(
            dict(
                label=label,
                reply=reply,
                rec=mark,
                t_open=t_open,
                record=record,
                summary=summary,
            )
        )

    def step(self, cmd: str, wait: float = 0.0, record=True, summary=False) -> str:
        mark, t_open = self.run.rec.mark(), time.monotonic_ns()
        reply = self.client.cmd(cmd)
        self._add(cmd, reply, mark, t_open, record, summary)
        if wait:
            time.sleep(wait)
        return reply

    def raw(
        self, data: bytes, nreplies: int, label: str, wait: float = 0.0
    ) -> list[str]:
        mark, t_open = self.run.rec.mark(), time.monotonic_ns()
        replies = self.client.raw(data, nreplies)
        self._add(label, " | ".join(replies), mark, t_open)
        if wait:
            time.sleep(wait)
        return replies

    def scripts(self) -> None:
        mark, t_open = self.run.rec.mark(), time.monotonic_ns()
        self.client.sock.sendall(b"SCRIPTS\n")
        lines = self.client.until("END")
        lines = [ln.replace(str(WORK), "<WORK>") for ln in lines]
        self._add("SCRIPTS", "\n      ".join(lines), mark, t_open, record=False)

    def note(self, text: str, record=True, summary=False) -> None:
        self._add(
            f"({text})", None, self.run.rec.mark(), time.monotonic_ns(), record, summary
        )

    def ctl_cmd(self, payload: bytes, label: str, wait: float = 0.0) -> str:
        mark, t_open = self.run.rec.mark(), time.monotonic_ns()
        reply = H.one_shot(H.CTL_PORT, payload)
        self._add(f"controller <- {label}", repr(reply), mark, t_open)
        if wait:
            time.sleep(wait)
        return reply

    def nav(self, target: str, avoid_aborts=True) -> None:
        """Walk legally from the current state to `target`, letting each hop settle."""
        cur = self.current_state()
        avoid = set(self.model.aborts) | self.model.dynamic | self.model.flow
        if self.model.fire:
            avoid.add(self.model.fire)
        hops = self.model.path(cur, target, avoid) if cur != target else []
        if hops is None:
            self.step("DEBUG_MODE:1", record=False)
            self.step(f"TRANSITION:{target}", record=False)
            self.step("DEBUG_MODE:0", record=False)
            time.sleep(self.hop_wait(target))
            return
        for h in hops:
            self.step(f"TRANSITION:{h}", self.hop_wait(h), record=False)

    def hop_wait(self, state: str) -> float:
        return min(0.85, self.model.max_delay.get(state, 0.0) + 0.3)

    def current_state(self) -> str:
        trans = self.run.el.since(self.el_mark)
        if not trans:
            return self.model.boot
        return self.model.names.get(trans[-1][2], f"id{trans[-1][2]}")

    def settle(self, min_wait=0.0, ticks=2, until_type=None, timeout=15.0) -> None:
        """End the current step's window just after a republish tick (N5).

        Waits `min_wait`, then (if given) for a datagram of `until_type` (ABORT_DONE, say), then
        until the state the rig is in *now* has republished `ticks` times since the step began
        (and at least once after that datagram), then until SETTLE_TAIL after that tick. Only
        ticks older than CLASSIFY_AFTER_NS are counted, so an entry is never mistaken for one.
        """
        t0 = self.steps[-1]["t_open"]
        time.sleep(min_wait)
        deadline = time.monotonic() + timeout
        need = None if until_type is not None else ticks
        while time.monotonic() < deadline:
            bounds = self._bounds()
            sends = W.to_sends(self.run.rec.since(self.rec_mark))
            W.mark_ticks(sends, bounds, aborts=self.model.aborts)
            cur = len(bounds) - 1
            final = time.monotonic_ns() - CLASSIFY_AFTER_NS
            mine = [
                s
                for s in sends
                if s.tick
                and s.loop == cur
                and t0 < s.t <= final
                and self._is_full(s, bounds)
            ]
            # One republish is a send to each board: count complete rounds.
            per_dest: dict[str, int] = {}
            for x in mine:
                per_dest[x.dest] = per_dest.get(x.dest, 0) + 1
            rounds = min(per_dest.values()) if per_dest else 0
            if need is None and any(s.ptype == until_type and s.t > t0 for s in sends):
                need = max(ticks, rounds + 1)
            if need is not None and rounds >= need:
                # SETTLE_TAIL after the tick that completed the count (already >= 150 ms ago).
                last = max(x.t for x in mine)
                time.sleep(
                    max(0.0, (last + SETTLE_TAIL * 1e9 - time.monotonic_ns()) / 1e9)
                )
                return
            time.sleep(0.02)
        raise RuntimeError(
            f"{self.name}: never settled after {self.steps[-1]['label']}"
        )

    def wait_after_tick(self, timeout: float = 3.0) -> None:
        """Block until the current loop republishes, then 50 ms more: the next tick is ~1 s off."""
        start = time.monotonic_ns()
        deadline = start + int(timeout * 1e9)
        while time.monotonic_ns() < deadline:
            bounds = self._bounds()
            sends = W.to_sends(self.run.rec.since(self.rec_mark))
            W.mark_ticks(sends, bounds, aborts=self.model.aborts)
            final = time.monotonic_ns() - CLASSIFY_AFTER_NS
            for s in sends:
                if s.tick and start < s.t <= final and self._is_full(s, bounds):
                    time.sleep(
                        max(0.0, (s.t + SETTLE_TAIL * 1e9 - time.monotonic_ns()) / 1e9)
                    )
                    return
            time.sleep(0.02)
        raise RuntimeError("no republish tick seen")

    def _bounds(self):
        out = list(self.boundaries)
        for t, _frm, to in self.run.el.since(self.el_mark):
            out.append((t, self.model.names.get(to, f"id{to}")))
        return out

    def _stage_delay(self, state: str, dest: str, raw: bytes):
        """N4: the delays-CSV value every role in this send shares in `state`, or None.

        None for an abort or scripted state (no schedule), or a send mixing delays."""
        if not self._staged(state):
            return None
        board = W.board_of(dest)
        by = {(b, ch): name for name, (_k, ch, b) in self.model.roles.items()}
        body = raw[6:]
        n = body[0] if body else 0
        ds = set()
        for i in range(n):
            role = by.get((board, body[1 + 2 * i]))
            if role is None:
                return None
            ds.add(self.model.delay.get((state, role), 0.0))
        return ds.pop() if len(ds) == 1 else None

    def _staged(self, state: str) -> bool:
        """States whose entry is a delays-CSV schedule (N4's fine band): not abort, not scripted."""
        return state not in self.model.aborts and state not in self.model.dynamic

    def _is_full(self, s: W.Send, bounds) -> bool:
        n = s.raw[6] if len(s.raw) > 6 else -1
        board = W.board_of(s.dest)
        return n > 0 and n == self.model.full_count(bounds[s.loop][1], board)

    # -- finish -----------------------------------------------------------------------------

    def finish(self) -> str:
        end_mark = self.run.rec.mark()
        if self.client:
            self.client.close()
        for svc in (self.seq, self.ctl):
            if svc:
                svc.stop()
        packets = self.run.rec.since(self.rec_mark)
        base = self.rec_mark
        bounds = self._bounds()
        sends_all = W.to_sends(packets[: end_mark - base])
        W.mark_ticks(sends_all, bounds, aborts=self.model.aborts)
        W.mark_pwm_tails(sends_all)
        for s in sends_all:
            if s.tick and not self._is_full(s, bounds):
                s.tick = False  # N5: only a full-column send can be a republish
        trans = self.run.el.since(self.el_mark)
        t_end = time.monotonic_ns()
        for i, st in enumerate(self.steps):
            nxt = self.steps[i + 1] if i + 1 < len(self.steps) else None
            lo = st["rec"] - base
            hi = (nxt["rec"] if nxt else end_mark) - base
            t_hi = nxt["t_open"] if nxt else t_end
            win = [s for s in sends_all if lo <= s.i < hi]
            label = st["label"]
            if st["reply"] is None:
                self.lines.append(label)
            else:
                self.lines.append(f"> {label}")
                self.lines.append(f"  < {st['reply'].replace(str(WORK), '<WORK>')}")
            if not st["record"]:
                continue
            # The state changes this window caused, from the Elodin side channel (never frozen as
            # bytes — only the from/to names, which the TCP reply already implies).
            for t, frm, to in trans:
                if st["t_open"] <= t < t_hi:
                    names = self.model.names
                    self.lines.append(
                        f"  state {names.get(frm, frm)} -> {names.get(to, to)}"
                    )
            self.lines.extend(
                W.render_window(
                    win,
                    self.model.rolemap,
                    bounds,
                    st["summary"],
                    st["t_open"],
                    from_open=st["reply"] is None,
                    t_close=t_hi,
                    stage_delay=self._stage_delay,
                )
            )
        for svc, load, facts, tag in (
            (self.seq, True, SEQ_FACTS, "sequencer"),
            (self.ctl, False, CTL_FACTS, "controller"),
        ):
            if not svc or not self.logs:
                continue
            picked = log_digest(svc.log.read_text(errors="replace"), load, facts)
            if picked:
                self.lines.append(
                    f"-- {tag} log (N6: load-time lines, then message counts)"
                )
                self.lines.extend("   " + ln for ln in picked)
        return "\n".join(self.lines) + "\n"


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name)


# ── sessions ───────────────────────────────────────────────────────────────────────────────────


def s_matrix(run, profile):
    """Every (from, to) pair: the transition table as the sequencer reads it. Replies only."""
    s = Session(run, f"{profile}/matrix")
    cfg = s.config(profile)
    s.start(cfg)
    m = s.model
    s.lines.append(
        f"# {len(m.order)} states; each row entered with DEBUG_MODE, then every target"
    )
    for src in m.order:
        s.client.cmd("DEBUG_MODE:1")
        r = s.client.cmd(f"TRANSITION:{src}")
        s.client.cmd("DEBUG_MODE:0")
        if not r.startswith("OK"):
            s.lines.append(f"{src}: cannot be entered: {r}")
            continue
        row = []
        for dst in m.order:
            r = s.client.cmd(f"TRANSITION:{dst}")
            row.append(f"  {src} -> {dst}: {r}")
            if r.startswith("OK"):
                s.client.cmd("DEBUG_MODE:1")
                back = s.client.cmd(f"TRANSITION:{src}")
                s.client.cmd("DEBUG_MODE:0")
                if not back.startswith("OK"):
                    row.append(f"  (could not return to {src}: {back})")
        s.lines.append(f"{src}:")
        s.lines.extend(row)
    s.steps = []
    s.logs = False  # every refusal is logged; the replies above already say it
    return s.finish()


def s_entry(run, profile, state):
    """Enter `state` from a legal predecessor and record everything on the wire."""
    s = Session(run, f"{profile}/entry/{state}")
    cfg = s.config(profile)
    s.start(cfg)
    m = s.model
    time.sleep(0.4)
    avoid = set(m.aborts) | m.dynamic | m.flow | ({m.fire} if m.fire else set())
    preds = sorted(p for p, tos in m.allowed.items() if state in tos and p != state)
    if state != m.boot and m.boot in preds:
        pred = m.boot
    else:
        pred = next(
            (
                p
                for p in preds
                if p not in avoid and m.path(m.boot, p, avoid) is not None
            ),
            None,
        )
    if pred is None:
        s.note("no legal predecessor: entered under DEBUG_MODE", record=False)
        s.step("DEBUG_MODE:1", record=False)
    else:
        s.note(f"walk legally {m.boot} -> {pred}", record=False)
        s.nav(pred)
    hold = 0.0
    if state == m.fire:
        hold = 0.5
    if state in m.flow:
        hold = 0.6 + m.max_delay.get(state, 0.0)
    if state in m.dynamic:
        s.step(f"TRANSITION:{state}", 0.4)
    else:
        s.step(f"TRANSITION:{state}", summary=True)
        s.settle(min_wait=hold, until_type=8 if state in m.aborts else None)
    return s.finish()


def s_actuators(run, profile):
    s = Session(run, f"{profile}/actuators")
    cfg = s.config(profile)
    s.start(cfg)
    m = s.model
    roles = sorted(m.roles)
    time.sleep(0.4)
    s.step(f"ACTUATOR:{roles[0]}:1", 0.1)
    s.step("DEBUG_MODE:1", 0.1)
    for r in roles:
        s.step(f"ACTUATOR:{r}:1", 0.12)
        s.step(f"ACTUATOR:{r}:0", 0.12)
    s.step(f"ACTUATOR:{roles[0].upper()}:open", 0.12)
    s.step(f"ACTUATOR:{roles[0].lower()}:closed", 0.12)
    s.step("ACTUATOR:No Such Valve:1", 0.12)
    s.step(f"ACTUATOR:{roles[0]}:2", 0.05)
    s.step(f"ACTUATOR:{roles[0]}", 0.05)
    s.step("ACTUATOR::1", 0.05)
    s.step(f"ACTUATOR: {roles[1]} : 1 ", 0.12)
    s.step(f"ACTUATOR:{roles[2]}:1", summary=True)  # overrides ride the republish
    s.settle()
    s.step("DEBUG_MODE:0", summary=True)  # ...and are cleared with debug mode
    s.settle()
    s.step(f"ACTUATOR:{roles[2]}:1", 0.1)
    s.step("DEBUG_MODE:1", 0.1)
    s.step(f"ACTUATOR:{roles[2]}:1", 0.1)
    s.wait_after_tick()
    target = sorted(m.allowed.get(m.boot, set()) - {m.boot} - m.aborts)[0]
    s.step(f"TRANSITION:{target}", summary=True)  # a transition clears the override too
    s.settle()
    return s.finish()


def s_debug(run, profile):
    s = Session(run, f"{profile}/debug")
    cfg = s.config(profile)
    s.start(cfg)
    m = s.model
    time.sleep(0.4)
    banned = [
        x
        for x in m.order
        if x not in m.allowed.get(m.boot, ())
        and x not in m.aborts
        and x not in m.dynamic
    ]
    if m.fire in banned:
        banned.remove(m.fire)
        banned.insert(0, m.fire)
    target = banned[0]
    s.step(f"TRANSITION:{target}", 0.1)
    for v in ("2", "yes", "", " 1 "):
        s.step(f"DEBUG_MODE:{v}", 0.05)
    s.step("DEBUG_MODE:true", 0.1)
    s.step(f"TRANSITION:{target}", 0.8 if target != m.fire else 1.0)
    s.step("DEBUG_MODE:false", 0.1)
    back = sorted(x for x in m.order if x not in m.allowed.get(s.current_state(), ()))[
        :1
    ]
    if back:
        s.step(f"TRANSITION:{back[0]}", 0.1)
    for dyn in sorted(m.dynamic):
        s.step("DEBUG_MODE:1", 0.05)
        s.step(f"TRANSITION:{dyn}", 0.2)
        s.step("DEBUG_MODE:0", 0.05)
    return s.finish()


def s_malformed(run, profile):
    s = Session(run, f"{profile}/malformed")
    cfg = s.config(profile)
    s.start(cfg)
    time.sleep(0.4)
    for c in (
        "RELOAD_CONFIG",
        "RELOAD_CONFIG:1",
        "FOO",
        "transition:Armed",
        "TRANSITION:",
        "TRANSITION:   ",
        "TRANSITION:No Such State",
        "TRANSITION:armed",
        "TRANSITION:Armed:abc",
        "TRANSITION:Armed:0",
        "TRANSITION:Armed:-5",
        "TRANSITION:Armed:99999999999",
        "EXTEND_FIRE",
        "EXTEND_FIRE:1",
        "SCRIPTS:1",
        "DEBUG_MODE",
        "ACTUATOR",
    ):
        s.step(c, 0.03)
    s.scripts()
    s.raw(b"\n\n  \nDEBUG_MODE:0\n", 1, "<blank lines> then DEBUG_MODE:0")
    s.raw(b"DEBUG_MODE:1\r\nDEBUG_MODE:0\r\n", 2, "two CRLF commands in one write")
    s.raw(b"  TRANSITION:Armed  \n", 1, "padded TRANSITION:Armed", 0.6)
    # Oversized: > 512 bytes with no newline drops the connection.
    mark, t_open = s.run.rec.mark(), time.monotonic_ns()
    s.client.sock.sendall(b"X" * 600)
    try:
        r = s.client._line()
    except ConnectionError:
        r = "<connection closed>"
    s._add("600 bytes without a newline", r, mark, t_open, record=False)
    s.client = H.Client(H.SEQ_PORT)
    s.step("DEBUG_MODE:0", 0.05)
    return s.finish()


def s_holds(run):
    s = Session(run, "default/holds")
    cfg = s.config("default")
    s.start(cfg)
    m = s.model
    time.sleep(0.4)
    for c in (
        "TRANSITION:Fire:500",
        "TRANSITION:Armed:500",
        "TRANSITION:Fire:0",
        "TRANSITION:Fire:4294967296",
        "EXTEND_FIRE",
    ):
        s.step(c, 0.05)
    s.nav("Ready")
    s.step("TRANSITION:Fire", 0.2)
    s.step("EXTEND_FIRE", 0.1)
    s.step("EXTEND_FIRE", 2.0)
    s.step("EXTEND_FIRE", 0.1)
    assert m.fire == "Fire"
    return s.finish()


def s_fire(run, name, seq_over=None, ctl_over=None, controller=True, extend=False):
    """Ready -> Fire with controller_service on the fire port (or not)."""
    s = Session(run, f"default/{name}")
    cfg = s.config("default", seq_over)
    if controller:
        s.start_controller(s.controller_config("default", ctl_over))
    s.start(cfg)
    time.sleep(0.4)
    s.nav("Ready")
    s.step("TRANSITION:Fire", summary=True)
    s.settle(min_wait=0.6)
    return s.finish()


def s_controller_direct(run, name, profile="default", ctl_over=None):
    s = Session(run, f"controller/{name}")
    s.config(profile)
    s.rec_mark = run.rec.mark()
    s.el_mark = run.el.mark()
    s.boundaries = [(time.monotonic_ns(), "-")]
    s.start_controller(s.controller_config(profile, ctl_over))
    time.sleep(0.3)
    for payload, label, wait in (
        (b"FIRE_START\n", "FIRE_START", 0.6),
        (b"FIRE_START\n", "FIRE_START (again)", 0.2),
        (b"FIRE_STOP\n", "FIRE_STOP", 0.2),
        (b"FIRE_STOP\n", "FIRE_STOP (again)", 0.2),
        (b"BOGUS\n", "BOGUS", 0.05),
        (b"\n", "<empty line>", 0.05),
        (b"FIRE_START\r\n", "FIRE_START<CRLF>", 0.2),
        (b"FIRE_STOP\r\n", "FIRE_STOP<CRLF>", 0.2),
        (b"", "<connect, send nothing, half-close>", 0.05),
        (b"FIRE_ST", "<partial, then half-close>", 0.05),
    ):
        s.ctl_cmd(payload, label, wait)
    return s.finish()


# The concurrent-client cap of the two command ports (sequencer_main.cpp kMaxClients,
# controller_main.cpp kMaxControlClients, both 64; DESIGN-WP8 §7.2 gap 5): with 64 idle
# connections held, the 65th is answered with the busy reply and closed, the service logs it
# once, and once the 64 close a 66th is served. Everything up to the 65th happens inside the
# per-client reader's SO_RCVTIMEO (5 s) counted from the first idle open, or the idle connections
# would be dropped as timeouts before the 65th arrives; the harness refuses to continue if it
# took longer. The log line is frozen as ascii() so its bytes — the controller's U+26A0 U+FE0F
# and two spaces, the em dash U+2014 in both — are explicit in the golden.
CLIENT_CAP = 64


def _hold_idle(port: int, n: int) -> list[socket.socket]:
    """n connections opened and never written to, paced so the accept loop (one accept per 10 ms
    select pass, listen backlog 10 / 4) is never asked to queue a burst."""
    t0 = time.monotonic()
    held = []
    for _ in range(n):
        held.append(socket.create_connection(("127.0.0.1", port), timeout=5))
        time.sleep(0.01)
    time.sleep(
        0.3
    )  # every connection accepted and on its own thread before the next one
    took = time.monotonic() - t0
    if took > 4.0:
        raise RuntimeError(
            f"holding {n} connections took {took:.1f}s; the readers' 5 s SO_RCVTIMEO is near"
        )
    return held


def _read_until_closed(port: int) -> str:
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    got = b""
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            got += chunk
    except socket.timeout:
        return ascii(got) + " (still open after 5 s)"
    finally:
        s.close()
    return ascii(got) + " then closed by the service"


def _busy_log_lines(log: str) -> list[str]:
    lines = [ln for ln in log.splitlines() if "client limit" in ln]
    return [f"-- busy log line(s), exact bytes: x{len(lines)}"] + [
        f"   {ascii(ln)}" for ln in lines
    ]


def s_clients(run, profile="default"):
    s = Session(run, f"{profile}/clients")
    cfg = s.config(profile)
    s.start(cfg)
    time.sleep(0.4)
    # The session's own connection would be one of the 64; hold 64 fresh idle ones instead.
    s.client.close()
    s.client = None
    s.note(f"{CLIENT_CAP} idle connections opened and held", record=False)
    held = _hold_idle(H.SEQ_PORT, CLIENT_CAP)
    mark, t_open = run.rec.mark(), time.monotonic_ns()
    reply = _read_until_closed(H.SEQ_PORT)
    s._add(
        f"connection {CLIENT_CAP + 1}, nothing sent", reply, mark, t_open, record=False
    )
    for h in held:
        h.close()
    # The 64 readers see EOF, return and mark themselves done; the accept loop reaps them before
    # it tests the cap for the next connection (timing assumption, README).
    time.sleep(1.0)
    s.note(f"the {CLIENT_CAP} idle connections closed", record=False)
    s.client = H.Client(H.SEQ_PORT)
    s.step("DEBUG_MODE:0", 0.05)
    text = s.finish()
    return text + "\n".join(_busy_log_lines(s.seq.log_text())) + "\n"


def s_controller_clients(run):
    s = Session(run, "controller/clients")
    s.config("default")
    s.rec_mark = run.rec.mark()
    s.el_mark = run.el.mark()
    s.boundaries = [(time.monotonic_ns(), "-")]
    s.start_controller(s.controller_config("default"))
    time.sleep(0.3)
    s.note(f"{CLIENT_CAP} idle connections opened and held", record=False)
    held = _hold_idle(H.CTL_PORT, CLIENT_CAP)
    mark, t_open = run.rec.mark(), time.monotonic_ns()
    reply = _read_until_closed(H.CTL_PORT)
    s._add(
        f"controller <- connection {CLIENT_CAP + 1}, nothing sent",
        reply,
        mark,
        t_open,
        record=False,
    )
    for h in held:
        h.close()
    time.sleep(1.0)
    s.note(f"the {CLIENT_CAP} idle connections closed", record=False)
    s.ctl_cmd(b"FIRE_STOP\n", f"FIRE_STOP (connection {CLIENT_CAP + 2})", 0.2)
    text = s.finish()
    return text + "\n".join(_busy_log_lines(s.ctl.log_text())) + "\n"


def s_flow(run):
    s = Session(run, "digital-twin/flow")
    cfg = s.config("digital-twin")
    s.start(cfg)
    time.sleep(0.4)
    for c in (
        "TRANSITION:Flow Test:0",
        "TRANSITION:Flow Test:20000",
        "TRANSITION:Ready:500",
        "TRANSITION:Flow Test:abc",
    ):
        s.step(c, 0.05)
    s.nav("Ready")
    s.step("TRANSITION:Flow Test:800", summary=True)  # hold = 800 + 1000 stagger
    s.settle(min_wait=1.9)
    s.step("TRANSITION:Flow Test:800", 0.3)
    s.step("EXTEND_FIRE", 0.05)
    # Leaving early ends the hold, and the gate's staged open never lands.
    s.step("TRANSITION:Ready", summary=True)
    s.settle()
    s.step("TRANSITION:Flow Test", 0.3)  # [flow].duration_ms (600) -> a 1.6 s hold
    s.step("TRANSITION:Flow Test:500", summary=True)  # re-entry restarts the window
    s.settle(min_wait=1.6)
    return s.finish()


def s_aborts(run):
    s = Session(run, "default/aborts")
    cfg = s.config("default")
    s.start(cfg)
    time.sleep(0.4)
    s.nav("Press Standby")
    # An abort's entry cancels a delayed stage of the state being left (C4-3): no Fuel Press
    # +0.2 s stage after Engine Abort, and Engine Abort's own column commands Fuel Press too (it
    # used to skip a role whose stage was pending). One ABORT burst per abort (C1-10).
    s.step("TRANSITION:Fuel Press", 0.05)  # its +0.2 s stage is still pending
    s.step("TRANSITION:Engine Abort", 0.5)
    # abort -> abort: the new column, no second burst, the first abort's ABORT_DONE kept
    s.step("TRANSITION:GSE Abort")
    s.settle(until_type=8)
    s.step("TRANSITION:Emergency Abort", 0.3)
    s.step("TRANSITION:Emergency Abort")  # a self-transition: no burst either
    s.settle(min_wait=1.2)
    s.step("TRANSITION:Idle")  # leaving the aborts clears the latch...
    s.settle()
    s.step("TRANSITION:Emergency Abort")  # ...so the next abort broadcasts, once
    s.settle(until_type=8)
    return s.finish()


def _twin_scripts_cfg(s: Session, overrides=None) -> Path:
    return s.config(
        "digital-twin",
        overrides,
        scripts=_scripts_files(),
        extra=_scripts_toml(),
        csv_edit=_scripts_csv_edit,
    )


def s_scripts_load(run):
    """What the sequencer made of every dynamic state at load, and what entering one costs.

    Entering a state refused at load used to deadlock the command worker whenever Elodin is
    connected (C4-1): doTransitionTo() held config_mutex_ across publishState(), which takes it
    again, and every later command waited out kCommandTimeoutSeconds (10 s) and failed. The
    refusal is now prompt and the worker keeps serving: the TRANSITION:Armed after it is OK (debug
    mode is on), and the abort after that goes out. Each refusal's reason is the SCRIPTS line (the
    reply quotes it).
    """
    s = Session(run, "digital-twin/scripts-load")
    cfg = _twin_scripts_cfg(s)
    s.start(cfg)
    time.sleep(0.4)
    s.scripts()
    s.nav("Press Standby")
    s.step("TRANSITION:Script Seq:500", 0.05)
    s.step("DEBUG_MODE:1", 0.05)
    s.step(
        "TRANSITION:Script Missing", 0.05
    )  # debug mode does not make it enterable...
    t0 = time.monotonic()
    s.step(
        "TRANSITION:Armed", 0.05
    )  # ...and the worker is still serving: a prompt OK, not 10 s and then ERR
    took = time.monotonic() - t0
    # The worker's command timeout is 10 s; a served command takes milliseconds.
    if took > 5.0:
        raise AssertionError(
            f"TRANSITION:Armed after a refused state took {took:.1f} s:"
            " the command worker is wedged (C4-1)"
        )
    s.step("DEBUG_MODE:0", 0.05)
    s.step("TRANSITION:Engine Abort", 0.3)  # and an abort reaches the boards
    return s.finish()


def s_script_run(run, state, wait, then=None):
    s = Session(run, f"digital-twin/script/{state}")
    cfg = _twin_scripts_cfg(s)
    s.start(cfg)
    time.sleep(0.4)
    s.nav("Press Standby")
    if then:
        s.step(f"TRANSITION:{state}", wait)
    else:
        s.step(f"TRANSITION:{state}", summary=True)
        s.settle(min_wait=wait)  # the script's own run, then its landing state settles
    for i, (cmd, w) in enumerate(then or ()):
        if i == len(then) - 1:
            s.step(cmd, summary=True)
            s.settle()
        else:
            s.step(cmd, w)
    return s.finish()


def _pt_tables(log: str) -> dict[str, tuple[int, int]]:
    out = {}
    for m in re.finditer(
        r'\[PressureFeed\] "([^"]+)" -> .*\(table 0x([0-9a-f]+),0x([0-9a-f]+)\)', log
    ):
        out[m.group(1)] = (int(m.group(2), 16), int(m.group(3), 16))
    return out


def s_pressure(run, name, plan):
    """digital-twin's own Dynamic Test (reads High Press and GN2 High) against the fake feed."""
    s = Session(run, f"digital-twin/pressure/{name}")
    cfg = s.config("digital-twin")
    run.el.clear_pressures()
    s.start(cfg)
    time.sleep(0.3)
    tables = _pt_tables(s.seq.log_text())
    s.lines.append(f"# pressure roles subscribed: {', '.join(sorted(tables))}")
    plan(s, tables)
    run.el.clear_pressures()
    return s.finish()


def _p_none(s, tables):
    s.nav("Press Standby")
    s.scripts()
    s.step("TRANSITION:Dynamic Test", 0.3)


def _p_uncal(s, tables):
    for t in tables.values():
        s.run.el.set_pressure(t, 1000.0, cal=0)
    s.nav("Press Standby")
    time.sleep(0.3)
    s.scripts()
    s.step("TRANSITION:Dynamic Test", 0.3)


def _p_run(s, tables):
    s.run.el.set_pressure(tables["High Press"], 1000.0)
    s.run.el.set_pressure(tables["GN2 High"], 500.0)
    s.nav("Press Standby")
    time.sleep(0.3)
    s.scripts()
    s.step("TRANSITION:Dynamic Test", 0.7)
    s.run.el.set_pressure(tables["GN2 High"], 800.0)
    s.note("GN2 High raised to 800 psi (>= 0.7 x High Press)", summary=True)
    s.settle(min_wait=3.0)  # the loop checks again at ~2.9 s, then Press Standby


def _p_stale(s, tables):
    s.run.el.set_pressure(tables["High Press"], 1000.0)
    s.run.el.set_pressure(tables["GN2 High"], 500.0)
    s.nav("Press Standby")
    time.sleep(0.3)
    s.step("TRANSITION:Dynamic Test", 0.6)
    s.run.el.clear_pressures()
    s.note("feed stopped", summary=True)
    s.settle(
        min_wait=3.0
    )  # the next pressure() is at ~2.9 s: stale, so the script fails


def sessions():
    out = []
    for prof in PROFILES:
        out.append((f"{prof}/matrix", lambda r, p=prof: s_matrix(r, p)))
    for prof in PROFILES:
        cfg = tomllib.loads(PROFILES[prof]["config"].read_text())
        for st in cfg["states"]:
            name = st["name"]
            out.append(
                (f"{prof}/entry/{name}", lambda r, p=prof, n=name: s_entry(r, p, n))
            )
    for prof in PROFILES:
        out.append((f"{prof}/actuators", lambda r, p=prof: s_actuators(r, p)))
        out.append((f"{prof}/debug", lambda r, p=prof: s_debug(r, p)))
    out.append(("default/malformed", lambda r: s_malformed(r, "default")))
    out.append(("default/holds", s_holds))
    out.append(("default/aborts", s_aborts))
    out.append(("default/fire-controller", lambda r: s_fire(r, "fire-controller")))
    out.append(
        (
            "default/fire-controller-duty",
            lambda r: s_fire(
                r,
                "fire-controller-duty",
                ctl_over={
                    ("controller", "fallback_fuel_duty_cycle"): "0.1",
                    ("controller", "fallback_ox_duty_cycle"): "0.1",
                },
            ),
        )
    )
    out.append(
        (
            "default/fire-controller-gate-disabled",
            lambda r: s_fire(
                r,
                "fire-controller-gate-disabled",
                ctl_over={("controller_service", "sequencer_owns_valves"): "true"},
            ),
        )
    )
    out.append(
        (
            "default/fire-sequencer-owns-valves",
            lambda r: s_fire(
                r,
                "fire-sequencer-owns-valves",
                seq_over={("controller_service", "sequencer_owns_valves"): "true"},
                ctl_over={("controller_service", "sequencer_owns_valves"): "true"},
            ),
        )
    )
    out.append(("controller/default", lambda r: s_controller_direct(r, "default")))
    out.append(
        (
            "controller/duty",
            lambda r: s_controller_direct(
                r,
                "duty",
                ctl_over={
                    ("controller", "fallback_fuel_duty_cycle"): "0.1",
                    ("controller", "fallback_ox_duty_cycle"): "0.1",
                },
            ),
        )
    )
    out.append(
        (
            "controller/gate-disabled",
            lambda r: s_controller_direct(
                r,
                "gate-disabled",
                ctl_over={("controller_service", "sequencer_owns_valves"): "true"},
            ),
        )
    )
    out.append(
        (
            "controller/unresolved-pwm",
            lambda r: s_controller_direct(
                r,
                "unresolved-pwm",
                profile="digital-twin",
                ctl_over={("controller_service", "sequencer_owns_valves"): "false"},
            ),
        )
    )
    out.append(("default/clients", lambda r: s_clients(r, "default")))
    out.append(("controller/clients", s_controller_clients))
    out.append(("digital-twin/flow", s_flow))
    out.append(("digital-twin/scripts-load", s_scripts_load))
    out.append(
        ("digital-twin/script/Script Seq", lambda r: s_script_run(r, "Script Seq", 0.8))
    )
    out.append(
        ("digital-twin/script/Script End", lambda r: s_script_run(r, "Script End", 0.8))
    )
    out.append(
        (
            "digital-twin/script/Script Timeout",
            lambda r: s_script_run(r, "Script Timeout", 0.9),
        )
    )
    out.append(
        (
            "digital-twin/script/Script Loop",
            lambda r: s_script_run(r, "Script Loop", 0.9),
        )
    )
    out.append(
        (
            "digital-twin/script/Script Long (preempted)",
            lambda r: s_script_run(
                r, "Script Long", 0.3, [("TRANSITION:Press Standby", None)]
            ),
        )
    )
    out.append(
        (
            "digital-twin/script/Script Long (manual override)",
            lambda r: s_script_run(
                r,
                "Script Long",
                0.2,
                [
                    ("DEBUG_MODE:1", 0.05),
                    ("ACTUATOR:Dome CTRL:0", 0.3),
                    ("TRANSITION:Vent", None),
                ],
            ),
        )
    )
    out.append(
        ("digital-twin/pressure/no-feed", lambda r: s_pressure(r, "no-feed", _p_none))
    )
    out.append(
        (
            "digital-twin/pressure/uncalibrated",
            lambda r: s_pressure(r, "uncalibrated", _p_uncal),
        )
    )
    out.append(("digital-twin/pressure/run", lambda r: s_pressure(r, "run", _p_run)))
    out.append(
        ("digital-twin/pressure/stale", lambda r: s_pressure(r, "stale", _p_stale))
    )
    return out


# ── runner ─────────────────────────────────────────────────────────────────────────────────────


def capture_boards() -> set[int]:
    ids = set()
    for p in PROFILES.values():
        ids |= H.board_ids(p["config"].read_text())
    return ids


class Run:
    def __init__(self):
        self.rec = H.Recorder(capture_boards())
        self.el = FakeElodin(H.DB_PORT)

    def close(self):
        self.rec.close()
        self.el.close()


def golden_path(name: str) -> Path:
    return GOLDEN / (_slug(name.replace("/", "__")) + ".txt")


def main() -> int:
    only = os.environ.get("CHAR_SEQ_ONLY")
    update = os.environ.get("CHAR_UPDATE") == "1"
    repeat = int(os.environ.get("CHAR_SEQ_REPEAT", "1"))
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    # Every actuator board gets its own loopback address so the capture names the board. On
    # macOS those need lo0 aliases; without them this suite fails rather than skip.
    missing = H.missing_aliases(capture_boards())
    if missing:
        print(
            "sequencer characterization: FAIL — missing loopback addresses: "
            + " ".join(missing)
        )
        print(
            "  add them (macOS): "
            + "; ".join(f"sudo ifconfig lo0 alias {a} up" for a in missing)
        )
        return 1
    run = Run()
    failures = []
    t_start = time.monotonic()
    selected = [(n, f) for n, f in sessions() if not only or re.search(only, n)]
    try:
        for name, fn in selected:
            t0 = time.monotonic()
            texts = []
            try:
                for i in range(repeat):
                    texts.append(fn(run))
            except Exception:
                traceback.print_exc()
                for svc in list(H.LIVE):
                    svc.stop()
                print(f"  ERROR             {name}", flush=True)
                failures.append(name)
                continue
            text = texts[0]
            (OUT / golden_path(name).name).write_text(text)
            status = "ok"
            for i, other in enumerate(texts[1:], 2):
                if other != text:
                    status = "NONDETERMINISTIC"
                    failures.append(name)
                    (OUT / (golden_path(name).stem + f".run{i}.txt")).write_text(other)
                    sys.stdout.writelines(
                        difflib.unified_diff(
                            text.splitlines(True),
                            other.splitlines(True),
                            "run1",
                            f"run{i}",
                        )
                    )
            gp = golden_path(name)
            if update:
                if status == "ok":
                    GOLDEN.mkdir(exist_ok=True)
                    gp.write_text(text)
                    status = "written"
            elif not gp.exists():
                status = "NO GOLDEN"
                failures.append(name)
            elif gp.read_text() != text:
                status = "DIFF"
                failures.append(name)
                sys.stdout.writelines(
                    difflib.unified_diff(
                        gp.read_text().splitlines(True),
                        text.splitlines(True),
                        f"golden/{gp.name}",
                        "actual",
                    )
                )
            print(f"  {status:<17} {name}  ({time.monotonic() - t0:.1f}s)", flush=True)
    finally:
        run.close()
    if not only:
        known = {golden_path(n).name for n, _ in sessions()}
        for g in sorted(GOLDEN.glob("*.txt")):
            if g.name not in known:
                print(f"  ORPHAN GOLDEN     {g.name}")
                failures.append(g.name)
    print(
        f"sequencer characterization: {len(selected)} session(s) in {time.monotonic() - t_start:.0f}s"
    )
    if failures:
        print("FAILED: " + ", ".join(sorted(set(failures))))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
