"""A Layer X run, exported (DATA-CONTRACT 4: ``GET /api/layerx/runs/{id}/export/{fmt}``).

* :func:`to_csv` -- every per-step signal in the result, one row per twin step (``series.t``), one
  column per signal, headed ``name [unit]``. The series, the delivered (replay) columns on the firing
  steps, the replay's own points on their steps, the full network record and every diagnostics
  column that follows the series. Floats are written with ``repr``, so they read back bit for bit.
* :func:`to_parquet` -- the same table as Parquet (pyarrow), each field's unit in its metadata.
* :func:`fea_bundle` -- a zip for structural and thermal analysis: ``pc_t.csv``, ``thrust_t.csv``,
  ``heatflux_xt.csv`` (from the ``axial`` sidecar, when given), ``loads.json`` with the peak loads,
  and ``README.txt`` with units and basis.

Nothing is interpolated onto the twin's grid. A value sampled at a replay point is written on that
point's step and left empty elsewhere: a table must not imply a resolution the model did not have.
A block on its own clock that does not land on the twin's steps is not written to the table;
:func:`columns` returns what was left out, and the Parquet file's metadata lists it
(``columns_skipped``).
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import zipfile
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

PSI = 6894.757293168361

#: Unit of a column by the end of its name (longest match first), then by whole name.
_SUFFIX_UNITS: Tuple[Tuple[str, str], ...] = (
    # Compound suffixes before their tails: "_mm_s" (a recession rate) would otherwise read as "_s".
    ("_MW_m2", "MW/m^2"), ("_kg_m3", "kg/m^3"), ("_m_s2", "m/s^2"), ("_mm_s", "mm/s"), ("_m_s", "m/s"),
    ("_kg_s", "kg/s"),
    ("_psia", "psia"), ("_psig", "psig"), ("_psi", "psi"), ("_pa", "Pa"), ("_Pa", "Pa"), ("_K", "K"),
    ("_kg", "kg"), ("_N", "N"), ("_Ns", "N*s"), ("_hz", "Hz"), ("_Hz", "Hz"), ("_mm", "mm"), ("_m2", "m^2"),
    ("_m3", "m^3"), ("_um", "um"), ("_ms", "ms"), ("_deg", "deg"), ("_cal", "cal"), ("_pct", "%"), ("_J", "J"),
    ("_W", "W"), ("_L", "L"), ("_s", "s"), ("_m", "m"), ("_g", "g0"),
)
_NAME_UNITS = {
    "t": "s", "dt": "s", "mdot": "kg/s", "mdot_O": "kg/s", "mdot_F": "kg/s", "mdot_ox": "kg/s",
    "mdot_fuel": "kg/s", "capacity_mdot": "kg/s", "cstar": "m/s", "cstar_ideal": "m/s", "cstar_actual": "m/s",
    "isp": "s", "Isp": "s", "thrust": "N", "p": "psia", "T": "K",
    "v_ox": "m/s", "v_fuel": "m/s", "omega": "rad/s", "frequency": "Hz", "firing": "bool", "converged": "bool",
    "extrapolated": "bool", "choked": "bool", "wide_open": "bool", "summerfield": "bool", "schmucker": "bool",
    "replay_point": "bool", "in_start": "bool",
}


def unit_of(name: str) -> str:
    """The unit a Layer X key carries, from the repo's naming convention (``*_psia``, ``*_K``, ...);
    ``1`` for a key without a unit suffix, which in this result is a ratio or a fraction (ΔP/Pc,
    O/F, ε, η, margins). Instrument and network columns pass their own unit explicitly."""
    leaf = name.rsplit(".", 1)[-1]
    if leaf in _NAME_UNITS:
        return _NAME_UNITS[leaf]
    for suffix, unit in _SUFFIX_UNITS:
        if leaf.endswith(suffix):
            return unit
    return "1"


def _cell(v: Any) -> Any:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    return None


def _is_column(v: Any, n: int) -> bool:
    return isinstance(v, list) and len(v) == n and all(x is None or isinstance(x, (int, float, bool)) for x in v)


def _walk(prefix: str, block: Any, n: int, out: List[Tuple[str, List[Any], Optional[str]]],
          skipped: List[str], depth: int = 0) -> None:
    """Every per-step list of length ``n`` under ``block``, as ``(dotted name, values, unit)``."""
    if depth > 6:
        return
    if isinstance(block, Mapping):
        for key in sorted(block, key=str):
            if key in ("model", "t", "index"):
                continue
            _walk(f"{prefix}.{key}" if prefix else str(key), block[key], n, out, skipped, depth + 1)
    elif isinstance(block, list) and block and all(isinstance(x, Mapping) for x in block):
        for k, item in enumerate(block):
            tag = str(item.get("id") or item.get("line") or item.get("tank") or k)
            _walk(f"{prefix}.{tag}", item, n, out, skipped, depth + 1)
    elif _is_column(block, n):
        out.append((prefix, [_cell(v) for v in block], None))
    elif isinstance(block, list) and block and all(x is None or isinstance(x, (int, float, bool)) for x in block):
        skipped.append(prefix)


def _place(n: int, rows: Sequence[int], values: Sequence[Any]) -> List[Any]:
    col: List[Any] = [None] * n
    for i, v in zip(rows, values):
        if 0 <= i < n:
            col[i] = _cell(v)
    return col


def _rows_of(times: Sequence[Any], t: Sequence[float], tol: float = 1e-6) -> Optional[List[int]]:
    """The series step of each time, when every time is one of the series' steps; else None."""
    out = []
    j = 0
    for x in times:
        if not isinstance(x, (int, float)):
            return None
        while j < len(t) and t[j] < x - tol:
            j += 1
        if j >= len(t) or abs(t[j] - x) > tol:
            return None
        out.append(j)
    return out


