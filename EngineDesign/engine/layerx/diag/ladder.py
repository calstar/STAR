"""The pressure ladder: bottle to chamber, element by element, per side, at every twin step.

``build_ladder(result, prep=None, config=None)`` reads ``result["network"]`` (DATA-CONTRACT 2) and
returns ``diagnostics.ladder`` (DATA-CONTRACT 3). It is bookkeeping, not a model: every drop is a
difference of the twin's own node pressures, so the elements of one side telescope to the
end-to-end drop by construction. The sum check is still made, on the branches' recorded
``dp_psi`` against the end nodes, because a recorder that writes a component's own loss (static
head left out, say) would break that identity and the ladder should say so rather than hide it.

Conventions (AUDIT 9.6 B1-B4):

* Node pressures only. ``series.copv_psia`` and ``series.*.tank_psia`` are post-step vessel
  states; the network's nodes are the solve's boundaries (1645.6 against 1651.4 psia at burnout
  on the bottle). Mixing the two in one ladder leaves a residual that is not a loss (AUDIT 5.5).
* Liquid-line nodes carry **total** pressure (lumped K, Borda dump at the manifold), so a
  wall-mounted PT reads about one dynamic head lower than the node.
* The tank is its own element: ullage node -> outlet node is the liquid head (a gain, negative).
* The engine card's injector branch (line exit -> chamber) is split, where the series carry the
  split, into the Borda dump at the manifold entrance and the orifice drop (manifold -> chamber).

The helpers at the top (``PSI``, ``arr``, ``out``, ``unavailable``, ``model_block``, ``inp``) are
shared by the other ``engine.layerx.diag`` modules of this set.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

import numpy as np

PSI = 6894.757293168361
"""Pa per psi."""

SIDES = ("ox", "fuel")
"""Network side keys (DATA-CONTRACT 2), which are also ``series`` keys."""

SIDE_ROLE = {"ox": "oxidiser", "fuel": "fuel"}
"""Network side -> ``prep.roles`` / ``derived.species`` key."""

SIDE_CONFIG = {"ox": "oxidizer", "fuel": "fuel"}
"""Network side -> EngineDesign config key (``fluids``, ``discharge``, ``injector.geometry``)."""

SUM_TOLERANCE_PSI = 1e-6
"""Largest |sum of element drops - end-to-end drop| the ladder accepts as closing [psi]. The drops
are differences of the same node values, so anything above float noise is a recorder fault."""


# ---- shared helpers -----------------------------------------------------------------------------

def arr(values: Optional[Iterable[Any]], n: Optional[int] = None) -> np.ndarray:
    """A float array with NaN where the input has None (JSON null) or a non-number."""
    if values is None:
        return np.full(n or 0, np.nan)
    out = []
    for v in values:
        try:
            out.append(float(v) if v is not None else math.nan)
        except (TypeError, ValueError):
            out.append(math.nan)
    a = np.asarray(out, dtype=float)
    if n is not None and a.size != n:
        raise ValueError(f"series of length {a.size}, expected {n}")
    return a


def out(values: Iterable[float], digits: Optional[int] = None) -> List[Optional[float]]:
    """A JSON-safe list: non-finite -> None."""
    res: List[Optional[float]] = []
    for v in values:
        f = float(v)
        if not math.isfinite(f):
            res.append(None)
        else:
            res.append(round(f, digits) if digits is not None else f)
    return res


def scalar(v: Any) -> Optional[float]:
    """A JSON-safe float or None."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def unavailable(error: str) -> Dict[str, Any]:
    """DATA-CONTRACT: a block that could not be computed. It never raises."""
    return {"available": False, "error": str(error)}


def inp(value: Any, unit: str, provenance: str) -> Dict[str, Any]:
    """One entry of a model block's ``inputs``."""
    if isinstance(value, (int, float, np.floating)) and not isinstance(value, bool):
        value = scalar(value)
    return {"value": value, "unit": unit, "provenance": provenance}


def model_block(name: str, source: str, assumptions: Sequence[str],
                inputs: Mapping[str, Dict[str, Any]]) -> Dict[str, Any]:
    """DATA-CONTRACT ``model``: what produced a block, so the run record can list it."""
    return {"name": name, "source": source, "assumptions": list(assumptions), "inputs": dict(inputs)}


def series_t(result: Mapping[str, Any]) -> np.ndarray:
    return arr((result.get("series") or {}).get("t"))


