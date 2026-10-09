"""Pressure regulators, modelled on what a datasheet actually tells you.

A regulator is not a restriction. A pipe's pressure drop is a function of the
flow through it; a regulator's outlet is a *setpoint* it defends, and the drop
across it is whatever the inlet happens to be minus that setpoint. Modelled as
a resistance it is wrong in the most misleading way -- it will happily report a
tank pressure that tracks COPV pressure, which is the exact behaviour a
regulator exists to prevent.

Why there is no force balance here
----------------------------------
An earlier plan for this module proposed deriving droop from a force balance
across the sensing diaphragm: dome pressure on the diaphragm against spring
preload, seat and stem areas, flow force on the poppet. That was abandoned, and
the reason is worth recording so nobody rebuilds it.

The balance needs the diaphragm's **effective area as a function of lift**, and
effective area depends on how the convolution rolls under load. No vendor
publishes it, it changes with the elastomer and with age, and it cannot be
recovered from an outline drawing. Building the model means inventing three
unmeasurable numbers and tuning them until the answer reproduces the one number
the datasheet already gave you. More machinery, less confidence.

How a dome-loaded regulator is actually set
--------------------------------------------
A dome regulator has no knob. Its outlet follows the pressure in its dome, and
the dome is fed by a second, hand-loaded regulator upstream -- the *control*
regulator. Turning that knob is how the setpoint moves, during a test, by hand.
So the dome pressure is a **signal** here, not a fixed parameter: a scenario can
ramp it, and an operator can change it mid-run, which is exactly what happens on
the stand.

Between the dome and the outlet sits a **bias**. The Aqua Environment 1092-50 in
use here delivers 50 psi *above* what its dome is loaded to, by design. Modelled
as a parameter rather than folded into the setpoint, because it is a property of
the regulator and the dome pressure is a property of the test: fold them
together and every scenario has to remember to add 50, and one day one of them
will not.

.. code-block:: text

    p_set = p_dome + bias            dome-loaded
    p_set = setpoint                 hand-loaded, or a fixed bench setting

What the datasheet does give you is two more coefficients, and they cover the
two physically distinct effects:

**Supply-pressure effect.** Outlet *rises* as inlet *falls*, because inlet
pressure helps hold the poppet shut against the seat and that help goes away.
Datasheets quote it as a rate, and it is declared here in the units they quote
it in -- the Aqua Environment 1092-50 in use here is **17 psi per 1000 psi** of
inlet, written

.. code-block:: toml

    supply_coefficient = { value = 17, unit = "psi/1000psi" }

It is measured from **zero inlet**, not from a full bottle: the outlet is

.. code-block:: text

    p_out = p_dome + bias - S . p_in            (p_in gauge)

so a 1092-50 loaded to 500 psi with 4000 psi behind it holds
``500 + 50 - 4 x 17 = 482`` psi, and it climbs from there as the bottle falls
-- from the first gram, not from some charge pressure onwards. (The team,
2026-10-07. An earlier version measured the term from an ``inlet_reference``
or the COPV charge, which zeroed it at a full bottle and put the whole effect
on the far side of that pressure.) Over a COPV decay from 4500 to 1500 psi it
moves the outlet up 51 psi -- about 6% on chamber pressure, and the wrong sign
to guess at.

The unit matters more than it looks. Outlet-pressure-per-inlet-pressure is
dimensionless by arithmetic, and an earlier version of this module took it as a
bare ``0.0147`` with unit ``-``. Nobody can check that against a datasheet:
17 psi/1000 psi, 1.7 psi/100 psi and a slipped decimal all look alike once the
units are gone, and the number that reaches the solver is three keystrokes from
being wrong by a factor of ten. It now carries its own ``pressure_ratio``
dimension, so ``-`` is rejected where one belongs and the vendor's own wording
is what gets typed in.

**Flow droop.** Outlet *falls* as flow rises, because the poppet must lift and
lifting takes a pressure difference across the sensing element. This is a
*separate* coefficient, and it turns out to be structurally load-bearing rather
than a refinement -- see below. It is tempting to think the seat's Cv already produces
it -- it does not. Cv sets where the regulator saturates and falls off a cliff;
at a tenth of rated flow the wide-open seat loss is a couple of psi while a real
unit has already drooped by ten. Both are modelled, and they are not the same
number.

The force balance is not forbidden, it is *deferred*: if a fitted droop
coefficient turns out to vary with something two coefficients cannot see, that
is the evidence that would justify building one.

Why zero flow droop is not "no droop" but "no answer"
-----------------------------------------------------
A regulator with ``flow_droop = 0`` holds its outlet at exactly the setpoint no
matter what passes through it. Put one between a COPV and a tank -- both of
whose pressures are states, hence boundary pressures at any instant -- and the
branch equation the network solver assembles is

.. code-block:: text

    (p_up - p_dn) - dp(mdot) = 0        with  dp(mdot) = p_up - p_set

which is satisfied for **every** value of ``mdot``. The flow is genuinely
indeterminate, the branch's Jacobian row is exactly zero, and Newton has nothing
to converge on. That is not a numerical quirk to regularise away; it is the
model saying that a perfect regulator does not determine its own flow.

Flow droop is what closes it. A non-zero coefficient gives the branch a slope of
``flow_droop / rated_flow`` and the flow becomes uniquely determined by how much
droop the downstream pressure is showing -- which is exactly the physical
mechanism. So :meth:`Regulator.check` reports a zero coefficient as an error
rather than a warning when the intent is a transient, and
:class:`IdealRegulator` exists precisely so that "I want a perfect setpoint" is a
deliberate, named choice with its consequence understood.
"""