def columns(result: Mapping[str, Any]) -> Tuple[List[Tuple[str, str, List[Any]]], List[str]]:
    """``([(name, unit, values)], skipped)``: the export table, one entry per column, every column as
    long as ``series.t``; and the dotted names of per-point blocks that were not on the twin's steps."""
    series = result.get("series") or {}
    t = [float(v) for v in (series.get("t") or [])]
    n = len(t)
    if n == 0:
        return [], []
    cols: List[Tuple[str, str, List[Any]]] = []
    skipped: List[str] = []

    seen: Dict[str, int] = {}

    def add(name: str, values: List[Any], unit: Optional[str] = None) -> None:
        # One header per column: a second signal of the same name (two diagnostics rows sharing an
        # id) is numbered rather than written over.
        seen[name] = seen.get(name, 0) + 1
        cols.append((name if seen[name] == 1 else f"{name}#{seen[name]}", unit or unit_of(name), values))

    add("t", [_cell(v) for v in t], "s")
    core = ("dt", "firing", "converged", "copv_psia", "copv_mass_kg", "copv_wall_K")
    for key in core:
        if _is_column(series.get(key), n):
            add(key, [_cell(v) for v in series[key]])
    for reg, block in sorted((series.get("regulators") or {}).items()):
        for key in sorted(block):
            if _is_column(block[key], n):
                add(f"regulators.{reg}.{key}", [_cell(v) for v in block[key]])
    for iid, inst in sorted((series.get("instruments") or {}).items()):
        if isinstance(inst, Mapping) and _is_column(inst.get("values"), n):
            tag = inst.get("tag") or iid
            add(f"instruments.{iid}.{tag}", [_cell(v) for v in inst["values"]], str(inst.get("unit") or "1"))
    for group in ("ox", "fuel", "chamber"):
        found: List[Tuple[str, List[Any], Optional[str]]] = []
        _walk(group, series.get(group) or {}, n, found, skipped)
        for name, values, unit in found:
            add(name, values, unit)
    rest = [k for k in sorted(series) if k not in ("t", "regulators", "instruments", "ox", "fuel", "chamber") + core]
    for key in rest:
        found = []
        _walk(key, series[key], n, found, skipped)
        for name, values, unit in found:
            add(name, values, unit)

    # The replay's answers on the firing steps (delivered) and at its own points (replay).
    firing = [i for i, f in enumerate(series.get("firing") or []) if f]
    dv = result.get("delivered")
    if isinstance(dv, Mapping) and isinstance(dv.get("t"), list):
        rows = _rows_of(dv["t"], t) or (firing if len(firing) == len(dv["t"]) else None)
        if rows is not None:
            for key in sorted(dv):
                if key in ("t", "summary") or not _is_column(dv[key], len(rows)):
                    continue
                add(f"delivered.{key}", _place(n, rows, dv[key]))
        else:
            skipped.append("delivered")
    rp = result.get("replay")
    if isinstance(rp, Mapping) and rp.get("available") and isinstance(rp.get("index"), list):
        rows = [int(i) for i in rp["index"]]
        for key in sorted(rp):
            if key in ("t", "index", "available") or not _is_column(rp[key], len(rows)):
                continue
            add(f"replay.{key}", _place(n, rows, rp[key]))

    # The full network, per step (DATA-CONTRACT 2).
    net = result.get("network")
    if isinstance(net, Mapping):
        for nid, node in sorted((net.get("nodes") or {}).items()):
            for key in ("p_psia", "T_K"):
                if isinstance(node, Mapping) and _is_column(node.get(key), n):
                    add(f"network.nodes.{nid}.{key}", [_cell(v) for v in node[key]])
        for bid, br in sorted((net.get("branches") or {}).items()):
            for key in ("mdot", "dp_psi", "state"):
                if isinstance(br, Mapping) and _is_column(br.get(key), n):
                    add(f"network.branches.{bid}.{key}", [_cell(v) for v in br[key]],
                        "kg/s" if key == "mdot" else "psi" if key == "dp_psi" else "1")

    # Diagnostics: a block on the series' clock is written as is; one on replay points, by its own
    # ``index`` (series steps) or by times that are series steps; anything else is listed as skipped.
    diag = result.get("diagnostics")
    if isinstance(diag, Mapping):
        for name in sorted(diag):
            block = diag[name]
            if name == "vv" or not isinstance(block, (Mapping, list)):
                continue
            _diagnostic(f"diagnostics.{name}", block, t, add, skipped)
    flight = result.get("flight")
    if isinstance(flight, Mapping) and isinstance(flight.get("stability"), Mapping):
        _diagnostic("flight.stability", flight["stability"], t, add, skipped)
    # Blocks of per-point data the table does not carry, named so the omission is on the record:
    # ``timeseries`` is a copy of ``delivered`` in EngineDesign's Time-Series format and units (the
    # flight curve), ``engine_check``/``cross_check`` are rows of nested comparisons at chosen
    # instants, ``feed_fit`` is a fit, not a history.
    for key in ("timeseries", "engine_check", "cross_check", "feed_fit"):
        if isinstance(result.get(key), Mapping):
            skipped.append(key)
    return cols, sorted(set(skipped))


