"""One change list for every Layer X tool that proposes a change: Set point, Hardware, Injector holes.

A tool's answer is a list of changes a person can act on, each saying what moves, from what to
what, on which part of the drawing or the design, where the new number comes from, and what it
costs to make (``cad_impact``). One record per change::

    {"component": "SV-LOX-PRESS", "pid_node_id": "SV_LOX_PRESS", "field": "Cv",
     "before": 1.7, "after": 3.8, "unit": "Cv",
     "provenance": "catalog row vent-solenoid-cv3.8 (estimated): ...",
     "effect": {"mean_thrust_N": +41.2, "of_mean": -0.0011, ...},
     "cad_impact": "new part",
     # and, beyond the required keys:
     "target": "node:SV_LOX_PRESS", "domain": "drawing", "label": "...", "source": "estimated",
     "before_provenance": "...", "catalog": {...} | None, "drill": {...} | None, "note": "..."}

``target`` says where the number lives, and with it which way the change is written:

* ``node:<id>`` / ``edge:<id>`` (domain ``drawing``): a drawing parameter. Never written over the
  drawing: :func:`pid_designer_export` gives a patched copy for pid-designer ("You own the drawing.
  We own what it does", docs/integration/pid-to-feedtwin-handoff.md).
* ``design:<dotted path>`` (domain ``design``): the engine config. Written only on confirmation,
  through ``PUT /api/config?expect_sha256=`` (backend/routers/config.py), which refuses with 409 when
  the live design is no longer the one the change was computed for (:func:`design_write`).
* ``op:<name>`` (domain ``operation``): a stand setting (dome dial, lockup, fill). Nothing is
  written; :func:`settings_patch` fills the Layer X rail.
* ``model:<dotted path>`` (domain ``model``): a fitted model number, not a part (the feed K0).

``effect`` is the change in each graded figure, after minus before, from the *verifying burn* of the
whole list. With more than one change it is the list's combined effect, said so in
``effect_basis``: separating them needs a burn per change, which no tool here pays for.

pid-designer has no import endpoint (lib/stardesign/stardesign/documents.py: create takes a name
only). Its payload is the graph itself, ``{"nodes": [...], "edges": [...]}``, which ``copy`` then
``autosave`` accept; :func:`pid_designer_export` returns that graph, patched, with the steps.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

SCHEMA = "layerx.change-list/1"

CAD_IMPACTS = ("none", "re-drill", "new plate", "new part", "setting only")
DOMAINS = ("operation", "drawing", "design", "model")
#: Where an after-value comes from. The first three are the drawing's own provenances.
SOURCES = ("measured", "manufacturer", "estimated", "solved", "catalog", "fitted", "assumed")

#: The figures a change list reports the effect on: key -> (label, unit). The keys are the
#: tools' burn figures (setpoint.figures).
FIGURES: Dict[str, tuple] = {
    "mean_thrust_N": ("Mean thrust", "N"),
    "thrust_t0_N": ("Thrust at T-0", "N"),
    "peak_thrust_N": ("Peak thrust", "N"),
    "min_thrust_N": ("Lowest thrust", "N"),
    "thrust_spread_pct": ("Thrust spread (peak - lowest) / mean", "%"),
    "total_impulse_Ns": ("Total impulse", "N·s"),
    "burn_time_s": ("Burn time", "s"),
    "of_mean": ("O/F", ""),
    "pc_mean_psia": ("Chamber pressure, mean", "psia"),
    "isp_mean_s": ("Isp, mean", "s"),
    "ox_peak_psia": ("LOX tank peak", "psia"),
    "fuel_peak_psia": ("Fuel tank peak", "psia"),
    "ox_stiffness_min": ("LOX injector ΔP/Pc, lowest", ""),
    "fuel_stiffness_min": ("Fuel injector ΔP/Pc, lowest", ""),
    "copv_spare_psi": ("Bottle over lockup at burnout", "psi"),
    "copv_end_psia": ("Bottle at burnout", "psia"),
    "chug_margin_min": ("Chug margin, lowest", ""),
    "dome_psig": ("Dome dial", "psig"),
    "lockup_psia": ("Tank lockup", "psia"),
}


def change(*, component: str, field: str, before: Any, after: Any, unit: str, provenance: str,
           cad_impact: str, target: str, domain: Optional[str] = None, pid_node_id: Optional[str] = None,
           label: Optional[str] = None, source: Optional[str] = None, before_provenance: Optional[str] = None,
           catalog: Optional[Dict[str, Any]] = None, drill: Optional[Dict[str, Any]] = None,
           note: Optional[str] = None, effect: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """One change record. ``target`` is ``node:``/``edge:``/``design:``/``op:``/``model:`` plus the id."""
    kind = target.split(":", 1)[0]
    domain = domain or {"node": "drawing", "edge": "drawing", "design": "design", "op": "operation",
                        "model": "model"}.get(kind)
    if domain not in DOMAINS:
        raise ValueError(f"change target {target!r}: no domain for {kind!r}")
    if cad_impact not in CAD_IMPACTS:
        raise ValueError(f"cad_impact {cad_impact!r}; expected one of {', '.join(CAD_IMPACTS)}")
    if source is not None and source not in SOURCES:
        raise ValueError(f"source {source!r}; expected one of {', '.join(SOURCES)}")
    if not str(provenance or "").strip():
        raise ValueError(f"{target}.{field}: a changed number needs its provenance")
    if pid_node_id is None and kind in ("node", "edge"):
        pid_node_id = target.split(":", 1)[1]
    return {
        "component": component, "pid_node_id": pid_node_id, "field": field,
        "before": before, "after": after, "unit": unit, "provenance": provenance,
        "effect": dict(effect) if effect else {}, "cad_impact": cad_impact,
        "target": target, "domain": domain, "label": label or f"{component} {field}",
        "source": source, "before_provenance": before_provenance,
        "catalog": catalog, "drill": drill, "note": note,
    }


def effects(before: Optional[Mapping[str, Any]], after: Optional[Mapping[str, Any]],
            keys: Optional[Iterable[str]] = None) -> Dict[str, float]:
    """``{figure: after - before}`` for every figure both burns have as a number."""
    if not before or not after:
        return {}
    out: Dict[str, float] = {}
    for k in (keys or FIGURES):
        a, b = after.get(k), before.get(k)
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) \
                and not isinstance(b, bool):
            out[k] = float(a) - float(b)
    return out


def effect_rows(before: Optional[Mapping[str, Any]], after: Optional[Mapping[str, Any]],
                limits: Optional[Sequence[Mapping[str, Any]]] = None) -> List[Dict[str, Any]]:
    """Each figure before -> after with its change, for the diff's own table."""
    if not after:
        return []
    rows = []
    for k, (label, unit) in FIGURES.items():
        a = after.get(k)
        b = (before or {}).get(k)
        if not isinstance(a, (int, float)) or isinstance(a, bool):
            continue
        rows.append({"key": k, "label": label, "unit": unit, "before": b, "after": a,
                     "delta": (float(a) - float(b)) if isinstance(b, (int, float)) and not isinstance(b, bool) else None})
    if limits:
        bad = [r for r in limits if r.get("grade") == "bad"]
        rows.append({"key": "limits_bad", "label": "Limits broken", "unit": "", "before": None,
                     "after": len(bad), "delta": None, "detail": [r.get("label") for r in bad]})
    return rows


