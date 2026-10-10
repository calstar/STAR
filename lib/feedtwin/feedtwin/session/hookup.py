"""How a stand's controls reach its drawing: which valve each state-machine
actuator drives, and which knob sets which regulator.

A drawing says what is plumbed; it does not say what the operator's panel
calls it. The DAQ's table commands "LOX Press" and "Fuel Main"; the drawing
has OU_SOL_R and FM-R. The GSE page has a hand-loaded regulator or three; the
drawing has PR symbols on two pages. Matching those up by name works for most
of a drawing (:func:`feedtwin.session.statemachine.bind`) and fails quietly for
the rest -- a main valve nothing commands, a cart regulator nothing turns.

A :class:`Hookup` is that matching written down, per drawing, by whoever knows
the stand. :func:`suggest` fills it the way the twin always matched -- names,
then what each valve is plumbed to do, and the one dome knob -- so an imported
drawing works at once and the person only has to fix what the names got wrong:

* ``channels``: the DAQ box, written down. Each is one connector on one of the
  DAQ's boards, cabled to one symbol, with the name the DAQ gives it -- the
  role name the console shows and, for a solenoid, the state table's row. That
  is the whole of how the real stand is declared (``[actuator_roles]``: name ->
  board and channel; the table opens names), so a hookup that has channels is
  *wired*: a row drives the valve on the channel of that name, and a row with
  no channel drives nothing. Without channels (``None``) the hookup is the old
  kind and the next field decides.
* ``valves``: actuator -> drawing id, only for what a person pinned. An empty
  id means "this actuator has no valve here". Everything not pinned is matched
  automatically, every time, so a drawing that grows a valve picks it up.
  Ignored once the hookup is wired.
* ``machine``: the stand's own state table when somebody edited it (the
  DAQ's State tab, in the twin); ``None`` is the shipped DAQ table.
* ``knobs``: each a dial on the GSE page and the regulators it sets. A knob on
  a dome loader (the hand-loaded control regulator) sets that loader, and the
  dome follows through it as it always did; on a dome-loaded regulator with no
  loader drawn it sets the dome; on a plain regulator it sets the setpoint. A
  regulator on no knob holds what the drawing says. The knob with id
  :data:`DOME` is the session's ``Setup.dome_psi`` -- the cockpit's dome knob
  and Layer X's lockup solve keep driving it.

Gauge pressures throughout, as on the panel.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping

from feedtwin.session.gauge import psig
from feedtwin.session.model import Model
from feedtwin.session.statemachine import (
    Binding,
    StateMachine,
    bind,
    machine_from_dict,
)

#: Bumped whenever the stored form changes meaning. 2 added the DAQ box
#: (``channels``, ``rows``, ``auto``) and an edited state table; 1 still reads.
SCHEMA = 2
_READS = (1, 2)

#: The knob the session's ``Setup.dome_psi`` drives.
DOME = "dome"

#: The knob the session's ``Setup.copv_target_psi`` drives: what the vehicle's
#: pressurant bottle is charged to. With a fill regulator drawn on the cart it
#: sets that regulator; with none, it is the built-in charge's target. One dial
#: either way.
CHARGE = "charge"

#: Where a hand-loaded regulator's knob starts when the drawing gives it no
#: setting [psig]: the regulator fallback the build fills in (500 psi absolute,
#: feedtwin.pid.network.FALLBACKS), so giving it a knob changes nothing.
UNSET_PSIG = 500.0 - 14.695948775513449


@dataclass(frozen=True, slots=True)
class Knob:
    """One dial on the GSE page, and the regulators it sets."""

    id: str
    label: str
    regulators: tuple[str, ...] = ()
    """Drawing ids of the PR symbols this knob sets."""
    psig: float = 500.0
    """Where it starts [psig]."""
    low: float = 0.0
    high: float = 1000.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "regulators": list(self.regulators),
            "psig": self.psig,
            "low": self.low,
            "high": self.high,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Knob":
        return cls(
            id=str(raw["id"]),
            label=str(raw.get("label") or raw["id"]),
            regulators=tuple(str(r) for r in raw.get("regulators") or ()),
            psig=float(raw.get("psig", 500.0)),
            low=float(raw.get("low", 0.0)),
            high=float(raw.get("high", 1000.0)),
        )


@dataclass(frozen=True, slots=True)
class Channel:
    """One connector on the DAQ box: which board, which connector, the symbol
    its cable goes to, and the name the DAQ gives it. ``board`` is the app's
    word for the board (feed-twin: ``sol12``, ``pt_low``...); the library only
    needs the name and the symbol."""

    board: str
    slot: int
    name: str
    symbol: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "board": self.board,
            "slot": self.slot,
            "name": self.name,
            "symbol": self.symbol,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Channel":
        return cls(
            board=str(raw["board"]),
            slot=int(raw["slot"]),
            name=str(raw.get("name") or "").strip(),
            symbol=str(raw.get("symbol") or ""),
        )


@dataclass(frozen=True, slots=True)
class Hookup:
    """What a person decided about one drawing's controls."""

    valves: Mapping[str, str] = field(default_factory=dict)
    """Pinned actuators: table name -> drawing id ("" = no valve here)."""
    knobs: tuple[Knob, ...] = ()
    aliases: Mapping[str, str] = field(default_factory=dict)
    """What the console calls a valve or transducer, by drawing id (or
    channel id, ``engine.pc``) -- "Chamber pressure" for a PT tagged PC. A
    name only: nothing is bound, solved or recorded by it. Absent, the
    console shows the drawing's own tag. A symbol on a channel goes by the
    channel's name instead (:meth:`names`)."""
    channels: tuple[Channel, ...] | None = None
    """The DAQ box: every connector with a cable on it. ``None``: not wired,
    the old hookup (pins and automatic matching). ``()``: wired, and nothing
    is plugged in -- no row drives anything."""
    rows: Mapping[str, int] = field(default_factory=dict)
    """How many rows of connectors each board shows. The panel's, not the
    stand's; kept so the box looks the same tomorrow."""
    auto: frozenset[str] = frozenset()
    """Rows still matched automatically on a wired hookup: on a stand of the
    rocket alone (:func:`on_vehicle`), the ones whose cable went to the cart,
    which is not there. Empty on anything a person saved."""
    machine: StateMachine | None = None
    """The stand's own state table, when somebody edited it. ``None``: the
    shipped DAQ table."""

    @property
    def wired(self) -> bool:
        return self.channels is not None

    def knob_for(self, regulator: str) -> Knob | None:
        return next((k for k in self.knobs if regulator in k.regulators), None)

    def channel_of(self, symbol: str) -> Channel | None:
        return next((c for c in self.channels or () if c.symbol == symbol), None)

    def names(self) -> dict[str, str]:
        """What the console calls each thing, by drawing id: a symbol on a
        channel by the channel's name, anything else by its alias."""
        return {
            **dict(self.aliases),
            **{c.symbol: c.name for c in self.channels or () if c.symbol},
        }

    def to_dict(self) -> dict[str, Any]:
        """The stored form. A hookup of the old kind -- no box, no edited
        table -- is written exactly as it always was (schema 1), so a run
        recorded before the box existed and one recorded since diff clean."""
        out: dict[str, Any] = {
            "schema": 1,
            "valves": dict(self.valves),
            "knobs": [k.to_dict() for k in self.knobs],
            "aliases": dict(self.aliases),
        }
        if self.channels is not None:
            out["channels"] = [c.to_dict() for c in self.channels]
        if self.rows:
            out["rows"] = dict(self.rows)
        if self.auto:
            out["auto"] = sorted(self.auto)
        if self.machine is not None:
            out["machine"] = self.machine.to_dict()
        if len(out) > 4:
            out["schema"] = SCHEMA
        return out

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Hookup":
        schema = int(raw.get("schema", SCHEMA))
        if schema not in _READS:
            raise ValueError(f"hookup schema {schema}; this feedtwin reads {SCHEMA}")
        knobs = tuple(Knob.from_dict(k) for k in raw.get("knobs") or ())
        ids = [k.id for k in knobs]
        if len(set(ids)) != len(ids):
            raise ValueError("two knobs share an id")
        owned = [r for k in knobs for r in k.regulators]
        if len(set(owned)) != len(owned):
            raise ValueError("a regulator is on two knobs; it can only be set once")
        listed = raw.get("channels")
        channels = (
            None if listed is None else tuple(Channel.from_dict(c) for c in listed)
        )
        _check_channels(channels or ())
        machine_raw = raw.get("machine")
        return cls(
            valves={str(a): str(s or "") for a, s in (raw.get("valves") or {}).items()},
            knobs=knobs,
            aliases={
                str(k): str(v).strip()
                for k, v in (raw.get("aliases") or {}).items()
                if str(v or "").strip()
            },
            channels=channels,
            rows={
                str(board): max(1, int(n))
                for board, n in (raw.get("rows") or {}).items()
            },
            auto=frozenset(str(a) for a in raw.get("auto") or ()),
            machine=machine_from_dict(machine_raw) if machine_raw else None,
        )


