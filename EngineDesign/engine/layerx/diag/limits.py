"""Every limit a Layer X burn is graded against, in one place (DATA-CONTRACT section 1).

Before this module the thresholds lived three times: the UI's ``VERDICT`` and ``verdictItems``
(``frontend/src/components/layerx/format.ts``, ``LayerXResult.tsx``), the optimiser's ``grade``
(``engine/layerx/optimize.py``) and the uncertainty sweep's crossings
(``engine/layerx/uncertainty.py``). They agreed by copy. :data:`THRESHOLDS` holds each number once,
with the reasoning that the UI kept in its hint, and :func:`grade` turns a result into the graded
list the GUI draws as margin bars.

What each entry carries (one dict per limit):

* ``key``, ``label``, ``group`` (stability | injector | tanks | pressurant | propellant | flight |
  hardware | model);
* ``value`` and ``unit``; ``limit`` (the red line) and ``warn`` (the amber edge), either of which
  may be ``None`` when the limit has only one; ``direction`` ``"min"`` (stay above) or ``"max"``
  (stay below);
* ``grade``: ``ok`` | ``warn`` | ``bad`` | ``info``. ``info`` is reported and never counts;
* ``t_worst`` and ``index_worst``: the time [s from Fire] and the ``series`` index of the worst
  point, ``None`` when the quantity is not time-resolved;
* ``series_ref``: the dotted path of its history in the result, for the margin bar to jump to;
* ``basis`` (what the value is computed from) and ``hint`` (one sentence: why this threshold).

A limit whose data is absent from the result is skipped, never guessed. An old saved run therefore
grades exactly as the UI graded it, and a run carrying the new ``diagnostics`` blocks grades them too.

Nothing here burns, solves or reads a file: it reads the result. It never raises on a malformed
block; the entry is skipped and the reason goes in a ``model`` health entry instead.
"""

from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

PSI = 6894.757293168361
"""One psi in pascals."""

#: The threshold for each limit, with what it is. None is a requirement from the config unless it
#: says so; they are judgement, stated so a reader can disagree. Ported from the UI's ``VERDICT``
#: (``format.ts``), ``optimize.grade`` and ``uncertainty.SPARE_PSI``, which agreed.
THRESHOLDS: Dict[str, Dict[str, Any]] = {
    "copv_headroom_psi": {
        "value": 100.0, "unit": "psi",
        "why": "Bottle above tank lockup at burnout: the dome regulator needs supply over its outlet to keep "
               "regulating. Assumed (UI VERDICT.copvHeadroomPsi, optimize dropout_margin_psi, uncertainty "
               "SPARE_PSI); replace with the regulator's measured dropout. Amber at twice it.",
    },
    "droop_psi": {
        "value": (30.0, 60.0), "unit": "psi",
        "why": "Tank droop from lockup while firing: amber, red. Assumed (UI VERDICT.droopPsi).",
    },
    "residual_kg": {
        "value": 0.2, "unit": "kg",
        "why": "Propellant stranded in the other tank above which to look. The team's figure (2026-10-03: "
               "\"if it's within 0.2 kg it's fine\"); about 2 % of the LE4 load.",
    },
    "stiffness_floor": {
        "value": 0.15, "unit": "",
        "why": "Injector dP/Pc floor when the config states no band: a common chug rule of thumb (UI "
               "VERDICT.stiffnessFloor; uncertainty's floor fallback).",
    },
    "chug_margin_red": {
        "value": 1.0, "unit": "",
        "why": "Gain margin 1 is neutral: below it the feed-coupled chug loop is predicted unstable.",
    },
    "chug_margin_amber": {
        "value": 1.2, "unit": "",
        "why": "Judgement (UI VERDICT.chugMarginWarn): the margin rests on an unmeasured mixing-lag band "
               "(AUDIT D7: nominal 2.18 against the gating 1.33) and moves ~0.1 with the feed basis. The "
               "amber edge is max(this, design_requirements.min_stability_margin).",
    },
    "rating_use": {
        "value": 0.8, "unit": "",
        "why": "Peak pressure across a vessel wall, as a fraction of its rating, above which to look. "
               "Judgement (UI VERDICT.ratingUse).",
    },
    "depletion_tie": {
        "value": 0.03, "unit": "",
        "why": "Left-over propellant, as a fraction of the load, under which which tank runs dry first is "
               "inside the orifice Cd's +-3 % scatter (UI VERDICT.depletionTie).",
    },
    "replay_agreement": {
        "value": (0.005, 0.02), "unit": "",
        "why": "Twin against EngineDesign's replay: fine below the first, worth a look below the second, "
               "red above. The card's own fit is ~0.02 % (UI VERDICT.replayAgreement).",
    },
    "summerfield_pe_pa": {
        "value": 0.4, "unit": "",
        "why": "Summerfield criterion: an overexpanded nozzle separates when p_exit/p_ambient falls to ~0.4 "
               "(Sutton & Biblarz, Rocket Propulsion Elements, sec. 3.3; engine/pipeline/handcheck.py).",
    },
    "saturation_margin_psi": {
        "value": (0.0, 25.0), "unit": "psi",
        "why": "Local static pressure over the liquid's vapour pressure: red at 0 (the liquid boils or flashes); "
               "amber under 25 psi, assumed: about one LOX-line dynamic head at full flow (AUDIT 9.6 B4), room for "
               "the transients the twin does not resolve (valve opening, line acoustics). The saturation block's "
               "own flag_margin_psi input, when it states one, sets the amber edge instead.",
    },
    "cavitation_margin": {
        "value": (1.0, 1.2), "unit": "",
        "why": "Injector cavitation number over Nurick's critical value (K/K_crit; Nurick, J. Fluids Eng. 98(4), "
               "1976): red under 1, where the orifice cavitates and its flow is Cc sqrt(K), not the single-phase "
               "Cd the engine card uses, so the burn's flows are not valid there; amber under 1.2, assumed (K_crit "
               "is the model's onset and incipient cavitation appears above it). The cavitation block's own "
               "near_margin input, when it states one, sets the amber edge instead.",
    },
    "conservation_mass_pct": {
        "value": (0.1, 1.0), "unit": "%",
        "why": "Propellant the burn cannot account for (diag/vv.py), amber, red. The recorded flows are end-of-step "
               "samples of a burn the twin integrates on finer sub-steps, so a sound burn sits at that quadrature "
               "error, first order in dt: 0.002-0.004 % on the flown GN2 runs of 2026-10-02, 0.035 % (2 g) on the "
               "LE4 he_pad baseline at dt 0.05 s. Amber at 0.1 % (~11 g on LE4), red at 1 %, the audit's "
               "threshold for a result change that matters (AUDIT 8).",
    },
    "conservation_pressurant_pct": {
        "value": (0.5, 2.0), "unit": "%",
        "why": "Pressurant the burn cannot account for (diag/vv.py), amber, red. The check re-prices each ullage "
               "with CoolProp from the recorded pressure, temperature and fill; it closes to ~1e-12 % on the flown "
               "GN2 runs of 2026-10-02 and 1.6e-7 % on the LE4 he_pad baseline, so its floor is property agreement, "
               "not bookkeeping. Amber at 0.5 % and red at 2 % are assumed (judgement): over three orders of "
               "magnitude above that floor, and below the ~2 % helium compressibility (Z ~ 1.02 at 578 psia, "
               "293 K, CoolProp) that an ideal-gas slip in the bookkeeping would show.",
    },
    "regulator_use": {
        "value": (0.8, 1.0), "unit": "",
        "why": "Regulator flow over its capacity at the seat: amber above 0.8 (judgement: droop grows "
               "steeply near full lift), red at 1 (wide open, the tanks follow the bottle).",
    },
}


