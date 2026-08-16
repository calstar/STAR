"""Three models, one config. PLAN.md §2, turned into numbers.

This module runs our physics, the OpenRocket port and the mastersheet port
against the same `Config` and lines their answers up. It is a **comparison
surface, not a design surface**: `F_design`, the off-nominal cases and the
corner sweep all live elsewhere, and nothing here may size hardware.

Why it exists: PLAN.md §2 asserts three defects in OpenRocket's descent model
and the README repeats them, but neither has ever produced a number. Likewise
the team's mastersheets have sized real flight hardware and have never been
checked against anything. A claim in prose that nobody can reproduce is worth
about as much as no claim at all.

The awkward part, and where the honesty lives
---------------------------------------------
The three models do not compute the same quantities, and the differences are
not symmetric:

  * OpenRocket computes **no opening load at all** -- not a zero, an absence
    (§2, defect 2). Every load row must render as "not computed" or the missing
    number reads as a passing one.
  * The mastersheet computes loads but **no trajectory in time** -- it assumes
    terminal velocity everywhere, so `a(t)` does not exist and its `z(t)` is a
    closed form rather than an integration.
  * Only the mastersheet has wind, so only it has drift.

`Metric.values` therefore carries `None` for "this model does not compute
this", and `Metric.note` says why. A caller that renders `None` as `0` has
turned an absence into a measurement, which is the single worst thing this
comparison could do.
"""

from physics import mastersheet as ms
from physics import openrocket as orx
from physics.cases import evaluate
from physics.constants import G0

# What each model is called on screen and in the CLI. Fixed order: ours first,
# because the other two are being compared *to* it.
MODELS = ("ours", "openrocket", "mastersheet")


# What every model here takes for granted. Listing these once, rather than
# three times over, is what makes the differences table below readable: a
# reader scanning for "where do these disagree" should not have to filter out
# eight lines they agree on.
SHARED_ASSUMPTIONS = (
    "1-D vertical descent - no horizontal motion, drift or dispersion.",
    "Point mass. No attitude, rotation, canopy oscillation or recontact.",
    "Constant mass throughout.",
    "Every device hangs off one attachment point.",
    "Dry air.",
)


# Where they actually differ. One row per aspect, one column per model, so the
# comparison is a table rather than three lists the reader has to diff by eye.
MODEL_DIFFERENCES = (
    {
        "aspect": "Deployment",
        "ours": "Finite filling time.",
        "openrocket": "Instantaneous; opens low (0.5 s step).",
        "mastersheet": "Instantaneous.",
    },
    {
        "aspect": "Descent",
        "ours": "Adaptive RK45; every speed integrated.",
        "openrocket": "Forward Euler, 0.5 s step.",
        "mastersheet": "Terminal velocity assumed.",
    },
    {
        "aspect": "Airframe drag",
        "ours": "Kept for the whole descent.",
        "openrocket": "Dropped once a canopy is out.",
        "mastersheet": "Never included.",
    },
    {
        "aspect": "Opening load",
        "ours": "Infinite-mass bound + Pflanz.",
        "openrocket": "Not computed.",
        "mastersheet": "Bound times a hand-entered factor.",
    },
    {
        "aspect": "Snatch load",
        "ours": "Series-spring harness.",
        "openrocket": "Not computed.",
        "mastersheet": "Not computed.",
    },
    {
        "aspect": "Atmosphere",
        "ours": "Re-fit to measured pad state.",
        "openrocket": "Same re-fit, sampled onto a table.",
        "mastersheet": "Sea-level column; no pad data.",
    },
    {
        "aspect": "Gravity",
        "ours": "9.807 m/s², inverse-square.",
        "openrocket": "WGS84; varies with lat/alt.",
        "mastersheet": "32.174 ft/s², constant.",
    },
    {
        "aspect": "Wind",
        "ours": "Coupled: air-relative airspeed at each deploy (loads) + ground track.",
        "openrocket": "None (ported landing stepper is windless).",
        "mastersheet": "Added to drift and first opening speed.",
    },
)