def _check_channels(channels: tuple[Channel, ...]) -> None:
    """A box that cannot be: two cables in one connector, one symbol on two
    connectors, a connector with no name or two with the same one (the DAQ
    resolves rows by name, so one of them would be unreachable)."""
    places = [(c.board, c.slot) for c in channels]
    if len(set(places)) != len(places):
        raise ValueError("two cables in one connector")
    if any(c.slot < 1 for c in channels):
        raise ValueError("connectors are numbered from 1")
    symbols = [c.symbol for c in channels]
    if "" in symbols:
        raise ValueError("a connector's cable goes to no symbol")
    if len(set(symbols)) != len(symbols):
        raise ValueError("one symbol on two connectors")
    names = [c.name.casefold() for c in channels]
    if "" in names:
        raise ValueError("a connector has no name")
    if len(set(names)) != len(names):
        twice = sorted({c.name for c in channels if names.count(c.name.casefold()) > 1})
        raise ValueError(f"two connectors are named {', '.join(twice)}")


@dataclass(frozen=True, slots=True)
class RegulatorInfo:
    """A PR symbol on the drawing, as a knob sees it."""

    id: str
    label: str
    kind: str
    """``loader`` (sets another's dome), ``dome`` (dome-loaded, no loader
    drawn) or ``plain`` (a hand-loaded setpoint)."""
    page: str
    drawn_psig: float | None
    """What the drawing sets it to [psig], if it says."""
    signal: str
    """The signal a knob drives (``<label>.dome``); for a loader, the loaded
    regulator's."""


