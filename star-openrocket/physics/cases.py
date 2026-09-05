"""Off-nominal cases and the corner sweep. PLAN.md §11.5, §11.9.

Sizing to the nominal sequence hides single-point failures, so three
off-nominal cases are computed on **every** run and presented alongside it.
They are not optional and not a separate mode -- a report that shows only the
nominal case is the failure §11.5 exists to prevent.

Each fails in a *different category*, which is why no single pass/fail number
covers them:

    1. simultaneous   fails on drift      (2.7x descent time)
    2. main fails     fails on impact     (17x nominal KE)
    3. drogue fails   fails on structure  (17x nominal load)
"""

import copy
import itertools

from physics.loads import design_load, device_loads
from physics.schema import Trigger, TriggerKind
from physics.solver import integrate

CASES = ("nominal", "simultaneous", "no_main", "no_drogue")


def _primary(devices):
    """The 'main': the largest drag area. §6.1.1 is explicit that a drogue is
    just a device with a small CdS that happens to deploy first, so identify
    by size rather than by name."""
    return max(devices, key=lambda d: d.CdS)


def _first_to_fire(devices):
    """The device whose trigger comes earliest. TIME triggers are compared on
    seconds, ALTITUDE on descending altitude, and a TIME trigger sorts first
    because the run starts at apogee."""
    def key(d):
        if d.trigger.kind is TriggerKind.TIME:
            return (0, d.trigger.value)
        return (1, -d.trigger.value)

    return min(devices, key=key)


def build_case(devices, case):
    """Return the device list for one §11.5 case. Never mutates the input."""
    devices = [copy.deepcopy(d) for d in devices]
    if case == "nominal" or len(devices) < 2:
        return devices

    main = _primary(devices)
    first = _first_to_fire(devices)

    if case == "simultaneous":
        # The main fires at the drogue's trigger, near apogee.
        main.trigger = Trigger(kind=first.trigger.kind, value=first.trigger.value)
        main.delay = first.delay
        return devices
    if case == "no_main":
        return [d for d in devices if d is not main]
    if case == "no_drogue":
        return [main]
    raise ValueError("unknown case %r" % case)


class CaseResult:
    __slots__ = ("case", "which", "run", "per_device", "design")

    def __init__(self, case, which, run, per_device, design):
        self.case, self.which, self.run = case, which, run
        self.per_device, self.design = per_device, design


def evaluate(config, which="axial", case="nominal", atm=None):
    """Integrate one case and attach its loads."""
    devices = build_case(config.devices, case)
    run = integrate(config, which=which, devices=devices, atm=atm,
                    label="%s/%s" % (case, which))
    per_device = [device_loads(d, s, run.m, run.m_b, run.traj)
                  for d, s in zip(run.devices, run.states)]
    Cx_max = max((d.Cx for d in run.devices), default=1.0)
    F_T_max = float(run.traj.F_T.max()) if len(run.traj.t) else None
    design = design_load(per_device, F_T_max, Cx_max, config.hardware)
    return CaseResult(case, which, run, per_device, design)


def evaluate_all(config, which="axial"):
    """The four §11.5 cases. Under 100 ms all in, so they ride along in the
    live tier rather than hiding behind a button nobody presses."""
    from physics.atmosphere import Atmosphere

    atm = Atmosphere(config.site.z_site, config.site.T_pad,
                     config.site.p_pad, config.site.lapse)
    return {c: evaluate(config, which, c, atm=atm) for c in CASES}


# --- §11.9 corner sweep ----------------------------------------------------



# Which object each swept key lives on. `CdS_body` is deliberately absent
# from both: it has no config field at all (§6.4 keeps it derived so the GUI
# cannot collapse the attitude band), so it is passed to the solver directly.
PER_DEVICE_KEYS = ("Cx", "n", "v_rel", "delay")
VEHICLE_KEYS = ("m",)