class Metric:
    """One row of the comparison table.

    `kind` must be a `lib/quantities.ts` **Kind** or None. That file
    deliberately has no `time`, `percent` or `angle` -- they have no imperial
    form, so offering a unit choice for them would be a control that does
    nothing -- and a kind the frontend does not know dereferences undefined in
    `unitFor` and takes the whole page down with it. Rows in such a unit carry
    `kind=None` and a literal `unit` string instead.
    `tests/test_api.py::test_crosscheck_metric_kinds_are_ones_the_frontend_knows`
    reads the union straight out of the TypeScript so the two cannot drift.
    """

    __slots__ = ("key", "label", "kind", "unit", "values", "note")

    def __init__(self, key, label, kind, values, note=None, unit=None):
        self.key = key
        self.label = label
        self.kind = kind
        self.unit = unit          # only when kind is None
        self.values = values      # {model: float or None}
        self.note = note

    @property
    def spread(self):
        """Max/min over the models that produced a number, or None.

        Deliberately a ratio rather than a delta against ours: the question the
        tab answers is "how far apart are these three", not "how wrong is
        everyone else", and a ratio survives the unit switcher unchanged.
        """
        got = [v for v in self.values.values() if v is not None]
        if len(got) < 2:
            return None
        lo, hi = min(got), max(got)
        if lo == 0.0:
            return None
        return hi / lo

    def as_dict(self):
        return {
            "key": self.key,
            "label": self.label,
            "kind": self.kind,
            "unit": self.unit,
            "values": dict(self.values),
            "note": self.note,
            "spread": self.spread,
        }


class Comparison:
    __slots__ = ("ours", "openrocket", "mastersheet", "metrics", "warnings",
                 "config", "which", "wind")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


def _deploy_order(config, or_run):
    """Devices in the order they actually deploy, with their altitudes.

    Deployment altitude is straightforward for an ALTITUDE trigger and has no
    closed form for a TIME one, so the TIME case is read off the OpenRocket
    trajectory. That is not a shortcut -- it is exactly what the mastersheets'
    own author did, pasting a velocity and an altitude out of OpenRocket into
    the yellow input cells. Reproducing the sheet means reproducing where its
    inputs came from.
    """
    rows = []
    for canopy in or_run.canopies:
        device = next(d for d in config.devices if d.name == canopy.name)
        if canopy.t_deploy is None:
            continue
        z = _z_at(or_run, canopy.t_deploy)
        rows.append((canopy.t_deploy, device, z, canopy))
    rows.sort(key=lambda r: r[0])
    return rows


def _z_at(run, t):
    """Altitude on the OpenRocket trajectory at time `t`, linearly."""
    ts, zs = run.traj.t, run.traj.z
    if not ts:
        return 0.0
    if t <= ts[0]:
        return zs[0]
    for i in range(1, len(ts)):
        if ts[i] >= t:
            span = ts[i] - ts[i - 1]
            if span <= 0.0:
                return zs[i]
            f = (t - ts[i - 1]) / span
            return zs[i - 1] + (zs[i] - zs[i - 1]) * f
    return zs[-1]


def _v_before(run, t):
    """Speed just before time `t`, for the descent rate under a canopy."""
    ts, vs = run.traj.t, run.traj.v
    best = 0.0
    for i, ti in enumerate(ts):
        if ti >= t:
            break
        best = abs(vs[i])
    return best


def run_mastersheet(config, or_run, wind_ms=0.0, X=1.0):
    """Drive the mastersheet model from our config.

    `X = 1.0` is the infinite-mass column, which is the only one comparable to
    our eq (23) -- the sheets' 0.5-0.8 values are hand-entered guesses at a
    Pflanz factor they never computed, so folding them in here would compare
    our physics against somebody's judgement call.
    """
    order = _deploy_order(config, or_run)
    if not order:
        raise ValueError(
            "no device deploys, so the mastersheet model has no phases to run")

    phases = []
    for i, (_, device, z_deploy, _) in enumerate(order):
        z_end = order[i + 1][2] if i + 1 < len(order) else 0.0
        phases.append((device.name, device.CdS, device.Cx, X, z_deploy, z_end))

    v_first = order[0][3].v_deploy or 0.0
    return ms.evaluate(
        phases_si=phases,
        m_kg=config.vehicle.m,
        ground_elev_m=config.site.z_site,
        v_first_ms=v_first,
        wind_ms=wind_ms,
    )