@dataclass(frozen=True, slots=True)
class ValveInfo:
    id: str
    label: str
    page: str
    role: tuple[str, ...]
    """What the topology says it does (``("fuel", "press")``), if it settles it."""


def valves(model: Model) -> list[ValveInfo]:
    """Every valve a state-machine actuator could drive. Hand valves are turned
    by a person on the P&ID, never by the table, so they are not among them."""
    built = model.built
    by_id = {n.id: n for n in model.diagram.nodes}
    out = []
    for sid, signal in built.actuators.items():
        if signal.endswith(".dome") or sid not in by_id or sid in built.hand_valves:
            continue
        node = by_id[sid]
        out.append(
            ValveInfo(
                id=sid,
                label=node.label or sid,
                page=node.page or "Main",
                role=tuple(sorted(built.valve_roles.get(sid, frozenset()))),
            )
        )
    return sorted(out, key=lambda v: (v.page, v.label))


def regulators(model: Model) -> list[RegulatorInfo]:
    """Every regulator on the drawing a knob could set."""
    built = model.built
    loaded = {loader.signal for loader in built.dome_loaders.values()}
    out = []
    for node in model.diagram.nodes:
        if node.type != "PR":
            continue
        if f"{node.label or node.id}.dome" in loaded:
            continue  # its dome comes from the loader drawn on it: turn that
        if node.id in built.dome_loaders:
            kind, signal = "loader", built.dome_loaders[node.id].signal
            param = node.params.get("setpoint")
        elif node.options.get("domeLoaded") == "yes":
            kind, signal = "dome", f"{node.label or node.id}.dome"
            param = node.params.get("dome_pressure")
        else:
            kind, signal = "plain", f"{node.label or node.id}.dome"
            param = node.params.get("setpoint")
        if node.id not in built.dome_loaders and node.id not in built.network.branches:
            continue  # not built: a regulator with nothing plumbed to it
        out.append(
            RegulatorInfo(
                id=node.id,
                label=node.label or node.id,
                kind=kind,
                page=node.page or "Main",
                drawn_psig=psig(param.si) if param is not None else None,
                signal=signal,
            )
        )
    return sorted(out, key=lambda r: (r.page, r.label))


