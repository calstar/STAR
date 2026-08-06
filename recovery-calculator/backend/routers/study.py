"""POST /api/study. The design study -- see `physics/study.py`.

Not to be confused with /api/sweep. That one asks how uncertain a design is and
answers with the governing corner; this one asks which of several designs is
better and answers with the four summary figures for each. They take the same
request body (both specs ride on `Config`) and mean entirely different things.
"""

from fastapi import APIRouter, HTTPException, Query

from backend.serialise import (
    SWEEP_COARSE_DT,
    SWEEP_EVENT_WINDOW,
    SWEEP_FINE_DT,
    build_events,
    resample_for_wire,
)
from physics.atmosphere import Atmosphere
from physics.cases import evaluate
from physics.schema import Config
from physics.study import (
    LABELLED_KEYS,
    MAX_RUNS,
    axis_values,
    current_value,
    enabled_axes,
    run_points,
)

router = APIRouter(prefix="/api", tags=["study"])


def _metrics(result):
    """The four figures the Recovery summary shows, for one design.

    Deliberately the same four, in the same units, from the same fields: a
    study exists to compare designs against the run you would get by opening
    the Recovery tab on each of them, and a fifth number here or a different
    definition of one of them would break that correspondence.
    """
    return {
        "descent_time": result.run.t_ground,
        "impact_velocity": result.run.v_impact,
        "impact_ke": 0.5 * result.run.m * result.run.v_impact ** 2,
        # The UNFACTORED eq (36) max -- the load the hardware actually sees,
        # matching the Recovery summary's "Max load (F_peak)" and the Corners
        # cards. F_design is this times the safety factor.
        "F_peak": result.design.governing_value,
        "F_design": result.design.F_design,
        "governing_device": result.design.governing_device,
        "governing_candidate": result.design.governing_candidate,
    }


def _axis_echo(axis, config):
    """The resolved axis, so the client can label columns without re-deriving.

    A study is only interpretable next to the grid it actually visited: 5
    points from 800 to 2000 ft and 5 points from 800 to 1200 ft produce tables
    of the same shape and different meaning.

    `current` is what the config as posted has on this axis, so the reference
    row can say where today's design sits on each one. None means the fitted
    canopy is not among the ones being compared -- which is itself worth
    saying, and is not the same as "unknown".
    """
    values = axis_values(axis)
    return {
        "key": axis.key.value,
        "device": axis.device,
        "mode": axis.mode.value,
        # Objects carry their own name; numbers are their own name.
        "labels": [v.label for v in values]
        if axis.key.value in LABELLED_KEYS else list(values),
        "current": current_value(config, axis),
    }


@router.post("/study")
def run_study(config: Config, trajectories: bool = Query(False)):
    """Every design the study describes, at nominal conditions.

    Nominal case and the axial airframe bound -- the /api/simulate defaults.
    The off-nominal cases are deliberately absent: they would multiply the run
    count by four to answer a question the Recovery tab already answers for
    each design one at a time, and a study is a comparison between designs
    rather than an analysis of any one of them.

    `trajectories=1` attaches each design's flight history, on the same coarse
    grid the corner sweep uses -- 20 histories is ~0.6 MB against a few kB
    without them, and only the chart wants them.

    The run count is capped at MAX_RUNS by `Config` itself, so an oversized
    study is a 422 naming the count rather than a truncated answer.
    """
    try:
        atm = Atmosphere(config.site.z_site, config.site.T_pad,
                         config.site.p_pad, config.site.lapse)
        points = run_points(config, atm=atm)
        # The unstudied config, as the reference line on the chart and the
        # first row of the table. It is generally NOT one of the points -- the
        # config's own canopy need not be among the ones being compared -- so
        # it is the thing "is this design better" is measured against.
        ref = evaluate(config, "axial", "nominal", atm=atm)
    except ValueError as exc:
        # Two things land here and both are real answers about the study, not
        # server faults: a physics-level rejection (a trigger at exactly
        # apogee, canopy masses over the vehicle mass), and a design point that
        # is not a legal vehicle -- `run_points` re-validates every mutated
        # config, which is where a trigger swept above apogee surfaces, and it
        # names the offending point.
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    nominal = _metrics(ref)
    if trajectories:
        nominal["trajectory"] = resample_for_wire(
            ref.run, build_events(ref.run), fine_dt=SWEEP_FINE_DT,
            coarse_dt=SWEEP_COARSE_DT, window=SWEEP_EVENT_WINDOW)

    return {
        "runs": len(points),
        "max_runs": MAX_RUNS,
        "axes": [_axis_echo(a, config) for a in enabled_axes(config)],
        "nominal": nominal,
        "points": [
            {
                # Stable across identical requests: the axes keep the caller's
                # order and itertools.product is stable, so p7 is the same
                # design every time and the client can key colour and
                # selection off it.
                "id": "p%d" % i,
                "values": values,
                **_metrics(result),
                **({"trajectory": resample_for_wire(
                        result.run, build_events(result.run),
                        fine_dt=SWEEP_FINE_DT, coarse_dt=SWEEP_COARSE_DT,
                        window=SWEEP_EVENT_WINDOW)}
                   if trajectories else {}),
            }
            for i, (values, result) in enumerate(points)
        ],
        "warnings": config.warnings(),
    }