#: Sub-blocks of a diagnostic that are not histories on the burn's clock (a frequency grid, a lag
#: sweep, a contour, a window, a model's inputs), whatever their lengths happen to be.
NOT_HISTORIES = frozenset({"model", "nyquist", "tau_sweep", "acoustic", "contour", "frames", "soak", "inputs",
                           "worst", "settled_min", "other_basis", "check", "feed", "start", "summary"})


def _diagnostic(prefix: str, block: Any, t: Sequence[float], add: Any, skipped: List[str],
                rows: Optional[List[int]] = None, depth: int = 0) -> None:
    """Write the histories under a diagnostics block. A block carrying its own ``index`` (series
    steps) or ``t`` (times that are series steps) places its lists on those steps, and its children
    inherit that clock; a list on no known clock is listed in ``skipped``."""
    n = len(t)
    if depth > 5:
        return
    if isinstance(block, list):
        if block and all(isinstance(x, Mapping) for x in block):
            for k, item in enumerate(block):
                tag = str(item.get("id") or item.get("line") or item.get("tank") or k)
                _diagnostic(f"{prefix}.{tag}", item, t, add, skipped, rows, depth + 1)
        return
    if not isinstance(block, Mapping):
        return
    own_t, index = block.get("t"), block.get("index")
    if isinstance(index, list) and index and all(isinstance(i, int) and not isinstance(i, bool) for i in index):
        rows = list(index)
    elif isinstance(own_t, list) and own_t:
        rows = _rows_of(own_t, t)
        if rows is None:
            # Its own clock, not the twin's steps: nothing below it can be placed without inventing.
            skipped.append(prefix)
            return
    for key in sorted(block, key=str):
        if key in ("t", "index") or key in NOT_HISTORIES:
            continue
        v = block[key]
        name = f"{prefix}.{key}"
        if isinstance(v, Mapping) or (isinstance(v, list) and v and isinstance(v[0], Mapping)):
            _diagnostic(name, v, t, add, skipped, rows, depth + 1)
            continue
        if not isinstance(v, list) or not v:
            continue
        if isinstance(v[0], list):
            skipped.append(name)                  # a 2-D grid (a sidecar's shape) is not a column
            continue
        if not all(x is None or isinstance(x, (int, float, bool)) for x in v):
            continue
        if rows is not None and len(v) == len(rows):
            add(name, _place(n, rows, v))
        elif rows is None and len(v) == n:
            add(name, [_cell(x) for x in v])
        else:
            skipped.append(name)


