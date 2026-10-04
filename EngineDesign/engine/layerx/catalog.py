"""The catalogues Hardware mode draws from: discrete parts, every row with where it came from.

Hardware mode never sizes a part continuously. It offers what can be bought or drilled, and only
what a row here says exists. Four kinds:

* **drills** -- number drills #40-#70 from ``engine.layerx.reconcile.NUMBER_DRILLS_IN`` (ASME
  B94.11M, *Twist Drills*), the table the injector reconcile already drills from, plus metric drills
  in 0.05 mm steps (``reconcile.METRIC_STEP_MM``, assumed: jobber sets in that range). Built here
  from that table, not re-typed, so the two cannot disagree.
* **valves** (``data/catalog/valves.json``) -- Cv options for solenoids, valves and regulators.
* **tubes** (``data/catalog/tubes.json``) -- bore and wall pairs for lines.
* **bottles** (``data/catalog/bottles.json``) -- pressurant bottles.

The JSON catalogues are seeded only with the parts the team named (the Aqua 1092-50 at Cv 0.8, the
1.7 Cv press solenoid) and what the shipped drawings carry, each row naming the drawing elements
and their own provenance. Nothing is taken from a vendor data sheet this repo does not hold
(docs/layerx/AUDIT.md 9.10 4b: "Hardware mode must wait for cited catalogue data, or it will
invent Cv values, bottle masses and tube ratings"). A person adds rows in
``<userdata>/layerx/catalog/<kind>.json`` (same shape); a user row replaces a shipped row with the
same id.

A row::

    {"id": "press-solenoid-cv1.7", "label": "...", "applies_to": ["SOL"],
     "params": {"Cv": {"value": 1.7, "unit": "Cv"}, "bore": {"value": 6.35, "unit": "mm", "source": "manufacturer"}},
     "source": "measured" | "manufacturer" | "estimated",
     "provenance": "who says so, and where (data sheet, drawing element)"}

A parameter's own ``source`` (optional) wins over the row's, for a row whose numbers do not share
one provenance (the drawn bottle: volume measured, mass and MAWP estimated).

``applies_to`` names drawing component types (``SOL``, ``PR``, ``KBOTTLE``) or ``line`` for an edge.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

SCHEMA = "layerx.catalog/1"
KINDS = ("drills", "valves", "tubes", "bottles")
FILE_KINDS = ("valves", "tubes", "bottles")
SOURCES = ("measured", "manufacturer", "estimated")
SHIPPED_DIR = Path(__file__).resolve().parent / "data" / "catalog"

DRILL_STANDARD = "ASME B94.11M, Twist Drills (number sizes #40-#70)"


def drill_rows(lo_mm: float = 0.5, hi_mm: float = 13.0) -> List[Dict[str, Any]]:
    """Number drills from the reconcile's table and metric drills every 0.05 mm in [lo, hi]."""
    from engine.layerx.reconcile import METRIC_STEP_MM, NUMBER_DRILLS_IN

    rows = [{"id": f"drill-no{no}", "label": f"#{no} drill", "drill": f"#{no}", "applies_to": ["hole", "orifice"],
             "params": {"d": {"value": inch * 25.4, "unit": "mm"}}, "source": "manufacturer",
             "provenance": f"{DRILL_STANDARD}: #{no} = {inch:.4f} in (engine/layerx/reconcile.py NUMBER_DRILLS_IN)"}
            for no, inch in NUMBER_DRILLS_IN.items()]
    k0, k1 = int(math.ceil(lo_mm / METRIC_STEP_MM - 1e-9)), int(math.floor(hi_mm / METRIC_STEP_MM + 1e-9))
    rows += [{"id": f"drill-{k * METRIC_STEP_MM:.2f}mm", "label": f"{k * METRIC_STEP_MM:.2f} mm drill",
              "drill": f"{k * METRIC_STEP_MM:.2f} mm", "applies_to": ["hole", "orifice"],
              "params": {"d": {"value": round(k * METRIC_STEP_MM, 4), "unit": "mm"}}, "source": "estimated",
              "provenance": (f"assumed: metric drills in {METRIC_STEP_MM} mm steps (reconcile.METRIC_STEP_MM, stated "
                             f"there for the small-hole range and carried here to {hi_mm:g} mm for trim plates, "
                             "which can be bored to size): check the size is stocked")}
             for k in range(k0, k1 + 1)]
    return rows