def default_sweep(config):
    """The canonical corner set for this vehicle, as `SweepParam` records.

    `CdS_body`'s bounds are computed from the airframe rather than written
    down, so they cannot disagree with the vehicle above them. Everything else
    is the §15.7 band.
    """
    from physics.devices import airframe_band
    from physics.schema import SweepKey, SweepParam

    axial, broadside = airframe_band(config.vehicle.d_body,
                                     config.vehicle.l_body)
    return [
        SweepParam(key=SweepKey.Cx, low=1.2, high=1.8),
        SweepParam(key=SweepKey.n, low=6.0, high=12.0),
        SweepParam(key=SweepKey.CdS_body, low=axial, high=broadside),
        SweepParam(key=SweepKey.v_rel, low=5.0, high=20.0),
        # Charge-to-line-stretch lag. 0 is free-packed; 1.0 s is the slow end
        # of the 0.3-1.0 s a bag extraction plausibly takes, and nobody has
        # measured it for this hardware -- an uncertainty, not a design choice.
        #
        # §15.7 ranks it THIRD, above both v_rel and n, and the original
        # 16-corner set swept those two while omitting this one. For a main
        # deployed from a stabilised drogue descent it changes nothing (the
        # vehicle is already at terminal, so an extra half-second only opens
        # it ~11 m lower), but on a drogue it doubles the opening load,
        # because the vehicle keeps accelerating on airframe drag until the
        # canopy sees air. It therefore only reaches F_design on a
        # drogue-governed design -- exactly the case a sweep would miss.
        SweepParam(key=SweepKey.delay, low=0.0, high=1.0),
        # Off by default. Mass is *measurable*, so unlike the five above it is
        # a tolerance rather than an unknown; sweeping it by default would
        # double the run count to describe a quantity you can put on a scale.
        SweepParam(key=SweepKey.m, enabled=False,
                   low=config.vehicle.m * 0.95, high=config.vehicle.m * 1.05),
    ]


def resolve_corners(config):
    """The corner values per key: {key: (value, ...)}, enabled entries only.

    Order is the caller's, so the corner dicts and the run order are stable
    and diffable between two runs of the same spec.
    """
    spec = default_sweep(config) if config.sweep is None else config.sweep
    return {p.key.value: p.bounds for p in spec if p.enabled}


def _attitude(CdS_body, config):
    """Name the airframe corner. §6.4's two bounds have names worth keeping in
    the report; anything else a caller pins is honestly labelled 'custom'."""
    from physics.devices import airframe_band

    axial, broadside = airframe_band(config.vehicle.d_body,
                                     config.vehicle.l_body)
    if abs(CdS_body - axial) <= 1e-12:
        return "axial"
    if abs(CdS_body - broadside) <= 1e-12:
        return "broadside"
    return "custom"


def sweep(config, case="nominal"):
    """Corner-sweep the genuinely-unknown parameters and take the worst.

    Phase 1 has no random inputs, so this is a sweep and not a sample; Monte
    Carlo belongs in Phase 2 with wind.

    The per-device parameters are swept **in common across devices**, not
    independently. They are the same unmeasured physics appearing in several
    places, so a corner where the drogue sits at Cx = 1.2 while the main sits
    at 1.8 is not a physical case -- and sweeping independently would inflate
    32 runs to 2^(4N+2) for no added coverage. A *disabled* parameter is the
    one case where devices may differ, because then each simply keeps the
    value its own config carries.

    Which corners get visited comes from `config.sweep`; see `default_sweep`
    for what None means. Run count is the product of the enabled bounds, so
    2^5 = 32 by default and 64 with mass turned on.
    """
    from physics.atmosphere import Atmosphere
    from physics.devices import airframe_band

    atm = Atmosphere(config.site.z_site, config.site.T_pad,
                     config.site.p_pad, config.site.lapse)
    corners = resolve_corners(config)
    keys = list(corners)

    # The airframe bound used when attitude is NOT swept. Axial, because it is
    # the conservative one for load -- and it is the same default `integrate`
    # applies, so disabling the parameter does not quietly move the answer.
    axial = airframe_band(config.vehicle.d_body, config.vehicle.l_body)[0]

    out = []
    for combo in itertools.product(*(corners[k] for k in keys)):
        corner = dict(zip(keys, combo))

        cfg = config
        if any(k in corner for k in VEHICLE_KEYS):
            cfg = config.model_copy(deep=True)
            for k in VEHICLE_KEYS:
                if k in corner:
                    setattr(cfg.vehicle, k, corner[k])

        devices = build_case(cfg.devices, case)
        for d in devices:
            for k in PER_DEVICE_KEYS:
                if k in corner:
                    setattr(d, k, corner[k])

        CdS_body = corner.get("CdS_body", axial)
        which = _attitude(CdS_body, config)
        run = integrate(cfg, which=which, devices=devices, atm=atm,
                        label=str(corner), CdS_body=CdS_body)
        per_device = [device_loads(d, s, run.m, run.m_b, run.traj)
                      for d, s in zip(run.devices, run.states)]
        F_T_max = float(run.traj.F_T.max()) if len(run.traj.t) else None
        # eq (21a) needs the largest Cx in play. When Cx is swept that is the
        # corner value; when it is not, devices may carry different ones.
        Cx_max = corner.get("Cx", max((d.Cx for d in devices), default=1.8))
        design = design_load(per_device, F_T_max, Cx_max, cfg.hardware)
        out.append((corner, CaseResult(case, which, run, per_device, design)))
    return out


