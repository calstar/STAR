"""Segmented RK45 driver. PLAN.md §10, and the §6.1.4 event contract.

Forward Euler is the wrong tool here. Linearising eq (17) about terminal
velocity gives a relaxation rate lambda = 2g/v_t, and Euler on y' = -lambda*y
rings for h*lambda > 1 and diverges for h*lambda > 2. A 7 m/s main gives a
stability limit of 0.71 s, and OpenRocket's 0.5 s nominal step sits at 70% of
it -- which is why its stepper contains an explicit "oscillation avoidance"
branch. Adaptive RK45 with dense output has no such problem, and adding finite
inflation (§6) removes the discontinuity that made the problem stiff in the
first place.

**The event model is the whole difficulty.** Three classes, one merge:

    ALTITUDE trigger   root-found on the dense output, descending only
    TIME trigger       known a priori
    LINE STRETCH       known a priori, but only once that device has triggered

Line stretch is *scheduled*, never added to a timestamp, because a second
device can trigger inside another's delay window -- a drogue with delay 1.0 s
whose main crosses its altitude 0.4 s later.
"""

import math

import numpy as np
from scipy.integrate import solve_ivp

from physics.budget import checkpoint
from physics.devices import CdS_of, CdS_total, DeviceState, airframe_band
from physics.dynamics import make_deriv
from physics.schema import TriggerKind
from physics.wind import WindProfile

# s; a run that reaches this has not converged. 20,000 s is 5.5 hours of
# descent: a 120 km apogee under a drogue at 30 m/s is ~4,000 s, so this keeps
# 5x headroom over the most extreme legitimate case. It used to be 100,000 --
# 27.8 hours -- which recovers nothing and, because `_resample` grids the whole
# descent at 5 ms, entitled one run to twenty million samples.
T_MAX = 20000.0
RTOL = 1e-8
ATOL = 1e-10

#: Derivative evaluations one descent may spend before it is called unphysical.
#:
#: Nothing else bounds the WORK a run costs. `T_MAX` bounds simulated time and
#: the segment guard below bounds how many events a run may resolve, but a
#: single `solve_ivp` call between two events can grind arbitrarily long: RK45
#: answers a stiff derivative by taking smaller steps, without limit.
#:
#: That gap is reachable by typing. A 313 m drogue -- a canopy the size of a
#: city block, which is what the D0 box accepts if you enter inches as metres
#: -- costs 942k evaluations and 25 s for ONE case, and `/api/simulate` runs
#: four. Each pins a core in the sync threadpool, the dev server has one
#: worker, and the frontend re-runs on every edit, so a single bad number in
#: the form starved the whole app -- `/api/health` included, which made the UI
#: report the backend as down -- until the process was killed by hand.
#:
#: A nominal descent costs ~1.7k evaluations, so this is ~90x headroom: a
#: genuinely stiff but real configuration still runs. What it refuses is the
#: configuration that has no descent to find, and it refuses it as a 422
#: naming the field, which is an answer about the config rather than a hang.
DERIV_BUDGET = 50_000
LOAD_DT = 0.005  # s; §8.1 requires <= 5 ms sampling for the tension peak

#: Load samples one descent may need, across all segments.
#:
#: This is the bound `DERIV_BUDGET` cannot supply and a compute budget cannot
#: enforce. RK45 takes LARGE steps on a smooth trajectory, so a descent can be
#: absurdly long and still cost few derivative evaluations: `h_a = 1e9` ran for
#: 428 SECONDS and returned success, having passed the evaluation budget and
#: then built its load grid. The cost is not in the integration at all, it is
#: here -- `np.linspace` plus `seg.sol(grid)` plus four Python-level callables
#: per sample -- and it is a handful of single C calls that nothing can
#: interrupt once entered. The only place to stop it is before the allocation.
#:
#: Sized from the worst LEGITIMATE case, measured rather than guessed. The
#: binding one is `simultaneous` -- both canopies opening at apogee -- and it
#: saturates with altitude, because above ~30 km the air is too thin to slow
#: anything: 92k samples from 3 km, 452k from 30 km, and still only 518k from
#: 120 km. So a million covers every configuration the field bounds permit,
#: with ~2x headroom over the most extreme, while the pathological `h_a = 1e9`
#: that started this needs four million and is still refused.
#:
#: (An earlier draft used 250,000, which looked generous against the worked
#: example's 24,000 and quietly refused a real 10 km flight's off-nominal
#: case. The headroom has to be measured against the worst case somebody might
#: legitimately ask for, not against the nominal one.)
#:
#: Cost at the cap: seven float64 arrays, ~56 MB, and four Python-level
#: callables per sample. Both this and T_MAX are needed -- T_MAX alone still
#: permits four million.
MAX_LOAD_SAMPLES = 1_000_000

