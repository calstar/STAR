"""Map internal results onto the wire contract the frontend builds against.

`frontend/src/types/schema.ts` declared a provisional `Result` shape before the
physics existed, and marked it "reconciled when the real thing lands". This is
that reconciliation. Where the frontend's names differ from the library's
internal ones, **the wire name wins** -- there is UI already written against it
and renaming would break a running app to no benefit:

    wire                    internal
    device                  DeviceLoads.name
    F_peak                  DeviceLoads.F_pflanz    (eq 28, finite-mass)
    F_num                   DeviceLoads.F_T_peak    (eq 21a, integrated peak)
    t_fill                  DeviceLoads.t_f         (eq 10)
    below_validity_floor    not DeviceLoads.bound_valid

That mapping lives here and nowhere else, so the library keeps the names its
equations use and the API keeps the names the UI uses.
"""

import datetime as dt
import os
import subprocess

import numpy as np

from physics.devices import airframe_band
from physics.loads import equivalent_height, impact_energy

SCHEMA_VERSION = "1.0.0"

# §11.6 wire format. A 168 s descent at 5 ms is 33,600 points -- megabytes of
# JSON and a sluggish chart. Full resolution only where the curvature is.
FINE_DT = 0.002
COARSE_DT = 0.100
EVENT_WINDOW = 0.5

