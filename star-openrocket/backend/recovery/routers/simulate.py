"""POST /api/simulate and /api/sweep. PLAN.md §11.5, §11.9."""

from typing import List, Literal, Union

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.recovery.serialise import (
    SWEEP_COARSE_DT,
    SWEEP_EVENT_WINDOW,
    SWEEP_FINE_DT,
    build_events,
    build_result,
    resample_for_wire,
)
from physics.atmosphere import Atmosphere
from physics.cases import (
    CASES,
    default_sweep,
    evaluate,
    governing_candidates,
    sweep,
    worst_by_category,
)
from physics.drift import compute_drift
from physics.schema import Config, ConstantWind, ProfileWind, WindInput  # noqa: F401
from physics.solver import integrate

router = APIRouter(prefix="/api", tags=["simulate"])


def _atmosphere(config):
    return Atmosphere(config.site.z_site, config.site.T_pad,
                      config.site.p_pad, config.site.lapse)


@router.post("/simulate")
def run_simulation(
    config: Config,
    which: str = Query(
        "axial",
        description="Airframe drag bound: 'axial' or 'broadside'. does "
                    "not permit picking one silently, so the response always "
                    "carries body_drag_band showing what the other would be.",
    ),
):
    """All four §11.5 cases, every run.

    They are not optional and not a separate mode: a report showing only the
    nominal case hides a single-point failure that, for the worked vehicle,
    exceeds the design load by 11x. Four integrations is ~160 ms, so there is
    no reason to gate them behind a button.

    Config validation is FastAPI's, straight off the Pydantic model -- a bad
    config returns 422 with the field path, and `schema.py` is the only place
    that defines what "bad" means.
    """
    if which not in ("axial", "broadside"):
        raise HTTPException(status_code=400,
                            detail="which must be 'axial' or 'broadside'")
    try:
        atm = _atmosphere(config)
        results = {c: evaluate(config, which, c, atm=atm) for c in CASES}
    except ValueError as exc:
        # Physics-level rejections: a trigger at exactly apogee giving v_s = 0,
        # canopy masses exceeding the vehicle mass. These are real answers
        # about the config, so they must not be swallowed into a 500.
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return build_result(config, results, atm, which, config.warnings())


@router.post("/simulate/both")
def run_both_bounds(config: Config):
    """Both §6.4 bounds in one call.

    The attitude band is worth 2.1x on the design load for the worked vehicle
    -- the single largest term in the model (§15.7) -- so seeing both at once
    is the honest default for a report.
    """
    try:
        atm = _atmosphere(config)
        out = {}
        for which in ("axial", "broadside"):
            results = {c: evaluate(config, which, c, atm=atm) for c in CASES}
            out[which] = build_result(config, results, atm, which,
                                      config.warnings())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return out