# ---------------------------------------------------------------------- small helpers


def _num(v: Any) -> Optional[float]:
    """A finite float, or None."""
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _dig(d: Any, path: str) -> Any:
    for part in path.split("."):
        if not isinstance(d, Mapping):
            return None
        d = d.get(part)
    return d


def _grade(value: Optional[float], limit: Optional[float], warn: Optional[float], direction: str) -> str:
    """ok | warn | bad, strict comparisons (the UI's): equal to the limit is not over it."""
    if value is None:
        return "warn"
    if direction == "min":
        if limit is not None and value < limit:
            return "bad"
        if warn is not None and value < warn:
            return "warn"
        return "ok"
    if limit is not None and value > limit:
        return "bad"
    if warn is not None and value > warn:
        return "warn"
    return "ok"


def _entry(key: str, label: str, group: str, value: Optional[float], unit: str, limit: Optional[float],
           warn: Optional[float], direction: str, grade: str, t_worst: Optional[float],
           index_worst: Optional[int], series_ref: Optional[str], basis: str, hint: str,
           **extra: Any) -> Dict[str, Any]:
    out = {"key": key, "label": label, "group": group, "value": value, "unit": unit, "limit": limit,
           "warn": warn, "direction": direction, "grade": grade, "t_worst": t_worst,
           "index_worst": index_worst, "series_ref": series_ref, "basis": basis, "hint": hint}
    out.update(extra)
    return out


class _Run:
    """Read-only views of a result that every grader needs: the series' clock and its firing steps."""

    def __init__(self, result: Mapping[str, Any]) -> None:
        self.result = result
        self.series = result.get("series") or {}
        self.summary = result.get("summary") or {}
        self.t: List[float] = [float(v) for v in (self.series.get("t") or [])]
        firing = self.series.get("firing") or []
        self.fire = [i for i, f in enumerate(firing) if f]
        # Summary statistics leave out the first 0.2 s on the burn's clock (analysis.reduce_trace).
        self.settled = [i for i in self.fire if self.t[i] >= 0.2] or list(self.fire)

    def at(self, i: Optional[int]) -> Tuple[Optional[float], Optional[int]]:
        if i is None or not 0 <= i < len(self.t):
            return None, None
        return self.t[i], i

    def index_of(self, t: Optional[float]) -> Optional[int]:
        """The series step nearest ``t`` (the step whose end is ``t`` when it is on the grid)."""
        if t is None or not self.t:
            return None
        return min(range(len(self.t)), key=lambda i: abs(self.t[i] - t))

    def column(self, path: str) -> List[Optional[float]]:
        col = _dig(self.series, path)
        return [_num(v) for v in col] if isinstance(col, list) else []

    def argext(self, values: Sequence[Optional[float]], idx: Iterable[int], fn: Any) -> Optional[int]:
        pairs = [(values[i], i) for i in idx if i < len(values) and values[i] is not None]
        if not pairs:
            return None
        return fn(pairs, key=lambda p: p[0])[1]

    def firing_to_series(self, k: Optional[int]) -> Optional[int]:
        """A ``delivered`` index (firing steps only) as a series index."""
        if k is None or not 0 <= k < len(self.fire):
            return None
        return self.fire[k]


def _derived(result: Mapping[str, Any], prep: Any) -> Dict[str, Any]:
    d = _dig(result, "provenance.derived")
    if isinstance(d, Mapping) and d:
        return dict(d)
    return dict(getattr(prep, "derived", None) or {})


def requirements(result: Mapping[str, Any], config: Any = None) -> Dict[str, Any]:
    """The design's ``design_requirements`` as a plain dict: from ``config`` when given, else from
    the YAML the run recorded (``provenance.reproduce.design_yaml``), else empty."""
    req = getattr(config, "design_requirements", None) if config is not None else None
    if req is not None:
        if hasattr(req, "model_dump"):
            return dict(req.model_dump())
        if isinstance(req, Mapping):
            return dict(req)
        return {k: getattr(req, k) for k in dir(req) if not k.startswith("_")}
    text = _dig(result, "provenance.reproduce.design_yaml")
    if isinstance(text, str) and text.strip():
        try:
            import yaml

            doc = yaml.safe_load(text)
            dr = doc.get("design_requirements") if isinstance(doc, dict) else None
            return dict(dr) if isinstance(dr, dict) else {}
        except Exception:  # noqa: BLE001 - an unreadable record grades without the design's caps
            return {}
    return {}


def _defaulted(config: Any) -> frozenset:
    """The ``design_requirements`` keys that hold the schema's default because the design never
    stated them (pydantic's ``model_fields_set``). Such a number has no source, so a limit built on
    it is reported, not graded. Empty when it cannot be told (a plain mapping, or the recorded YAML,
    which holds only what the design stated)."""
    req = getattr(config, "design_requirements", None) if config is not None else None
    fields = getattr(type(req), "model_fields", None) if req is not None else None
    stated = getattr(req, "model_fields_set", None) if req is not None else None
    if not isinstance(fields, Mapping) or stated is None:
        return frozenset()
    return frozenset(k for k in fields if k not in stated)


