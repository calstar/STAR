"""Design studies: comparing choices, not uncertainties.

The §11.9 corner sweep in `cases.py` asks **how much of this answer is
actually known** -- it perturbs the parameters nobody has measured (Cx, n,
delay, v_rel, the airframe attitude band) to their endpoints, in common across
every device, and reports the governing corner. That is a question about
ignorance.

This asks the other question: **which design is better.** It varies things the
designer picks -- which canopy, how high the main comes out, how heavy the
vehicle ended up -- over a grid or an explicit list, applied to one named
device, and reports the four summary figures for each. Nothing here is a
bound; every point is a vehicle somebody could actually build.

The two differ in every dimension (endpoints vs a grid, in-common vs
per-device, all four §11.5 cases vs nominal only), which is why this is its own
module and its own request rather than more keys on `SweepParam`.
"""

import itertools

from pydantic import ValidationError

from physics.cases import evaluate

# The run count is the product of the axes, so it grows fast enough that a cap
# has to exist somewhere. 20 is chosen at the *display* end rather than the
# compute end: 20 integrations is under a second, but 20 lines is already more
# than one set of axes can carry, and the tab draws them all on one.
MAX_RUNS = 20

# Where each key lives. Mirrors `cases.PER_DEVICE_KEYS`/`VEHICLE_KEYS` in
# shape, so there is one place per module that says which object a key is an
# attribute of -- and `schema.StudyAxis` reads VEHICLE_KEYS from here rather
# than keeping a second copy that could disagree.
VEHICLE_KEYS = ("m", "h_a", "d_body", "l_body")
DEVICE_KEYS = ("CdS", "D0", "m_c", "j", "n", "Cx", "delay", "v_rel", "k_eff",
               "trigger", "canopy")

# The four fields one catalogue row supplies. NOT everything on a device: n,
# Cx, delay, v_rel, k_eff and the trigger are properties of how you deploy it
# and how it was packed, not of what the vendor sells, so swapping canopies
# leaves them alone.
CANOPY_FIELDS = ("CdS", "D0", "m_c", "j")


def axis_values(axis):
    """The values one axis takes, in order.

    Linear is inclusive of BOTH ends -- `points` is how many values you get,
    not how many gaps. 5 points from 800 to 2000 is 800, 1100, 1400, 1700,
    2000; a reader who asks for the range 800-2000 and gets 1760 as the top
    would have to work out why. `points == 1` is the start, which makes pinning
    an axis cost a factor of one rather than being a special case.

    `frontend/src/lib/study.ts` computes this identically, because the GUI
    shows the resolved grid before the backend ever runs. The two are held
    together by a shared case table in `tests/test_study.py` and
    `lib/study.test.ts`.
    """
    from physics.schema import StudyKey, StudyMode

    if axis.mode is StudyMode.LIST:
        if axis.key is StudyKey.canopy:
            return list(axis.canopies)
        return list(axis.values)

    if axis.points == 1:
        return [axis.start]
    step = (axis.stop - axis.start) / (axis.points - 1)
    # The last point is the stop VERBATIM, not start + (n-1)*step. Floating
    # point makes those differ in the last digit, and a sweep whose top value
    # reads 1999.9999999999998 in the table looks like a bug in the physics.
    return [axis.start + i * step for i in range(axis.points - 1)] + [axis.stop]


def enabled_axes(config):
    """The study's enabled axes. Empty when there is no study."""
    return [a for a in (config.study or []) if a.enabled]


def run_count(config):
    """How many designs this study describes."""
    n = 1
    for axis in enabled_axes(config):
        n *= len(axis_values(axis))
    return n


def _device(devices, name):
    for d in devices:
        if d.name == name:
            return d
    # Unreachable through the API -- Config._hard_errors checks this first --
    # but a direct library caller can construct one, and a silent no-op would
    # report a study that never varied anything.
    raise ValueError("no device named %r" % name)