def suggest(
    model: Model, dome_psig: float = 500.0, charge_psig: float = 4500.0
) -> Hookup:
    """The hookup the drawing implies, before anyone writes one down.

    No pinned valves (names and roles decide). The knob :data:`DOME` on every
    dome loader -- or, with none drawn, on the first dome-loaded regulator --
    which is what the session's dome knob always drove. Then a knob for every
    regulator a hand sets: every regulator on the ground support, whatever the
    sheet says (the cart's regulators are turned on the pad), and any other
    the drawing gives no setting at all. The one whose outlet charges the
    vehicle's pressurant bottle is :data:`CHARGE` (the COPV fill), the rest are
    knobs of their own. Every knob starts at the drawing's setting
    (:func:`drawn_settings`); only a regulator the sheet says nothing about
    starts at ``dome_psig``, ``charge_psig`` or where the build left it. A
    drawing of the rocket alone whose regulators all carry their settings gets
    only the dome knob, as before.
    """
    drawn = drawn_settings(model)
    built = model.built
    labels = {n.id: n.label or n.id for n in model.diagram.nodes}
    knobs: list[Knob] = []
    loaders = sorted(built.dome_loaders)
    if loaders:
        owned: tuple[str, ...] = tuple(loaders)
    else:
        first = next(
            (sid for sid, s in built.actuators.items() if s.endswith(".dome")), ""
        )
        owned = (first,) if first else ()
    if owned:
        knobs.append(
            Knob(
                id=DOME,
                label=(
                    "Dome control regulator"
                    if len(owned) != 1
                    else f"Dome control regulator ({labels.get(owned[0], owned[0])})"
                ),
                regulators=owned,
                psig=_first_drawn(drawn, owned, dome_psig),
                low=0.0,
                high=1000.0,
            )
        )
    for regulator in _hand_loaded_regulators(model, set(owned)):
        if _charges_vehicle_bottle(model, regulator):
            if any(k.id == CHARGE for k in knobs):
                continue  # two fill regulators: the second holds its fallback
            knobs.append(
                Knob(
                    id=CHARGE,
                    label=f"COPV fill ({labels.get(regulator, regulator)})",
                    regulators=(regulator,),
                    psig=drawn.get(regulator, charge_psig),
                    low=0.0,
                    high=6000.0,
                )
            )
        else:
            knobs.append(
                Knob(
                    id=regulator,
                    label=labels.get(regulator, regulator),
                    regulators=(regulator,),
                    psig=drawn.get(regulator, UNSET_PSIG),
                    low=0.0,
                    high=max(1000.0, 2.0 * drawn.get(regulator, 0.0)),
                )
            )
    return Hookup(knobs=tuple(knobs))