from __future__ import annotations

import math

from fluids.fittings import Cv_to_K

from feedtwin.comps.base import (
    FlowConditions,
    HydraulicComponent,
    Violation,
    register_builder,
)
from feedtwin.comps.iec_gas import XT_TYPICAL, GasCv, iec_gamma, is_gas
from feedtwin.model.spec import SpecError

#: Resistance a regulator shows to reverse flow [Pa/(kg/s)].
#:
#: Large enough that reverse flow is negligible against the forward flows on a
#: stand -- 1e-6 kg/s backwards costs 10 kPa -- and small enough to keep the
#: Jacobian conditioned next to pipe slopes of 1e5 to 1e7. A finite slope
#: rather than a hard block because Newton needs something to descend; a true
#: one-way constraint is a complementarity problem and this network solve is
#: not one.
REVERSE_STIFFNESS = 1.0e10

#: Where the supply-pressure effect is measured from [Pa abs]: zero gauge
#: inlet. ``p_out = p_dome + bias - S (p_in - this)``.
SUPPLY_ZERO = 101325.0

#: Signal that turns on the compressible seat, its value the xT a regulator
#: that declares none takes. A session sends it while
#: ``Setup.regulator_compressible_seat`` is on (the default since 2026-10-08);
#: absent or zero, the seat is the incompressible Cv law, as it always was.
SEAT_XT_SIGNAL = "regulator_seat_xT"

SEAT_MODEL_NAME = "regulator seat, compressible (IEC 60534-2-1)"
SEAT_MODEL_SOURCE = (
    "IEC 60534-2-1:2011, Industrial-process control valves - Part 2-1: Flow "
    "capacity - Sizing equations for fluid flow under installed conditions: "
    "W = N6 C Y sqrt(x p1 rho1), Y = 1 - x/(3 F_gamma xT), F_gamma = gamma/1.40, "
    "choked at x >= F_gamma xT"
)


def _dynamic_head(mdot: float, bore: float, rho: float) -> float:
    import math

    if bore <= 0.0 or rho <= 0.0:
        return 0.0
    area = math.pi * bore * bore / 4.0
    v = mdot / (rho * area)
    return 0.5 * rho * v * v