# ---------------------------------------------------------------------- the graders


def _chug(run: _Run, req: Mapping[str, Any], defaulted: frozenset = frozenset()) -> List[Dict[str, Any]]:
    msm = _num(req.get("min_stability_margin"))
    amber = THRESHOLDS["chug_margin_amber"]["value"]
    warn = max(amber, msm) if msm is not None else amber
    red = THRESHOLDS["chug_margin_red"]["value"]
    said = ("the config schema's default for design_requirements.min_stability_margin, which the design does "
            "not state" if "min_stability_margin" in defaulted else "design_requirements.min_stability_margin")
    why = (f"Below {red:g} the feed-coupled loop is predicted unstable (red). Amber under {warn:g}: "
           + (f"the design requires {msm:g} ({said}), but the amber edge "
              f"stays at {amber:g} or above because the margin rests on an unmeasured mixing-lag band and "
              "moves ~0.1 with the feed basis (AUDIT D7)." if msm is not None else
              "judgement, the margin rests on an unmeasured mixing-lag band (AUDIT D7)."))
    out: List[Dict[str, Any]] = []
    st = _dig(run.result, "diagnostics.stability")
    if isinstance(st, Mapping) and st.get("available", True) is not False and (
            _num(_dig(st, "settled_min.margin")) is not None or _num(_dig(st, "worst.margin")) is not None):
        basis_name = st.get("basis") or "config"
        settled = _num(_dig(st, "settled_min.margin"))
        worst = _num(_dig(st, "worst.margin"))
        if settled is not None:
            value, t, idx = settled, _num(_dig(st, "settled_min.t")), _dig(st, "settled_min.index")
            # The frequency of the point that is graded, not the start window's (AUDIT 5.1: the
            # reported 34.6 Hz was not the gating ~22 Hz).
            freq = _num(_dig(st, "settled_min.frequency_hz"))
            window = _num(st.get("start_window_s"))
            scope = (f"from the first full-flow step (after the first {window:g} s)" if window is not None
                     else "from the first full-flow step")
        else:
            value, t, scope = worst, _num(_dig(st, "worst.t")), "over the whole burn, start included"
            idx = _dig(st, "worst.index")
            freq = _num(_dig(st, "worst.frequency_hz"))
        i = idx if isinstance(idx, int) and 0 <= idx < len(run.t) else run.index_of(t)
        out.append(_entry(
            "chug_margin", "Chug margin", "stability", value, "", red, warn, "min", _grade(value, red, warn, "min"),
            t, i, "diagnostics.stability.margin",
            f"EngineDesign double-time-lag chug model, {basis_name} feed basis, {scope}",
            f"Feed-coupled gain margin, worst over the mixing-lag band. {why}",
            frequency_hz=freq))
        if settled is not None and worst is not None and worst < settled:
            tw = _num(_dig(st, "worst.t"))
            iw = _dig(st, "worst.index")
            out.append(_entry(
                "chug_margin_start", "Chug margin, start window", "stability", worst, "", red, warn, "min", "info",
                tw, iw if isinstance(iw, int) and 0 <= iw < len(run.t) else run.index_of(tw),
                "diagnostics.stability.margin",
                f"EngineDesign double-time-lag chug model, {basis_name} feed basis, inside the start window",
                "Reported, not graded: the start transient (valve ramp, priming, ignition delay) is not modelled "
                "here, and the minimum inside it moves with the time step (AUDIT 5.1, #8).",
                frequency_hz=_num(_dig(st, "worst.frequency_hz"))))
        other = st.get("other_basis")
        if isinstance(other, Mapping) and _num(other.get("margin_min")) is not None:
            to = _num(other.get("t"))
            v = _num(other.get("margin_min"))
            out.append(_entry(
                "chug_margin_other_basis", f"Chug margin, {other.get('basis') or 'other'} basis", "stability", v, "",
                red, warn, "min", "info", to, run.index_of(to),
                "diagnostics.stability.margin_other" if isinstance(st.get("margin_other"), list) else None,
                f"EngineDesign double-time-lag chug model, {other.get('basis') or 'other'} feed basis",
                "The same margin on the other feed basis, for comparison; the graded one is above.",
                frequency_hz=_num(other.get("frequency_hz"))))
        return out
    dv = run.result.get("delivered") or {}
    s = dv.get("summary") or {}
    value = _num(s.get("chug_margin_min"))
    if value is None:
        return out
    t = _num(s.get("chug_margin_min_t"))
    col = [_num(v) for v in (dv.get("chug_margin") or [])]
    k = run.argext(col, range(len(col)), min) if col else None
    i = run.firing_to_series(k) if k is not None else run.index_of(t)
    out.append(_entry(
        "chug_margin", "Chug margin", "stability", value, "", red, warn, "min", _grade(value, red, warn, "min"),
        t, i, "delivered.chug_margin",
        "EngineDesign double-time-lag chug model at the erosion replay's points (config feed basis, A_t and L* "
        "at the design point), interpolated onto the twin's firing steps; lowest over every firing step, the "
        "first included, which lies inside the valve ramp, so the minimum moves with the time step "
        "(AUDIT 5.1, #12)",
        f"Feed-coupled gain margin, worst over the mixing-lag band. {why}"))
    return out


