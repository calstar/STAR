"""Which part of a drawing is the vehicle, and which is the ground support.

pid-designer draws a stand on pages -- the rocket on one, the GSE on another --
joined only by quick-disconnects paired across the pages (``options.pairedWith``).
The twin mates those pairs into one network, because filling the vehicle is what
the GSE is for. But a vessel's *job* depends on which side of the couplings it
sits: a TANK on the vehicle is a load the engine burns, a TANK on the cart is
where a load comes from; a KBOTTLE on the vehicle is the pressurant the burn
spends, a 49 L K-bottle on the cart is delivered full and charges it.

The vehicle is everything joined to the engine by a drawn line, walked through
any symbol. A paired disconnect is not a drawn line, so the walk stops at the
coupling, which is where the vehicle ends. A drawing with no engine, or whose
GSE is drawn with lines into the vehicle, is one piece: the whole drawing is the
vehicle, and every drawing that read before reads exactly as it did.

Shared by the cockpit and Layer X (``EngineDesign/engine/layerx``), so the two
never disagree about which tank is which.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace

from feedtwin.pid.document import Diagram, PidNode

#: Symbols that make an engine end of the vehicle.
ENGINE_TYPES = frozenset({"ENGINE", "INJECTOR"})


def vehicle_ids(diagram: Diagram) -> frozenset[str] | None:
    """Every symbol joined to an ENGINE by drawn lines, or ``None`` without one.

    Instruments clipped to a vehicle symbol (an RTD on a tank, a TC on the
    engine) belong with it.
    """
    engines = [n.id for n in diagram.nodes if n.type in ENGINE_TYPES]
    if not engines:
        return None
    adjacent: dict[str, set[str]] = defaultdict(set)
    for edge in diagram.edges:
        adjacent[edge.source].add(edge.target)
        adjacent[edge.target].add(edge.source)
    seen = set(engines)
    stack = list(engines)
    while stack:
        for other in adjacent[stack.pop()]:
            if other not in seen:
                seen.add(other)
                stack.append(other)
    for node in diagram.nodes:
        if node.attached_to in seen:
            seen.add(node.id)
    return frozenset(seen)


def ground_ids(diagram: Diagram) -> frozenset[str]:
    """Every symbol that is ground support: off the vehicle. Empty for a drawing
    that is one piece (or has no engine to say which piece is the vehicle)."""
    vehicle = vehicle_ids(diagram)
    if vehicle is None or len(vehicle) == len(diagram.nodes):
        return frozenset()
    return frozenset(n.id for n in diagram.nodes if n.id not in vehicle)


#: Symbols :func:`vehicle_only` names when it says what it cut.
VESSEL_TYPES = frozenset({"TANK", "KBOTTLE", "DEWAR"})

#: What makes a branch of the cart a supply rather than a vent: something that
#: holds or sets a pressure, or a further coupling that leads on.
SUPPLY_TYPES = VESSEL_TYPES | frozenset({"PR", "PUMP", "QD"})

#: What a vent line does its job with: a valve the state table opens, a relief,
#: or the outlet itself. A hand valve alone is not one: nobody's table opens
#: it, so a coupling with only that behind it stays capped and the tank keeps
#: the stand-in vent the binding gives a capped tank-top disconnect.
VENTING_TYPES = frozenset({"SOL", "MOV", "ROT", "RV", "VENT"})


def _mate(node: PidNode) -> str:
    mate = str(node.options.get("pairedWith", "") or "").strip()
    return "" if mate == "none" else mate


def vent_branches(diagram: Diagram) -> frozenset[str]:
    """The cart's vent lines: every off-vehicle symbol behind a vehicle
    disconnect whose far side is only a vent.

    The vents sit on the GSE, but they are a small part of it that stays
    plugged into the rocket until the last moment before launch (the team,
    2026-10-10): with the rest of the cart unplugged a tank still vents
    through its own line and valve. A branch is a vent when the walk from the
    mate along drawn lines, off the vehicle, finds a valve or an outlet and
    nothing that holds or sets a pressure (``SUPPLY_TYPES``: a vessel, a
    regulator, another coupling). Instruments clipped to it come with it. A
    coupling with nothing drawn behind it, or only a hand valve, is no vent
    line: it stays capped.
    """
    vehicle = vehicle_ids(diagram)
    if vehicle is None:
        return frozenset()
    by_id = {n.id: n for n in diagram.nodes}
    adjacent: dict[str, set[str]] = defaultdict(set)
    for edge in diagram.edges:
        adjacent[edge.source].add(edge.target)
        adjacent[edge.target].add(edge.source)
    kept: set[str] = set()
    for node in diagram.nodes:
        mate = _mate(node)
        if (
            node.id not in vehicle
            or node.type != "QD"
            or mate not in by_id
            or mate in vehicle
        ):
            continue
        branch = _off_vehicle_branch(mate, vehicle, adjacent, set(by_id))
        types = [by_id[i].type for i in branch if i != mate]
        if any(t in SUPPLY_TYPES for t in types) or not any(
            t in VENTING_TYPES for t in types
        ):
            continue
        kept |= branch
    for node in diagram.nodes:
        if node.attached_to in kept:
            kept.add(node.id)
    return frozenset(kept)


def _off_vehicle_branch(
    start: str, vehicle: frozenset[str], adjacent: dict[str, set[str]], ids: set[str]
) -> set[str]:
    branch = {start}
    stack = [start]
    while stack:
        for other in adjacent[stack.pop()]:
            if other not in branch and other not in vehicle and other in ids:
                branch.add(other)
                stack.append(other)
    return branch


def unpaired_vents(diagram: Diagram) -> list[str]:
    """What to say when the cart draws a vent line whose coupling is paired
    with nothing while the rocket has a coupling paired with nothing: they are
    likely the vent's two halves, and as drawn the vent valve behind the cart's
    half is never reached (the tank vents through the rocket's half as a
    stand-in). Said, not guessed: which half goes with which is the drawing's
    to state (``options.pairedWith`` in pid-designer)."""
    vehicle = vehicle_ids(diagram)
    if vehicle is None:
        return []
    by_id = {n.id: n for n in diagram.nodes}
    adjacent: dict[str, set[str]] = defaultdict(set)
    for edge in diagram.edges:
        adjacent[edge.source].add(edge.target)
        adjacent[edge.target].add(edge.source)
    loose_rocket = sorted(
        n.label or n.id
        for n in diagram.nodes
        if n.type == "QD" and n.id in vehicle and not _mate(n)
    )
    loose_vents: list[str] = []
    for n in diagram.nodes:
        if n.type != "QD" or n.id in vehicle or _mate(n):
            continue
        branch = _off_vehicle_branch(n.id, vehicle, adjacent, set(by_id))
        types = [by_id[i].type for i in branch if i != n.id]
        if any(t in SUPPLY_TYPES for t in types):
            continue
        valves = sorted(
            by_id[i].label or i for i in branch if by_id[i].type in VENTING_TYPES
        )
        if valves:
            loose_vents.append(f"{n.label or n.id} (in front of {', '.join(valves)})")
    if not (loose_rocket and loose_vents):
        return []
    return [
        f"The rocket's {', '.join(loose_rocket)} and the cart's vent coupling "
        f"{'; '.join(sorted(loose_vents))} are paired with nothing. If they are a "
        "vent's two halves, pair them in pid-designer and the tank vents through "
        "the cart's vent valve; as drawn it vents through the rocket's half as a "
        "stand-in."
    ]


def vehicle_only(diagram: Diagram) -> tuple[Diagram, tuple[str, ...]]:
    """The drawing with its ground support cut away, and the labels of the
    vessels that went with it.

    What a stand with its GSE unplugged is: every symbol off the vehicle is
    gone, with every line that touches one, and each vehicle disconnect whose
    mate was cut is a capped half -- which is how a one-page drawing of the
    rocket reads its fill and vent ports. The cart's vent lines stay
    (:func:`vent_branches`): they are plugged into the rocket until launch.
    A drawing that is one piece comes back as the same object, with nothing
    cut.
    """
    vehicle = vehicle_ids(diagram)
    if vehicle is None or len(vehicle) == len(diagram.nodes):
        return diagram, ()
    keep = vehicle | vent_branches(diagram)
    if len(keep) == len(diagram.nodes):
        return diagram, ()
    cut = tuple(
        n.label or n.id
        for n in diagram.nodes
        if n.id not in keep and n.type in VESSEL_TYPES
    )

    def capped(node: PidNode) -> PidNode:
        mate = _mate(node)
        if not mate or mate in keep:
            return node
        return replace(node, options={**node.options, "pairedWith": ""})

    return (
        replace(
            diagram,
            nodes=tuple(capped(n) for n in diagram.nodes if n.id in keep),
            edges=tuple(
                e for e in diagram.edges if e.source in keep and e.target in keep
            ),
        ),
        cut,
    )