# ---------------------------------------------------------------------- CSV and Parquet


def _header(name: str, unit: str) -> str:
    return f"{name} [{unit}]"


def to_csv(result: Mapping[str, Any]) -> str:
    """Every per-step signal as CSV: a header row of ``name [unit]``, then one row per twin step.
    Booleans are 1/0, undefined cells empty, floats ``repr`` (exact)."""
    cols, _ = columns(result)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow([_header(name, unit) for name, unit, _ in cols])
    n = len(cols[0][2]) if cols else 0
    for i in range(n):
        w.writerow(["" if c[2][i] is None else repr(c[2][i]) if isinstance(c[2][i], float) else str(c[2][i])
                    for c in cols])
    return buf.getvalue()


HEADER_RE = re.compile(r"^(?P<name>.*) \[(?P<unit>[^\]]*)\]$")


def read_csv(text: str) -> Dict[str, Tuple[str, List[Optional[float]]]]:
    """:func:`to_csv`'s output back as ``{name: (unit, values)}``: the round trip the tests use and a
    reader for anyone scripting against an export."""
    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return {}
    heads = [HEADER_RE.match(h) for h in rows[0]]
    out: Dict[str, Tuple[str, List[Optional[float]]]] = {}
    for j, m in enumerate(heads):
        name, unit = (m.group("name"), m.group("unit")) if m else (rows[0][j], "")
        out[name] = (unit, [float(r[j]) if r[j] != "" else None for r in rows[1:]])
    return out


def to_parquet(result: Mapping[str, Any]) -> bytes:
    """The CSV's table as Parquet: one float64 column per signal (booleans as 0/1), named as the CSV
    names it without the unit; each field's ``unit`` in its metadata, and the run's identity and the
    skipped blocks in the file's."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    cols, skipped = columns(result)
    fields, arrays = [], []
    for name, unit, values in cols:
        fields.append(pa.field(name, pa.float64(), nullable=True, metadata={"unit": unit}))
        arrays.append(pa.array([None if v is None else float(v) for v in values], type=pa.float64()))
    prov = result.get("provenance") or {}
    meta = {
        "layerx.export": "series table (engine/layerx/export.py)",
        "config_sha256": str(prov.get("config_sha256") or ""),
        "drawing_sha256": str((prov.get("drawing") or {}).get("sha256") or ""),
        "columns_skipped": json.dumps(skipped),
    }
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields, metadata=meta))
    sink = io.BytesIO()
    pq.write_table(table, sink)
    return sink.getvalue()


# ---------------------------------------------------------------------- FEA bundle


def _engine_history(result: Mapping[str, Any], key_delivered: str, key_twin: str) -> Tuple[List[float], List[Optional[float]], str]:
    """``(t, values, source)`` over the firing steps: EngineDesign's delivered values when the run
    has them (the eroding engine), else the twin's own chamber."""
    series = result.get("series") or {}
    t = series.get("t") or []
    fire = [i for i, f in enumerate(series.get("firing") or []) if f]
    dv = result.get("delivered")
    if isinstance(dv, Mapping) and isinstance(dv.get(key_delivered), list) and len(dv[key_delivered]) == len(dv.get("t") or []):
        return ([float(v) for v in dv["t"]], [_cell(v) for v in dv[key_delivered]],
                "EngineDesign time-varying solve (erosion replay), interpolated between its replay points onto the "
                "twin's firing steps")
    col = (series.get("chamber") or {}).get(key_twin) or []
    return ([float(t[i]) for i in fire], [_cell(col[i]) if i < len(col) else None for i in fire],
            "the twin's engine card at the as-built throat (no erosion replay in this run)")


