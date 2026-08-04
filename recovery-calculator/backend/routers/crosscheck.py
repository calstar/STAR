"""POST /api/crosscheck. Our model against OpenRocket and the mastersheet.

Not to be confused with the other three. `/api/simulate` answers "what does this
vehicle do", `/api/sweep` answers "how much of that is known", `/api/study`
answers "which design is better" -- and this one answers "do the three tools the
team actually uses agree". It takes the same `Config` body as the others (§11.7,
one body schema) and sizes nothing.

The response deliberately carries `null` rather than `0` for a quantity a model
does not compute, and a `note` saying why. See `physics/crosscheck.py`.
"""

from fastapi import APIRouter, HTTPException, Query

from backend.serialise import build_events, git_sha
from physics.atmosphere import Atmosphere
from physics.crosscheck import (
    MODEL_DIFFERENCES,
    SHARED_ASSUMPTIONS,
    crosscheck,
)
from physics.schema import Config

router = APIRouter(prefix="/api", tags=["crosscheck"])

# The pinned OpenRocket the port was written against. Travels with every
# response for the same reason `git_sha` does (§11.4): when a number from this
# tool reaches a design review, which version of *both* models produced it has
# to be recoverable.
OPENROCKET_RELEASE = "release-24.12"
OPENROCKET_COMMIT = "133b558d"


def _our_trajectory(run):
    """Our run, thinned for the wire.

    Reuses the corner sweep's coarser grid rather than /api/simulate's: this
    chart is a comparison of three lines, not the load analysis, and §8.1's
    <=5 ms sampling still happens inside `_resample` regardless.
    """
    from backend.serialise import (
        SWEEP_COARSE_DT,
        SWEEP_EVENT_WINDOW,
        SWEEP_FINE_DT,
        resample_for_wire,
    )

    return resample_for_wire(run, build_events(run), fine_dt=SWEEP_FINE_DT,
                             coarse_dt=SWEEP_COARSE_DT,
                             window=SWEEP_EVENT_WINDOW)


def _openrocket_trajectory(run):
    """OpenRocket's run, verbatim.

    No resampling: a 0.5 s nominal step over a three-minute descent is a few
    hundred points, so there is nothing to thin -- and the coarse stepping is
    worth seeing rather than smoothing away. `F_T` is absent, not zero, because
    OpenRocket computes no load at all.
    """
    return [
        {"t": run.traj.t[i], "z": run.traj.z[i], "v": run.traj.v[i],
         "a": run.traj.a[i], "F_T": None, "CdS_tot": run.traj.CdS[i]}
        for i in range(len(run.traj.t))
    ]


# Between two phases the drag area steps. Both the last sample of one leg and
# the first of the next fall on the same `t`, and `TrajectoryOverlay` merges its
# rows by `t` -- so without a nudge the second silently overwrites the first and
# the step renders as a diagonal ramp across the whole preceding leg. A
# microsecond is far below any sampling anyone will look at and keeps both rows.
_STEP_EPS = 1e-6


def _mastersheet_trajectory(result):
    """The mastersheet as a curve, sampled from its own closed form.

    Emphatically **not** a straight line between each leg's endpoints. Their
    `TROP_DESCENT_TIME` integrates `dz / v_t(z)` with `v_t` going as
    `1/sqrt(rho)`, so within a single leg the vehicle is measurably faster at
    the top than the bottom: `z(t)` is curved and `v` is not constant. Drawing
    the chord would show a model nobody wrote -- and would hide the one place
    the sheet's atmosphere does real work.

    `a` is null throughout, because a terminal-velocity model has no
    acceleration, and `F_T` is null because the loads are discrete events
    rather than a history -- both ride in `events` and the table instead.
    """
    out = []
    t0 = 0.0
    for i, phase in enumerate(result.phases):
        samples = phase.sample()
        for j, (dt, z, v) in enumerate(samples):
            t = t0 + dt
            # Nudge only the first sample of a later leg -- see _STEP_EPS.
            if i > 0 and j == 0:
                t += _STEP_EPS
            out.append({"t": t, "z": z, "v": -v, "a": None, "F_T": None,
                        "CdS_tot": phase.CdS})
        t0 += phase.t_descent
    return out


