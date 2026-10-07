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

from feedtwin.pid.document import Diagram

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