def firing_mask(result: Mapping[str, Any], n: int) -> np.ndarray:
    """``series.firing`` as booleans (all False when absent)."""
    f = (result.get("series") or {}).get("firing")
    if f is None or len(f) != n:
        return np.zeros(n, dtype=bool)
    return np.asarray([bool(x) for x in f], dtype=bool)


def network_of(result: Mapping[str, Any]) -> Mapping[str, Any]:
    """``result["network"]`` checked against ``series.t``; raises ValueError with the reason."""
    net = result.get("network")
    if not isinstance(net, Mapping) or not net.get("nodes") or not net.get("branches"):
        raise ValueError("no feed network was recorded for this run (result.network)")
    t = net.get("t")
    st = (result.get("series") or {}).get("t")
    if t is None or st is None or len(t) != len(st):
        raise ValueError("result.network.t does not follow series.t")
    return net


def node_p(net: Mapping[str, Any], node: str, n: int) -> np.ndarray:
    nd = net["nodes"].get(node)
    if nd is None:
        raise ValueError(f"node {node!r} is not in the recorded network")
    return arr(nd.get("p_psia"), n)


def node_T(net: Mapping[str, Any], node: str, n: int) -> np.ndarray:
    """A node's temperature [K]; NaN where it is missing or not positive (the recorder writes 0.0
    for a node the step's enthalpy walk did not reach)."""
    nd = net["nodes"].get(node)
    if not nd or nd.get("T_K") is None:
        return np.full(n, np.nan)
    T = arr(nd.get("T_K"), n)
    return np.where(T > 0.0, T, np.nan)


def branch_dp(net: Mapping[str, Any], bid: str, n: int) -> np.ndarray:
    """A branch's own drop [psi]: the recorded ``dp_psi``, else from/to node pressures."""
    br = net["branches"][bid]
    if br.get("dp_psi") is not None:
        return arr(br["dp_psi"], n)
    return node_p(net, br["from"], n) - node_p(net, br["to"], n)


# ---- the ladder ---------------------------------------------------------------------------------

def _element(eid: str, label: str, kind: str, dp: np.ndarray, frm: str, to: str) -> Dict[str, Any]:
    return {"id": eid, "label": label, "kind": kind, "from": frm, "to": to, "dp": dp}


def side_elements(net: Mapping[str, Any], side: str, n: int,
                  series_side: Optional[Mapping[str, Any]] = None) -> List[Dict[str, Any]]:
    """The elements along ``net["paths"][side]``, with every gap between consecutive branches
    filled by a vessel element (a tank's liquid head) and the injector branch split into dump and
    orifices when ``series_side`` carries ``dump_psi`` and ``dp_injector_psi``. The orifice
    element's ``check_psi`` is the largest gap between its drop and ``series.*.dp_injector_psi``
    on the steps the series carry one (0 on the card)."""
    path = list((net.get("paths") or {}).get(side) or [])
    if not path:
        raise ValueError(f"no {side} path in result.network.paths")
    nodes, branches = net["nodes"], net["branches"]
    elements: List[Dict[str, Any]] = []
    prev_to: Optional[str] = None
    for bid in path:
        br = branches.get(bid)
        if br is None:
            raise ValueError(f"path {side} names branch {bid!r}, which is not recorded")
        frm, to = br["from"], br["to"]
        if prev_to is not None and frm != prev_to:
            # A vessel between two branches: the gas enters the ullage node, the liquid leaves
            # from the outlet node. Its "drop" is the head of liquid (negative: a gain).
            up, dn = nodes.get(prev_to, {}), nodes.get(frm, {})
            kind = "tank_head" if up.get("kind") == "tank" or dn.get("kind") == "tank_outlet" else "vessel"
            label = f"{up.get('label') or prev_to} head" if kind == "tank_head" else \
                f"{up.get('label') or prev_to} -> {dn.get('label') or frm}"
            elements.append(_element(f"{prev_to}->{frm}", label, kind,
                                     node_p(net, prev_to, n) - node_p(net, frm, n), prev_to, frm))
        dp = branch_dp(net, bid, n)
        kind = str(br.get("kind") or "branch")
        label = str(br.get("label") or bid)
        split = None
        if kind == "injector" and series_side is not None:
            dump, orf = series_side.get("dump_psi"), series_side.get("dp_injector_psi")
            if dump is not None and orf is not None and len(dump) == n and len(orf) == n:
                split = (arr(dump, n), arr(orf, n))
        if split is not None:
            dump, orf_series = split
            # Everything after the dump is the orifices' (manifold node -> chamber node), so the side
            # still telescopes on steps where the series carry no split (before Fire the chamber
            # node sits at ambient and the series hold zeros). Where the series do carry it, the
            # two must agree: the gap is kept as ``check_psi`` on the element.
            orf = dp - dump
            gap = np.where(np.abs(orf_series) > 0.0, orf - orf_series, np.nan)
            elements.append(_element(f"{bid}:dump", f"{label} manifold dump (Borda exit)", "dump",
                                     dump, frm, f"{bid}:manifold"))
            orifice = _element(f"{bid}:orifice", f"{label} orifices (manifold -> chamber)",
                               "orifice", orf, f"{bid}:manifold", to)
            orifice["check_psi"] = scalar(np.nanmax(np.abs(gap))) if np.isfinite(gap).any() else None
            elements.append(orifice)
        else:
            elements.append(_element(bid, label, kind, dp, frm, to))
        prev_to = to
    return elements