class Regulator(HydraulicComponent):
    """A pressure regulator holding an outlet setpoint.

    The outlet it defends is

    .. code-block:: text

        p_set  -  S . p_in                     supply-pressure effect, p_in gauge
               -  D . (|mdot| / mdot_rated)    flow droop

    clamped by two physical limits: it can never raise pressure, and it can
    never pass more than a wide-open seat allows.

    Both coefficients default to zero with ``source = "default"``, so a
    regulator declared without them behaves as an ideal one *and says so* in the
    provenance report. That is deliberate: an unstated droop should look like a
    missing measurement, not like a regulator that happens to be perfect.
    """

    def commanded_setpoint(self, flow: FlowConditions) -> float:
        """What this regulator has been told to hold [Pa], before any droop.

        For a dome-loaded unit that is the dome pressure plus the regulator's
        own bias; for anything else it is the setpoint as configured. The dome
        pressure is read as a *signal* first, so a scenario or an operator can
        move it during a run the way a hand on the control regulator does.
        """
        bias = self.p.get("dome_bias", 0.0)
        dome = self.signal(flow, "dome", self.p.get("dome_pressure", 0.0))
        if dome > 0.0:
            return dome + bias
        return self.p["setpoint"]

    def supply_effect(self, flow: FlowConditions) -> float:
        """The supply-pressure term [Pa]: ``-S p_in``, the inlet in gauge.

        Measured from zero inlet, never from a charge pressure: at 4000 psi a
        1092-50 sits ``4 x 17`` psi under dome plus bias, and comes up as the
        bottle falls.
        """
        supply = self.p.get("supply_coefficient", 0.0)
        return supply * (SUPPLY_ZERO - flow.p_upstream)

    def outlet_setpoint(self, mdot: float, flow: FlowConditions) -> float:
        """The pressure this regulator is trying to hold right now [Pa]."""
        droop = self.p.get("flow_droop", 0.0)
        rated = self.p.get("rated_flow", 0.0)

        target = self.commanded_setpoint(flow) + self.supply_effect(flow)
        if rated > 0.0:
            target -= droop * (abs(mdot) / rated)
        return target

    def lockup_pressure(self, flow: FlowConditions | None = None) -> float:
        """Outlet at zero flow [Pa]: setpoint plus the seat's overshoot.

        Real seats do not close at exactly the setpoint -- the outlet creeps up
        until the poppet seals. It matters because lockup, not setpoint, is what
        a downstream relief valve and a burst disc actually see between firings,
        and on a dome-loaded unit it moves with the dome.

        The base is the outlet the regulator holds at zero flow,
        ``outlet_setpoint(0)``, so it carries the supply-pressure effect: the
        inlet pushing on the poppet does not stop when the flow does, and the
        branch is continuous across zero flow. (Leaving it out stepped the
        branch by the whole supply term at zero flow, and a tank inside that
        step had no root.)
        """
        if flow is None:
            return self.p["setpoint"] + self.p.get("lockup_rise", 0.0)
        return self.outlet_setpoint(0.0, flow) + self.p.get("lockup_rise", 0.0)

    # ------------------------------------------------------------- the seat

    def _gas_seat(self, flow: FlowConditions) -> GasCv | None:
        """The seat as IEC 60534-2-1 sees a gas, or None for the old law.

        On only when the session sends :data:`SEAT_XT_SIGNAL` (the opt-in) and
        the inlet is a gas. The drawing's own ``xT`` wins over the signal's.
        """
        xT_signal = self.signal(flow, SEAT_XT_SIGNAL, 0.0)
        if xT_signal <= 0.0 or not is_gas(flow):
            return None
        xT = float(self.p.get("xT", xT_signal))
        return GasCv(float(self.p["Cv"]), float(self.p["bore"]), xT)

    def _seat_dp(self, magnitude: float, flow: FlowConditions) -> float:
        """Drop the wide-open seat takes at ``magnitude`` [Pa]."""
        seat = self._gas_seat(flow)
        if seat is None:
            # Incompressible: K rho v^2 / 2 at the inlet density. No expansion
            # factor and no choke -- see AUDIT.md 5.3; 25 % high on GN2 near
            # burnout. Off is this, exactly.
            return Cv_to_K(self.p["Cv"], self.p["bore"]) * _dynamic_head(
                magnitude, self.p["bore"], flow.rho
            )
        return seat.drop(magnitude, flow.p_upstream, flow.rho, iec_gamma(flow))

    def seat_capacity(
        self, flow: FlowConditions, xT: float = XT_TYPICAL
    ) -> float | None:
        """Choked gas flow through the wide-open seat [kg/s], IEC 60534-2-1.

        What the regulator can pass at this inlet whatever is downstream: a
        diagnostic (how close to wide open a burn runs), on whichever seat law
        the solve uses. The drawing's ``xT`` wins over ``xT``. None for a liquid.
        """
        if not is_gas(flow):
            return None
        seat = GasCv(
            float(self.p["Cv"]), float(self.p["bore"]), float(self.p.get("xT", xT))
        )
        return seat.capacity(flow.p_upstream, flow.rho, iec_gamma(flow))

    def pinned_flow(self, dp_available: float, flow: FlowConditions) -> float | None:
        """The choked flow, when the compressible seat is wide open and choked.

        Wide open: the downstream is below what the regulator would hold even at
        that flow, ``p_in - target(W_c)``. Choked: the drop ratio is past
        ``F_gamma xT``. Both, and the flow is the seat's capacity whatever
        downstream does. Never with the seat off (the old law has no choke).
        """
        seat = self._gas_seat(flow)
        if seat is None:
            return None
        gamma = iec_gamma(flow)
        p_in = flow.p_upstream
        capacity = seat.capacity(p_in, flow.rho, gamma)
        if capacity <= 0.0:
            return None
        wide_open = p_in - self.outlet_setpoint(capacity, flow)
        if dp_available >= max(seat.x_critical(gamma) * p_in, wide_open):
            return capacity
        return None

    def seat_model(self, xT: float = XT_TYPICAL) -> dict[str, object]:
        """The run record's ``model`` block for the compressible seat."""
        param = self.instance.params.get("xT")
        cv = self.instance.params.get("Cv")
        inputs: dict[str, object] = {
            "xT": (
                {
                    "value": param.value,
                    "unit": param.unit,
                    "provenance": f"{param.source.value}: {param.reference}",
                }
                if param is not None
                else {
                    "value": xT,
                    "unit": "-",
                    "provenance": "assumed: IEC 60534 typical",
                }
            ),
        }
        if cv is not None:
            inputs["Cv"] = {
                "value": cv.value,
                "unit": cv.unit,
                "provenance": f"{cv.source.value}: {cv.reference}",
            }
        return {
            "name": SEAT_MODEL_NAME,
            "source": SEAT_MODEL_SOURCE,
            "assumptions": [
                "the wide-open seat is a control valve of the regulator's Cv",
                "gamma is the ideal-gas ratio of specific heats (cp/cv at 1 kPa)",
                "scale from the Cv definition (fluids Cv_to_K), so x -> 0 is the "
                "incompressible law exactly",
                "only the wide-open (saturated) regulator is affected; while it "
                "regulates, its outlet is the droop law",
            ],
            "inputs": inputs,
        }

    # ---------------------------------------------------------- the branch

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        p_in = flow.p_upstream
        magnitude = abs(mdot)

        if magnitude == 0.0:
            # Shut. Downstream sits at lockup, unless the inlet is below it.
            return max(p_in - self.lockup_pressure(flow), 0.0)

        # The most the seat can pass wide open sets the floor on the drop. Below
        # that the regulator is saturated: it is a hole, not a regulator, and
        # the outlet is whatever the line gives it.
        seat_dp = self._seat_dp(magnitude, flow)

        target = self.outlet_setpoint(mdot, flow)
        required = p_in - target

        # A regulator cannot raise pressure and cannot drop less than its own
        # seat does. Whichever binds, wins.
        return max(required, seat_dp, 0.0)

    def total_dp(self, mdot: float, flow: FlowConditions) -> float:
        """Signed, and **not** the base class's mirror of the forward loss.

        :meth:`HydraulicComponent.total_dp` negates the loss for reverse flow,
        which is right for anything symmetric: run a pipe backwards and the
        pressure falls backwards by the same amount. A regulator is not
        symmetric. Its forward "loss" is the whole difference between a 4500 psi
        bottle and a 550 psi setpoint, so mirroring it puts a step of
        ``2 (p_in - p_set)`` -- eight thousand psi -- across ``mdot = 0``.

        The finite difference the solver takes across that step reports a slope
        of order 1e16 Pa/(kg/s). One Newton iterate landing near zero flow on
        the regulator is then enough to destroy the solve: the step it computes
        is meaningless, the backtracking finds nothing better, and the run
        stalls just above tolerance while the network quietly settles into
        gas circulating backwards out of one tank and into the other. It cost
        117 ticks out of 141 on a helium burn, and it presents as the tank
        draining to atmosphere while the bottle stays full.

        Forward, this is the base class. Backward, the poppet is on its seat:
        continuous with the forward branch at zero and steeply resistant, so
        Newton is pushed back toward non-negative flow rather than finding a
        mirrored pressure source on the far side of a cliff.
        """
        if mdot >= 0.0:
            return self.pressure_drop(mdot, flow) + self.static_head(flow)
        shut = max(flow.p_upstream - self.lockup_pressure(flow), 0.0)
        return shut + REVERSE_STIFFNESS * mdot + self.static_head(flow)

    def flow_ceiling(self, flow: FlowConditions) -> float | None:
        """Zero: what a shut regulator passes.

        Consulted by the solver only when :meth:`is_choked` says the regulator
        has closed, so the constant is not a claim that a regulator never flows.
        """
        return 0.0

    def is_choked(self, dp_available: float, flow: FlowConditions) -> bool:
        """Whether the regulator has shut because downstream is already high.

        A regulator is a one-way device. Turn the control regulator down below
        what the tank is already sitting at and the dome reg simply closes --
        it cannot pull the tank back down, and nothing flows until the tank is
        vented or drained past the new setting. That is what happens on the
        stand, and it is what makes "turn the knob down and watch" a question
        the model can answer.

        Without this the branch equation asks for a pressure drop larger than
        the network has, which has no solution and diverges rather than
        reporting a shut valve.
        """
        setpoint = self.outlet_setpoint(0.0, flow)
        required = flow.p_upstream - setpoint
        # The band is a *fraction of the setpoint*, not a fixed pascal. With a
        # 1 Pa threshold a regulator whose downstream is sitting on its
        # setpoint -- which is exactly where a pressurised tank sits -- flips
        # between "shut" and "regulating" from one step to the next. Each flip
        # swaps the branch equation for a different one, and the network solve
        # is asked to converge on a discontinuity. Half a percent is small
        # against any real regulator's droop and wide enough that the mode is
        # decided rather than argued over.
        return dp_available < required - 0.005 * setpoint

    def is_saturated(self, mdot: float, flow: FlowConditions) -> bool:
        """Whether the regulator has run out of authority at this operating point.

        True means the outlet is being set by the seat rather than by the
        setpoint -- the regulator is wide open and no longer regulating. Worth
        surfacing loudly: the pressure it reports is still a real number, and it
        is no longer the number anybody designed for.
        """
        if mdot == 0.0:
            return False
        seat_dp = self._seat_dp(abs(mdot), flow)
        return seat_dp > (flow.p_upstream - self.outlet_setpoint(mdot, flow))

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        dp = self.pressure_drop(mdot, flow)
        target = self.outlet_setpoint(mdot, flow)
        commanded = self.commanded_setpoint(flow)
        return {
            "setpoint": commanded,
            "dome_pressure": self.signal(
                flow, "dome", self.p.get("dome_pressure", 0.0)
            ),
            "dome_bias": self.p.get("dome_bias", 0.0),
            "outlet_target": target,
            "outlet_actual": flow.p_upstream - dp,
            "droop_from_setpoint": (flow.p_upstream - dp) - commanded,
            "inlet_differential": flow.p_upstream - (flow.p_upstream - dp),
            "saturated": 1.0 if self.is_saturated(mdot, flow) else 0.0,
            "shut": (
                1.0
                if self.is_choked(flow.p_upstream - (flow.p_upstream - dp), flow)
                else 0.0
            ),
            "dp": dp,
        }

    def check(self) -> list[Violation]:
        out: list[Violation] = []
        for name in ("supply_coefficient", "flow_droop"):
            param = self.instance.params.get(name)
            if param is not None and param.source.is_assumed:
                out.append(
                    Violation(
                        self.id,
                        name,
                        f"{name} is {param.source.value}, not measured. A "
                        "regulator's droop is the one number its datasheet "
                        "always gives; leaving it assumed throws away the only "
                        "characterisation that exists.",
                        severity="warning",
                    )
                )
        droop = self.p.get("flow_droop", 0.0)
        rated = self.p.get("rated_flow", 0.0)
        if droop <= 0.0 or rated <= 0.0:
            out.append(
                Violation(
                    self.id,
                    "flow_droop",
                    "flow droop is zero, so this regulator holds its setpoint "
                    "exactly at any flow. Between two pressure boundaries that "
                    "makes its branch flow mathematically indeterminate -- the "
                    "branch equation is satisfied for every mass flow and the "
                    "Jacobian row is identically zero. Steady solves against a "
                    "fixed downstream demand still work; a transient will not "
                    "converge. Give it the datasheet's droop-at-rated-flow, or "
                    "declare model='ideal' to say the perfect setpoint is "
                    "deliberate.",
                    severity="warning",
                )
            )
        if droop > 0.0 and rated <= 0.0:
            out.append(
                Violation(
                    self.id,
                    "rated_flow",
                    "flow_droop is set but rated_flow is zero, so the droop "
                    "term has no scale and is silently doing nothing.",
                )
            )
        if self.instance.params.get("inlet_reference") is not None and (
            self.p.get("inlet_reference", 0.0) > 0.0
        ):
            out.append(
                Violation(
                    self.id,
                    "inlet_reference",
                    "inlet_reference is not used: the supply-pressure effect is "
                    "measured from zero inlet (dome + bias - S x inlet), not from "
                    "a charge pressure. Drop it from the drawing.",
                    severity="warning",
                )
            )
        if (
            self.p.get("dome_pressure", 0.0) <= 0.0
            and self.p.get("dome_bias", 0.0) > 0.0
        ):
            out.append(
                Violation(
                    self.id,
                    "dome_bias",
                    "a dome bias is declared but no dome pressure, so the bias "
                    "does nothing. Either load the dome -- a `dome` signal, or "
                    "`dome_pressure` -- or drop the bias. A 50 psi offset that "
                    "silently is not applied is worse than not declaring one.",
                    severity="warning",
                )
            )
        return out

    def envelope_violations(self, mdot: float, flow: FlowConditions) -> list[Violation]:
        """Limits broken at *this* operating point, unlike :meth:`check`.

        Separate because a regulator can be configured perfectly and still be
        outside its envelope on a given run, and a solver wants to know which.
        """
        out: list[Violation] = []
        dp = self.pressure_drop(mdot, flow)
        minimum = self.p.get("min_inlet_differential", 0.0)
        if minimum > 0.0 and dp < minimum:
            out.append(
                Violation(
                    self.id,
                    "min_inlet_differential",
                    f"only {dp / 6894.757:.1f} psi across the regulator, below "
                    f"the {minimum / 6894.757:.1f} psi it needs to control. The "
                    "outlet is not being regulated at this point.",
                )
            )
        if self.is_saturated(mdot, flow):
            out.append(
                Violation(
                    self.id,
                    "capacity",
                    f"wide open at {abs(mdot):.4g} kg/s and still not holding "
                    "setpoint; the seat is the restriction. Outlet pressure "
                    "here is set by the line, not by the regulator.",
                )
            )
        return out


