"""OpenRocket's descent model, ported. **This is not our physics.**

A reimplementation of what OpenRocket does between apogee and the ground, kept
so the Cross-check tab can put its numbers next to ours on the same config.
Nothing may import this to produce a design number -- it exists to be compared
against, and PLAN.md §2 lists the three reasons why.

Ported from **release-24.12** (commit 133b558d), the latest full release, and
that pin is load-bearing rather than tidy. The repo's default branch is
`unstable`; its `ExtendedISAModel` has a geopotential-altitude conversion and a
humidity-dependent gas constant that **no released OpenRocket has**. Porting the
branch tip would have modelled an atmosphere nobody runs. See
`tools/openrocket-oracle/README.md` for the pin and how to move it.

Stdlib only, like `atmosphere.py` -- a hand-rolled Euler loop over a few hundred
steps needs nothing else, and staying dependency-free keeps
`tests/test_imports.py`'s tier boundary intact. It is duck-typed on `Config`
rather than importing `schema`, for the same reason.

What is reproduced exactly
--------------------------
`BasicLandingStepper.computeCD`     drag from deployed canopies only
`AbstractEulerStepper.step`         forward Euler, the step-size ladder,
                                    the ground-hit quadratic, the apogee
                                    solve, and the jerk-based oscillation
                                    avoidance branch
`ExtendedISAModel`                  the pad re-fit, behind
`InterpolatingAtmosphericModel`     a 500 m lookup grid
`WGSGravityModel`                   latitude and altitude dependent g
`DeploymentConfiguration`           APOGEE and ALTITUDE triggers, and the
                                    `max(0.001, deployDelay)` floor

Three consequences, which are the whole point of the comparison (PLAN.md §2):

  1. **Deployment is a step function.** `CdS` goes from zero to full between two
     integration points. No filling time, no area growth, infinite jerk.
  2. **No opening load exists.** OpenRocket computes none -- only a warning
     string above 20 m/s. `Trajectory.F_T` here is None, and the Cross-check
     tab must render that as "not computed", never as a zero.
  3. **Airframe drag is dropped after deployment.** `computeCD` iterates only
     deployed recovery devices, so the body contributes nothing once a canopy
     is out. This is a real error during drogue descent.

The one place this is not exact
-------------------------------
Between apogee and the first deployment OpenRocket does not use the landing
stepper at all -- it uses `RK4SimulationStepper` with the full Barrowman
aerodynamic model, which needs nose shape, transitions, fin planform and surface
roughness. Our `Config` carries `d_body` and `l_body`, so that is not a function
of our inputs. This module uses our eq (14) axial `CdS_body` for that window
and the golden-CSV test measures what the substitution costs, rather than
assuming it is small. `CdS_coast=0.0` reproduces the landing stepper literally
from t=0 if you want the other bound.
"""

import heapq
import math

from physics.devices import airframe_band

# --- AbstractSimulationStepper / AbstractEulerStepper ------------------------
MIN_TIME_STEP = 0.001        # AbstractSimulationStepper.MIN_TIME_STEP
RECOVERY_TIME_STEP = 0.5     # AbstractEulerStepper.RECOVERY_TIME_STEP
EPSILON = 0.00000001         # MathUtil.EPSILON

# --- AtmosphericConditions (24.12: dry air, no humidity term) ---------------
R_AIR = 287.053
ISA_G = 9.80665              # ExtendedISAModel.G

# --- InterpolatingAtmosphericModel ------------------------------------------
DELTA = 500.0

# --- WGSGravityModel / WorldCoordinate --------------------------------------
REARTH = 6371000.0           # WorldCoordinate.REARTH, NOT the ISA radius

STANDARD_LAYERS = (0.0, 11000.0, 20000.0, 32000.0, 47000.0, 51000.0,
                   71000.0, 84852.0)
STANDARD_TEMPERATURES = (288.15, 216.65, 216.65, 228.65, 270.65, 270.65,
                         214.65, 186.95)

# A run that reaches this has not converged. OpenRocket's own cap is
# RECOMMENDED_MAX_TIME = 1200 s; this is deliberately looser so a slow descent
# is reported rather than truncated, and the warning says which happened.
T_MAX = 10000.0


def wgs_gravity(latitude_deg, altitude_msl):
    """`WGSGravityModel.calcGravity`, verbatim.

    Note `REARTH = 6371000` -- the mean radius, not the 6356766 the ISA uses
    for geopotential. OpenRocket keeps the two separate and so does this.
    """
    sin2lat = math.sin(math.radians(latitude_deg)) ** 2
    g_0 = 9.7803267714 * (
        (1.0 + 0.00193185138639 * sin2lat)
        / math.sqrt(1.0 - 0.00669437999013 * sin2lat)
    )
    return g_0 * (REARTH / (REARTH + altitude_msl)) ** 2