def _check_row(kind: str, row: Mapping[str, Any], where: str) -> Dict[str, Any]:
    if not isinstance(row, Mapping):
        raise ValueError(f"{where}: a {kind} row must be an object")
    rid = str(row.get("id") or "").strip()
    if not rid:
        raise ValueError(f"{where}: a {kind} row needs an id")
    if not str(row.get("provenance") or "").strip():
        raise ValueError(f"{where}: {kind} row {rid!r} has no provenance; a part nobody can source is not offered")
    source = row.get("source")
    if source not in SOURCES:
        raise ValueError(f"{where}: {kind} row {rid!r} source {source!r}; expected one of {', '.join(SOURCES)}")
    params = row.get("params")
    if not isinstance(params, Mapping) or not params:
        raise ValueError(f"{where}: {kind} row {rid!r} states no params")
    for name, p in params.items():
        if not isinstance(p, Mapping) or not isinstance(p.get("value"), (int, float)) or isinstance(p.get("value"), bool) \
                or not math.isfinite(float(p["value"])) or float(p["value"]) <= 0 or not str(p.get("unit") or "").strip():
            raise ValueError(f"{where}: {kind} row {rid!r} param {name!r} needs a positive value and a unit")
        if p.get("source") is not None and p.get("source") not in SOURCES:
            raise ValueError(f"{where}: {kind} row {rid!r} param {name!r} source {p.get('source')!r}; expected one of "
                             f"{', '.join(SOURCES)}")
    applies = row.get("applies_to")
    if not isinstance(applies, list) or not applies:
        raise ValueError(f"{where}: {kind} row {rid!r} says nothing it applies_to")
    return {**dict(row), "id": rid, "origin": where}


def _read(path: Path, kind: str) -> List[Dict[str, Any]]:
    data = json.loads(path.read_text())
    if not isinstance(data, Mapping) or data.get("kind") != kind or not isinstance(data.get("rows"), list):
        raise ValueError(f"{path}: not a {kind} catalogue ({SCHEMA}, kind {kind!r}, rows [...])")
    return [_check_row(kind, r, path.name) for r in data["rows"]]


def user_catalog_dir(user_dir: Optional[Path]) -> Optional[Path]:
    return (Path(user_dir) / "layerx" / "catalog") if user_dir else None


def load_catalogs(user_dir: Optional[Path] = None, shipped_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Every catalogue, shipped rows first and a user's rows over them (by id). A user file that
    does not read is reported in ``problems``, never silently dropped, and the shipped rows stand."""
    shipped = Path(shipped_dir) if shipped_dir else SHIPPED_DIR
    out: Dict[str, Any] = {"drills": drill_rows(), "problems": []}
    udir = user_catalog_dir(user_dir)
    for kind in FILE_KINDS:
        rows: Dict[str, Dict[str, Any]] = {}
        path = shipped / f"{kind}.json"
        if path.is_file():
            for r in _read(path, kind):
                rows[r["id"]] = {**r, "origin": "shipped"}
        if udir is not None and (udir / f"{kind}.json").is_file():
            try:
                for r in _read(udir / f"{kind}.json", kind):
                    rows[r["id"]] = {**r, "origin": "user"}
            except (ValueError, OSError, json.JSONDecodeError) as exc:
                out["problems"].append(f"{kind}: {exc}")
        out[kind] = list(rows.values())
    return out


def rows_for(catalogs: Mapping[str, Any], kind: str, applies: str) -> List[Dict[str, Any]]:
    return [r for r in catalogs.get(kind) or [] if applies in (r.get("applies_to") or [])]


def param_si(row: Mapping[str, Any], name: str) -> Optional[float]:
    """A row parameter in the drawing's own SI-ish units: mm for lengths, L for volume, psi, Cv."""
    p = (row.get("params") or {}).get(name)
    if not isinstance(p, Mapping):
        return None
    v, u = float(p["value"]), str(p.get("unit") or "")
    return v * {"in": 25.4, "m": 1e3, "mm": 1.0}.get(u, 1.0) if u in ("in", "m", "mm") else v


def neighbours(rows: List[Dict[str, Any]], key: str, current: float, n: int) -> List[Dict[str, Any]]:
    """Up to ``n`` rows each side of ``current`` in ``key`` (nearest first, by ratio), never the
    current size itself."""
    scored = [(param_si(r, key), r) for r in rows]
    scored = [(v, r) for v, r in scored if v is not None and v > 0 and abs(v / current - 1.0) > 1e-6]
    below = sorted([s for s in scored if s[0] < current], key=lambda s: current / s[0])[:n]
    above = sorted([s for s in scored if s[0] > current], key=lambda s: s[0] / current)[:n]
    seen, out = set(), []
    for _, r in below + above:
        if r["id"] not in seen:
            seen.add(r["id"])
            out.append(r)
    return out