def _mastersheet_reported(result):
    """The points the workbook itself puts a number on.

    The smooth curve in `_mastersheet_trajectory` is a *reconstruction*: it
    re-enters the sheet's own closed form at intermediate altitudes the sheet's
    authors never evaluated. That is legitimate -- it is their function -- but
    it is not the same thing as a cell somebody read off and designed against,
    and a chart that shows only the curve invites the reader to treat every
    point on it as reported.

    So these get drawn as dots on top of the line, and they are exactly what a
    yellow or blue cell in the workbook holds: each canopy's deployment
    altitude and the terminal speed there, plus the landing speed at the end.
    Everything between two dots is interpolation.
    """
    out = []
    t = 0.0
    for i, phase in enumerate(result.phases):
        out.append({"t": t, "z": phase.z_deploy, "v": -phase.v_terminal,
                    "a": None, "F_T": None, "CdS_tot": phase.CdS})
        t += phase.t_descent
        if i == len(result.phases) - 1:
            # The landing speed is its own reported cell, and it is NOT the
            # deployment terminal speed -- it is re-evaluated at ground density.
            out.append({"t": t, "z": phase.z_end,
                        "v": -result.impact_velocity, "a": None, "F_T": None,
                        "CdS_tot": phase.CdS})
    return out


def _mastersheet_events(result):
    """The discrete opening loads, as markers rather than a line."""
    events = []
    t = 0.0
    for phase in result.phases:
        events.append({
            "t": t,
            "device": phase.name,
            "z": phase.z_deploy,
            "v_deploy": phase.v_deploy,
            "F_inf": phase.F_inf,
            "F_reduced": phase.F_reduced,
            "X": phase.X,
        })
        t += phase.t_descent
    return events


@router.post("/crosscheck")
def run_crosscheck(config: Config, wind: float = Query(0.0, ge=0.0)):
    """Run all three models on one config.

    `wind` feeds the mastersheet's drift estimate only. Our descent and the
    OpenRocket one are windless either way -- Phase 1 has no wind (§3, §14) and
    the OpenRocket port is run without it so the two trajectories stay
    comparable.
    """
    try:
        atm = Atmosphere(config.site.z_site, config.site.T_pad,
                         config.site.p_pad, config.site.lapse)
        comparison = crosscheck(config, which="axial", wind_ms=wind, atm=atm)
    except ValueError as exc:
        # A physics-level rejection is a real answer about the config, not a
        # server fault: a trigger at exactly apogee, canopy masses over the
        # vehicle mass, or a config where nothing deploys and the mastersheet
        # model therefore has no phases.
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    ours = comparison.ours
    theirs = comparison.openrocket
    sheet = comparison.mastersheet

    return {
        "git_sha": git_sha(),
        "openrocket_version": {
            "release": OPENROCKET_RELEASE,
            "commit": OPENROCKET_COMMIT,
        },
        "which": comparison.which,
        "wind": wind,
        "metrics": [m.as_dict() for m in comparison.metrics],
        # Split deliberately. `shared` is what all three take for granted and
        # `differs` is where they part company -- keeping them apart is what
        # lets a reader scan for disagreement without filtering out the eight
        # lines everyone agrees on. `warnings` stays separate again: those are
        # about *this config*, not about the models.
        "assumptions": {
            "shared": list(SHARED_ASSUMPTIONS),
            "differs": [dict(row) for row in MODEL_DIFFERENCES],
        },
        "warnings": comparison.warnings,
        "models": {
            "ours": {
                "label": "This tool",
                "trajectory": _our_trajectory(ours.run),
                "events": build_events(ours.run),
                "computes_load": True,
            },
            "openrocket": {
                "label": "OpenRocket %s" % OPENROCKET_RELEASE,
                "trajectory": _openrocket_trajectory(theirs),
                "events": [
                    {"t": c.t_deploy, "device": c.name, "z": None,
                     "v_deploy": c.v_deploy, "F_inf": None,
                     "F_reduced": None, "X": None}
                    for c in theirs.canopies if c.t_deploy is not None
                ],
                # The flag the UI keys off to render "not computed" instead of
                # an empty chart on the tension channel.
                "computes_load": False,
                "coast_CdS": theirs.CdS_coast,
            },
            "mastersheet": {
                "label": "Recovery mastersheet",
                "trajectory": _mastersheet_trajectory(sheet),
                "events": _mastersheet_events(sheet),
                "computes_load": True,
                # Drawn as dots over the line: the cells the workbook actually
                # holds, as opposed to the closed form reconstructed between
                # them. See `_mastersheet_reported`.
                "reported": _mastersheet_reported(sheet),
                # Their own never-called DESCENT_TIME, for the warning the UI
                # shows next to descent time.
                "descent_time_layered": sheet.descent_time_layered,
            },
        },
    }