class ExtendedISA:
    """`ExtendedISAModel` behind `InterpolatingAtmosphericModel`, as at 24.12.

    Altitudes are **geometric MSL** and there is no geopotential conversion --
    that arrived after the release; see the module docstring.

    The layer structure is the interesting part, and it is the same idea as our
    eq (7): replace the lowest layer with one that passes through the measured
    pad state and still meets the standard 216.65 K at 11 km. Where it differs
    from ours is what happens next -- the profile is then sampled onto a 500 m
    table and linearly interpolated, which is a ~0.6% density error near the
    ground that our `atmosphere.py` does not have because it evaluates exactly.
    """

    def __init__(self, altitude=0.0, temperature=288.15, pressure=101325.0):
        if altitude >= STANDARD_LAYERS[1]:
            raise ValueError("Too high first altitude: %s" % altitude)
        if temperature <= 0:
            raise ValueError("Temperature must be positive (Kelvin)")
        if pressure <= 0:
            raise ValueError("Pressure must be positive (Pascals)")

        if altitude > 0.0:
            n = len(STANDARD_LAYERS) + 1
            self.layer = [0.0] * n
            self.base_temperature = [0.0] * n
            self.base_pressure = [0.0] * n

            layer1_alt = STANDARD_LAYERS[1]
            layer1_temp = STANDARD_TEMPERATURES[1]
            temp_rate = (layer1_temp - temperature) / (layer1_alt - altitude)
            sea_level_temp = temperature - temp_rate * altitude

            self.layer[0] = 0.0
            self.layer[1] = altitude
            self.base_temperature[0] = sea_level_temp
            self.base_temperature[1] = temperature
            self.base_pressure[0] = self._pressure(
                0.0, sea_level_temp, altitude, temperature, pressure)
            self.base_pressure[1] = pressure

            for i in range(2, n):
                self.layer[i] = STANDARD_LAYERS[i - 1]
                self.base_temperature[i] = STANDARD_TEMPERATURES[i - 1]
            first = 2
        else:
            self.layer = list(STANDARD_LAYERS)
            self.base_temperature = list(STANDARD_TEMPERATURES)
            self.base_pressure = [0.0] * len(self.layer)
            self.base_temperature[0] = temperature
            self.base_pressure[0] = pressure
            first = 1

        # Each remaining layer base is sampled one metre BELOW the boundary,
        # from the layer beneath it. Faithful to the original, including the
        # off-by-one metre, which is how the table stays self-consistent.
        for i in range(first, len(self.base_pressure)):
            self.base_pressure[i] = self.exact(self.layer[i] - 1.0)[1]

        self._levels = None

    @staticmethod
    def _pressure(alt1, temp1, alt2, temp2, press2):
        """`ExtendedISAModel.calculatePressure`, verbatim -- with one rescue.

        `alt2 == alt1` happens on every call that lands exactly on a layer
        base, which includes sea level on the very first grid sample. Java does
        not raise there: the division gives Infinity, `1 + 0*Infinity` is NaN,
        the exponent `-G/(Infinity*R)` is -0.0, and `Math.pow(NaN, -0.0)` is
        **1.0** by specification -- so the whole expression collapses to
        `press2`, which is the right answer, the pressure at the layer base
        being the base pressure. Python raises ZeroDivisionError instead, so
        the case is written out rather than left to arithmetic.
        """
        if alt2 == alt1:
            return press2
        temp_rate = (temp2 - temp1) / (alt2 - alt1)
        if abs(temp_rate) > 0.000001:
            return press2 / (
                (1.0 + (alt2 - alt1) * temp_rate / temp1)
                ** (-ISA_G / (temp_rate * R_AIR))
            )
        return press2 / math.exp(-(alt2 - alt1) * ISA_G / (R_AIR * temp1))

    def exact(self, altitude):
        """`getExactConditions`. Returns (temperature K, pressure Pa)."""
        top = self.layer[-1]
        altitude = min(max(altitude, self.layer[0]), top)

        start = len(self.layer) - 2
        for i in range(len(self.layer) - 1):
            if self.layer[i + 1] > altitude:
                start = i
                break

        alt_diff = altitude - self.layer[start]
        start_temp = self.base_temperature[start]
        temp_rate = ((self.base_temperature[start + 1] - start_temp)
                     / (self.layer[start + 1] - self.layer[start]))
        temp = start_temp + alt_diff * temp_rate
        press = self._pressure(altitude, temp, self.layer[start], start_temp,
                               self.base_pressure[start])
        return temp, press

    def _compute_levels(self):
        """`InterpolatingAtmosphericModel.computeLayers`. 170 entries at 500 m."""
        size = int(math.ceil(self.layer[-1] / DELTA))
        return [self.exact(i * DELTA) for i in range(size)]

    def conditions(self, altitude):
        """`getConditions`. The 500 m grid, linearly interpolated.

        This is the ~0.6% near-ground density error PLAN.md §5 calls out: the
        profile is genuinely curved over 500 m and a chord under-reads it.
        """
        if self._levels is None:
            self._levels = self._compute_levels()
        levels = self._levels

        if altitude <= 0.0:
            return levels[0]
        max_index = len(levels) - 1
        if altitude >= DELTA * max_index:
            return levels[max_index]

        lower_index = int(math.floor(altitude / DELTA))
        fraction = (altitude - lower_index * DELTA) / DELTA
        lo, hi = levels[lower_index], levels[lower_index + 1]
        return (lo[0] + (hi[0] - lo[0]) * fraction,
                lo[1] + (hi[1] - lo[1]) * fraction)

    def density(self, altitude):
        """`AtmosphericConditions.getDensity`, dry air at 24.12."""
        temp, press = self.conditions(altitude)
        return press / (R_AIR * temp)