def worst(sweep_results):
    """The structurally governing corner: highest design load.

    Kept for callers that only want the load. **It is not "the worst corner"**
    -- see `worst_by_category`, because the corner that maximises load is not
    the corner that maximises descent time.
    """
    return max(sweep_results, key=lambda cr: cr[1].design.F_design or 0.0)


def _impact_ke(cr):
    return 0.5 * cr.run.m * cr.run.v_impact ** 2


# What each category is measured by. Mirrors §11.5's second table: each
# category is decided by a different metric, so each has its own worst corner.
METRICS = {
    "structure": ("F_design", "N", lambda cr: cr.design.F_design or 0.0),
    "drift": ("descent time", "s", lambda cr: cr.run.t_ground),
    "impact": ("impact KE", "J", _impact_ke),
}


def irrelevant_parameters(sweep_results, metric, tol=1e-9):
    """Swept parameters that do not move this metric's maximum.

    Without this, `max()` breaks ties arbitrarily and the report names a value
    that had no bearing on the answer -- e.g. printing `v_rel: 5.0` as the
    governing corner when F_design is identical at 5 and 20 because the
    infinite-mass bound governs and snatch never enters. A reader would take
    that as "v_rel = 5 is the dangerous case", which is exactly backwards.
    """
    if not sweep_results:
        return []

    # Derived from the corners actually visited, not from a module-level
    # table. The sweep is configurable (`config.sweep`), so a fixed list would
    # report a parameter as irrelevant that this run never swept at all.
    out = []
    for key in sweep_results[0][0]:
        peaks = []
        for value in sorted({c[key] for c, _ in sweep_results}):
            subset = [cr for c, cr in sweep_results if c[key] == value]
            peaks.append(max((metric(cr) for cr in subset), default=0.0))
        if len(peaks) < 2:
            continue  # pinned to one value: it did not vary, so say nothing
        if max(peaks) - min(peaks) <= tol * max(1.0, abs(max(peaks))):
            out.append(key)
    return out


def worst_by_category(sweep_results):
    """The governing corner for **each** failure category.

    §11.5 establishes that each case fails in a different category, so no
    single pass/fail number covers them. The same is true across the corners,
    and more sharply: for the worked vehicle the structural worst case is the
    *axial* airframe bound while the drift worst case is *broadside* -- the
    opposite corner. Reporting only the load winner states the airframe is
    nose-down while the descent-time risk lives at the other bound.
    """
    out = {}
    for name, (label, unit, metric) in METRICS.items():
        corner, result = max(sweep_results, key=lambda cr: metric(cr[1]))
        out[name] = {
            "corner": corner,
            "result": result,
            "metric": label,
            "unit": unit,
            "value": metric(result),
            "irrelevant": irrelevant_parameters(sweep_results, metric),
        }
    return out


def governing_candidates(sweep_results):
    """How many corners each eq (36) candidate governs.

    A design whose governing candidate *changes* across the sweep is worth
    knowing about: for the worked vehicle the bound governs at Cx = 1.8 and
    snatch governs at Cx = 1.2, so the fix that helps depends on which
    corner you believe.
    """
    counts = {}
    for _, cr in sweep_results:
        key = "%s / %s" % (cr.design.governing_device,
                           cr.design.governing_candidate)
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))