def _stiffness(run: _Run, band: Mapping[str, Any]) -> List[Dict[str, Any]]:
    floor = THRESHOLDS["stiffness_floor"]["value"]
    out = []
    for side, short, name in (("oxidiser", "ox", "LOX"), ("fuel", "fuel", "Fuel")):
        s = run.summary.get(short) or {}
        if not s and not run.series.get(short):
            continue
        value = _num(s.get("stiffness_min"))
        b = band.get(side) if isinstance(band, Mapping) else None
        b = [float(b[0]), float(b[1])] if isinstance(b, (list, tuple)) and len(b) == 2 and None not in b else None
        if value is None:
            grade = "warn"
        elif b:
            grade = "bad" if value < b[0] else "warn" if value > b[1] else "ok"
        else:
            grade = "bad" if value < floor else "ok"
        col = run.column(f"{short}.stiffness")
        i = run.argext(col, run.settled, min)
        t, i = run.at(i)
        band_text = (f"the design's band is {b[0] * 100:g}-{b[1] * 100:g} %: red below it (chug), amber above it "
                     "(tank pressure spent on the injector)" if b else
                     f"the design sets no band, so it is graded against {floor * 100:g} % "
                     "(a common chug rule of thumb)")
        out.append(_entry(
            f"stiffness_{short}", f"{name} injector ΔP/Pc", "injector", value, "",
            b[0] if b else floor, None, "min", grade, t, i, f"series.{short}.stiffness",
            "Twin: manifold (line exit less the Borda dump) minus Pc, over Pc; lowest over firing steps from "
            "t = 0.2 s (the start transient is not modelled)",
            f"Lowest injector pressure drop over chamber pressure through the burn; {band_text}.",
            band=b))
        ign = _num(s.get("stiffness_min_ignition"))
        if ign is not None:
            early = [k for k in run.fire if k not in set(run.settled)]
            j = run.argext(col, early, min)
            tj, j = run.at(j)
            out.append(_entry(
                f"stiffness_{short}_ignition", f"{name} injector ΔP/Pc, first 0.2 s", "injector", ign, "",
                b[0] if b else floor, None, "min", "info", tj, j, f"series.{short}.stiffness",
                "Twin, firing steps before t = 0.2 s",
                "Reported, not graded: the start transient (valve ramp, priming, ignition) is not modelled, "
                "so the figure moves with the time step (AUDIT 5.1, #13).", band=b))
    return out


def _tanks(run: _Run, derived: Mapping[str, Any], req: Mapping[str, Any],
           meop_psi: Optional[Mapping[str, float]], defaulted: frozenset = frozenset()) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    roles = derived.get("roles") or {}
    mawps = derived.get("tank_mawp_psi") or {}
    ambient_pa = _num(derived.get("ambient_pa"))
    ambient_psia = ambient_pa / PSI if ambient_pa is not None else 14.6959
    meops = dict(derived.get("tank_meop_psi") or {})
    use = THRESHOLDS["rating_use"]["value"]
    for side, short, name, cap_key in (("oxidiser", "ox", "LOX", "max_lox_tank_pressure_psi"),
                                       ("fuel", "fuel", "Fuel", "max_fuel_tank_pressure_psi")):
        s = run.summary.get(short) or {}
        peak = _num(s.get("peak_psia"))
        if peak is None:
            continue
        col = run.column(f"{short}.tank_psia")
        i = run.argext(col, range(len(col)), max)
        t, i = run.at(i)
        across = peak - ambient_psia
        tank_id = roles.get(side)
        mawp = _num(mawps.get(tank_id)) if tank_id else None
        if mawp is not None:
            out.append(_entry(
                f"tank_mawp_{short}", f"{name} tank peak vs MAWP", "tanks", across, "psi", mawp, use * mawp, "max",
                # Information for now (the team, 2026-10-03: "don't worry about tank limits for now"); a
                # vessel over its MAWP still trips the stand (vessel_trip, the twin's own physics).
                "info", t, i, f"series.{short}.tank_psia",
                f"Ullage pressure, highest over the recorded lead-in and the burn, less the site's atmosphere "
                f"({ambient_psia:.2f} psia), against the drawing's MAWP for {tank_id}",
                f"Highest pressure across the wall: {across / mawp * 100:.0f} % of the drawing's MAWP (amber above "
                f"{use * 100:.0f} %, a judgement). The recorded lead-in is the last 0.5 s before Fire, not the "
                "pad hold.", rating_source="drawing"))
        meop = None
        for src in (meop_psi or {}, meops):
            meop = _num(src.get(side)) if src.get(side) is not None else _num(src.get(tank_id)) if tank_id else None
            if meop is not None:
                break
        if meop is not None:
            out.append(_entry(
                f"tank_meop_{short}", f"{name} tank peak vs MEOP", "tanks", across, "psi", meop, None, "max",
                "info", t, i, f"series.{short}.tank_psia",
                "Ullage pressure across the wall (as for the MAWP), against the stated maximum expected operating "
                "pressure",
                "MEOP is the most the vessel is meant to see in operation: above it the burn has left the envelope "
                "the vessel was qualified for.", rating_source="restated MEOP"))
        cap = _num(req.get(cap_key))
        if cap is not None:
            schema_default = cap_key in defaulted
            out.append(_entry(
                f"tank_cap_{short}", f"{name} tank peak vs design cap", "tanks", peak, "psia", cap, cap, "max",
                "info", t, i, f"series.{short}.tank_psia",
                f"Ullage pressure, highest over the recorded lead-in and the burn, against "
                f"design_requirements.{cap_key}, read as absolute (as EngineDesign's tank pressures and the "
                "optimiser's lockup bound read it)"
                + ("; the design does not state it, so this is the config schema's default (no source)"
                   if schema_default else ""),
                ("Reported, not graded: the cap is the schema's default, not a number the design states. "
                 if schema_default else "")
                + "Graded amber, not red, until it is decided whether the design's tank cap applies at T-0 or at "
                  "the peak (AUDIT D11): the regulator's supply-pressure effect lifts the tanks ~40 psi during a "
                  "burn.",
                cap_source="schema default" if schema_default else "design_requirements"))
    return out


def _bottle(run: _Run) -> List[Dict[str, Any]]:
    s = run.summary
    if "copv_end_psia" not in s:
        return []
    ox, fu = s.get("ox") or {}, s.get("fuel") or {}
    lockups = [v for v in (_num(ox.get("t0_psia")), _num(fu.get("t0_psia"))) if v is not None]
    end = _num(s.get("copv_end_psia"))
    value = end - max(lockups) if end is not None and lockups else None
    h = THRESHOLDS["copv_headroom_psi"]["value"]
    t, i = run.at(len(run.t) - 1 if run.t else None)
    # The bottle is read off its gauge everywhere else on the page (psig, at the run's gauge zero):
    # quote it the same way here, or one bottle shows as two numbers.
    derived = (run.result.get("provenance") or {}).get("derived") or {}
    zero_pa = _num(derived.get("gauge_zero_pa"))
    zero_psia = zero_pa / PSI if zero_pa is not None else 14.6959
    return [_entry(
        "bottle_margin", "Bottle over lockup at burnout", "pressurant", value, "psi", h, 2.0 * h, "min",
        _grade(value, h, 2.0 * h, "min"), t, i, "series.copv_psia",
        "Bottle vessel pressure at the last step less the higher tank's pressure at T-0 (the lockup)",
        "How far the bottle is above the tanks' lockup when the burn ends"
        + (f" (the bottle reads {end - zero_psia:,.0f} psig)" if end is not None else "")
        + f". Under {h:g} psi the regulator stops holding tank pressure (an assumed dropout); amber under "
          f"{2 * h:g}.")]