def build_ladder(result: Mapping[str, Any], prep: Any = None, config: Any = None) -> Dict[str, Any]:
    """``diagnostics.ladder`` from ``result["network"]``. Never raises.

    Per side: ``elements`` [{id, label, kind, from, to, dp_psi, share}], ``total_psi`` (first node of
    the path minus its last), ``sum_psi`` (the elements added up), ``residual_psi`` and
    ``max_abs_residual_psi`` (sum minus total) and ``closes`` (the residual within
    ``SUM_TOLERANCE_PSI``). ``share`` is each drop over ``total_psi`` (null where the total is 0).
    ``prep`` and ``config`` are not needed; they are accepted for a uniform signature.
    """
    try:
        net = network_of(result)
        t = series_t(result)
        n = t.size
        series = result.get("series") or {}
        block: Dict[str, Any] = {"t": out(t)}
        for side in SIDES:
            if not (net.get("paths") or {}).get(side):
                continue
            els = side_elements(net, side, n, series.get(side))
            start = els[0]["from"]
            end = els[-1]["to"]
            total = node_p(net, start, n) - node_p(net, end, n)
            total_sum = np.zeros(n)
            for e in els:
                total_sum = total_sum + e["dp"]
            residual = total_sum - total
            with np.errstate(divide="ignore", invalid="ignore"):
                shares = [np.where(np.abs(total) > 1e-9, e["dp"] / total, np.nan) for e in els]
            worst = float(np.nanmax(np.abs(residual))) if np.isfinite(residual).any() else math.nan
            block[side] = {
                "start": start,
                "end": end,
                "elements": [{"id": e["id"], "label": e["label"], "kind": e["kind"], "from": e["from"],
                              "to": e["to"], "dp_psi": out(e["dp"]), "share": out(s),
                              **({"check_psi": e["check_psi"]} if "check_psi" in e else {})}
                             for e, s in zip(els, shares)],
                "total_psi": out(total),
                "sum_psi": out(total_sum),
                "residual_psi": out(residual),
                "max_abs_residual_psi": scalar(worst),
                "closes": bool(math.isfinite(worst) and worst <= SUM_TOLERANCE_PSI),
            }
        if not any(s in block for s in SIDES):
            return unavailable("result.network.paths has neither an ox nor a fuel path")
        block["basis"] = ("Differences of the twin's node pressures along each side's path (node values only, "
                          "never vessel states). Liquid-line nodes are total pressure (lumped K; the "
                          "Borda dump at the manifold carries the velocity head). The tank's liquid head is "
                          "its own element (ullage node -> outlet node; negative = gain). The injector "
                          "branch is split into the dump and the orifices from series.*.dump_psi and "
                          "series.*.dp_injector_psi.")
        return block
    except Exception as exc:  # noqa: BLE001 - a diagnostic never takes the burn down
        return unavailable(f"{type(exc).__name__}: {exc}")


def element_series(ladder: Mapping[str, Any], side: str, kind: str) -> List[Dict[str, Any]]:
    """The ladder elements of one ``kind`` on one side (for the regulator/solenoid blocks)."""
    return [e for e in (ladder.get(side) or {}).get("elements", []) if e.get("kind") == kind]