TRIGGER = "trigger"
LINE_STRETCH = "line_stretch"
GROUND = "ground"


class Trajectory:
    """Resampled history plus the raw segments that produced it.

    `x`/`y` are the horizontal ground track (east/north, m from the pad),
    integrated by the coupled descent -- the drift model reads them directly.
    """

    __slots__ = ("t", "z", "v", "a", "x", "y", "CdS", "F_T", "segments")

    def __init__(self, t, z, v, a, x, y, CdS, F_T, segments):
        self.t, self.z, self.v, self.a = t, z, v, a
        self.x, self.y = x, y
        self.CdS, self.F_T = CdS, F_T
        self.segments = segments


class RunResult:
    """One integration: trajectory, per-device state, landing metrics."""

    __slots__ = ("traj", "states", "devices", "atm", "m", "m_b", "CdS_body",
                 "t_ground", "v_impact", "warnings", "label")

    def __init__(self, traj, states, devices, atm, m, m_b, CdS_body,
                 t_ground, v_impact, warnings, label=""):
        self.traj = traj
        self.states = states
        self.devices = devices
        self.atm = atm
        self.m = m
        self.m_b = m_b
        self.CdS_body = CdS_body
        self.t_ground = t_ground
        self.v_impact = v_impact
        self.warnings = warnings
        self.label = label

    def state_of(self, name):
        for d, s in zip(self.devices, self.states):
            if d.name == name:
                return s
        raise KeyError(name)


def _resolve_body_drag(vehicle, which, override=None):
    """Airframe drag area for this run, eqs (14)/(15).

    Derived from the airframe geometry, never read from the config -- see the
    note in `schema.Vehicle`. `override` exists for tests and for anyone with
    measured or CFD data; it is a function argument rather than a config field
    precisely so the GUI cannot offer it and quietly collapse the §6.4 band.
    """
    if override is not None:
        return override
    axial, broadside = airframe_band(vehicle.d_body, vehicle.l_body)
    if which == "axial":
        return axial
    if which == "broadside":
        return broadside
    raise ValueError("which must be 'axial' or 'broadside'")


def _budgeted(deriv, label=""):
    """`deriv`, refusing to be called more than `DERIV_BUDGET` times.

    A ValueError rather than a RuntimeError on purpose: the routers already
    treat ValueError as a physics-level rejection of the config and return it
    as a 422 with the message, which is what this is. A RuntimeError would
    become a 500, which reads as "the server broke" for what is really "these
    numbers do not describe a descent".
    """
    n = [0]

    def counted(t_, y_):
        n[0] += 1
        # Every 1024th call: a clock read is ~50 ns against a ~4 us derivative,
        # so gating it makes the request budget free while still giving ~4 ms
        # granularity. `checkpoint` is itself a no-op when nothing installed a
        # budget, which is the library and CLI case.
        if not n[0] & 0x3FF:
            checkpoint("the descent integration")
        if n[0] > DERIV_BUDGET:
            where = f" in the {label} case" if label else ""
            raise ValueError(
                f"this configuration did not converge to a descent within "
                f"{DERIV_BUDGET:,} derivative evaluations{where}. That is "
                f"~30x a normal run, so the inputs are almost certainly not "
                f"physical -- check the canopy sizes (CdS, D0), the vehicle "
                f"mass and the deployment altitudes."
            )
        return deriv(t_, y_)

    return counted