def _apply(cfg, axis, value):
    """Set one axis's value on a (already-copied) config."""
    from physics.schema import StudyKey

    key = axis.key
    if key.value in VEHICLE_KEYS:
        setattr(cfg.vehicle, key.value, value)
        return

    device = _device(cfg.devices, axis.device)
    if key is StudyKey.canopy:
        for field in CANOPY_FIELDS:
            setattr(device, field, getattr(value, field))
    elif key is StudyKey.trigger:
        # The value only. Changing ALTITUDE to TIME would be a different
        # deployment scheme, not a point on an axis.
        device.trigger.value = value
    elif key is StudyKey.j:
        setattr(device, "j", int(value))
    else:
        setattr(device, key.value, value)


def _label(axis, value):
    """What this axis's value is called, for the point's `values` map."""
    from physics.schema import StudyKey

    return value.label if axis.key is StudyKey.canopy else value


def _describe(values):
    """One design point in words, for an error message: `main trigger=2000`."""
    return ", ".join("%s=%s" % (k, v) for k, v in values.items())


def current_value(config, axis):
    """What this axis is set to in the config as it stands.

    So the reference row of the table can say where the current design sits on
    each axis rather than leaving the columns blank. Without it "current
    config" is a row of four numbers with nothing to attach them to, and the
    common case -- the fitted canopy IS one of the ones being compared -- is
    invisible.

    Canopies return the LABEL of whichever compared canopy the device matches,
    or None when the fitted one is not among them. The comparison is on the
    four fields the swap actually sets, because that is what "the same canopy"
    means here: two rows with the same drag area, diameter, mass and cloth type
    are the same design point whatever the vendor calls them.
    """
    from physics.schema import StudyKey

    if axis.key.value in VEHICLE_KEYS:
        return getattr(config.vehicle, axis.key.value)

    device = _device(config.devices, axis.device)
    if axis.key is StudyKey.trigger:
        return device.trigger.value
    if axis.key is StudyKey.canopy:
        for canopy in axis.canopies or []:
            if all(getattr(canopy, f) == getattr(device, f)
                   for f in CANOPY_FIELDS):
                return canopy.label
        return None
    return getattr(device, axis.key.value)


def run_points(config, atm=None):
    """Every design in the study: [(values, CaseResult)], in product order.

    Nominal case, axial airframe -- the /api/simulate defaults. A study
    compares designs against each other, so the off-nominal cases would
    multiply the run count by four to answer a question the Recovery tab
    already answers for each design individually.

    Order is `itertools.product` over the axes in the caller's order, which is
    stable, so point 7 is the same design on every request for the same spec
    and the GUI can key colour and selection off the index.
    """
    from physics.atmosphere import Atmosphere
    from physics.schema import Config

    if atm is None:
        atm = Atmosphere(config.site.z_site, config.site.T_pad,
                         config.site.p_pad, config.site.lapse)

    axes = enabled_axes(config)
    grids = [axis_values(a) for a in axes]

    out = []
    for combo in itertools.product(*grids):
        cfg = config.model_copy(deep=True)
        for axis, value in zip(axes, combo):
            _apply(cfg, axis, value)

        values = {a.key.value: _label(a, v) for a, v in zip(axes, combo)}

        # Re-validate the MUTATED config, not just the one that was posted.
        # This is what makes a deploy-altitude sweep safe: `_hard_errors`
        # rejects a trigger above apogee, and without this step a study that
        # walked the main's altitude past 3000 ft would quietly produce points
        # where the device never fires -- a descent under drogue alone,
        # reported as if it were the design asked for.
        #
        # The point is named in the message. "above apogee" alone leaves the
        # reader to work out which of twenty designs is the illegal one, and
        # it is nearly always the top of exactly one axis.
        try:
            cfg = Config.model_validate(cfg.model_dump())
        except ValidationError as exc:
            raise ValueError(
                "design %s is not a valid vehicle: %s"
                % (_describe(values), "; ".join(
                    e["msg"].replace("Value error, ", "")
                    for e in exc.errors()))) from exc

        out.append((values, evaluate(cfg, "axial", "nominal", atm=atm)))
    return out