def _sag(run: _Run) -> List[Dict[str, Any]]:
    best: Optional[Tuple[float, str]] = None
    for short in ("ox", "fuel"):
        s = run.summary.get(short) or {}
        t0, lo = _num(s.get("t0_psia")), _num(s.get("min_psia"))
        if t0 is None:
            continue
        d = t0 - (lo if lo is not None else t0)
        if best is None or d > best[0]:
            best = (d, short)
    if best is None:
        return []
    droop, short = best
    warn, red = THRESHOLDS["droop_psi"]["value"]
    i = run.argext(run.column(f"{short}.tank_psia"), run.fire, min)
    t, i = run.at(i)
    return [_entry(
        "tank_sag", "Tank pressure sag", "tanks", droop, "psi", red, warn, "max", _grade(droop, red, warn, "max"),
        t, i, f"series.{short}.tank_psia",
        f"T-0 tank pressure less the lowest while firing, the deeper of the two tanks ({'LOX' if short == 'ox' else 'fuel'})",
        f"Deepest dip below the set tank pressure while firing (amber over {warn:g}, red over {red:g} psi; "
        "assumed).")]


def _propellant(run: _Run) -> List[Dict[str, Any]]:
    s = run.summary
    side = s.get("depleted_side")
    ox, fu = s.get("ox") or {}, s.get("fuel") or {}
    out: List[Dict[str, Any]] = []
    if side not in ("oxidiser", "fuel"):
        if run.fire and s:
            t, i = run.at(run.fire[-1])
            why = ("The burn stopped at a vessel trip with propellant in both tanks (vessel_trip): its totals end "
                   "at the trip and are not the load's." if isinstance(run.result.get("tripped"), Mapping) else
                   "The burn reached its horizon with propellant in both tanks: a regulator that dropped out or a "
                   "horizon too short. Its totals are not the load's.")
            out.append(_entry(
                "depletion", "A tank runs dry", "model", None, "", None, None, "min", "warn", t, i, None,
                "The burn's end condition", why))
        return out
    residual = _num((fu if side == "oxidiser" else ox).get("residual_kg"))
    loads = [_num(ox.get("loaded_kg")), _num(fu.get("loaded_kg"))]
    first = "LOX" if side == "oxidiser" else "Fuel"
    t_dry = _num(s.get("burn_time_s"))
    # The step the burn ended on (the burn cuts its last step to land on depletion, so its time is
    # the depletion time); without firing steps, the summary's.
    t, i = run.at(run.fire[-1]) if run.fire else (t_dry, None)
    if residual is None:
        return out
    if None not in loads:
        frac = THRESHOLDS["depletion_tie"]["value"]
        tie = frac * (loads[0] + loads[1])
        other = "fuel" if side == "oxidiser" else "LOX"
        # Information, never a warning: one tank always empties first, and which one inside the Cd
        # scatter is not something a person acts on (the team, 2026-10-03). What is worth a look is the
        # propellant left over, graded below.
        out.append(_entry(
            "depletion_tie", "Runs dry first", "propellant", residual, "kg", None, None, "min",
            "info", t, i, f"series.{'fuel' if side == 'oxidiser' else 'ox'}.liquid_kg",
            f"Liquid left in the {other} tank when the {first} tank ran dry",
            f"Within {frac * 100:.0f} % of the load ({tie:.2f} kg) the orifice Cd's +-3 % scatter decides which tank "
            "empties first: on the stand it may be the other one.",
            detail=f"{first} runs dry first, {residual:.3f} kg of {other} left", side=side))
    r = THRESHOLDS["residual_kg"]["value"]
    out.append(_entry(
        "residual", "Propellant left over", "propellant", residual, "kg", None, r, "max",
        "warn" if residual > r else "ok", t, i, None,
        "Liquid left in the tank that did not run dry, at burnout",
        f"Propellant carried to burnout and never burned: dead mass in flight. Amber above {r:g} kg (the team's "
        "figure)."))
    return out


def _saturation(run: _Run) -> List[Dict[str, Any]]:
    sat = _dig(run.result, "diagnostics.saturation")
    if not isinstance(sat, Mapping) or sat.get("available") is False:
        return []
    red, warn = THRESHOLDS["saturation_margin_psi"]["value"]
    stated = _num(sat.get("flag_margin_psi"))
    warn = stated if stated is not None else warn
    out = []
    for n, node in enumerate(sat.get("nodes") or []):
        if not isinstance(node, Mapping):
            continue
        # The static margin (total less the dynamic head) is what boils a moving liquid; the total
        # margin when the block could not price the head.
        static = _num(node.get("min_static_psi")) is not None
        key, col_key, t_key = (("min_static_psi", "margin_static_psi", "t_min_static") if static
                               else ("min_psi", "margin_psi", "t_min"))
        margins = [_num(v) for v in (node.get(col_key) or [])] if isinstance(node.get(col_key), list) else []
        value = _num(node.get(key))
        k = run.argext(margins, run.fire or range(len(margins)), min) if margins else None
        if value is None and k is not None:
            value = margins[k]
        if value is None:
            continue
        t = _num(node.get(t_key))
        i = k if k is not None and len(margins) == len(run.t) else run.index_of(t)
        if t is None and i is not None:
            t = run.t[i]
        nid = str(node.get("id") or n)
        out.append(_entry(
            f"saturation_{nid}", f"Saturation margin, {node.get('label') or nid}", "propellant", value, "psi",
            red, warn, "min", _grade(value, red, warn, "min"), t, i, f"diagnostics.saturation.nodes.{n}.{col_key}",
            ("Local static pressure (node total less the line's dynamic head)" if static else "Local node pressure")
            + " less the liquid's vapour pressure at its temperature, lowest over the firing steps "
              "(diagnostics.saturation)",
            THRESHOLDS["saturation_margin_psi"]["why"], side=node.get("side")))
    return out