def on_vehicle(saved: Hookup, model: Model) -> Hookup:
    """``saved`` for a stand built on the vehicle alone (``Setup.ignore_gse``):
    the valves a person pinned on the vehicle kept, the knobs the cut drawing
    suggests. The saved knobs turn the cart's regulators, which are not there;
    with the cart's dome loader gone, the dome knob sets the dome-loaded
    regulator itself, as on a drawing of the rocket alone, and the COPV fill
    is the built-in charge's target.
    """
    ids = {n.id for n in model.diagram.nodes}
    knobs = suggest(model).knobs
    kept = {k.id: k for k in saved.knobs}
    channels = saved.channels
    auto = saved.auto
    if channels is not None:
        # A wired hookup keeps the rocket's connectors. A row whose cable went
        # to the cart is matched on the rocket as the old hookup's would be
        # (its vent row finds the tank-top disconnect, the GSE vent); a row
        # with no cable at all stays unwired, as the person left it.
        auto = auto | {c.name for c in channels if c.symbol not in ids}
        channels = tuple(c for c in channels if c.symbol in ids)
    return replace(
        saved,
        valves={a: v for a, v in saved.valves.items() if not v or v in ids},
        # A knob the cut drawing also has starts where the saved one did.
        knobs=tuple(
            (
                replace(k, psig=kept[k.id].psig)
                if k.id in kept and kept[k.id].regulators == k.regulators
                else k
            )
            for k in knobs
        ),
        channels=channels,
        auto=auto,
    )


def drawn_settings(model: Model) -> dict[str, float]:
    """What the drawing sets each regulator to [psig], by drawing id: a
    loader's or plain regulator's ``setpoint``, a dome-loaded one's
    ``dome_pressure``. A regulator the sheet says nothing about is absent."""
    out: dict[str, float] = {}
    for node in model.diagram.nodes:
        if node.type != "PR":
            continue
        key = (
            "dome_pressure"
            if node.options.get("domeLoaded") == "yes"
            and node.id not in model.built.dome_loaders
            else "setpoint"
        )
        param = node.params.get(key)
        if param is not None:
            out[node.id] = psig(param.si)
    return out


def knob_starts(hookup: Hookup, model: Model) -> dict[str, float]:
    """Where each of ``hookup``'s knobs starts on this drawing [psig], by knob
    id: the drawing's setting of the first regulator on it that states one.
    A knob on regulators the sheet says nothing about is absent -- it starts
    at the session's own setting."""
    drawn = drawn_settings(model)
    out: dict[str, float] = {}
    for knob in hookup.knobs:
        found = _first_drawn(drawn, knob.regulators, float("nan"))
        if found == found:
            out[knob.id] = found
    return out


def _first_drawn(
    drawn: Mapping[str, float], regulators: tuple[str, ...], default: float
) -> float:
    return next((drawn[r] for r in regulators if r in drawn), default)


def _hand_loaded_regulators(model: Model, taken: set[str]) -> list[str]:
    """Built regulators a hand sets, not already on a knob: every one on the
    ground support (the cart's regulators are turned on the pad, whatever the
    sheet says they were set to), and any other the drawing gives no setting."""
    built = model.built
    ground = (
        frozenset()
        if built.vehicle is None
        else frozenset(n.id for n in model.diagram.nodes if n.id not in built.vehicle)
    )
    out = []
    for node in model.diagram.nodes:
        if node.type != "PR" or node.id in taken or node.id in built.dome_loaders:
            continue
        if node.options.get("domeLoaded") == "yes":
            continue  # its dome is the dome knob's
        if node.id not in built.network.branches:
            continue
        if {"setpoint", "dome_pressure"} & set(node.params) and node.id not in ground:
            continue
        out.append(node.id)
    return out


def _charges_vehicle_bottle(model: Model, regulator: str) -> bool:
    """Whether a regulator's outlet reaches the vehicle's pressurant bottle:
    through any valve, across mated disconnects, without passing a vessel."""
    built = model.built
    net = built.network
    branch = net.branches.get(regulator)
    if branch is None:
        return False
    types = {n.id: n.type for n in model.diagram.nodes}
    bottles = {
        built.node_of.get(sid, sid)
        for sid, kind in types.items()
        if kind == "KBOTTLE" and (built.vehicle is None or sid in built.vehicle)
    }
    adjacent: dict[str, list[str]] = {}
    for other in net.branches.values():
        if other.id == regulator:
            continue
        adjacent.setdefault(other.upstream, []).append(other.downstream)
        adjacent.setdefault(other.downstream, []).append(other.upstream)
    seen = {branch.downstream}
    frontier = [branch.downstream]
    while frontier:
        here = frontier.pop()
        for there in adjacent.get(here, ()):
            if there in seen:
                continue
            seen.add(there)
            if there in bottles:
                return True
            if net.nodes[there].pressure is not None:
                continue
            frontier.append(there)
    return False