def build(tool: str, changes: List[Dict[str, Any]], *, before: Optional[Mapping[str, Any]] = None,
          after: Optional[Mapping[str, Any]] = None, limits: Optional[Sequence[Mapping[str, Any]]] = None,
          basis: Optional[Dict[str, Any]] = None, notes: Optional[List[str]] = None,
          needs_pid_designer: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """The change list. Each record without its own ``effect`` gets the whole list's, measured from
    the ``before`` burn to the ``after`` (verifying) burn."""
    combined = effects(before, after)
    out_changes = []
    for c in changes:
        c = dict(c)
        if not c.get("effect"):
            c["effect"] = dict(combined)
            c["effect_basis"] = ("this change alone" if len(changes) == 1
                                 else "combined with the other changes in this list")
        out_changes.append(c)
    return {
        "schema": SCHEMA,
        "tool": tool,
        "changes": out_changes,
        "effects": effect_rows(before, after, limits),
        "basis": basis or {},
        "notes": list(notes or []),
        "needs_pid_designer": list(needs_pid_designer or []),
        "counts": {d: sum(1 for c in out_changes if c["domain"] == d) for d in DOMAINS},
    }


# ------------------------------------------------------------------ where each domain goes


def settings_patch(diff: Mapping[str, Any]) -> Dict[str, float]:
    """The operation-domain changes as a Layer X rail patch ("use these settings")."""
    rail = {"op:lockup_psia": "tank_pressure_psia", "op:copv_psig": "copv_pressure_psig"}
    out: Dict[str, float] = {}
    for c in diff.get("changes") or []:
        key = rail.get(c.get("target", ""))
        if key and isinstance(c.get("after"), (int, float)):
            out[key] = float(c["after"])
    return out


def design_write(updates: Optional[Mapping[str, Any]], config_sha256: str) -> Optional[Dict[str, Any]]:
    """The design-domain changes as the one write the server accepts for them: a merge into the
    live design, refused (409) unless the design is still ``config_sha256``. Nothing is written here;
    the UI sends it after the person confirms, with the checkout the route requires."""
    if not updates:
        return None
    if not config_sha256 or len(config_sha256) != 64:
        raise ValueError("a design write needs the sha256 of the design it was computed for")
    return {
        "method": "PUT",
        "path": "/api/config",
        "query": {"expect_sha256": config_sha256},
        "body": copy.deepcopy(dict(updates)),
        "requires_confirmation": True,
        "precondition": "409 when the live design is no longer the one these changes were computed for",
    }


def overrides_of(diff: Mapping[str, Any]) -> List[Any]:
    """The drawing-domain changes as restatements (engine.layerx.measurements.Override)."""
    from engine.layerx.measurements import Override

    out = []
    for c in diff.get("changes") or []:
        if c.get("domain") != "drawing" or not isinstance(c.get("after"), (int, float)):
            continue
        source = c.get("source") if c.get("source") in ("measured", "manufacturer", "estimated") else "estimated"
        out.append(Override(target=c["target"], parameter=c["field"], value=float(c["after"]), unit=c.get("unit") or "",
                            source=str(c["provenance"])[:300], provenance=source))
    return out


def pid_designer_export(payload: Mapping[str, Any], diff: Mapping[str, Any], *, name: str,
                        source: str = "") -> Optional[Dict[str, Any]]:
    """The drawing with the change list's drawing-domain changes written in, in pid-designer's own
    payload shape, or ``None`` when the list changes nothing on the drawing.

    The patched parameters carry ``{value, unit, source, reference}`` exactly as pid-designer stores
    them (measurements.apply_overrides). The source drawing is never touched: the steps copy it
    first and autosave the patched graph into the copy."""
    overrides = overrides_of(diff)
    if not overrides:
        return None
    from engine.layerx.measurements import apply_overrides

    patched, applied, missing = apply_overrides(payload, overrides)
    if missing:
        raise ValueError(f"the drawing has no {', '.join(missing)}: the change list is for another revision")
    return {
        "schema": "pid-designer/diagram",
        "name": name,
        "derived_from": source,
        "nodes": patched.get("nodes") or [],
        "edges": patched.get("edges") or [],
        "layerx": {"changes": [c for c in diff.get("changes") or [] if c.get("domain") == "drawing"],
                   "applied": applied},
        "apply": [
            "POST /api/pid/diagrams/copy {owner, id, name}: a copy of the source drawing you own (and hold)",
            "POST /api/pid/diagrams/{new id}/autosave with this file's {nodes, edges}",
            "Import the copy into Layer X and burn it: its sha256 is then the change list's after-state",
        ],
        "needs_pid_designer": list(diff.get("needs_pid_designer") or []),
    }


def to_json(obj: Mapping[str, Any]) -> str:
    return json.dumps(obj, indent=1, sort_keys=False, default=str)


# ------------------------------------------------------------------ Injector holes


def from_reconcile(result: Mapping[str, Any]) -> Dict[str, Any]:
    """A reconcile result (engine.layerx.reconcile.run_reconcile) as a change list. Its old keys
    stay; this is the same answer in the shared format."""
    upd = result.get("design_update") or {}
    geo_after = ((upd.get("injector") or {}).get("geometry") or {})
    dis_after = upd.get("discharge") or {}
    before = result.get("before") or {}
    out: List[Dict[str, Any]] = []
    names = {"oxidizer": "LOX", "fuel": "Fuel"}
    target = result.get("target") or {}
    grid = [r for r in result.get("drill_grid") or [] if isinstance(r.get("thrust_N"), (int, float))
            and isinstance(r.get("of"), (int, float))]
    pair = None
    if grid and target.get("thrust_N") and target.get("of"):
        # The drill pair nearest the target in thrust and O/F together (each relative), in Forward mode:
        # the nearest drill per side can miss O/F by 3 % (AUDIT 5.3: #51/#53 gave O/F 1.5501 for 1.5).
        pair = min(grid, key=lambda r: abs(r["thrust_N"] / target["thrust_N"] - 1.0) + abs(r["of"] / target["of"] - 1.0))
    for side, word in names.items():
        d0 = before.get("d_O_mm" if side == "oxidizer" else "d_F_mm")
        d1 = (geo_after.get(side) or {}).get("d_jet")
        row = next((r for r in result.get("changes") or [] if r.get("item") == f"{word} orifice diameter"), None)
        if row is not None:
            d0 = row.get("from")
            d1_mm = row.get("to")
        else:
            d1_mm = d1 * 1e3 if isinstance(d1, (int, float)) else None
        if isinstance(d0, (int, float)) and isinstance(d1_mm, (int, float)) and abs(d1_mm - d0) > 1e-6:
            options = (result.get("drill_options") or {}).get(side) or []
            out.append(change(
                component=f"{word} injector orifices", field="d_jet", before=round(d0, 5), after=round(d1_mm, 5),
                unit="mm", target=f"design:injector.geometry.{side}.d_jet", source="solved",
                provenance=("solved: Layer X injector reconcile, holes sized in Forward mode through the drawing's "
                            "fitted feed and burned until they stop moving"),
                cad_impact="re-drill" if d1_mm > d0 else "new plate",
                drill={"options": options,
                       "picked": ({"drill": pair[side], "d_mm": pair["d_O_mm" if side == "oxidizer" else "d_F_mm"],
                                   "pair": {"oxidizer": pair["oxidizer"], "fuel": pair["fuel"]},
                                   "forward": {"thrust_N": pair["thrust_N"], "of": pair["of"]}} if pair else None),
                       "note": "the exact diameter is what was burned; the drill pair is priced in Forward mode only "
                               "(drill_grid), not burned"},
                note=(row or {}).get("fabrication")))
        lod = (dis_after.get(side) or {}).get("orifice_l_over_d")
        lrow = next((r for r in result.get("changes") or [] if r.get("item") == f"{word} passage L/d"), None)
        if lrow is not None and isinstance(lod, (int, float)) and abs(lrow["to"] - lrow["from"]) > 1e-9:
            out.append(change(
                component=f"{word} injector passages", field="orifice_l_over_d", before=round(lrow["from"], 4),
                after=round(lod, 4), unit="", target=f"design:discharge.{side}.orifice_l_over_d", source="solved",
                provenance="follows the hole: the drilled passage keeps its length", cad_impact="none",
                note=lrow.get("fabrication")))
        arow = next((r for r in result.get("changes") or [] if r.get("item") == f"{word} jet angle"), None)
        if arow is not None:
            out.append(change(
                component=f"{word} jets", field="impingement_angle", before=arow["from"], after=arow["to"], unit="deg",
                target=f"design:injector.geometry.{side}.impingement_angle", source="solved",
                provenance="solved: whole-degree angles, included angle held, that keep the spray resultant's tilt",
                cad_impact="new plate"))
    for side, fs in (upd.get("feed_system") or {}).items():
        if isinstance(fs, dict) and "K0" in fs:
            out.append(change(
                component=f"{names.get(side, side)} feed loss", field="K0", before=None, after=fs["K0"], unit="",
                target=f"model:feed_system.{side}.K0", source="fitted",
                provenance=f"fitted to a Layer X burn of the drawing's feed ({(fs.get('derived_from') or {}).get('by', 'feedfit')})",
                cad_impact="none", note="a model number, not a part: it makes Forward mode agree with the drawing"))
    before_burn, after_burn = result.get("before_burn"), result.get("after_burn")
    notes = list(result.get("notes") or [])
    notes.append("Effects are the burned injector's (pass 1 against the last pass); the drill pair is not burned.")
    notes.append("The holes are sized for the target at the T-0 lockup in Forward mode; the regulator's supply-pressure "
                 "effect lifts the burn's mean above it (AUDIT 9.10 5: +0.9 %).")
    sha = str(result.get("config_sha256") or "")
    d = build("reconcile", out, before=before_burn, after=after_burn, notes=notes,
              basis={"config_sha256": sha, "condition": result.get("condition"),
                     "lockup_psia": result.get("lockup_psia"), "target": target})
    d["exports"] = {"design_write": design_write(upd, sha) if len(sha) == 64 else None, "pid_designer": None}
    return d