def _cavitation(run: _Run) -> List[Dict[str, Any]]:
    cav = _dig(run.result, "diagnostics.cavitation")
    if not isinstance(cav, Mapping) or cav.get("available") is False:
        return []
    red, warn = THRESHOLDS["cavitation_margin"]["value"]
    near = _num(_dig(cav, "model.inputs.near_margin.value"))
    warn = red + near if near is not None else warn
    out = []
    for short, name in (("ox", "LOX"), ("fuel", "Fuel")):
        c = cav.get(short)
        if not isinstance(c, Mapping):
            continue
        ratio = [_num(v) for v in (c.get("margin") or [])] if isinstance(c.get("margin"), list) else []
        value = _num(c.get("min_margin"))
        k = run.argext(ratio, range(len(ratio)), min) if ratio else None
        if value is None and k is not None:
            value = ratio[k]
        if value is None:
            # A block with only K: graded against its incipient K.
            K, inc = _num(c.get("min_K")), _num(c.get("K_incipient"))
            value = K / inc if K is not None and inc else None
        if value is None:
            continue
        t = _num(c.get("t_min"))
        i = k if k is not None and len(ratio) == len(run.t) else run.index_of(t)
        if t is None and i is not None:
            t = run.t[i]
        flip = bool(c.get("flip_risk"))
        grade = "bad" if flip else _grade(value, red, warn, "min")
        out.append(_entry(
            f"cavitation_{short}", f"{name} injector cavitation", "injector", value, "", red, warn, "min",
            grade, t, i, f"diagnostics.cavitation.{short}.margin",
            "Cavitation number K = (p_manifold - p_vapour)/(p_manifold - Pc) over Nurick's critical K, lowest over "
            "the firing steps (diagnostics.cavitation)",
            THRESHOLDS["cavitation_margin"]["why"] + (" Hydraulic-flip risk flagged: the jet may detach from the "
                                                      "orifice wall." if flip else ""),
            flip_risk=flip, K=_num(c.get("min_K")), K_incipient=_num(c.get("K_incipient"))))
    return out


def _water_hammer(run: _Run) -> List[Dict[str, Any]]:
    """The surge when the mains open at Fire, as information. The mains open for Fire and stay open
    (the team, 2026-10-03): the burn ends on depletion, never on a closing valve, so the closing
    surge the diagnostic also computes is not a case the stand sees and is not listed."""
    wh = _dig(run.result, "diagnostics.water_hammer")
    if not isinstance(wh, list):
        return []
    out = []
    for n, w in enumerate(wh):
        if not isinstance(w, Mapping):
            continue
        opening = w.get("opening") if isinstance(w.get("opening"), Mapping) else {}
        peak, rating = _num(opening.get("peak_psia")), _num(w.get("rating_psia"))
        if peak is None:
            continue
        line = str(w.get("line") or n)
        out.append(_entry(
            f"water_hammer_{line}", f"Opening surge, {line}", "hardware", peak, "psia", rating, None, "max",
            "info", None, None, None,
            "Peak line pressure when the main valve opens at Fire (diagnostics.water_hammer.opening): the "
            "start model's arrival flow meeting the orifices, the gas cushion ignored (an upper bound)",
            "Information: the mains open once and stay open, so there is no closing surge to grade.",
            side=w.get("side")))
    return out


def _separation(run: _Run, derived: Mapping[str, Any]) -> List[Dict[str, Any]]:
    crit = THRESHOLDS["summerfield_pe_pa"]["value"]
    sep = _dig(run.result, "diagnostics.hardware.separation")
    hw_t = _dig(run.result, "diagnostics.hardware.t")
    ambient_pa = _num(derived.get("ambient_pa"))
    ratio: List[Optional[float]] = []
    times: List[float] = []
    schmucker = False
    if isinstance(sep, Mapping) and isinstance(sep.get("ratio"), list):
        ratio = [_num(v) for v in sep["ratio"]]
        times = [float(v) for v in hw_t] if isinstance(hw_t, list) and len(hw_t) == len(ratio) else []
        schmucker = any(bool(v) for v in (sep.get("schmucker") or []))
        basis = ("Exit pressure over the ambient the nozzle exhausts into (diagnostics.hardware.separation, at the "
                 "erosion replay's points)")
        ref = "diagnostics.hardware.separation.ratio"
    else:
        dv = run.result.get("delivered") or {}
        pe = [_num(v) for v in (dv.get("p_exit_psia") or [])]
        amb = [_num(v) for v in (dv.get("ambient_psia") or [])]
        if not pe:
            return []
        if amb and len(amb) == len(pe):
            ratio = [p / a if p is not None and a else None for p, a in zip(pe, amb)]
        elif ambient_pa:
            ratio = [p * PSI / ambient_pa if p is not None else None for p in pe]
        times = [float(v) for v in (dv.get("t") or [])]
        basis = ("EngineDesign's exit pressure from the erosion replay (delivered.p_exit_psia, interpolated onto the "
                 "firing steps) over the ambient the nozzle exhausts into")
        ref = "delivered.p_exit_psia"
    live = [j for j in range(len(ratio)) if ratio[j] is not None]
    if not live:
        return []
    k = min(live, key=lambda j: ratio[j])  # type: ignore[arg-type,return-value]
    value = ratio[k]
    t = times[k] if k < len(times) else None
    grade = _grade(value, crit, None, "min")
    if grade == "ok" and schmucker:
        grade = "warn"
    return [_entry(
        "separation", "Nozzle exit over ambient", "hardware", value, "", crit, None, "min", grade, t,
        run.index_of(t), ref, basis + "; lowest over the burn",
        THRESHOLDS["summerfield_pe_pa"]["why"] + (" Amber: Schmucker's criterion already predicts separation."
                                                    if schmucker else ""))]