@router.post("/sweep")
def run_sweep(config: Config, case: str = Query("nominal"),
              trajectories: bool = Query(False)):
    """The §11.9 corner sweep. 32 runs and ~1.4 s on the canonical set.

    Phase 1 has no random inputs, so this sweeps corners rather than sampling;
    Monte Carlo belongs in Phase 2 with wind. The per-device parameters are
    perturbed **in common across devices** -- a corner where the drogue sits
    at Cx = 1.2 while the main sits at 1.8 is not a physical case.

    Which corners to visit rides in `config.sweep`, so it uses the same body
    as /api/simulate. Omit it for the canonical set; send `SweepParam` entries
    to change the bounds or to disable a parameter. Run count is the product
    of the enabled bounds, which is 2^n for n enabled parameters -- the caller
    is choosing the cost as well as the coverage.

    `trajectories=1` attaches each corner's flight history. Off by default
    because it is the whole cost of the response: 32 descents at the
    /api/simulate resolution is 6 MB against a few kB without them. The
    coarser SWEEP_* grid brings that to ~1 MB, and only the GUI's chart wants
    it -- every other caller reads the scalars.
    """
    if case not in CASES:
        raise HTTPException(status_code=400,
                            detail="case must be one of %s" % (CASES,))
    try:
        rows = sweep(config, case)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    designs = [cr.design.F_design or 0.0 for _, cr in rows]

    # A stable handle per corner, so the client can key selection and colour off
    # something short instead of comparing float dicts. Index order is
    # deterministic: `resolve_corners` preserves the caller's key order and
    # itertools.product is stable, so c7 is the same corner on every request
    # for the same spec.
    ids = ["c%d" % i for i in range(len(rows))]
    id_of = {id(cr): cid for cid, (_, cr) in zip(ids, rows)}

    # Per category, NOT a single winner. §11.5's argument about cases applies
    # to corners too, and more sharply: for the worked vehicle the structural
    # worst case is the axial airframe bound and the drift worst case is
    # broadside -- the opposite corner. A single headline would say the
    # airframe is nose-down while the descent-time risk lives at the other
    # bound. `irrelevant` names parameters that did not move that metric, so
    # an arbitrary tie-break is never read as significant.
    by_cat = worst_by_category(rows)
    worst_payload = {
        name: {
            "corner": entry["corner"],
            # So the chart can pre-select the corners that produced the worst
            # cases -- which is the default view -- without matching floats.
            "id": id_of[id(entry["result"])],
            # The airframe corner travels as a drag area, because that is what
            # it physically is and what a custom bound would be. "axial" /
            # "broadside" is its §6.4 name, carried alongside so the report
            # does not have to show a reader 0.00507 m2 and hope.
            "attitude": entry["result"].which,
            # The eq (36) max BEFORE the safety factor -- the load the
            # hardware actually sees. F_design is that times SF, and since SF
            # is the same in every corner the two rank identically; this is
            # the one worth reading, because it is the number to compare a
            # component rating against.
            "F_peak": entry["result"].design.governing_value,
            "metric": entry["metric"],
            "unit": entry["unit"],
            "value": entry["value"],
            "irrelevant": entry["irrelevant"],
            "F_design": entry["result"].design.F_design,
            "descent_time": entry["result"].run.t_ground,
            "impact_velocity": entry["result"].run.v_impact,
            "governing_device": entry["result"].design.governing_device,
            "governing_candidate": entry["result"].design.governing_candidate,
        }
        for name, entry in by_cat.items()
    }

    # Echo the resolved spec. The caller may have sent nothing (and got the
    # canonical set), sent bounds that were normalised, or disabled a
    # parameter -- and a sweep is only interpretable next to the corners it
    # actually visited. Without this, 16 runs and 32 runs look like the same
    # answer with different precision rather than different questions.
    spec = default_sweep(config) if config.sweep is None else config.sweep

    # The un-perturbed run, as a reference line on the chart.
    #
    # It is NOT one of the corners and generally cannot be: the config's own
    # values sit inside the swept bands rather than at their bounds (n defaults
    # to 8 against corners at 6 and 12). Without it the chart shows only
    # extremes, and there is nothing to read "how far from nominal is this"
    # against -- which is the question the sweep exists to answer.
    ref = evaluate(config, "axial", case, atm=_atmosphere(config))
    nominal_payload = {
        "F_design": ref.design.F_design,
        "F_peak": ref.design.governing_value,
        "governing_device": ref.design.governing_device,
        "governing_candidate": ref.design.governing_candidate,
        "descent_time": ref.run.t_ground,
        "impact_velocity": ref.run.v_impact,
        "impact_ke": 0.5 * ref.run.m * ref.run.v_impact ** 2,
    }
    if trajectories:
        nominal_payload["trajectory"] = resample_for_wire(
            ref.run, build_events(ref.run), fine_dt=SWEEP_FINE_DT,
            coarse_dt=SWEEP_COARSE_DT, window=SWEEP_EVENT_WINDOW)

    return {
        "case": case,
        "runs": len(rows),
        "nominal": nominal_payload,
        "swept": [
            {"key": p.key.value, "enabled": p.enabled,
             "low": p.low, "high": p.high}
            for p in spec
        ],
        "defaulted": config.sweep is None,
        "corners": [
            {
                "id": cid,
                "corner": c,
                "attitude": cr.which,
                "F_peak": cr.design.governing_value,
                **({"trajectory": resample_for_wire(
                        cr.run, build_events(cr.run),
                        fine_dt=SWEEP_FINE_DT, coarse_dt=SWEEP_COARSE_DT,
                        window=SWEEP_EVENT_WINDOW)}
                   if trajectories else {}),
                "F_design": cr.design.F_design,
                "governing_device": cr.design.governing_device,
                "governing_candidate": cr.design.governing_candidate,
                "descent_time": cr.run.t_ground,
                "impact_velocity": cr.run.v_impact,
                "impact_ke": 0.5 * cr.run.m * cr.run.v_impact ** 2,
            }
            for cid, (c, cr) in zip(ids, rows)
        ],
        "worst_by_category": worst_payload,
        # Retained for callers that only want the load. It is the `structure`
        # entry above, and it is NOT "the worst corner" in general.
        "worst": worst_payload["structure"],
        "governing_candidates": governing_candidates(rows),
        "range": {"min": min(designs), "max": max(designs),
                  "ratio": (max(designs) / min(designs)) if min(designs) else None},
    }