def integrate(config, which="axial", devices=None, atm=None, label="",
              CdS_body=None):
    """Run one descent. Returns a RunResult.

    `devices` overrides config.devices, which is how §11.5 builds its
    off-nominal cases without mutating the config.
    """
    from physics.atmosphere import Atmosphere

    vehicle = config.vehicle
    devices = list(config.devices if devices is None else devices)
    if atm is None:
        atm = Atmosphere(config.site.z_site, config.site.T_pad,
                         config.site.p_pad, config.site.lapse)

    CdS_body = _resolve_body_drag(vehicle, which, CdS_body)
    m = vehicle.m
    # Body mass is the harness-side mass: total less every canopy assembly.
    # PLAN.md §15.4 records the 3.9% this costs by not tracking which canopies
    # are still stowed, and marks it conservative.
    m_b = m - sum(d.m_c for d in devices)
    if m_b <= 0.0:
        raise ValueError("canopy masses exceed the total descending mass")

    states = [DeviceState() for _ in devices]
    warnings = []

    # Horizontal wind. Promoted onto Config so the descent itself is wind-aware
    # (deployment airspeed -> loads, and the ground track). None = still air, which
    # makes `wind.u/v` identically 0 and leaves the descent 1-D.
    if config.wind is not None:
        wind = config.wind.to_profile(config.site.z_site)
    else:
        wind = WindProfile.constant(0.0, 0.0, site_elev=config.site.z_site)

    # Coupled state [z, vz, x, vx, y, vy]. The horizontal seed is the apogee lateral
    # GROUND velocity (a weathercocked rocket arriving sideways); default 0, which
    # keeps `x=y=0` and reduces the run to the 1-D vertical descent.
    v_lat = vehicle.v_lat or 0.0
    r_lat = math.radians(vehicle.v_lat_dir or 0.0)
    vx0 = v_lat * math.sin(r_lat)   # east
    vy0 = v_lat * math.cos(r_lat)   # north

    t = 0.0
    y = np.array(
        [vehicle.z0 if vehicle.z0 is not None else vehicle.h_a,
         vehicle.v0 if vehicle.v0 is not None else 0.0,
         0.0, vx0, 0.0, vy0],
        dtype=float,
    )

    segments = []
    deriv = _budgeted(make_deriv(devices, states, m, CdS_body, atm, wind),
                      label)

    def ground_event(t_, y_):
        return y_[0]

    ground_event.terminal = True
    ground_event.direction = -1

    def settle(t_now, y_now):
        """Resolve every event already due at `t_now`, repeatedly.

        Ties are real and must not be dropped: §11.5's 'simultaneous' case
        fires two devices at the same instant by construction, and a
        zero-delay trigger turns into a line stretch at that same instant
        too. Resolving due events here -- before any cap is computed -- keeps
        that a loop over states rather than a special case in the integrator.
        """
        moved = True
        while moved:
            moved = False
            for i, (d, s) in enumerate(zip(devices, states)):
                if s.pending:
                    due = (
                        d.trigger.kind is TriggerKind.TIME
                        and d.trigger.value <= t_now + 1e-12
                    ) or (
                        d.trigger.kind is TriggerKind.ALTITUDE
                        and y_now[0] <= d.trigger.value + 1e-12
                        and y_now[1] <= 0.0
                    )
                    if due:
                        s.fire(t_now, d.delay)
                        moved = True
                if s.triggered and not s.stretched and s.t_d <= t_now + 1e-12:
                    # Horizontal air-relative speed at the event, so the loads see
                    # the resultant deployment airspeed (0 in the windless 1-D case).
                    s_h = math.hypot(y_now[3] - wind.u(y_now[0]),
                                     y_now[5] - wind.v(y_now[0]))
                    s.stretch(t_now, y_now[0], y_now[1], d, atm, atm.site_elev, s_h)
                    moved = True

    guard = 0
    while y[0] > 0.0 and t < T_MAX:
        guard += 1
        if guard > 4 * len(devices) + 8:
            warnings.append("event loop exceeded its segment budget; aborting")
            break

        checkpoint("the descent integration")
        settle(t, y)

        # --- assemble the three event classes ------------------------------
        events = [ground_event]
        event_owner = [None]  # parallel to `events`

        for i, (d, s) in enumerate(zip(devices, states)):
            if not s.pending or d.trigger.kind is not TriggerKind.ALTITUDE:
                continue
            z_d = d.trigger.value

            def alt_event(t_, y_, z_d=z_d):
                return y_[0] - z_d

            # Descending crossings only. A vehicle passes its main deployment
            # altitude on the way up as well, and accepting either crossing
            # fires the main during boost at several hundred m/s. Inert while
            # runs start at apogee with v = 0; a live bug the moment §4.0
            # permits v0 > 0.
            alt_event.terminal = True
            alt_event.direction = -1
            events.append(alt_event)
            event_owner.append((TRIGGER, i))

        caps = []
        for i, (d, s) in enumerate(zip(devices, states)):
            if s.pending and d.trigger.kind is TriggerKind.TIME:
                caps.append((d.trigger.value, TRIGGER, i))
            elif s.triggered and not s.stretched:
                caps.append((s.t_d, LINE_STRETCH, i))
        caps = [c for c in caps if c[0] > t + 1e-15]
        t_cap = min((c[0] for c in caps), default=T_MAX)

        seg = solve_ivp(
            deriv, (t, t_cap), y, method="RK45",
            events=events, dense_output=True, rtol=RTOL, atol=ATOL,
        )
        if not seg.success:
            raise RuntimeError("integration failed: %s" % seg.message)
        segments.append(seg)

        t = float(seg.t[-1])
        y = np.array(seg.y[:, -1], dtype=float)

        # --- ground is the only terminal event that ends the run -----------
        if len(seg.t_events[0]):
            break

        # Everything else -- an altitude crossing, a TIME cap, a scheduled
        # line stretch -- is resolved by `settle` at the top of the next
        # pass, from the state the segment ended in. There is deliberately no
        # second copy of that logic here: a zero-delay trigger must collapse
        # into a line stretch through exactly the same code path as a delayed
        # one, or the two arithmetics can drift (assertion 58).
        if not len(seg.t_events[0]) and t >= t_cap and t_cap >= T_MAX:
            warnings.append("run did not reach the ground within T_MAX")
            break

    settle(t, y)
    t_ground = t
    v_impact = abs(float(y[1]))

    # --- eq (8b): two distinct failures, and the second is easy to miss ----
    for d, s in zip(devices, states):
        if s.pending:
            warnings.append(
                "%s never reached its trigger before impact." % d.name)
        elif not s.stretched:
            warnings.append(
                "%s fired at t=%.2f s but never opened before ground."
                % (d.name, s.t_x))

    # --- deployed too low to reach a steady descent rate (§11.10) ----------
    #
    # Nothing in this model assumes terminal velocity -- every speed is
    # integrated -- which is exactly why this check is possible: compare the
    # computed impact speed against what eq (18) says a settled descent would
    # give. They agree to 0.02% for a normally-deployed main because the
    # physics puts them there, and diverge sharply when it does not.
    #
    # Deploy the worked vehicle's main at 10 m instead of 152 m and it lands
    # at 2.4x terminal, for 5.8x the impact energy, while every load number
    # still looks unremarkable. Without this the report says nothing about it.
    CdS_final = CdS_total(devices, states, t_ground, CdS_body)
    rho_g = atm.rho_g(0.0)
    v_settled = (2.0 * m * rho_g[1] / (rho_g[0] * CdS_final)) ** 0.5  # eq (18)
    if v_impact > 1.02 * v_settled:
        warnings.append(
            "Impact at %.2f m/s is %.1fx the settled rate (%.1fx energy); "
            "deployed too low to slow down."
            % (v_impact, v_impact / v_settled,
               (v_impact / v_settled) ** 2)
        )

    traj = _resample(segments, devices, states, m, m_b, CdS_body, atm, wind)
    return RunResult(traj, states, devices, atm, m, m_b, CdS_body,
                     t_ground, v_impact, warnings, label)