# The corner sweep sends up to 32 trajectories in one response, so it pays the
# above 32 times over: 1148 points per run is 3.2 MB and ~37k points for the
# chart to draw. These are the same rules at a coarser grid -- measured at 365
# points per run, 1.0 MB, which is a chart that stays interactive when every
# corner is selected.
#
# Safe to coarsen because the sweep view is a *comparison* between corners, not
# the load analysis: §8.1's <=5 ms sampling still happens in `_resample`, this
# only thins what crosses the wire, and `resample_for_wire` force-keeps the
# tension peak regardless of stride.
SWEEP_FINE_DT = 0.010
SWEEP_COARSE_DT = 0.250
SWEEP_EVENT_WINDOW = 0.3

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git_sha():
    """§11.4: when a number from this tool reaches a design review, which
    version of the physics produced it must be recoverable."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=_REPO_ROOT, capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


def build_events(run):
    """Flight events for the chart's vertical markers.

    Note `line_stretch` IS inflation start -- they are the same instant in this
    model (eq 11, tau = 0), so no separate `inflation_start` is emitted. The
    frontend's enum allows both; emitting one event twice would just draw two
    markers on the same line.
    """
    events = [{
        "t": 0.0, "kind": "start", "device": None,
        "z": float(run.traj.z[0]) if len(run.traj.t) else 0.0,
        "v": float(run.traj.v[0]) if len(run.traj.t) else 0.0,
        "label": "apogee",
    }]

    for device, state in zip(run.devices, run.states):
        if state.t_x is not None:
            events.append({
                "t": state.t_x, "kind": "trigger", "device": device.name,
                "z": _z_at(run, state.t_x), "v": _v_at(run, state.t_x),
                "label": "%s charge" % device.name,
            })
        if state.stretched:
            events.append({
                "t": state.t_d, "kind": "line_stretch", "device": device.name,
                "z": state.z_d, "v": -state.v_s,
                "label": "%s line stretch" % device.name,
            })
            t_full = state.t_d + state.t_f
            if t_full <= run.t_ground:
                events.append({
                    "t": t_full, "kind": "inflation_end", "device": device.name,
                    "z": _z_at(run, t_full), "v": _v_at(run, t_full),
                    "label": "%s inflated" % device.name,
                })

    events.append({
        "t": run.t_ground, "kind": "ground", "device": None,
        "z": 0.0, "v": -run.v_impact, "label": "ground",
    })
    events.sort(key=lambda e: e["t"])
    return events


def _z_at(run, t):
    if not len(run.traj.t):
        return 0.0
    return float(np.interp(t, run.traj.t, run.traj.z))


def _v_at(run, t):
    if not len(run.traj.t):
        return 0.0
    return float(np.interp(t, run.traj.t, run.traj.v))


def resample_for_wire(run, events, fine_dt=FINE_DT, coarse_dt=COARSE_DT,
                      window=EVENT_WINDOW):
    """§11.6: 2 ms within +/-0.5 s of each event, 100 ms elsewhere.

    The load *analysis* still runs on the full <=5 ms grid (§8.1) -- this only
    thins what crosses the wire, so a peak can never be lost by decimation.

    The three resolutions are arguments so the corner sweep can ask for a
    coarser grid (SWEEP_* above) without a second copy of this function. The
    defaults are what /api/simulate has always used, so its output is
    unchanged.
    """
    t = run.traj.t
    if not len(t):
        return []

    keep = np.zeros(len(t), dtype=bool)
    keep[0] = keep[-1] = True

    event_times = np.array([e["t"] for e in events], dtype=float)
    near = np.zeros(len(t), dtype=bool)
    for et in event_times:
        near |= np.abs(t - et) <= window

    # Greedy stride: walk forward, keeping a sample whenever enough time has
    # passed for the local resolution.
    last = t[0]
    for i in range(1, len(t)):
        want = fine_dt if near[i] else coarse_dt
        if t[i] - last >= want:
            keep[i] = True
            last = t[i]

    # Never drop the sample carrying the tension peak.
    if len(run.traj.F_T):
        keep[int(np.argmax(run.traj.F_T))] = True

    idx = np.flatnonzero(keep)
    return [
        {
            "t": float(t[i]),
            "z": float(run.traj.z[i]),
            "v": float(run.traj.v[i]),
            "a": float(run.traj.a[i]),
            "F_T": float(run.traj.F_T[i]),
            "CdS_tot": float(run.traj.CdS[i]),
        }
        for i in idx
    ]


def device_loads_payload(per_device):
    out = []
    for dl in per_device:
        if not dl.fired:
            continue
        out.append({
            "device": dl.name,
            "v_s": dl.v_s,
            "A": dl.A,
            "X1": dl.X1,
            "F_inf": dl.F_inf,
            "F_peak": dl.F_pflanz,     # eq (28), the finite-mass expectation
            "F_num": dl.F_T_peak,      # eq (21a), integrated peak (gravity + drag)
            "F_snatch": dl.F_snatch,
            "t_fill": dl.t_f,          # eq (10)
            "below_validity_floor": not dl.bound_valid,
        })
    return out


def case_status(case, cr, hardware):
    """§11.5: each case fails in a *different* category, so no single pass/fail
    covers them. Only the structural cases have a declared threshold.

    'na' where the category has no allowable -- the impact and drift categories
    do not, because nothing in the schema declares a maximum landing energy or
    a recovery-zone radius. Inventing one here would be a verdict the user
    never asked for. §4.2: without hardware the tool reports loads, with it a
    verdict.
    """
    if case in ("nominal", "no_drogue"):
        if hardware is None or cr.design.F_allow is None:
            return "na"
        return "pass" if cr.design.passes else "fail"
    return "na"


def build_case(case, cr, hardware):
    run = cr.run
    events = build_events(run)
    F_max = float(run.traj.F_T.max()) if len(run.traj.t) else 0.0
    return {
        "case": case,
        "trajectory": resample_for_wire(run, events),
        "events": events,
        "device_loads": device_loads_payload(cr.per_device),
        "descent_time": run.t_ground,
        "impact_velocity": run.v_impact,
        "impact_ke": impact_energy(run.m, run.v_impact),
        "h_equiv": equivalent_height(run.v_impact),
        "F_max": F_max,
        # The eq (36) max BEFORE the safety factor: the load the hardware
        # actually sees. F_design is that number times SF -- a margin the
        # designer chose, not a prediction -- so both go on the wire and the
        # GUI leads with the physical one. This is also the number
        # `case_status` compares against F_allow, since F_allow already
        # carries SF.
        "F_peak_max": cr.design.governing_value or 0.0,
        "safety_factor": cr.design.safety_factor,
        "F_design": cr.design.F_design or 0.0,
        "status": case_status(case, cr, hardware),
        "governing_link": cr.design.governing_link,
        # Beyond the frontend's provisional shape, but cheap and load-bearing:
        # eq (36) is a max over three candidates and the report has to name
        # which one, or a design limited by drogue snatch looks identical to
        # one limited by main opening.
        "governing_device": cr.design.governing_device,
        "governing_candidate": cr.design.governing_candidate,
    }


def build_result(config, results, atm, which, warnings):
    """Assemble the full `Result` the frontend expects."""
    # Always present: the airframe band is derived from geometry, never
    # entered, so there is no configuration in which only one bound exists.
    # §6.4 requires both be visible, and the response is where that is
    # enforced for the GUI.
    axial, broadside = airframe_band(config.vehicle.d_body,
                                     config.vehicle.l_body)
    band = {"axial": axial, "broadside": broadside,
            "ratio": broadside / axial}

    all_warnings = list(warnings)
    for case, cr in results.items():
        for w in cr.run.warnings:
            all_warnings.append("%s: %s" % (case, w))

    return {
        "schema_version": SCHEMA_VERSION,
        "git_sha": git_sha(),
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="seconds"),
        "config": config.model_dump(mode="json"),
        "warnings": all_warnings,
        "cases": {c: build_case(c, cr, config.hardware)
                  for c, cr in results.items()},
        "pad": {
            "p_pad": atm.p_pad,
            "T_pad": atm.T_pad,
            "rho_pad": atm.rho(0.0),
            "source": ("standard column"
                       if config.site.p_pad is None else "supplied"),
            "lapse": atm.L0,
        },
        "body_drag_band": band,
        # Which bound this Result was computed at. The band above says what the
        # alternative would have been; §6.4 forbids presenting one silently.
        "airframe_bound": which,
    }