def _flight(run: _Run, req: Mapping[str, Any]) -> List[Dict[str, Any]]:
    f = run.result.get("flight")
    if not isinstance(f, Mapping) or not f.get("ok"):
        return []
    st = f.get("stability") if isinstance(f.get("stability"), Mapping) else {}
    out: List[Dict[str, Any]] = []
    need = _num(req.get("min_rail_exit_velocity_m_s"))
    if need is None:
        need = _num(st.get("rail_exit_required_m_s"))
    v = _num(st.get("rail_exit_m_s"))
    if v is None:
        v = _num(f.get("rail_exit_velocity_m_s"))
    if v is not None and need is not None:
        t = _num(st.get("rail_exit_t"))
        t = t if t is not None else _num(f.get("rail_exit_time_s"))
        out.append(_entry(
            "rail_exit", "Rail exit speed", "flight", v, "m/s", need, None, "min", _grade(v, need, None, "min"),
            t, run.index_of(t), None, "RocketPy Flight.out_of_rail_velocity",
            "design_requirements.min_rail_exit_velocity_m_s: below it the fins have too little airspeed to "
            "stabilise the vehicle off the rail."))
    lo, hi = _num(req.get("min_static_margin_cal")), _num(req.get("max_static_margin_cal"))
    liftoff = _num(st.get("liftoff_static_margin_cal"))
    liftoff = liftoff if liftoff is not None else _num(st.get("static_margin_liftoff_cal"))
    smin = _num(st.get("min_static_margin_cal"))
    smin_t = _num(st.get("min_static_margin_t"))
    if smin is None:
        smin, smin_t = _num(st.get("min_stability_margin_cal")), _num(st.get("min_stability_margin_time_s"))
    for key, label, value, t in (("static_margin_liftoff", "Static margin at liftoff", liftoff, 0.0),
                                 ("static_margin_min", "Static margin, lowest", smin, smin_t)):
        if value is None:
            continue
        grade = _grade(value, lo, None, "min") if lo is not None else "info"
        if hi is not None and value > hi:
            grade = "warn"
        out.append(_entry(
            key, label, "flight", value, "cal", lo, None, "min", grade, t, run.index_of(t),
            "flight.stability.static_margin_cal" if isinstance(st.get("static_margin_cal"), list) else None,
            "RocketPy Barrowman static margin (CG less CP over the body diameter)",
            ("design_requirements.min_static_margin_cal" + (f" ({lo:g} cal)" if lo is not None else "")
             + (f"; amber above max_static_margin_cal ({hi:g} cal), where the vehicle weathercocks" if hi is not None
                else "") if lo is not None or hi is not None else
             "Reported, not graded: the design states no static-margin requirement.")))
    q = _num(st.get("max_q_pa"))
    if q is not None:
        tq = _num(st.get("max_q_t"))
        out.append(_entry(
            "max_q", "Max dynamic pressure", "flight", q, "Pa", None, None, "max", "info", tq, run.index_of(tq),
            None, "RocketPy Flight.max_dynamic_pressure", "Reported for the airframe's loads; not a Layer X limit."))
    ceiling = f.get("ceiling") if isinstance(f.get("ceiling"), Mapping) else None
    apogee = _num(f.get("apogee_agl_m"))
    if ceiling and apogee is not None and _num(ceiling.get("limit_agl_m")) is not None:
        lim = _num(ceiling.get("limit_agl_m"))
        out.append(_entry(
            "apogee_ceiling", "Apogee under the ceiling", "flight", apogee, "m", lim, None, "max",
            _grade(apogee, lim, None, "max"), None, None, None, "RocketPy apogee above the pad",
            "design_requirements.max_apogee_m: the waiver ceiling (optimize.grade's 'ceiling')."))
    return out


def _regulator(run: _Run) -> List[Dict[str, Any]]:
    reg = _dig(run.result, "diagnostics.regulator")
    if not isinstance(reg, Mapping) or reg.get("available") is False:
        return []
    use = [_num(v) for v in (reg.get("use_frac") or [])]
    wide = [bool(v) for v in (reg.get("wide_open") or [])]
    times = [float(v) for v in (reg.get("t") or run.t)]
    if not use and not wide:
        return []
    warn, red = THRESHOLDS["regulator_use"]["value"]
    k = run.argext(use, range(len(use)), max) if use else None
    value = use[k] if k is not None else None
    if any(wide):
        k = wide.index(True)
    t = times[k] if k is not None and k < len(times) else None
    grade = "bad" if any(wide) else _grade(value, red, warn, "max") if value is not None else "info"
    return [_entry(
        "regulator_wide_open", "Regulator use of capacity", "pressurant", value, "", red, warn, "max", grade, t,
        run.index_of(t), "diagnostics.regulator.use_frac",
        "Dome regulator flow over its capacity at the seat (diagnostics.regulator)",
        THRESHOLDS["regulator_use"]["why"])]


def _health(run: _Run) -> List[Dict[str, Any]]:
    r, s = run.result, run.summary
    out: List[Dict[str, Any]] = []
    last_t, last_i = run.at(len(run.t) - 1 if run.t else None)
    trip = r.get("tripped")
    if isinstance(trip, Mapping):
        p, m = _num(trip.get("p_psia")), _num(trip.get("mawp_psia"))
        tt = _num(trip.get("t"))
        out.append(_entry(
            "vessel_trip", f"Vessel trip ({trip.get('vessel') or 'vessel'})", "model", p, "psia", m, None, "max",
            "bad", tt, run.index_of(tt), None,
            "The twin's MAWP trip: the stand shut down at this instant and the burn stopped there",
            "A vessel passed the MAWP its drawing declares; everything after this instant was not burned."))
    if r.get("converged") is False:
        out.append(_entry(
            "unsettled", "Model settled", "model", None, "", None, None, "min", "warn", last_t, last_i, None,
            "The erosion replay and flight coupling loop (result.passes)",
            "The erosion replay or the flight coupling did not settle, or the replay failed: thrust and Pc may be "
            "the as-built throat's. See the events."))
    outside = s.get("card_outside_steps")
    if isinstance(outside, (int, float)) and not isinstance(outside, bool):
        out.append(_entry(
            "card_outside", "Engine table", "model", float(outside), "steps", None, 0.0, "max",
            "warn" if outside > 0 else "ok", None, None, None,
            "Firing steps whose injector or chamber point lay outside the engine card's sample hull (a count; the "
            "steps are not recorded)",
            "Steps outside what the card was fitted to are extrapolated."))
    ec = r.get("engine_check")
    if isinstance(ec, Mapping) and ec.get("available") and isinstance(ec.get("worst"), Mapping):
        w = ec["worst"]
        keys = ["pc", "mdot_O", "mdot_F"] + ([] if ec.get("against") == "replay" else ["thrust"])
        gaps = [(abs(_num(w.get(k)) or 0.0), k) for k in keys]
        gap, which = max(gaps)
        a, b = THRESHOLDS["replay_agreement"]["value"]
        grade = "ok" if gap < a else "warn" if gap < b else "bad"
        t_w = None
        for row in ec.get("rows") or []:
            rel = (row or {}).get("rel") or {}
            v = _num(rel.get(which))
            if v is not None and abs(v) == gap:
                t_w = _num(row.get("t"))
                break
        out.append(_entry(
            "engine_fit", "Engine fit", "model", gap, "", b, a, "max", grade, t_w, run.index_of(t_w),
            None, f"Twin against EngineDesign at the same line-exit pressures (engine_check, worst of {', '.join(keys)})",
            THRESHOLDS["replay_agreement"]["why"], worst_of=which))
    failed = s.get("failed_steps")
    settled_t0 = s.get("t0_settled")
    if failed is not None or settled_t0 is not None:
        conv = r.get("series", {}).get("converged") or []
        first_bad = next((j for j, c in enumerate(conv) if c is False), None)
        tb, ib = run.at(first_bad)
        bad = bool(failed) or settled_t0 is False
        out.append(_entry(
            "solver", "Solver", "model", float(failed or 0), "steps", None, 0.0, "max", "warn" if bad else "ok", tb, ib,
            "series.converged", "Steps the network solve could not close, and whether T-0 settled",
            "A step the solver could not close holds its last good flows." + (
                " T-0 did not settle: the trace opens off its datum." if settled_t0 is False else "")))
    vv = _dig(r, "diagnostics.vv")
    if isinstance(vv, Mapping):
        out.extend(_conservation(vv, last_t, last_i))
    return out


