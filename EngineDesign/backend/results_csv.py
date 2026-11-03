"""Layer 2/3 optimizer results as the pressure-curve CSV the UI downloads.

Used to be built in the browser (Layer2Optimization / Layer3Optimization
``downloadCSV``), so nothing but an open tab could produce it. Now the backend
writes it (GET /api/optimizer/layer{2,3}/results.csv) and the UI's button fetches
that, so the file is the same whoever asks -- the design-tools MCP included.

The format is unchanged: ``Time (s),LOX Pressure (Pa),Fuel Pressure (Pa)``, one
row per time, numbers written the way JavaScript's ``String(n)`` writes them
(``5`` not ``5.0``, stardesign.jsformat), since that is what the file has always held.
"""

from __future__ import annotations

from typing import Any, Iterable

from stardesign.jsformat import js_number

HEADER = "Time (s),LOX Pressure (Pa),Fuel Pressure (Pa)\n"


def pressure_curves_csv(results: dict[str, Any]) -> str:
    t: Iterable[Any] = results.get("time_array") or []
    lox = results.get("lox_pressure") or []
    fuel = results.get("fuel_pressure") or []
    rows = [HEADER]
    for i, ti in enumerate(t):
        lo = lox[i] if i < len(lox) else None
        fu = fuel[i] if i < len(fuel) else None
        # The browser wrote `undefined` past the end of a short array; say nothing instead.
        rows.append(f"{js_number(ti)},{'' if lo is None else js_number(lo)},{'' if fu is None else js_number(fu)}\n")
    return "".join(rows)