# --- deployment -------------------------------------------------------------

APOGEE = "APOGEE"
ALTITUDE = "ALTITUDE"


class _Canopy:
    """One recovery device, as OpenRocket would configure it."""

    __slots__ = ("name", "CdS", "kind", "deploy_altitude", "deploy_delay",
                 "deployed", "t_deploy", "v_deploy")

    def __init__(self, name, CdS, kind, deploy_altitude, deploy_delay):
        self.name = name
        self.CdS = CdS
        self.kind = kind
        self.deploy_altitude = deploy_altitude
        self.deploy_delay = deploy_delay
        self.deployed = False
        self.t_deploy = None
        self.v_deploy = None


def canopies_from(config):
    """Map our devices onto OpenRocket deployment configurations.

    The mapping, and why each half of it is the only one available:

      * our `CdS` is OpenRocket's `Cd * Area` product. `computeCD` divides by
        the reference area and `calculateAcceleration` multiplies it straight
        back, so the reference area cancels algebraically and no airframe
        diameter is needed to make the drag agree.
      * an **ALTITUDE** trigger maps to `deployAltitude`, with our `delay`
        as `deployDelay`.
      * a **TIME** trigger has no OpenRocket equivalent -- there is no
        "seconds after apogee" deploy event -- so it maps to an APOGEE-event
        device whose `deployDelay` carries `trigger.value + delay`. Our run
        starts at apogee, so those are the same instant, and the total lag to
        a fully open canopy is preserved.

    Our `delay` is the charge-to-line-stretch lag; OpenRocket's `deployDelay`
    is charge-to-fully-open. Mapping one onto the other is the closest
    available and is exactly PLAN.md §2's first defect: there is nowhere in
    OpenRocket to put a filling time.
    """
    out = []
    for d in config.devices:
        kind = getattr(d.trigger.kind, "value", d.trigger.kind)
        if kind == "ALTITUDE":
            out.append(_Canopy(d.name, d.CdS, ALTITUDE, d.trigger.value,
                               d.delay))
        elif kind == "TIME":
            out.append(_Canopy(d.name, d.CdS, APOGEE, None,
                               d.trigger.value + d.delay))
        else:
            raise ValueError("unknown trigger kind %r" % (kind,))
    return out


class Trajectory:
    """Flight history at OpenRocket's own step boundaries.

    Not resampled. A 0.5 s nominal step over a three-minute descent is a few
    hundred points, so there is nothing to thin -- and the coarse stepping is
    worth seeing on the chart rather than smoothing away.

    `F_T` is None and stays None. OpenRocket computes no opening load at all
    (PLAN.md §2, defect 2), and emitting zeros would render an absence as a
    measurement.
    """

    __slots__ = ("t", "z", "v", "a", "CdS", "F_T")

    def __init__(self):
        self.t, self.z, self.v, self.a, self.CdS = [], [], [], [], []
        self.F_T = None

    def _append(self, t, z, v, a, CdS):
        self.t.append(t)
        self.z.append(z)
        self.v.append(v)
        self.a.append(a)
        self.CdS.append(CdS)