def _peak(t: Sequence[float], v: Sequence[Optional[float]]) -> Optional[Dict[str, float]]:
    pairs = [(x, tt) for tt, x in zip(t, v) if x is not None]
    if not pairs:
        return None
    x, tt = max(pairs)
    return {"value": x, "t": tt}


def _csv(rows: Iterable[Sequence[Any]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    for r in rows:
        w.writerow(["" if v is None else repr(v) if isinstance(v, float) else v for v in r])
    return buf.getvalue()


def _heatflux_rows(side: Mapping[str, Any], qkey: str, tkey: Optional[str]) -> Optional[List[List[Any]]]:
    x, t, q = side.get("x_mm"), side.get("t"), side.get(qkey)
    if not (isinstance(x, list) and isinstance(t, list) and isinstance(q, list) and len(q) == len(t)):
        return None
    temp = side.get(tkey) if tkey else None
    rows: List[List[Any]] = []
    for k, tt in enumerate(t):
        row_q = q[k] if isinstance(q[k], list) else []
        row_T = temp[k] if isinstance(temp, list) and k < len(temp) and isinstance(temp[k], list) else []
        for j, xx in enumerate(x):
            rows.append([_cell(tt), _cell(xx), _cell(row_q[j]) if j < len(row_q) else None,
                         _cell(row_T[j]) if j < len(row_T) else None])
    return rows


def fea_bundle(result: Mapping[str, Any], sidecar: Optional[Mapping[str, Any]] = None) -> bytes:
    """The loads a structural or thermal model needs, as a zip (bytes).

    ``sidecar`` is the run's ``axial`` sidecar (``{x_mm, t, q_MW_m2, T_wall_K}``, rows t, columns x);
    without it there is no ``heatflux_xt.csv`` and ``loads.json`` says so.
    """
    series = result.get("series") or {}
    prov = result.get("provenance") or {}
    t_pc, pc, pc_src = _engine_history(result, "pc_psia", "pc_psia")
    t_f, thrust, f_src = _engine_history(result, "thrust_N", "thrust_N")
    files: Dict[str, str] = {}
    files["pc_t.csv"] = _csv([["t [s]", "pc_psia [psia]", "pc_Pa [Pa]"]]
                             + [[tt, p, p * PSI if p is not None else None] for tt, p in zip(t_pc, pc)])
    files["thrust_t.csv"] = _csv([["t [s]", "thrust_N [N]"]] + [[tt, f] for tt, f in zip(t_f, thrust)])

    loads: Dict[str, Any] = {
        "units": {"t": "s from Fire", "pressure": "psia (absolute) and Pa", "thrust": "N", "heat_flux": "MW/m^2",
                  "temperature": "K", "x": "mm along the chamber axis from the injector face"},
        "chamber_pressure": {"peak": _peak(t_pc, pc), "source": pc_src,
                             "basis": "injector-end chamber pressure, the highest static pressure the chamber wall sees"},
        "thrust": {"peak": _peak(t_f, thrust), "source": f_src},
        "run": {"config_sha256": prov.get("config_sha256"), "drawing": (prov.get("drawing") or {}).get("name"),
                "drawing_sha256": (prov.get("drawing") or {}).get("sha256"), "converged": result.get("converged"),
                "test_mode": result.get("test_mode")},
    }
    if loads["chamber_pressure"]["peak"]:
        loads["chamber_pressure"]["peak"]["value_Pa"] = loads["chamber_pressure"]["peak"]["value"] * PSI
    tanks = {}
    t_all = [float(v) for v in (series.get("t") or [])]
    for side in ("ox", "fuel"):
        col = [_cell(v) for v in ((series.get(side) or {}).get("tank_psia") or [])]
        pk = _peak(t_all, col)
        if pk:
            tanks[side] = {**pk, "unit": "psia", "basis": "ullage pressure over the recorded lead-in and the burn"}
    if tanks:
        loads["tank_pressure"] = tanks
    bottle = _peak(t_all, [_cell(v) for v in (series.get("copv_psia") or [])])
    if bottle:
        loads["bottle_pressure"] = {**bottle, "unit": "psia"}
    wh = ((result.get("diagnostics") or {}).get("water_hammer") or [])
    if isinstance(wh, list) and wh:
        loads["water_hammer"] = [{k: w.get(k) for k in ("line", "side", "closure_s", "peak_psia", "rating_psia")}
                                 for w in wh if isinstance(w, Mapping)]

    heat_rows = _heatflux_rows(sidecar, "q_MW_m2", "T_wall_K") if isinstance(sidecar, Mapping) else None
    if heat_rows is not None:
        files["heatflux_xt.csv"] = _csv([["t [s]", "x_mm [mm]", "q_MW_m2 [MW/m^2]", "T_wall_K [K]"]] + heat_rows)
        live = [r for r in heat_rows if r[2] is not None]
        if live:
            top = max(live, key=lambda r: r[2])
            loads["heat_flux"] = {"peak": {"value": top[2], "t": top[0], "x_mm": top[1]},
                                  "basis": str(sidecar.get("basis") or "the run's axial sidecar")}
        hot = [r for r in heat_rows if r[3] is not None]
        if hot:
            top = max(hot, key=lambda r: r[3])
            loads["wall_temperature"] = {"peak": {"value": top[3], "t": top[0], "x_mm": top[1]}}
        prof = sidecar.get("profile")
        if isinstance(prof, Mapping):
            prof_rows = _heatflux_rows({**prof, "t": sidecar.get("t")}, "q_MW_m2", None)
            if prof_rows is not None:
                files["heatflux_profile_xt.csv"] = _csv([["t [s]", "x_mm [mm]", "q_MW_m2 [MW/m^2]", "T_wall_K [K]"]] + prof_rows)
    else:
        loads["heat_flux"] = {"available": False, "error": "no axial sidecar for this run"}

    files["loads.json"] = json.dumps(loads, indent=2, sort_keys=True, default=lambda o: None)
    files["README.txt"] = _readme(files, pc_src, f_src, sidecar)
    sink = io.BytesIO()
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))   # fixed: the same run zips identically
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[name])
    return sink.getvalue()