def _resample(segments, devices, states, m, m_b, CdS_body, atm, wind):
    """Sample the dense output at <= LOAD_DT and evaluate loads there.

    §8.1: record max F_T sampled on the dense output at <= 5 ms, NOT at
    integrator step boundaries -- the adaptive controller can step over the
    peak entirely.

    Evaluating with the *final* device states is correct even for early
    segments, because `CdS_of` returns 0 for any t before that device's line
    stretch. There is no need to replay the state machine.
    """
    # Count first, allocate second. Every line below this is a C call over the
    # whole grid, and none of them can be interrupted once entered -- so a
    # descent that would need twenty million samples has to be refused here,
    # while the cost is still a loop over a handful of segments. See
    # MAX_LOAD_SAMPLES for the run that made this necessary.
    wanted = 0
    for seg in segments:
        t0, t1 = float(seg.t[0]), float(seg.t[-1])
        if t1 <= t0:
            continue
        wanted += max(2, int(np.ceil((t1 - t0) / LOAD_DT)) + 1)
    if wanted > MAX_LOAD_SAMPLES:
        # Refused, NOT coarsened. §8.1 requires <= 5 ms sampling for the tension
        # peak and the whole load report rests on it, so a grid this run cannot
        # afford is a run this model cannot answer -- quietly widening the step
        # would keep reporting a peak while removing the guarantee that it is
        # the peak. And the configurations that reach this are not near misses:
        # they describe a descent lasting hours.
        raise ValueError(
            "this descent needs %s load samples at %g s, over the limit of "
            "%s. It lasts %.0f s, which is not a recovery event -- check the "
            "apogee, the canopy sizes (CdS, D0) and the vehicle mass."
            % (format(wanted, ","), LOAD_DT, format(MAX_LOAD_SAMPLES, ","),
               float(segments[-1].t[-1]) if segments else 0.0)
        )

    ts, zs, vs, xs, ys, vxs, vys = [], [], [], [], [], [], []
    for seg in segments:
        t0, t1 = float(seg.t[0]), float(seg.t[-1])
        if t1 <= t0:
            continue
        checkpoint("sampling the descent for loads")
        n = max(2, int(np.ceil((t1 - t0) / LOAD_DT)) + 1)
        grid = np.linspace(t0, t1, n)
        y = seg.sol(grid)
        ts.append(grid)
        zs.append(y[0]); vs.append(y[1])
        xs.append(y[2]); vxs.append(y[3])
        ys.append(y[4]); vys.append(y[5])

    if not ts:
        empty = np.zeros(0)
        return Trajectory(empty, empty, empty, empty, empty, empty,
                          empty, empty, segments)

    t = np.concatenate(ts)
    z = np.concatenate(zs)
    v = np.concatenate(vs)
    x = np.concatenate(xs); vx = np.concatenate(vxs)
    y_pos = np.concatenate(ys); vy = np.concatenate(vys)

    # Drop duplicated segment boundaries so event markers are unambiguous.
    keep = np.concatenate(([True], np.diff(t) > 1e-12))
    t, z, v = t[keep], z[keep], v[keep]
    x, vx, y_pos, vy = x[keep], vx[keep], y_pos[keep], vy[keep]

    # Four Python-level callables, once per sample each. At the cap that is a
    # million calls, so the budget gets a look between them.
    checkpoint("evaluating loads")
    CdS = np.array([CdS_total(devices, states, ti, CdS_body) for ti in t])
    checkpoint("evaluating loads")
    rho_g = np.array([atm.rho_g(zi) for zi in z])
    rho, g = rho_g[:, 0], rho_g[:, 1]

    # Resultant air-relative speed drives the drag (|v_rel|=|v| when windless and
    # straight-down, so a/F_T are unchanged in the 1-D case).
    checkpoint("evaluating loads")
    u = np.array([wind.u(zi) for zi in z])
    w = np.array([wind.v(zi) for zi in z])
    v_rel = np.sqrt((vx - u) ** 2 + (vy - w) ** 2 + v * v)

    a = -g - rho * CdS / (2.0 * m) * v_rel * v               # eq (17), coupled
    # Airframe axial drag stays on the axial (vertical) airspeed -- the body drags
    # along its axis, not the resultant -- so eq (19)/(20) are unchanged at calm.
    F_D_body = 0.5 * rho * CdS_body * v * v                  # eq (19)
    F_T = m_b * (a + g) - F_D_body                          # eq (20)

    return Trajectory(t, z, v, a, x, y_pos, CdS, F_T, segments)