def crosscheck(config, which="axial", wind_ms=0.0, latitude=None, atm=None):
    """Run all three models and align their answers.

    `which` is the airframe bound for *our* model only. OpenRocket has no
    airframe term after deployment at all, and the mastersheet has none ever,
    so §6.4's band is a property this comparison cannot share -- which is
    itself part of the finding.
    """
    # Wind lives on the config now, so our descent is already wind-aware (it feeds
    # the deployment airspeed -> loads, and the ground track). Drive the mastersheet
    # from the SAME wind so the two wind-aware models are compared like-for-like;
    # OpenRocket stays windless (its ported landing stepper has no wind).
    if config.wind is not None:
        wind_ms = config.wind.to_profile(config.site.z_site).speed(0.0)

    ours = evaluate(config, which=which, case="nominal", atm=atm)
    theirs = orx.simulate(config, latitude=latitude)
    sheet = run_mastersheet(config, theirs, wind_ms=wind_ms)

    or_order = _deploy_order(config, theirs)
    first_deploy = or_order[0][0] if or_order else None
    last_deploy = or_order[-1][0] if or_order else None

    # --- descent rate under the first canopy -------------------------------
    # Measured just before the last deployment, which is where a drogue
    # descent has settled if it is ever going to. The mastersheet's equivalent
    # is its first phase's terminal velocity, by construction.
    ours_drogue = _v_before_ours(ours.run, last_deploy) if last_deploy else None
    or_drogue = _v_before(theirs, last_deploy) if last_deploy else None
    ms_drogue = sheet.phases[0].v_terminal if len(sheet.phases) > 1 else None

    metrics = [
        # Seconds have no imperial form, so no Kind -- see `Metric`.
        Metric("descent_time", "Descent time", None, {
            "ours": ours.run.t_ground,
            "openrocket": theirs.t_ground,
            "mastersheet": sheet.descent_time,
        }, unit="s"),
        Metric("impact_velocity", "Impact velocity", "speed", {
            "ours": ours.run.v_impact,
            "openrocket": theirs.v_impact,
            "mastersheet": sheet.impact_velocity,
        }),
        Metric("impact_ke", "Impact energy", "energy", {
            "ours": 0.5 * ours.run.m * ours.run.v_impact ** 2,
            "openrocket": 0.5 * theirs.m * theirs.v_impact ** 2,
            "mastersheet": sheet.impact_ke,
        }),
        Metric("drogue_rate", "Descent rate under drogue", "speed", {
            "ours": ours_drogue,
            "openrocket": or_drogue,
            "mastersheet": ms_drogue,
        }, note="The phase with the smallest canopy, so the airframe is the "
                "largest share of total drag area - this is where dropping it "
                "shows up."),
        Metric("F_peak", "Peak opening load", "force", {
            "ours": ours.design.governing_value,
            "openrocket": None,
            "mastersheet": sheet.F_peak,
        }, note="OpenRocket computes no opening load at all - an absence, not "
                "a zero. The mastersheet figure is its infinite-mass column, "
                "the one comparable to ours."),
        Metric("peak_decel", "Peak deceleration", "accel", {
            "ours": max((abs(a) for a in ours.run.traj.a), default=None),
            "openrocket": max((abs(a) for a in theirs.traj.a), default=None),
            "mastersheet": None,
        }, note="OpenRocket's figure is an artefact of opening the canopy "
                "between two integration points, not a load prediction."),
        Metric("drift", "Drift in wind", "distance", {
            "ours": None,
            "openrocket": None,
            "mastersheet": sheet.drift,
        }, note="Only the mastersheet models wind - descent time times wind "
                "speed."),
    ]

    warnings = list(config.warnings())
    warnings += ["our model: %s" % w for w in ours.run.warnings]
    warnings += ["OpenRocket: %s" % w for w in theirs.warnings]
    warnings += ["mastersheet: %s" % w for w in sheet.warnings]

    if first_deploy is not None and first_deploy > 0.0:
        warnings.append(
            "Before the first charge, OpenRocket really uses a full "
            "aerodynamic model needing geometry this tool does not carry, so "
            "that stretch runs on our airframe area instead - %.2f s of a "
            "%.1f s descent." % (first_deploy, theirs.t_ground))

    return Comparison(ours=ours, openrocket=theirs, mastersheet=sheet,
                      metrics=metrics, warnings=warnings, config=config,
                      which=which, wind=wind_ms)


def _v_before_ours(run, t):
    """`_v_before`, against our numpy-backed trajectory."""
    best = 0.0
    for i in range(len(run.traj.t)):
        if run.traj.t[i] >= t:
            break
        best = abs(float(run.traj.v[i]))
    return best