def _readme(files: Mapping[str, str], pc_src: str, f_src: str, sidecar: Optional[Mapping[str, Any]]) -> str:
    lines = [
        "Layer X FEA load bundle",
        "",
        "Time is seconds from the Fire command. Pressures are absolute (psia, with Pa alongside where an FEA",
        "deck wants SI); 1 psi = 6894.757293168361 Pa. Thrust in N. Heat flux in MW/m^2, temperatures in K,",
        "axial position x in mm from the injector face along the chamber axis.",
        "",
        "pc_t.csv      chamber pressure at the injector end, on the twin's firing steps. Source: " + pc_src + ".",
        "              The injector-end pressure is ~0.4 % above the nozzle stagnation pressure (Rayleigh loss);",
        "              it is the highest static pressure the chamber wall sees.",
        "thrust_t.csv  thrust on the same steps. Source: " + f_src + ".",
        "              Values between replay points are linear interpolations of EngineDesign solves spaced",
        "              0.10-0.15 s apart: they do not resolve the start or shutdown transient, which is not modelled.",
    ]
    if "heatflux_xt.csv" in files:
        lines += [
            "heatflux_xt.csv  long format, one row per (t, x): net gas-side heat flux at each wall station and",
            "              that station's surface temperature, at the erosion replay's points. Basis: "
            + str((sidecar or {}).get("basis") or "the run's axial sidecar") + ".",
        ]
    if "heatflux_profile_xt.csv" in files:
        lines += [
            "heatflux_profile_xt.csv  the chamber solve's whole-contour flux at one quasi-steady liner surface",
            "              temperature: where the gas loads the wall, not the transient wall (no T_wall column).",
        ]
    lines += [
        "loads.json    peak loads (value and time) with their basis: chamber pressure, thrust, tank and bottle",
        "              pressures, heat flux and wall temperature when the sidecar is present, water hammer when",
        "              diagnosed, and the run's config and drawing hashes.",
        "",
        "These are model outputs. Every input behind them carries its provenance in the run record; read it",
        "before using a number for a margin.",
    ]
    return "\n".join(lines) + "\n"