# --- drift (PLAN.md §21) ---------------------------------------------------


class DriftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Wind now rides on the config (config.wind), so the descent itself is
    # wind-aware and the drift is just its ground track.
    config: Config


# The ground track is smooth (no events), so a plain time stride is enough;
# ~300 points keeps the plan-view curve crisp without shipping the full
# 5 ms load grid.
_TRACK_MAX_POINTS = 300


def _thin_track(drift):
    n = len(drift.t)
    if n == 0:
        return []
    step = max(1, n // _TRACK_MAX_POINTS)
    idx = list(range(0, n, step))
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return [
        {"t": float(drift.t[i]), "z": float(drift.z[i]),
         "x": float(drift.x[i]), "y": float(drift.y[i])}
        for i in idx
    ]


@router.post("/drift")
def run_drift(
    req: DriftRequest,
    which: str = Query(
        "axial",
        description="Airframe drag bound: 'axial' or 'broadside'. Descent rate "
                    "sets how long the vehicle is exposed to the wind, so the "
                    "bound moves drift slightly; broadside descends slower and "
                    "drifts a touch further."),
):
    """Downwind drift of the nominal descent under a given wind.

    Runs the nominal descent (config.devices as-is, not the §11.5 off-nominal
    cases), then carries it sideways with the wind via the equilibrium model in
    physics/drift.py. Returns the ground track plus the total distance and
    bearing from the pad.
    """
    if which not in ("axial", "broadside"):
        raise HTTPException(status_code=400,
                            detail="which must be 'axial' or 'broadside'")
    try:
        atm = _atmosphere(req.config)
        # The descent reads config.wind and integrates the horizontal track, so
        # the drift is simply that track (compute_drift reads run.traj.x/y).
        run = integrate(req.config, which, atm=atm)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    drift = compute_drift(run)
    # The wind the run actually saw at the ground, for the report.
    if req.config.wind is not None:
        wind = req.config.wind.to_profile(req.config.site.z_site)
    else:
        from physics.wind import WindProfile
        wind = WindProfile.constant(0.0, 0.0, site_elev=req.config.site.z_site)

    return {
        "distance": drift.distance,
        "bearing_deg": drift.bearing_deg,
        "descent_time": run.t_ground,
        "landing": {"x": float(drift.x[-1]), "y": float(drift.y[-1])},
        "track": _thin_track(drift),
        # What the physics actually used at the ground, so the report is not
        # asserting a wind the run did not see.
        "wind_ground": {
            "speed": wind.speed(0.0),
            "heading_deg": wind.heading(0.0),
        },
        "airframe_bound": which,
    }