class Result:
    __slots__ = ("traj", "canopies", "t_ground", "v_impact", "m", "warnings",
                 "atm", "CdS_coast", "high_speed_deployments")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


def simulate(config, latitude=None, CdS_coast=None, t_max=T_MAX,
             recovery_time_step=RECOVERY_TIME_STEP):
    """Run OpenRocket's descent from apogee to the ground.

    `CdS_coast` is the drag area before the first canopy deploys -- see the
    module docstring for why this cannot be exact. Defaults to our eq (14)
    axial airframe bound; pass 0.0 to run `BasicLandingStepper` literally from
    t = 0 instead.

    `recovery_time_step` is OpenRocket's hard-coded 0.5 s and should be left
    alone for any comparison. It is a parameter for exactly one reason: the
    test suite shrinks it to show that this model converges onto ours as the
    step goes to zero. That is what separates "a different model, integrated
    coarsely" -- which is the finding -- from "a coding error", which would not
    converge to anything. See `tests/test_openrocket.py`.
    """
    from physics.site import FAR_ELEV_M, FAR_LAT

    vehicle = config.vehicle
    site_elev = config.site.z_site
    latitude = FAR_LAT if latitude is None else latitude

    if CdS_coast is None:
        CdS_coast = airframe_band(vehicle.d_body, vehicle.l_body)[0]

    # OpenRocket's launch-site conditions are the pad state, at the pad's
    # geometric altitude. Where we default an unmeasured pad to the standard
    # column (§5), so does it -- ExtendedISAModel() with no arguments.
    T_pad = config.site.T_pad
    p_pad = config.site.p_pad
    if T_pad is None or p_pad is None:
        standard = ExtendedISA()
        s_temp, s_press = standard.exact(site_elev)
        T_pad = s_temp if T_pad is None else T_pad
        p_pad = s_press if p_pad is None else p_pad
    atm = ExtendedISA(site_elev, T_pad, p_pad)

    m = vehicle.m
    canopies = canopies_from(config)
    warnings = []
    # (device name, speed m/s) for each Warning.HighSpeedDeployment.
    high_speed = []

    t = 0.0
    z = vehicle.h_a if vehicle.z0 is None else vehicle.z0
    v = 0.0 if vehicle.v0 is None else vehicle.v0

    # The event queue: (time, sequence, kind, payload). `seq` keeps insertion
    # order among simultaneous events, which is what Java's PriorityQueue does
    # for equal keys in practice and what makes a run reproducible.
    queue = []
    seq = [0]

    def push(time, kind, payload=None):
        seq[0] += 1
        heapq.heappush(queue, (time, seq[0], kind, payload))

    def drag_area():
        """`BasicLandingStepper.computeCD`, plus the coast substitution.

        Once ANY canopy is out the airframe term vanishes -- that is the whole
        of defect 3, and it is one `if`.
        """
        total = sum(c.CdS for c in canopies if c.deployed)
        if not any(c.deployed for c in canopies):
            return CdS_coast
        return total

    def acceleration(z_, v_, CdA):
        """`AbstractEulerStepper.calculateAcceleration`, 1-D and windless.

        Coriolis is dropped: for a purely vertical velocity the acceleration
        `2 * omega x v` is horizontal, so its z-component is identically zero
        and a 1-D model cannot see it.
        """
        rho = atm.density(z_ + site_elev)
        g = wgs_gravity(latitude, z_ + site_elev)
        speed = abs(v_)
        drag_force = 0.5 * CdA * rho * speed * speed
        a = 0.0
        if speed > EPSILON:
            # airSpeed.normalize() * (-dragForce / mass)
            a = -math.copysign(1.0, v_) * drag_force / m
        return a - g, rho, drag_force

    traj = Trajectory()
    # The run begins at apogee, which is an event OpenRocket emits and which
    # every APOGEE-configured device is waiting for.
    push(0.0, APOGEE)

    landed = False
    guard = 0
    while not landed and t < t_max:
        guard += 1
        if guard > 200000:
            warnings.append("event loop exceeded its budget; aborting")
            break

        # --- handleEvents ---------------------------------------------------
        while queue and queue[0][0] <= t + 1e-12:
            _, _, kind, payload = heapq.heappop(queue)
            if kind == APOGEE:
                for c in canopies:
                    if c.kind is APOGEE and not c.deployed:
                        push(t + max(MIN_TIME_STEP, c.deploy_delay),
                             "DEPLOY", c)
            elif kind == ALTITUDE:
                old_alt, new_alt = payload
                for c in canopies:
                    # DeploymentConfiguration.ALTITUDE.isActivationEvent:
                    # the step must STRADDLE the target on the way down.
                    if (c.kind is ALTITUDE and not c.deployed
                            and c.t_deploy is None
                            and old_alt >= c.deploy_altitude
                            and new_alt <= c.deploy_altitude):
                        c.t_deploy = t + max(MIN_TIME_STEP, c.deploy_delay)
                        push(c.t_deploy, "DEPLOY", c)
            elif kind == "DEPLOY":
                c = payload
                c.deployed = True
                c.t_deploy = t
                c.v_deploy = abs(v)
                if abs(v) > 20.0:
                    # Warning.HighSpeedDeployment -- the ONLY thing OpenRocket
                    # says about opening loads, and it is a string, not a
                    # number.
                    #
                    # Structured rather than appended to `warnings`, because it
                    # is a fact about OpenRocket's model rather than about this
                    # config, and it belongs wherever that model is being
                    # described. As free text it duplicated the "no opening
                    # load" line the comparison already carries.
                    high_speed.append((c.name, abs(v)))
            elif kind == "GROUND_HIT":
                landed = True

        if landed:
            break

        # --- step at most to the next event --------------------------------
        max_step_time = float("inf")
        if queue:
            max_step_time = max(queue[0][0] - t, MIN_TIME_STEP)
        if max_step_time <= EPSILON:
            continue

        CdA = drag_area()
        a, _, _ = acceleration(z, v, CdA)
        traj._append(t, z, v, a, CdA)

        dt = recovery_time_step
        abs_accel = abs(a)
        if abs_accel > EPSILON:
            dt = min(dt, 1.0 / abs_accel)
        if max_step_time < dt:
            if max_step_time > MIN_TIME_STEP:
                dt = max_step_time - MIN_TIME_STEP
            else:
                dt = max_step_time
        dt = max(dt, MIN_TIME_STEP)

        new_z = z + v * dt + a * dt * dt / 2.0
        new_v = v + a * dt

        step = dt
        if new_z < 0.0:
            # 1/2 a t^2 + v t + z = 0, the exact ground crossing
            step = (-v - math.sqrt(v * v - 2.0 * a * z)) / a
        elif v * new_v < 0.0:
            step = abs(v / a)
        else:
            # Jerk by the chain rule, dA/dt = dA/dV * dV/dt. In 1-D the
            # componentwise Coordinate multiply reduces to a scalar product,
            # and the sign of dAdV follows the sign of the airspeed.
            rho = atm.density(z + site_elev)
            speed = abs(v)
            dFdV = CdA * rho * speed
            dAdV = 0.0
            if speed > EPSILON:
                dAdV = math.copysign(1.0, v) * dFdV / m
            jerk = a * dAdV
            new_a = a + jerk * dt
            if new_a * a < -EPSILON:
                step = abs(a / jerk)

        step = max(step, MIN_TIME_STEP)
        if abs(step - dt) > EPSILON:
            dt = step
            if max_step_time - dt < MIN_TIME_STEP:
                dt = max_step_time
            new_z = z + v * dt + a * dt * dt / 2.0
            new_v = v + a * dt
            if abs(new_z) < EPSILON:
                new_z = 0.0

        old_alt = z
        t += dt
        z, v = new_z, new_v

        # --- post-step events ----------------------------------------------
        # The ALTITUDE event is emitted AFTER the step, carrying the pair the
        # step spanned. Nothing looks ahead to a deployment altitude, so a
        # canopy fires at the END of the step that crossed it -- up to a full
        # 0.5 s late. That lateness is real OpenRocket behaviour and is one of
        # the things the comparison is for.
        if z >= EPSILON:
            push(t, ALTITUDE, (old_alt, z))
        else:
            push(t, "GROUND_HIT")

    if not landed and t >= t_max:
        warnings.append("run did not reach the ground within %.0f s" % t_max)

    CdA = drag_area()
    a, _, _ = acceleration(z, v, CdA)
    traj._append(t, z, v, a, CdA)

    for c in canopies:
        if not c.deployed:
            warnings.append("%s never deployed before impact." % c.name)

    return Result(traj=traj, canopies=canopies, t_ground=t, v_impact=abs(v),
                  m=m, warnings=warnings, atm=atm, CdS_coast=CdS_coast,
                  high_speed_deployments=high_speed)
