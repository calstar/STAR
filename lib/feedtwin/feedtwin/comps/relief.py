"""A spring-loaded pressure relief valve: shut until the pressure says otherwise.

Until this existed a drawn ``RV`` became a plain Cv valve with no actuator, so it
was *open* -- a permanent vent hung off whatever it was drawn on -- and the only
overpressure protection the twin had was tripping the stand at a vessel's MAWP
(EngineDesign/docs/layerx/AUDIT.md 5.2, 9.6 E). A drawn RV that declares a
``set_pressure`` now builds as this; one that does not keeps the old behaviour and
the build says it is not a relief model (:func:`feedtwin.pid.network.build_network`).

What it does
------------
Terms are ISO 4126-1 (*Safety devices for protection against excessive pressure
-- Part 1: Safety valves*): **set pressure** (the valve begins to open),
**overpressure** (the rise above set at which it reaches its rated lift, as a
fraction of set), **blowdown** (set less the **reseating pressure**, as a
fraction of set).

.. code-block:: text

    shut:  opens once  dp_act >= p_set
    open:  lift = (dp_act - p_reseat) / (p_full - p_reseat), clipped to [0, 1]
           shuts once dp_act < p_reseat
    p_reseat = p_set (1 - blowdown),   p_full = p_set (1 + overpressure)

``dp_act`` is the pressure **across** the valve, inlet over outlet: a
conventional (unbalanced) spring valve's set pressure is referenced to its
outlet, so a superimposed back pressure raises the inlet pressure it opens at.
Discharging to atmosphere, it is the gauge pressure the valve is stamped with.
The loop between opening at ``p_set`` and shutting at ``p_reseat`` is the
hysteresis; inside it the lift follows the pressure, so a valve that has popped
throttles down continuously to its seat rather than chattering between shut and
wide open.

The lift is a state, decided by the session once per coupling step from the
pressures of the last solve (:meth:`ReliefValve.lift_for`; the session's
``_relief_signals``), and handed to the component as the ``<id>.lift`` signal --
the same way a solenoid's position is. A component evaluated without a session
(a steady solve) reads no signal and is **shut**, which is a relief valve's
normal state.

The flow
--------
Through ``Cv x lift`` (linear), and for a gas by IEC 60534-2-1 with its expansion
factor and choke (:mod:`feedtwin.comps.iec_gas`): the rated capacity is the
choked flow at full lift, ``W = N6 C (2/3) sqrt(F_gamma xT p1 rho1)`` at the
relieving pressure ``p1 = p_set (1 + overpressure) + p_out``. A liquid relief
takes the plain valve's incompressible Cv law and its IEC liquid choke.

Sizing basis
------------
API 520 Part I (*Sizing, Selection, and Installation of Pressure-relieving
Devices -- Sizing and Selection*) sizes a gas relief at critical flow as
``W = C(k) Kd A p1 sqrt(M / (Z T))``, by orifice area and certified discharge
coefficient; ISO 4126-1 rates the same way. This valve is sized by the Cv a
datasheet gives instead, so ``Kd A`` is not an input. The choked capacity above
has API 520's form in ``p1``, ``M``, ``Z`` and ``T`` (``rho1 = p1 M / (Z R T)``);
only the dependence on ``k`` differs -- IEC's ``sqrt(F_gamma)`` against API's
``C(k)``, which puts helium 2.9 % higher relative to nitrogen here
(``sqrt(1.667/1.40)`` = 1.091 against ``C(1.667)/C(1.40)`` = 1.061). A relief
whose datasheet gives ``Kd`` and an orifice area, not a Cv, needs an area model.
"""

from __future__ import annotations

from typing import Any, Mapping

from fluids.fittings import Cv_to_K

from feedtwin.comps.base import FlowConditions, Violation, register_builder
from feedtwin.comps.elements import SHUT_POSITION, Valve, _dynamic_head
from feedtwin.comps.iec_gas import XT_TYPICAL, GasCv, iec_gamma, is_gas

#: What a session calls a relief's lift signal: ``"<component id>.lift"``.
LIFT = "lift"

MODEL_NAME = "spring relief valve (ISO 4126-1 terms, IEC 60534-2-1 gas flow)"
MODEL_SOURCE = (
    "ISO 4126-1, Safety devices for protection against excessive pressure - "
    "Part 1: Safety valves (set pressure, overpressure, blowdown, reseating "
    "pressure); API 520 Part I, Sizing, Selection, and Installation of "
    "Pressure-relieving Devices (sizing basis: choked gas capacity scaling as "
    "p1 sqrt(M/(Z T)), here through the datasheet Cv rather than Kd A); "
    "IEC 60534-2-1:2011, Industrial-process control valves - Part 2-1: "
    "Flow capacity - Sizing equations for fluid flow under installed conditions "
    "(compressible flow: Y = 1 - x/(3 F_gamma xT), choked at x = F_gamma xT)"
)


