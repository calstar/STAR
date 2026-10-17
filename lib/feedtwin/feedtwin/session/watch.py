"""The watcher: laws a correct stand cannot break, checked every tick.

The solver tab says whether the arithmetic closed. This says whether the answer
it closed on is one the world allows -- conservation and equilibrium, not the
sim checked against itself (docs/PHYSICS-BENCHMARK.md). Each check is a thing a
bug has done here:

* **Gas made in a sealed tank.** A tank with no open path to the air gained
  gas from its ullage floor (``TankSim.floored_kg``). The ullage floor did it as a sealed fuel tank
  drained (2026-10-11).
* **A line that never moved.** A converged solve left a branch at the solve's
  starting flow (:data:`feedtwin.solve.steady.INITIAL_FLOW`) to the gram:
  Newton took no step there. A 0.45 psi drain beside a 6,000 psi bottle did.
* **Pressure held against an open path.** A vessel more than a psi off
  atmosphere, with a path to the air that every valve on the drawing leaves
  open, and nothing flowing for two seconds.
* **Liquid from nowhere.** The network delivering liquid to a tank's outlet
  that no tank feeding it sent (``TankSim.refused_kg``): the chamber pushing
  back, or air drawn in through an open main, which one fluid per line cannot
  carry.
* **Not converging**, three ticks running; **at the edge of tolerance**, five
  seconds running above half of it.
* **Mass not accounted for**: what the vessels hold against what crossed the
  boundary, less what the clamps booked.

A flag opens when its condition holds (for as long as the check asks) and
closes when it stops; one flag per episode, not one per tick. Read-only:
nothing here changes a step, and a check that raises is reported as a flag,
never as a stopped stand.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Deque, Iterator

from feedtwin.session.diagnostics import SolverRecord
from feedtwin.session.gauge import ATMOSPHERE, PSI, say
from feedtwin.solve.steady import INITIAL_FLOW

if TYPE_CHECKING:  # pragma: no cover
    from feedtwin.session.core import Session

#: What a sealed tank's floor may add in a tick and still be round-off [kg].
SEALED_GAIN_KG = 1.0e-9
#: Off atmosphere by more than this, with an open path, is held pressure [Pa].
HELD_DP = 1.0 * PSI
#: ...and nothing flowing means less than this at the vessel's node [kg/s].
STILL_FLOW = 1.0e-5
#: ...for this long [s] (a valve slews; a line takes a moment to start).
HELD_FOR_S = 2.0
#: A fixed node within this of atmosphere is the air [Pa].
AIR_BAND = 0.2 * PSI
#: Liquid arriving at an outlet must be at least this to count [kg/s].
LIQUID_IN_MIN = 1.0e-4
#: Unconverged ticks in a row before it is a flag.
UNCONVERGED_TICKS = 3
#: Residual above this share of the tolerance, for :data:`EDGE_FOR_S`.
EDGE_SHARE = 0.5
EDGE_FOR_S = 5.0
#: Mass nobody booked: absolute [kg], plus a share of what moved.
UNEXPLAINED_KG = 1.0e-6
UNEXPLAINED_SHARE = 1.0e-6
#: A flag closes once its condition has been gone this long [s], so a check
#: that holds every other tick is one episode, not twenty.
CLOSE_AFTER_S = 1.0
#: Flags kept per session, newest last.
FLAGS_KEPT = 200

#: What each check is called on the page.
TITLES = {
    "sealed_gain": "Gas made in a sealed tank",
    "stuck_guess": "A line never left the solver's starting guess",
    "held_open": "Pressure held against an open path",
    "liquid_from_nowhere": "Liquid from nowhere",
    "unconverged": "Not converging",
    "edge": "At the edge of the solver's tolerance",
    "unexplained": "Mass not accounted for",
    "watcher": "The watcher itself failed",
}


@dataclass
class Flag:
    """One episode of one check on one thing."""

    check: str
    subject: str
    started: float
    last: float
    detail: str
    open: bool = True

    @property
    def title(self) -> str:
        return TITLES.get(self.check, self.check)

    def to_dict(self) -> dict[str, object]:
        return {
            "check": self.check,
            "title": self.title,
            "subject": self.subject,
            "started": self.started,
            "last": self.last,
            "detail": self.detail,
            "open": self.open,
        }


@dataclass(frozen=True)
class _Seen:
    check: str
    subject: str
    detail: str
    hold: float = 0.0
    """How long the condition must hold before it is a flag [s]."""


class Watcher:
    """Checks a session's tick; keeps its flags."""

    def __init__(self) -> None:
        self.flags: Deque[Flag] = deque(maxlen=FLAGS_KEPT)
        self._open: dict[tuple[str, str], Flag] = {}
        self._since: dict[tuple[str, str], float] = {}
        self._floored: dict[str, float] = {}
        self._refused: dict[str, float] = {}
        self._t: float | None = None
        self._unconverged = 0
        self._edge_since: float | None = None

    @property
    def open_flags(self) -> list[Flag]:
        return [f for f in self.flags if f.open]

    def observe(self, session: "Session", record: SolverRecord) -> None:
        try:
            seen = list(self._checks(session, record))
        except Exception as exc:  # noqa: BLE001 - a watcher never stops a stand
            seen = [_Seen("watcher", "watcher", f"{type(exc).__name__}: {exc}")]
        self._update(record.t, seen)

    # ------------------------------------------------------------------ book

    def _update(self, t: float, seen: list[_Seen]) -> None:
        now = {(s.check, s.subject): s for s in seen}
        for key in list(self._since):
            if key not in now:
                del self._since[key]
        for key, flag in list(self._open.items()):
            if key not in now and t - flag.last >= CLOSE_AFTER_S:
                flag.open = False
                del self._open[key]
        for key, s in now.items():
            since = self._since.setdefault(key, t)
            current = self._open.get(key)
            if current is not None:
                current.last, current.detail = t, s.detail
                continue
            if t - since + 1e-9 < s.hold:
                continue
            flag = Flag(s.check, s.subject, since, t, s.detail)
            self._open[key] = flag
            self.flags.append(flag)

    # ---------------------------------------------------------------- checks

    def _checks(self, session: "Session", record: SolverRecord) -> Iterator[_Seen]:
        net = session.model.built.network
        labels = {n.id: n.label or n.id for n in session.model.diagram.nodes}

        def name(item: str) -> str:
            return labels.get(item) or labels.get(item.split(".")[0]) or item

        flows = session._last_flows
        isolated = session._last_isolated

        # Gas made in a sealed tank.
        for sim in session.tanks.values():
            before = self._floored.get(sim.id, sim.floored_kg)
            self._floored[sim.id] = sim.floored_kg
            made = sim.floored_kg - before
            if sim.sealed and made > SEALED_GAIN_KG:
                yield _Seen(
                    "sealed_gain",
                    sim.label,
                    f"the ullage floor put in {made * 1e3:.3g} g of gas this tick "
                    "with no open path to the air",
                )

        # A line that never moved.
        if record.converged:
            for branch_id, flow in flows.items():
                if branch_id in isolated:
                    continue
                if abs(flow - INITIAL_FLOW) < 1e-15:
                    yield _Seen(
                        "stuck_guess",
                        name(branch_id),
                        "converged with this branch at the solve's 1 g/s "
                        "starting flow: Newton took no step on it",
                    )

        # Pressure held against an open path.
        vessels = {s.ullage_node for s in session.tanks.values()}
        vessels |= {s.outlet_node for s in session.tanks.values()}
        vessels |= {b.node for b in session.bottles.values()}
        dry = session._dry_branches()
        shut_by_valve = frozenset(isolated - dry)
        for sim in session.tanks.values():
            for node, side in ((sim.ullage_node, "gas"), (sim.outlet_node, "liquid")):
                pressure = net.nodes[node].pressure
                if pressure is None or abs(pressure - ATMOSPHERE) <= HELD_DP:
                    continue
                if side == "liquid" and sim.state.liquid_mass <= 1e-3:
                    continue
                drawn = _path_to_air(net, node, shut_by_valve, vessels)
                if drawn is None:
                    continue
                gas_in, gas_out = session._split_at(node, flows)
                if gas_in + gas_out > STILL_FLOW:
                    continue
                solved = _path_to_air(net, node, isolated, vessels)
                cut = [b for b in drawn if b in isolated]
                detail = (
                    f"{say(pressure, 1)} ({(pressure - ATMOSPHERE) / PSI:+.1f} psi "
                    f"off atmosphere) at the {side} side, "
                    f"open to the air through {', '.join(name(b) for b in drawn[:6])}"
                )
                if solved is None and cut:
                    detail += f"; the solve shut {', '.join(name(b) for b in cut)}"
                else:
                    detail += "; nothing flows"
                yield _Seen("held_open", f"{sim.label} ({side})", detail, HELD_FOR_S)

        # Liquid from nowhere: what the network delivered to a tank's outlet
        # that no tank feeding it sent, which the tank refused.
        for sim in session.tanks.values():
            before = self._refused.get(sim.id, sim.refused_kg)
            self._refused[sim.id] = sim.refused_kg
            dt = record.t - self._t if self._t is not None else 0.0
            rate = (sim.refused_kg - before) / dt if dt > 0.0 else 0.0
            if rate > LIQUID_IN_MIN:
                yield _Seen(
                    "liquid_from_nowhere",
                    sim.label,
                    f"the network sent {rate * 1e3:.3g} g/s into its outlet that no "
                    "tank gave; refused, and booked as a clamp",
                )
        self._t = record.t

        # Not converging; at the edge.
        self._unconverged = 0 if record.converged else self._unconverged + 1
        if self._unconverged >= UNCONVERGED_TICKS:
            yield _Seen(
                "unconverged",
                "network",
                f"{self._unconverged} ticks in a row; residual {record.residual:.2e}",
            )
        tol = float(getattr(session.setup, "network_tolerance", 0.0) or 0.0)
        if tol > 0.0 and record.residual > EDGE_SHARE * tol:
            if self._edge_since is None:
                self._edge_since = record.t
        else:
            self._edge_since = None
        if self._edge_since is not None and record.t - self._edge_since >= EDGE_FOR_S:
            yield _Seen(
                "edge",
                "network",
                f"residual above {EDGE_SHARE:.0%} of the tolerance ({tol:g}) since "
                f"{self._edge_since:.1f} s; now {record.residual:.2e}",
            )

        # Mass not accounted for.
        unexplained = record.mass_error_kg - record.guard_kg
        scale = max(record.throughput_kg, record.inventory_kg)
        if abs(unexplained) > UNEXPLAINED_KG + UNEXPLAINED_SHARE * scale:
            yield _Seen(
                "unexplained",
                "stand",
                f"{unexplained * 1e3:+.3g} g that no vessel booked and no boundary "
                "carried",
            )


def _path_to_air(
    net: object, start: str, shut: frozenset[str], vessels: set[str]
) -> list[str] | None:
    """The branches of a path from ``start`` to the air (a fixed node at
    atmosphere that is not a vessel), avoiding ``shut`` -- or None."""
    links: dict[str, list[tuple[str, str]]] = {}
    for branch_id, branch in net.branches.items():  # type: ignore[attr-defined]
        if branch_id in shut:
            continue
        links.setdefault(branch.upstream, []).append((branch.downstream, branch_id))
        links.setdefault(branch.downstream, []).append((branch.upstream, branch_id))
    came: dict[str, tuple[str, str]] = {}
    frontier = [start]
    seen = {start}
    while frontier:
        here = frontier.pop(0)
        for there, branch_id in links.get(here, ()):
            if there in seen or there in vessels:
                continue
            seen.add(there)
            came[there] = (here, branch_id)
            node = net.nodes[there]  # type: ignore[attr-defined]
            if node.pressure is not None:
                if abs(node.pressure - ATMOSPHERE) <= AIR_BAND:
                    path = []
                    at = there
                    while at != start:
                        at, branch = came[at]
                        path.append(branch)
                    return path[::-1]
                continue
            frontier.append(there)
    return None
