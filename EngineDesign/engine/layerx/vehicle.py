"""Which part of a drawing is the vehicle.

A stand drawing can carry its ground support on the same sheet: pid-designer draws the rocket on one
page and the GSE on another, joined only by quick-disconnects paired across the pages
(``options.pairedWith``). The feed twin mates those pairs into one network, because filling the
vehicle is what the GSE is for. Layer X burns the vehicle: its propellant tanks are the tanks that
feed the engine and its pressurant bottle is the bottle that presses them, not a GSE fuel-transfer
tank or a 49 L K-bottle on the cart that happen to hold the same fluids.

The vehicle is everything joined to the engine by a drawn line, walked through any symbol. A paired
disconnect is not a drawn line, so the walk stops at the coupling, which is where the vehicle ends.
A drawing whose GSE is drawn with lines into the vehicle, or that has no GSE, is one piece and the
whole drawing is the vehicle: every drawing that ran before reads exactly as it did.
"""

from __future__ import annotations

import copy
from collections import defaultdict
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Tuple


def vehicle_ids(diagram: Any) -> Optional[FrozenSet[str]]:
    """The ids of every symbol joined to an ENGINE by drawn lines, or None without an engine."""
    engines = [n.id for n in diagram.nodes if n.type in ("ENGINE", "INJECTOR")]
    if not engines:
        return None
    adjacent = defaultdict(set)
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
    # Instruments clipped to a vehicle symbol (an RTD on a tank, a TC on the engine) belong with it.
    for n in diagram.nodes:
        if getattr(n, "attached_to", None) in seen:
            seen.add(n.id)
    return frozenset(seen)


def on_vehicle(nodes: Iterable[Any], vehicle: Optional[FrozenSet[str]]) -> List[Any]:
    """``nodes`` that are on the vehicle; all of them when the drawing has no engine to scope by."""
    nodes = list(nodes)
    return nodes if vehicle is None else [n for n in nodes if n.id in vehicle]


def off_vehicle(nodes: Iterable[Any], vehicle: Optional[FrozenSet[str]]) -> List[Any]:
    """``nodes`` that are ground support (not joined to the engine by a line)."""
    return [] if vehicle is None else [n for n in nodes if n.id not in vehicle]


def vehicle_payload(payload: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """``payload`` cut to the vehicle, and the labels of the ground-support vessels left out.

    Layer X primes the vehicle itself -- the loads, the bottle's fill, the regulator's dome -- which
    is what the GSE is for, and then fires it. Left in, a GSE page mated through its paired
    disconnects keeps working the vehicle during the burn: on LE4 the GSE dome regulator, mated to
    the vehicle's dome line, loaded the press regulator past Layer X's lockup and tripped the LOX
    tank at 802 psig before T-0. Cut, each vehicle-side disconnect half is capped, as a stand with
    its GSE unplugged has it. A drawing that is one piece comes back unchanged (the same object).
    """
    from feedtwin.pid import read_diagram

    diagram = read_diagram(payload, name="vehicle")
    vehicle = vehicle_ids(diagram)
    if vehicle is None or len(vehicle) == len(diagram.nodes):
        return payload, []
    ground = [n.label or n.id for n in diagram.nodes
              if n.id not in vehicle and n.type in ("TANK", "KBOTTLE", "DEWAR")]
    out = copy.deepcopy(payload)
    out["nodes"] = [n for n in out.get("nodes") or [] if isinstance(n, dict) and str(n.get("id")) in vehicle]
    out["edges"] = [e for e in out.get("edges") or [] if isinstance(e, dict)
                    and str(e.get("source")) in vehicle and str(e.get("target")) in vehicle]
    for node in out["nodes"]:
        options = (node.get("data") or {}).get("options")
        if isinstance(options, dict) and str(options.get("pairedWith") or "") not in ("", "none") \
                and str(options["pairedWith"]) not in vehicle:
            options["pairedWith"] = ""   # its mate is ground support: a capped half
    return out, ground