def binding(model: Model, machine: StateMachine, hookup: Hookup | None) -> Binding:
    """The machine bound to the drawing's valves: pins first, then names and
    roles -- or, on a wired hookup, exactly its connectors. There a row drives
    the valve on the connector of its name and nothing else: a row with no
    connector, or one whose cable goes to a symbol that is not a valve here,
    drives nothing (and says so in ``unmatched``) rather than being matched
    behind the person's back. Only the rows in ``auto`` are matched."""
    # Valves only: a regulator's dome signal is a knob's, not the table's.
    built = model.built
    # A valve on the ground-support side answers to "GSE" as well as to its
    # tag: the table says "GSE High Press Control", the cart's drawing says
    # HPC_SOL, and only the page it is on says the rest.
    labels = {
        node.id: (node.label or node.id)
        + (" GSE" if built.vehicle is not None and node.id not in built.vehicle else "")
        for node in model.diagram.nodes
        if node.id in built.actuators
        and not built.actuators[node.id].endswith(".dome")
        and node.id not in built.hand_valves
    }
    overrides: dict[str, str] | None = None
    if hookup is not None and hookup.channels is not None:
        # A connector joins the row of its name as a person reads it: "Lox
        # Main" is the table's "LOX Main". (Names are unique ignoring case on
        # the box and in the table, so this can only find the one row.)
        rows = {a.casefold(): a for a in machine.actuators}
        drawn = {n.id for n in model.diagram.nodes}
        auto = {a.casefold() for a in hookup.auto}
        overrides = {}
        for c in hookup.channels:
            row = rows.get(c.name.casefold())
            if row is None:
                continue
            if c.symbol in labels:
                overrides[row] = c.symbol
            elif c.symbol not in drawn:
                # The drawing lost the symbol the cable went to (redrawn, a
                # new id): matched by name again, as a pin to a lost valve
                # always was -- a main the drawing still has must not go
                # uncommanded because its old id did. The stand says so.
                auto.add(row.casefold())
        free = [
            a
            for a in machine.actuators
            if a not in overrides and a.casefold() not in auto
        ]
        overrides.update({a: "" for a in free})
        stand_ins = _stand_ins(model)
        if stand_ins and free:
            # Rocket only, the cut drawing makes stand-ins of the disconnects
            # that mated the cart (the tank-top GSE vent). The box cannot take
            # one -- on the whole drawing it is not a valve -- so a row the box
            # leaves unwired drives the stand-in the old matching gives it,
            # and nothing else.
            trial = bind(
                machine,
                labels,
                roles=built.valve_roles,
                overrides={k: v for k, v in overrides.items() if k not in free},
            )
            for a in free:
                found = trial.to_symbol.get(a, "")
                if found in stand_ins:
                    overrides[a] = found
    elif hookup is not None:
        overrides = dict(hookup.valves)
    return bind(
        machine,
        labels,
        roles=model.built.valve_roles,
        overrides=overrides,
    )


def _stand_ins(model: Model) -> frozenset[str]:
    """A rocket-only drawing's valves that are not valves on the whole one: a
    disconnect whose mate went with the cart (``meta["capped"]``), read as the
    GSE vent it couples (:func:`feedtwin.pid.network._gse_vents`)."""
    raw = model.meta.get("capped")
    capped = {str(c) for c in raw} if isinstance(raw, (list, tuple)) else set()
    return frozenset(
        n.id
        for n in model.diagram.nodes
        if n.id in capped and n.type == "QD" and n.id in model.built.actuators
    )


def lost_connectors(hookup: Hookup, model: Model) -> list[Channel]:
    """The box's connectors whose cable goes to a symbol the drawing no longer
    has: their rows are matched by name instead, and the stand should say so.
    Give it the whole drawing: on a rocket-only one the cart's connectors are
    cut on purpose (:func:`on_vehicle`)."""
    drawn = {n.id for n in model.diagram.nodes}
    return [c for c in hookup.channels or () if c.symbol not in drawn]