class IdealRegulator(Regulator):
    """Perfect setpoint, unlimited capacity. For sanity checks and first passes.

    Kept as a *named model* rather than a regulator with zero coefficients so
    that a report can distinguish "we chose not to model droop" from "nobody
    filled in the droop". Those look identical in the numbers and are very
    different in what they mean.
    """

    def outlet_setpoint(self, mdot: float, flow: FlowConditions) -> float:
        return self.commanded_setpoint(flow)

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        return max(flow.p_upstream - self.commanded_setpoint(flow), 0.0)

    def is_saturated(self, mdot: float, flow: FlowConditions) -> bool:
        return False


class CurveRegulator(Regulator):
    """Outlet against flow, read from a datasheet curve or a flow bench.

    Supersedes the two-coefficient form when a real curve exists, which is the
    same principle as every other ``measured`` model in this library: data in
    front of a correlation, never blended with it.
    """

    def outlet_setpoint(self, mdot: float, flow: FlowConditions) -> float:
        curve = self.instance.curves.get("outlet_mdot")
        if curve is None:
            raise SpecError(
                f"{self.id}: model 'curve' needs an 'outlet_mdot' curve -- "
                "outlet pressure against mass flow, off the datasheet."
            )
        target = float(curve(abs(mdot)))
        # A dome-loaded unit's curve is measured at one dome setting; moving the
        # dome shifts the whole curve by the same amount.
        target += self.commanded_setpoint(flow) - self.p["setpoint"]
        # The supply term still applies, from zero inlet like the droop form's.
        return target + self.supply_effect(flow)


def _measured_regulator(instance: object) -> HydraulicComponent:
    from feedtwin.comps.elements import MeasuredElement

    return MeasuredElement(instance)  # type: ignore[arg-type]


register_builder("regulator", "ideal", IdealRegulator)
register_builder("regulator", "droop", Regulator)
register_builder("regulator", "curve", CurveRegulator)
register_builder("regulator", "measured", _measured_regulator)