def _conservation(vv: Mapping[str, Any], last_t: Optional[float], last_i: Optional[int]) -> List[Dict[str, Any]]:
    out = []
    rows: List[Tuple[str, str, Any, str]] = []
    for side, name in (("ox", "LOX"), ("fuel", "Fuel")):
        rows.append((f"conservation_mass_{side}", f"{name} mass balance", _dig(vv, f"mass.{side}.error_pct"), "mass"))
    rows.append(("conservation_pressurant", "Pressurant mass balance", _dig(vv, "pressurant.error_pct"), "pressurant"))
    for key, label, err, kind in rows:
        e = _num(err)
        if e is None:
            continue
        warn, red = THRESHOLDS[f"conservation_{kind}_pct"]["value"]
        out.append(_entry(
            key, label, "model", abs(e), "%", red, warn, "max", _grade(abs(e), red, warn, "max"), last_t, last_i,
            f"diagnostics.vv.{'mass.' + key.rsplit('_', 1)[-1] if kind == 'mass' else 'pressurant'}",
            "Conservation check (engine/layerx/diag/vv.py): relative error of the balance over the burn",
            THRESHOLDS[f"conservation_{kind}_pct"]["why"]))
    e = _num(_dig(vv, "energy.error_pct"))
    if e is not None:
        out.append(_entry(
            "conservation_energy", "Gas energy balance", "model", e, "%", None, None, "max", "info", last_t, last_i,
            "diagnostics.vv.energy", str(_dig(vv, "energy.basis") or "gas-side first law"),
            "Reported, not graded: the residual includes the heat the tank walls, the liquid surface and the lines "
            "exchange with the gas, which the series does not record (see the basis)."))
    return out


# ---------------------------------------------------------------------- the entry point


def grade(result: Mapping[str, Any], prep: Any = None, config: Any = None, *,
          meop_psi: Optional[Mapping[str, float]] = None) -> List[Dict[str, Any]]:
    """Every limit the burn in ``result`` is graded against, most consequential group first.

    ``prep`` (a :class:`engine.layerx.prepare.Prepared`) is read only when the result carries no
    ``provenance.derived``; ``config`` supplies ``design_requirements`` (otherwise read from the YAML
    the run recorded). ``meop_psi`` is a maximum expected operating pressure across the wall per
    side (``{"oxidiser": psi, "fuel": psi}``), as the set-point request states it; a drawing's or a
    restatement's ``derived.tank_meop_psi`` (per tank id or side) is read too.
    """
    run = _Run(result or {})
    if not run.t:
        return []
    derived = _derived(result, prep)
    req = requirements(result, config)
    defaulted = _defaulted(config)
    band = derived.get("stiffness_band") or {}
    sections = (
        lambda: _chug(run, req, defaulted),
        lambda: _stiffness(run, band),
        lambda: _tanks(run, derived, req, meop_psi, defaulted),
        lambda: _bottle(run),
        lambda: _regulator(run),
        lambda: _sag(run),
        lambda: _propellant(run),
        lambda: _saturation(run),
        lambda: _cavitation(run),
        lambda: _water_hammer(run),
        lambda: _separation(run, derived),
        lambda: _flight(run, req),
        lambda: _health(run),
    )
    out: List[Dict[str, Any]] = []
    for build in sections:
        try:
            out.extend(build())
        except Exception as exc:  # noqa: BLE001 - one malformed block never costs the others their grades
            out.append(_entry(
                "limits_error", "Limits", "model", None, "", None, None, "max", "info", None, None, None,
                f"{type(exc).__name__}: {exc}", "A block of the result could not be graded; the others were."))
    return out


def overall(entries: Sequence[Mapping[str, Any]]) -> str:
    """bad if any limit is broken, warn if any is worth a look, else ok. ``info`` never counts."""
    grades = {e.get("grade") for e in entries}
    return "bad" if "bad" in grades else "warn" if "warn" in grades else "ok"


def breaks(entries: Sequence[Mapping[str, Any]]) -> List[str]:
    """The broken limits as one line each, for a sweep's crossing list."""
    out = []
    for e in entries:
        if e.get("grade") != "bad":
            continue
        v = e.get("value")
        lim = e.get("limit")
        unit = e.get("unit") or ""
        rel = "<" if e.get("direction") == "min" else ">"
        out.append(f"{e.get('label')} {v:.4g}{(' ' + unit) if unit else ''} {rel} {lim:.4g}"
                   if isinstance(v, (int, float)) and isinstance(lim, (int, float)) else str(e.get("label")))
    return out