class ReliefValve(Valve):
    """A pressure-actuated relief valve. See the module docstring."""

    # ------------------------------------------------------------ the law

    @property
    def set_pressure(self) -> float:
        """Differential at which it begins to open [Pa]."""
        return float(self.p["set_pressure"])

    @property
    def reseat_pressure(self) -> float:
        """Differential below which an open valve shuts [Pa]."""
        return self.set_pressure * (1.0 - float(self.p.get("blowdown", 0.0)))

    @property
    def full_lift_pressure(self) -> float:
        """Differential at which it reaches rated lift [Pa]."""
        return self.set_pressure * (1.0 + float(self.p.get("overpressure", 0.0)))

    def lift_for(self, dp_actuating: float, was_open: bool) -> tuple[float, bool]:
        """``(lift, open)`` for the pressure across the valve, given its history.

        Shut, it opens once ``dp_actuating`` reaches the set pressure; open, it
        stays open until ``dp_actuating`` falls below the reseating pressure. The
        lift is proportional between the reseating pressure and full lift.
        """
        if was_open:
            is_open = dp_actuating >= self.reseat_pressure
        else:
            is_open = dp_actuating >= self.set_pressure
        if not is_open:
            return 0.0, False
        span = self.full_lift_pressure - self.reseat_pressure
        if span <= 0.0:
            return 1.0, True
        lift = (dp_actuating - self.reseat_pressure) / span
        return min(max(lift, 0.0), 1.0), True

    # --------------------------------------------------------- the valve

    def _lift(self, signals: Mapping[str, float]) -> float:
        for key in (f"{self.id}.{LIFT}", LIFT):
            if key in signals:
                return min(max(float(signals[key]), 0.0), 1.0)
        return 0.0  # no session deciding it: a relief valve sits shut

    def isolates(self, signals: Mapping[str, float] | None = None) -> bool:
        return self._lift(signals or {}) <= SHUT_POSITION

    def _gas(self, flow: FlowConditions) -> GasCv | None:
        if not is_gas(flow):
            return None
        cv = self.effective_cv(self._lift(flow.signals))
        return GasCv(cv, float(self.p["bore"]), float(self.p.get("xT", XT_TYPICAL)))

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        gas = self._gas(flow)
        if gas is not None:
            return gas.drop(mdot, flow.p_upstream, flow.rho, iec_gamma(flow))
        Cv = self.effective_cv(self._lift(flow.signals))
        bore = float(self.p["bore"])
        return Cv_to_K(Cv, bore) * _dynamic_head(mdot, bore, flow.rho)

    def _gas_choke(self, flow: FlowConditions) -> tuple[float, float] | None:
        if not is_gas(flow):
            return None
        gamma = iec_gamma(flow)
        xT = float(self.p.get("xT", XT_TYPICAL))
        return GasCv(1.0, 1.0, xT).x_critical(gamma), gamma / 1.40

    def flow_ceiling(self, flow: FlowConditions) -> float | None:
        gas = self._gas(flow)
        if gas is None:
            return None
        return gas.capacity(flow.p_upstream, flow.rho, iec_gamma(flow))

    def rated_capacity(self, flow: FlowConditions) -> float | None:
        """Choked gas flow at full lift [kg/s] for the inlet state ``flow``.

        Pass the conditions at the relieving pressure, ``full_lift_pressure``
        plus the outlet's, for the valve's rated capacity. ``None`` for a liquid.
        """
        if not is_gas(flow):
            return None
        gas = GasCv(
            float(self.p["Cv"]),
            float(self.p["bore"]),
            float(self.p.get("xT", XT_TYPICAL)),
        )
        return gas.capacity(flow.p_upstream, flow.rho, iec_gamma(flow))

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        lift = self._lift(flow.signals)
        out: dict[str, float] = {
            "lift": lift,
            "Cv": self.effective_cv(lift),
            "dp": self.pressure_drop(mdot, flow),
            "set_pressure": self.set_pressure,
            "reseat_pressure": self.reseat_pressure,
            "full_lift_pressure": self.full_lift_pressure,
        }
        ceiling = self.flow_ceiling(flow)
        if ceiling is not None:
            out["capacity"] = ceiling
        return out

    def check(self) -> list[Violation]:
        out: list[Violation] = []
        if self.set_pressure <= 0.0:
            out.append(
                Violation(self.id, "set_pressure", "set pressure is not positive")
            )
        blowdown = float(self.p.get("blowdown", 0.0))
        if not 0.0 <= blowdown < 1.0:
            out.append(
                Violation(
                    self.id,
                    "blowdown",
                    f"blowdown {blowdown:g} is outside [0, 1): the valve would "
                    "reseat at or below zero",
                )
            )
        for name in ("Cv", "overpressure", "blowdown", "xT"):
            param = self.instance.params.get(name)
            if param is not None and param.source.is_assumed:
                out.append(
                    Violation(
                        self.id,
                        name,
                        f"{name} is {param.source.value}, not from the valve's "
                        "datasheet; it sets how much this relief can pass.",
                        severity="warning",
                    )
                )
        return out

    # ------------------------------------------------------------ report

    def model(self) -> dict[str, Any]:
        """The run record's ``model`` block for this valve."""
        inputs: dict[str, Any] = {}
        for name in ("set_pressure", "overpressure", "blowdown", "Cv", "bore", "xT"):
            param = self.instance.params.get(name)
            if param is None:
                continue
            inputs[name] = {
                "value": param.value,
                "unit": param.unit,
                "provenance": f"{param.source.value}: {param.reference}".rstrip(": "),
            }
        return {
            "name": MODEL_NAME,
            "source": MODEL_SOURCE,
            "assumptions": [
                "conventional spring valve: opens on the pressure across it "
                "(inlet over outlet), so back pressure raises the inlet set point",
                "lift linear in pressure between the reseating pressure and full "
                "lift at set x (1 + overpressure); Cv linear in lift",
                "no opening or closing time: the lift follows the pressure each "
                "coupling step (relief pop and reseat dynamics not modelled)",
                "gas flow per IEC 60534-2-1 with the ideal-gas ratio of specific "
                "heats; scale from the Cv definition (fluids Cv_to_K)",
                "decided from the previous coupling step's pressures (one coupling "
                "step of lag, milliseconds)",
            ],
            "inputs": inputs,
        }


register_builder("relief_valve", "spring", ReliefValve)
