"""The liquid-side components: pipe, fitting, orifice, valve, check valve.

Every correlation here comes from ``fluids``, which is validated against the
books it implements -- Crane TP-410, IEC 60534, ISO 5167. This module contributes
the adapters and the bookkeeping, and deliberately nothing else. Where a number
in this package disagrees with the source, the fault is in an adapter.

The one thing worth reading before using any of these: **pressure drop is
expressed as a function of mass flow**, not the other way round. A network solve
carries flows and solves for pressures, so this is the direction that avoids an
inner root-find per component per iteration.
"""

from __future__ import annotations

import math
from typing import Any, Mapping

import fluids.control_valve as cv
from fluids.fittings import Cv_to_K
from fluids.fittings import bend_rounded as ft_bend_rounded
from fluids.friction import friction_factor_curved
from fluids.flow_meter import differential_pressure_meter_solver

from feedtwin.props import Fluid, PropertyError
from feedtwin.comps.base import (
    R_UNIVERSAL,
    FlowConditions,
    HydraulicComponent,
    InfeasibleOperatingPoint,
    Violation,
    register_builder,
)
from feedtwin.comps.correlations import (
    DEFAULT_FRICTION_METHOD,
    FittingContext,
    LAMINAR_LIMIT,
    darcy_friction_factor,
    fitting_K,
    reynolds,
    velocity,
)
from feedtwin.model.component import ComponentInstance
from feedtwin.model.curve import Curve
from feedtwin.model.segments import LineSegment
from feedtwin.model.spec import SpecError

GRAVITY = 9.80665
"""Standard gravity [m/s^2], by definition."""

#: Choked-gas coefficient, calibrated against ``fluids`` rather than transcribed.
#:
#: IEC 60534-2-1 sizes a valve on gas as ``W = N6 . C . Y . sqrt(x . p1 . rho1)``.
#: The published N6 depends on which unit set *and* which flow coefficient (Kv or
#: Cv) the table is written for, and getting that pairing wrong is a silent
#: order-of-magnitude error -- transcribing N6 = 27.3 against Cv and kPa
#: over-predicts by 10.5x, which is how this constant was first written here.
#:
#: So it is not transcribed. ``_calibrate_choke()`` derives it once from
#: ``fluids.control_valve.size_control_valve_g``, the same implementation of the
#: same standard the rest of this module adapts. The value is invariant: across
#: helium and nitrogen, 200-4500 psi, 250-293 K and Cv 1.6-60 the implied
#: coefficient is constant to 5 significant figures, which is the check that the
#: *form* above is right and only the scale was ever in question.
_CHOKE_COEFFICIENT: float | None = None


def _calibrate_choke() -> float:
    """One call to ``fluids``, cached, giving the coefficient for Cv/kPa/kg-m^3."""
    global _CHOKE_COEFFICIENT
    if _CHOKE_COEFFICIENT is None:
        MW, gamma, T, p1, bore = 4.0026, 1.667, 293.15, 3.792e6, 0.00953
        r_specific = R_UNIVERSAL * 1000.0 / MW
        rho1 = p1 / (r_specific * T)
        rho_std = 101325.0 / (r_specific * 288.15)
        sized: Any = cv.size_control_valve_g(
            T=T,
            MW=MW,
            mu=2.0e-5,
            gamma=gamma,
            Z=1.0,
            P1=p1,
            P2=101325.0,
            Q=1.0,
            D1=bore,
            D2=bore,
            d=bore,
            allow_choked=True,
            full_output=True,
        )
        # `fluids` reports Kv; one Kv is 1.156 Cv. Q=1 m^3/s at standard
        # conditions is rho_std kg/s, so this is "kg/s per unit Cv".
        per_cv = rho_std * KV_PER_CV / float(sized["Kv"])
        x = (gamma / 1.40) * XT_DEFAULT
        _CHOKE_COEFFICIENT = per_cv / (
            (2.0 / 3.0) * math.sqrt(x * (p1 / 1000.0) * rho1)
        )
    return _CHOKE_COEFFICIENT


KV_PER_CV = 1.0 / 1.1560992283536566
"""Kv per unit Cv. One Cv is one US gallon per minute of water at one psi; one Kv
is one cubic metre per hour at one bar."""

XT_DEFAULT = 0.7
"""Default pressure-drop ratio factor at choked flow.

IEC 60534-2-1's value for a globe or ball valve with a flow-to-open plug, used
when a datasheet does not give one. It is the single largest uncertainty in a
choked-gas prediction -- a real xT ranges about 0.3 (butterfly) to 0.8 (some
globe trims) -- so a valve whose xT matters should carry its own."""


def _dynamic_head(mdot: float, bore: float, rho: float) -> float:
    """rho . v^2 / 2 [Pa] -- the quantity every K multiplies."""
    v = velocity(mdot, bore, rho)
    return 0.5 * rho * v * v


# ---------------------------------------------------------------------------
# Pipe
# ---------------------------------------------------------------------------


class Pipe(HydraulicComponent):
    """A straight run: Darcy friction, lumped minor losses, and elevation.

    ``dp = (f L / D + K_minor) . rho v^2 / 2``, plus ``rho g dz`` of static head.

    The two are reported separately because they behave differently: friction
    reverses with the flow, elevation does not. Omitting elevation is a real
    error in a tall vehicle with a dense cryogen -- ten metres of LOX is about
    1.6 bar -- and conflating it with the loss is a subtler one that only shows
    up when a branch reverses.

    ``K_minor`` is a deliberate shortcut for lumping fittings into a run. It
    costs the per-fitting provenance that a :class:`Fitting` component keeps, so
    it defaults to zero and is worth avoiding where the fittings are known.
    """

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        friction, _ = self._friction(mdot, flow)
        return friction

    def static_head(self, flow: FlowConditions) -> float:
        """``rho g dz``. Not a loss -- it is recovered coming back down, and it
        keeps its sign when the flow reverses."""
        return self._elevation(flow)

    def _friction(self, mdot: float, flow: FlowConditions) -> tuple[float, float]:
        bore = self.p["bore"]
        Re = reynolds(mdot, bore, flow.rho, flow.mu)
        fd = darcy_friction_factor(
            Re,
            self.p["roughness"] / bore,
            self.opt.get("friction", DEFAULT_FRICTION_METHOD),
        )
        K = fd * self.p["length"] / bore + self.p.get("K_minor", 0.0)
        return K * _dynamic_head(mdot, bore, flow.rho), Re

    def _elevation(self, flow: FlowConditions) -> float:
        return flow.rho * GRAVITY * self.p.get("elevation_change", 0.0)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        bore = self.p["bore"]
        Re = reynolds(mdot, bore, flow.rho, flow.mu)
        friction, _ = self._friction(mdot, flow)
        return {
            "velocity": velocity(mdot, bore, flow.rho),
            "Re": Re,
            "friction_factor": darcy_friction_factor(
                Re,
                self.p["roughness"] / bore,
                self.opt.get("friction", DEFAULT_FRICTION_METHOD),
            ),
            "dp_friction": friction,
            "dp_elevation": self._elevation(flow),
            "laminar": 1.0 if 0.0 < Re < LAMINAR_LIMIT else 0.0,
        }


# ---------------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------------


class Fitting(HydraulicComponent):
    """One fitting, with its own resistance coefficient and its own provenance.

    A component rather than a number on a pipe, so an elbow is a thing on the
    drawing with a Crane citation behind it. :class:`Pipe`'s ``K_minor`` is the
    shortcut for when that is more bookkeeping than a run is worth.
    """

    def _K(self, mdot: float, flow: FlowConditions) -> float:
        bore = self.p["bore"]
        Re = reynolds(mdot, bore, flow.rho, flow.mu)
        fd = darcy_friction_factor(
            Re, self.p["roughness"] / bore, DEFAULT_FRICTION_METHOD
        )
        extra: dict[str, float] = {
            name: self.p[name]
            for name in ("angle", "bore2", "bend_diameters")
            if name in self.p
        }
        ctx = FittingContext(
            bore=bore, Re=Re, roughness=self.p["roughness"], fd=fd, params=extra
        )
        return fitting_K(self.opt["kind"], ctx)

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        return self._K(mdot, flow) * _dynamic_head(mdot, self.p["bore"], flow.rho)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        return {
            "K": self._K(mdot, flow),
            "velocity": velocity(mdot, self.p["bore"], flow.rho),
            "Re": reynolds(mdot, self.p["bore"], flow.rho, flow.mu),
        }


# ---------------------------------------------------------------------------
# Bend -- hardline, geometry-aware
# ---------------------------------------------------------------------------


class Bend(HydraulicComponent):
    """A bend in hardline, resisted according to how tight it actually is.

    ``fluids.bend_rounded`` takes the real centreline radius rather than a
    nominal elbow class, which matters: the resistance of a bend is a strong
    function of r/D, and a tube bent on whatever former was to hand is not a
    long-radius elbow. Between r/D = 1 and r/D = 5 the loss changes severalfold.

    The curvature's effect on friction is inside that correlation already, so
    this deliberately does *not* add a curved-friction term on top -- that would
    count the same physics twice. :class:`FlexHose` is the case where curved
    friction is added, because there the whole run is bent rather than a
    discrete arc of it.

    Minimum bend radius is checked but never enforced. See :meth:`check`.
    """

    def _K(self, mdot: float, flow: FlowConditions) -> float:
        bore = self.p["bore"]
        Re = reynolds(mdot, bore, flow.rho, flow.mu)
        return float(
            ft_bend_rounded(
                Di=bore,
                angle=math.degrees(self.p["angle"]),
                rc=self.p["bend_radius"],
                Re=Re or None,
                roughness=self.p["roughness"],
            )
        )

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        return self._K(mdot, flow) * _dynamic_head(mdot, self.p["bore"], flow.rho)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        bore = self.p["bore"]
        return {
            "K": self._K(mdot, flow),
            "r_over_D": self.p["bend_radius"] / bore,
            "velocity": velocity(mdot, bore, flow.rho),
            "Re": reynolds(mdot, bore, flow.rho, flow.mu),
        }

    def check(self) -> list[Violation]:
        """Is this bend tighter than the tube allows?

        Reported, not raised: a line bent too tight is buildable, and the model
        should still solve so the cost is visible. Quoted against OD where one
        is given, because that is how tube benders and hose datasheets state it.
        """
        limit = self.p.get("min_bend_radius")
        radius = self.p["bend_radius"]
        if limit is None or radius >= limit:
            return []

        od = self.p.get("outer_diameter")
        ratio = (
            f", {radius / od:.2f}x OD against a {limit / od:.2f}x limit" if od else ""
        )
        return [
            Violation(
                component=self.id,
                limit="min_bend_radius",
                detail=(
                    f"bent to {radius * 1000:.1f} mm centreline radius, tighter "
                    f"than the {limit * 1000:.1f} mm minimum{ratio}. The wall "
                    "thins and the section ovalises below this."
                ),
            )
        ]


# ---------------------------------------------------------------------------
# Flex hose
# ---------------------------------------------------------------------------


class FlexHose(HydraulicComponent):
    """A flexible hose: rougher than tube, crimped ends, and a bend limit.

    Three things separate it from hardline, and all three change the answer:

    * **It is rougher.** A smooth-bore liner is close to drawn tube; convoluted
      metal hose is several times worse, because the convolutions are in the
      flow path and not merely in the braid.
    * **Its ends are fittings.** Two crimped transitions, which on a short hose
      dominate the loss entirely.
    * **It is usually bent.** When ``installed_bend_radius`` is set, friction is
      computed for curved flow through
      ``fluids.friction_factor_curved`` -- and unlike a discrete bend, the whole
      developed length is curved, so this is where that term belongs.

    Minimum bend radius is generally what actually constrains a routing, and is
    quoted twice: a static limit, and a larger dynamic one for anything that
    gimbals, grows thermally or vibrates.
    """

    def _friction_factor(self, mdot: float, flow: FlowConditions) -> float:
        bore = self.p["bore"]
        Re = reynolds(mdot, bore, flow.rho, flow.mu)
        if Re <= 0.0:
            return 0.0

        radius = self.p.get("installed_bend_radius")
        if radius and radius > 0.0:
            # Coil diameter is twice the centreline bend radius.
            fd = float(
                friction_factor_curved(
                    Re=Re, Di=bore, Dc=2.0 * radius, roughness=self.p["roughness"]
                )
            )
        else:
            fd = darcy_friction_factor(
                Re, self.p["roughness"] / bore, DEFAULT_FRICTION_METHOD
            )

        if self.opt.get("construction") == "convoluted":
            fd *= self.p.get("convolution_factor", 1.0)
        return fd

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        bore = self.p["bore"]
        fd = self._friction_factor(mdot, flow)
        K = fd * self.p["length"] / bore + self.p.get("end_fitting_K", 0.0)
        return K * _dynamic_head(mdot, bore, flow.rho)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        bore = self.p["bore"]
        fd = self._friction_factor(mdot, flow)
        head = _dynamic_head(mdot, bore, flow.rho)
        out = {
            "velocity": velocity(mdot, bore, flow.rho),
            "Re": reynolds(mdot, bore, flow.rho, flow.mu),
            "friction_factor": fd,
            "dp_hose": fd * self.p["length"] / bore * head,
            "dp_end_fittings": self.p.get("end_fitting_K", 0.0) * head,
        }
        radius = self.p.get("installed_bend_radius")
        if radius:
            out["r_over_D"] = radius / bore
        return out

    def check(self) -> list[Violation]:
        """Is the hose routed tighter than it may be bent?

        Both limits are checked. The dynamic one is a warning rather than an
        error because whether a given hose actually moves in service is a fact
        about the installation that the model does not know -- but a run inside
        the static limit and outside the dynamic one is exactly the case worth
        surfacing rather than silently passing.
        """
        radius = self.p.get("installed_bend_radius")
        if not radius:
            return []

        violations: list[Violation] = []
        static = self.p.get("min_bend_radius")
        if static and radius < static:
            violations.append(
                Violation(
                    component=self.id,
                    limit="min_bend_radius",
                    detail=(
                        f"routed to {radius * 1000:.0f} mm, tighter than the "
                        f"{static * 1000:.0f} mm static minimum. A smooth-bore "
                        "liner collapses and a convoluted one fatigues."
                    ),
                )
            )

        dynamic = self.p.get("min_bend_radius_dynamic")
        if dynamic and radius < dynamic and (not static or radius >= static):
            violations.append(
                Violation(
                    component=self.id,
                    limit="min_bend_radius_dynamic",
                    severity="warning",
                    detail=(
                        f"routed to {radius * 1000:.0f} mm, inside the "
                        f"{dynamic * 1000:.0f} mm dynamic minimum. Acceptable "
                        "static; not if this run flexes in service."
                    ),
                )
            )
        return violations


# ---------------------------------------------------------------------------
# Orifice
# ---------------------------------------------------------------------------


class OrificeCd(HydraulicComponent):
    """A restriction with a fixed discharge coefficient.

    ``m = Cd . A . sqrt(2 rho dp)``, inverted. The simplest useful restriction
    model and the right one when Cd has been measured -- which for an injector
    element it usually has.
    """

    def _area(self) -> float:
        d = self.p["bore"]
        return math.pi * d * d / 4.0

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        effective = self.p["Cd"] * self._area()
        if effective <= 0.0 or flow.rho <= 0.0:
            return 0.0
        return (mdot / effective) ** 2 / (2.0 * flow.rho)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        dp = self.pressure_drop(mdot, flow)
        return {
            "dp": dp,
            "beta": self.p["bore"] / self.p["pipe_bore"],
            "velocity_throat": velocity(mdot, self.p["bore"], flow.rho),
            "cavitation_margin": flow.p_upstream - dp - flow.p_sat,
        }


class OrificeISO5167(HydraulicComponent):
    """A metering orifice, with the discharge coefficient from ISO 5167.

    Reader-Harris/Gallagher via ``fluids``: C depends on the beta ratio, the
    Reynolds number and the tapping arrangement, so unlike :class:`OrificeCd`
    this needs no measured coefficient -- which is the point of using a standard
    geometry in the first place.
    """

    METER = "ISO 5167 orifice"

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        if mdot == 0.0:
            return 0.0
        p1 = flow.p_upstream
        try:
            p2 = self._solve_downstream(p1, mdot, flow)
        except Exception as exc:  # fluids raises several numeric types here
            raise InfeasibleOperatingPoint(self.id, mdot, p1) from exc
        return p1 - float(p2)

    def _solve_downstream(self, p1: float, mdot: float, flow: FlowConditions) -> float:
        return differential_pressure_meter_solver(
            D=self.p["pipe_bore"],
            D2=self.p["bore"],
            rho=flow.rho,
            mu=flow.mu,
            m=abs(mdot),
            P1=p1,
            meter_type=self.METER,
            taps="D",
            # ISO 5167 sets the expansibility factor to 1 for an incompressible
            # fluid, which is the whole scope of this phase. Left unset, fluids
            # tries to compute it and needs an isentropic exponent that a liquid
            # has no business supplying. The gas side arrives in Phase 05 and
            # will pass a real k instead.
            # Exactly 1, and passed as an int because that is what fluids'
            # annotation accepts -- the value is exact either way.
            epsilon_specified=1,
        )

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        return {
            "dp": self.pressure_drop(mdot, flow),
            "beta": self.p["bore"] / self.p["pipe_bore"],
            "Re": reynolds(mdot, self.p["pipe_bore"], flow.rho, flow.mu),
        }


# ---------------------------------------------------------------------------
# Valve
# ---------------------------------------------------------------------------

#: Inherent characteristics: fraction of full Cv against fractional travel.
#: From ``fluids.control_valve``; ``tabulated`` reads the instance's own curve.
CHARACTERISTICS: dict[str, object] = {
    "linear": cv.Cv_char_linear,
    "equal_percentage": cv.Cv_char_equal_percentage,
    "quick_opening": cv.Cv_char_quick_opening,
}


#: Travel at or below which a valve is treated as shut -- an open circuit
#: rather than a very small orifice. See HydraulicComponent.isolates.
SHUT_POSITION = 1.0e-3


class Valve(HydraulicComponent):
    """A valve sized by flow coefficient, with position and choking.

    Loss comes from the Cv-to-K conversion in ``fluids``, which reproduces the
    definition of Cv itself -- one US gallon per minute of water at one psi --
    to better than 0.1%, independently of bore.

    Position enters through the inherent characteristic. A closed valve keeps a
    small ``leak_closed`` capacity: real seats leak, and a capacity of exactly
    zero makes the network singular rather than shut.
    """

    def effective_cv(self, position: float) -> float:
        """Cv at a fractional travel between 0 and 1."""
        position = min(max(position, 0.0), 1.0)
        shape = self.opt.get("characteristic", "linear")

        if shape == "tabulated":
            curve = self.instance.curves.get("cv_position")
            if curve is None:
                raise SpecError(
                    f"{self.id}: characteristic is 'tabulated' but no 'cv_position' "
                    "curve was given"
                )
            fraction = curve(position) / max(self.p["Cv"], 1e-30)
        else:
            fn = CHARACTERISTICS.get(shape)
            if fn is None:
                raise SpecError(
                    f"{self.id}: unknown characteristic {shape!r}; available: "
                    f"{', '.join(sorted(CHARACTERISTICS))}, tabulated"
                )
            fraction = float(fn(position))  # type: ignore[operator]

        leak = self.p.get("leak_closed", 0.0)
        return max(self.p["Cv"] * fraction, leak)

    def isolates(self, signals: Mapping[str, float] | None = None) -> bool:
        """Commanded shut, so the branch is an open circuit this solve.

        The threshold is on *travel*, not on the resulting Cv: a valve at 0.5%
        open is shut as far as any stand is concerned, and leaving it in the
        network buys a row Newton cannot move.
        """
        position = 1.0
        for key in (f"{self.id}.command", "command"):
            if signals and key in signals:
                position = float(signals[key])
                break
        return position <= SHUT_POSITION

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        position = self.signal(flow, "command", 1.0)
        Cv = self.effective_cv(position)
        bore = self.p["bore"]
        K = Cv_to_K(Cv, bore)
        return K * _dynamic_head(mdot, bore, flow.rho)

    # ---------------------------------------------------------------- choking
    #
    # A valve on a gas line is the common case on a stand -- every vent, every
    # press solenoid -- and until this existed none of them could choke. The
    # liquid model below returns None for a gas (correctly: it is a flashing
    # model), the base class then reports no ceiling, and a tank at 550 psi
    # vented to atmosphere through the incompressible Cv law at **2.5x to 5.5x
    # the sonic mass flow**, measured across bores from 3/8 in. to 1 in. The
    # solver machinery for ceilings was already here and correct; nothing
    # reached it.

    def _gas_choke(self, flow: FlowConditions) -> tuple[float, float] | None:
        """``(x_critical, F_gamma)`` for this fluid, or None if it is not a gas.

        ``x`` is IEC 60534's pressure-drop ratio ``dp/p1``; choking begins at
        ``F_gamma * xT``. ``F_gamma = gamma / 1.40`` carries the specific-heat
        ratio relative to air, which is what makes helium (1.667) choke at a
        different ratio from nitrogen (1.40).
        """
        if flow.gamma <= 0.0 or flow.p_upstream <= 0.0 or flow.rho <= 0.0:
            return None
        F_gamma = flow.gamma / 1.40
        return F_gamma * self.p.get("xT", XT_DEFAULT), F_gamma

    def flow_ceiling(self, flow: FlowConditions) -> float | None:
        """Sonic mass flow through the valve [kg/s], or None for a liquid.

        IEC 60534-2-1 sizes a valve on gas as
        ``W = N6 . C . Y . sqrt(x . p1 . rho1)`` with ``Y = 1 - x/(3.F_gamma.xT)``.
        At the critical ratio ``x = F_gamma.xT`` the expansion factor is exactly
        ``2/3`` and the flow stops responding to downstream pressure, which is
        the ceiling. ``N6 = 27.3`` for W in kg/h, p in kPa and rho in kg/m^3.

        This is the same standard the Cv itself is defined by, so a valve's
        datasheet number and its choke point come from one model rather than two.
        """
        choke = self._gas_choke(flow)
        if choke is None:
            return None
        x_crit, _ = choke
        Cv_eff = self.effective_cv(self.signal(flow, "command", 1.0))
        if Cv_eff <= 0.0:
            return None
        return (
            _calibrate_choke()
            * Cv_eff
            * (2.0 / 3.0)
            * math.sqrt(x_crit * (flow.p_upstream / 1000.0) * flow.rho)
        )

    def is_choked(self, dp_available: float, flow: FlowConditions) -> bool:
        choke = self._gas_choke(flow)
        if choke is None:
            limit = self.choked_dp(flow)
            return limit is not None and dp_available >= limit
        x_crit, _ = choke
        return dp_available >= x_crit * flow.p_upstream

    def choked_dp(self, flow: FlowConditions) -> float | None:
        """Pressure drop at which the liquid flow chokes, per IEC 60534.

        ``None`` when the fluid state does not say -- no saturation pressure
        given, which is the honest answer for an incompletely specified liquid.
        A gas is handled by :meth:`flow_ceiling` instead.
        """
        if flow.p_sat <= 0.0 or flow.p_crit <= 0.0 or flow.p_upstream <= 0.0:
            return None
        p2_choke = cv.control_valve_choke_P_l(
            Psat=flow.p_sat,
            Pc=flow.p_crit,
            FL=self.p["FL"],
            P1=flow.p_upstream,
        )
        return flow.p_upstream - float(p2_choke)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        position = self.signal(flow, "command", 1.0)
        dp = self.pressure_drop(mdot, flow)
        out: dict[str, float] = {
            "position": position,
            "Cv": self.effective_cv(position),
            "dp": dp,
            "velocity": velocity(mdot, self.p["bore"], flow.rho),
        }
        limit = self.choked_dp(flow)
        if limit is not None:
            out["dp_choked"] = limit
            out["choked"] = 1.0 if dp >= limit else 0.0
        if flow.p_sat > 0.0 and flow.p_upstream > flow.p_sat:
            out["cavitation_index"] = float(
                cv.cavitation_index(flow.p_upstream, flow.p_upstream - dp, flow.p_sat)
            )
        return out


#: US gpm of water through one square inch at one psi, per unit Cd. From the
#: orifice law: at dp = 6894.76 Pa and rho = 998 kg/m^3 the velocity is
#: 3.717 m/s, so 6.4516e-4 m^2 passes 2.398e-3 m^3/s = 38.0 gpm.
GPM_PER_IN2_AT_1PSI = 38.0


def cv_from_cd(cd: float, bore: float) -> float:
    """The Cv a discharge coefficient and a bore [m] amount to.

    ``Cv = 38.0 . Cd . A[in^2]``. A team that measured a valve's Cd rather
    than its Cv gets the same element with the number they have; the rest of
    the valve -- position, characteristic, choking -- is unchanged, because it
    is the same physics stated the other way round.
    """
    area_in2 = math.pi * (bore / 0.0254) ** 2 / 4.0
    return GPM_PER_IN2_AT_1PSI * cd * area_in2


class ValveCd(Valve):
    """A valve given as a discharge coefficient.

    The Cv equivalent is computed once from ``Cd`` and ``bore`` and then it is
    the Cv valve in every respect.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        if "Cv" not in self.p:
            self.p["Cv"] = cv_from_cd(self.p["Cd"], self.p["bore"])


class CheckValve(HydraulicComponent):
    """Forward flow through a Cv; reverse flow through a seat leak.

    The first component here that is not a smooth function of flow. Forward, it
    is a valve with a cracking pressure to overcome; backward, it is very nearly
    shut. That discontinuity at zero flow is exactly why the solver interface is
    residual-based rather than ``dp(mdot)``, and it is the component to re-check
    when Phase 04 settles that interface.
    """

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        bore = self.p["bore"]
        forward = mdot >= 0.0
        Cv = self.p["Cv"] if forward else self.p["leak_reverse"]
        head = Cv_to_K(max(Cv, 1e-12), bore) * _dynamic_head(mdot, bore, flow.rho)
        return head + (self.p["cracking_pressure"] if forward else 0.0)

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        return {
            "open": 1.0 if mdot > 0.0 else 0.0,
            "dp": self.pressure_drop(mdot, flow),
            "velocity": velocity(mdot, self.p["bore"], flow.rho),
        }


class CheckValveCd(CheckValve):
    """A check valve given as a discharge coefficient. See :class:`ValveCd`."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        if "Cv" not in self.p:
            self.p["Cv"] = cv_from_cd(self.p["Cd"], self.p["bore"])


# ---------------------------------------------------------------------------
# Measured -- available for any component type
# ---------------------------------------------------------------------------


class MeasuredElement(HydraulicComponent):
    """Pressure drop read from a measured curve, superseding every correlation.

    The component-level counterpart of the property layer's tabulated backend,
    and the same principle: inside the range you measured, your data wins.

    Unlike the property layer this does **not** fall through to a correlation
    outside its range -- it raises. A property has a defensible fallback in an
    equation of state; a component's measured curve has no equivalent, and
    quietly switching to a correlation halfway up a flow sweep would produce a
    kink nobody asked for and nobody would see.
    """

    def __init__(self, instance: ComponentInstance) -> None:
        super().__init__(instance)
        curve = instance.curves.get("dp_mdot")
        if curve is None:
            raise SpecError(
                f"{instance.id}: model 'measured' needs a 'dp_mdot' curve "
                "(mass flow against pressure drop)"
            )
        self.curve: Curve = curve

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        return self.curve(abs(mdot))

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        low, high = self.curve.x_range_si
        return {
            "dp": self.pressure_drop(mdot, flow),
            "mdot_min": low,
            "mdot_max": high,
        }


# ---------------------------------------------------------------------------
# SegmentedPipe
# ---------------------------------------------------------------------------


class SegmentedPipe(HydraulicComponent):
    """A run the drawing itemised: several bores, several lengths, real fittings.

    :class:`Pipe` is one bore of one length with its fittings lumped into
    ``K_minor``. A real line is not that. It is 400 mm of 1/2 in. tube, three
    elbows, a reducer, 900 mm of 3/8 in., a tee. The drawing records exactly
    that, and this evaluates it segment by segment::

        dp = sum_i (f_i L_i / D_i + sum_j K_ij) . rho v_i^2 / 2

    with ``v_i`` the velocity in *that* segment's bore. The bore is inside the
    sum for a reason: it enters as the fifth power (``v^2 ~ D^-4``, and ``L/D``
    one more), so a run that steps from 1/2 in. to 3/8 in. halfway is nowhere
    near the average of the two. Lumping this run into one equivalent bore is
    the error this class exists to stop.

    Two things it does that a per-segment sum does not do by itself:

    **The tube length, not the assembly length.** A fitting's K already prices
    the flow through the fitting, so the friction term must use the tube only.
    :meth:`~feedtwin.model.segments.LineSegment.tube_length` takes the fitting
    bodies out when the drawing says the length was measured end to end.

    **Bore changes are contractions.** Two adjacent segments of different bore
    *are* a reducer, whether or not anybody drew one. Deriving it is the only
    safe choice: a reducer somebody forgot to add is silent, and on a 1/2 in.
    to 3/8 in. step at 10 m/s it is worth about 0.1 bar -- larger than most of
    the elbows that did get drawn.

    Segments are evaluated by their own method, so a run that has been flowed in
    one place and estimated in another gets the measurement where the
    measurement exists. See :mod:`feedtwin.model.segments` for the ladder.
    """

    def __init__(self, instance: ComponentInstance) -> None:
        super().__init__(instance)
        if not instance.segments:
            raise SpecError(
                f"{instance.id}: model 'segmented' needs a segment list; the "
                "drawing did not itemise this line, so it wants model 'darcy'"
            )
        self.segments = instance.segments
        self._roughness = self.p.get("roughness", 1.5e-6)
        self._method = self.opt.get("friction", DEFAULT_FRICTION_METHOD)
        # The bore the run's *reported* velocity and Reynolds number refer to.
        # The tightest one, because that is where a velocity limit bites and
        # where cavitation starts -- an average bore would report a number that
        # is true nowhere on the line.
        bores = [s.bore_si for s in self.segments if s.bore_si > 0.0]
        self._bore = min(bores) if bores else 0.0
        # Whole-run elevation, used only when no segment states its own. A
        # drawing that records the rise per segment has already recorded the
        # total, so adding the line-level value on top would count it twice.
        stated = [
            s.elevation_change.si
            for s in self.segments
            if s.elevation_change is not None
        ]
        self._elevation_m = (
            sum(stated) if stated else self.p.get("elevation_change", 0.0)
        )

    # ------------------------------------------------------------ the physics

    def pressure_drop(self, mdot: float, flow: FlowConditions) -> float:
        total = 0.0
        for index, segment in enumerate(self.segments):
            total += self._segment_dp(segment, mdot, flow)
            total += self._transition_dp(index, mdot, flow)
        return total

    def static_head(self, flow: FlowConditions) -> float:
        return flow.rho * GRAVITY * self._elevation_m

    def _segment_dp(
        self, segment: LineSegment, mdot: float, flow: FlowConditions
    ) -> float:
        if segment.method == "curve" and segment.curve is not None:
            return _curve_dp(segment.curve, abs(mdot))

        bore = segment.bore_si or self._bore
        if bore <= 0.0:
            # No bore anywhere on the line: nothing can be sized. The reader
            # has already warned; contributing zero is the only honest answer,
            # and it is visible in `segments_sized`.
            return 0.0
        head = _dynamic_head(mdot, bore, flow.rho)

        if segment.method in ("measured_K", "lumped_K"):
            return (segment.K.si if segment.K is not None else 0.0) * head
        if segment.method != "itemised":
            return 0.0

        roughness = (
            segment.roughness.si if segment.roughness is not None else self._roughness
        )
        Re = reynolds(mdot, bore, flow.rho, flow.mu)
        fd = darcy_friction_factor(Re, roughness / bore, self._method)
        K = fd * segment.tube_length() / bore
        K += self._fittings_K(segment, bore, Re, fd, roughness)
        return K * head

    def _fittings_K(
        self, segment: LineSegment, bore: float, Re: float, fd: float, rough: float
    ) -> float:
        """Every fitting on one segment, summed, referred to the segment bore.

        A fitting carrying its own measured K uses it: a number off a flow bench
        beats every correlation, which is the same rule the segment ladder
        applies one level up. One that carries its own bore is priced in that
        bore but referred back to the segment's, because the K a solver adds to
        ``f L / D`` has to multiply the same dynamic head as the friction does.
        """
        total = 0.0
        for fitting in segment.fittings:
            if fitting.count <= 0:
                continue
            if fitting.K > 0.0:
                total += fitting.K * fitting.count
                continue
            own = fitting.bore if fitting.bore > 0.0 else bore
            try:
                K = fitting_K(
                    fitting.kind,
                    FittingContext(bore=own, Re=Re, roughness=rough, fd=fd),
                )
            except KeyError:
                # Not a kind this library prices. The reader warned; carrying on
                # with the rest of the run beats refusing to solve the line.
                continue
            if own != bore:
                # K scales with the dynamic head it was referred to, which goes
                # as 1/A^2, so as the fourth power of the bore ratio.
                K *= (bore / own) ** 4
            total += K * fitting.count
        return total

    def _transition_dp(self, index: int, mdot: float, flow: FlowConditions) -> float:
        """The reducer or expander implied by the next segment's bore.

        Derived rather than drawn. Two adjacent segments of different bore *are*
        the transition; making somebody add a row for it is a step they can
        forget, and then the run is quietly cheap.
        """
        if index + 1 >= len(self.segments):
            return 0.0
        here = self.segments[index].bore_si or self._bore
        there = self.segments[index + 1].bore_si or self._bore
        if here <= 0.0 or there <= 0.0 or abs(here - there) < 1e-9:
            return 0.0
        # Both fluids' correlations refer K to the *smaller* bore, which is also
        # where the velocity is highest and the loss actually happens.
        small = min(here, there)
        Re = reynolds(mdot, small, flow.rho, flow.mu)
        fd = darcy_friction_factor(Re, self._roughness / small, self._method)
        kind = "contraction" if there < here else "expansion"
        K = fitting_K(
            kind,
            FittingContext(
                bore=here,
                Re=Re,
                roughness=self._roughness,
                fd=fd,
                params={"bore2": there},
            ),
        )
        return K * _dynamic_head(mdot, small, flow.rho)

    # ---------------------------------------------------------- what it shows

    def diagnostics(self, mdot: float, flow: FlowConditions) -> dict[str, float]:
        loss = self.pressure_drop(mdot, flow)
        Re = reynolds(mdot, self._bore, flow.rho, flow.mu) if self._bore > 0.0 else 0.0
        sized = sum(1 for s in self.segments if (s.bore_si or self._bore) > 0.0)
        return {
            # At the tightest bore, so this is the worst velocity on the run and
            # the one worth comparing against a limit.
            "velocity": (
                velocity(mdot, self._bore, flow.rho) if self._bore > 0.0 else 0.0
            ),
            "Re": Re,
            "dp_friction": loss,
            "dp_elevation": self.static_head(flow),
            "bore_min": self._bore,
            "length_tube": sum(s.tube_length() for s in self.segments),
            "segments": float(len(self.segments)),
            "segments_sized": float(sized),
            "fittings": float(sum(f.count for s in self.segments for f in s.fittings)),
            "laminar": 1.0 if 0.0 < Re < LAMINAR_LIMIT else 0.0,
        }


def _curve_dp(curve: Curve, mdot: float) -> float:
    """A measured curve, continued quadratically past the ends it was measured over.

    :class:`MeasuredElement` raises outside its range, and for a whole component
    declared ``measured`` that is right -- the run is the measurement, and there
    is nothing else to fall back on.

    A *segment* is different in two ways. It is one part of a run whose other
    parts still have physics, so refusing the point throws away everything that
    is known about the rest of the line. And a Newton iterate overshoots by its
    nature: killing a transient because the solver probed 1.1x the top of a flow
    bench sweep would make a measured segment worse to have than no measurement.

    So it is continued, and continued *quadratically* -- ``dp ~ mdot^2`` is the
    turbulent law the curve is a measurement of, so this is the shape the data
    already has rather than a shape invented to fill a gap. Clamping instead
    would be worse than either: a flat dp above the last point takes the flow
    dependence out of the branch equation, and a branch whose loss does not
    respond to its own flow makes the Jacobian singular.
    """
    low, high = curve.x_range_si
    if low <= mdot <= high:
        return curve(mdot)
    edge = high if mdot > high else low
    if edge <= 0.0:
        return curve(low) if mdot < low else curve(high)
    return float(curve(edge) * (mdot / edge) ** 2)


def _segmented(instance: ComponentInstance) -> HydraulicComponent:
    return SegmentedPipe(instance)


def _measured(instance: ComponentInstance) -> HydraulicComponent:
    return MeasuredElement(instance)


register_builder("pipe", "darcy", Pipe)
register_builder("pipe", "measured", _measured)
register_builder("pipe", "segmented", _segmented)
register_builder("fitting", "K", Fitting)
register_builder("bend", "rounded", Bend)
register_builder("bend", "measured", _measured)
register_builder("flex_hose", "darcy", FlexHose)
register_builder("flex_hose", "measured", _measured)
register_builder("fitting", "measured", _measured)
register_builder("orifice", "cd", OrificeCd)
register_builder("orifice", "iso5167", OrificeISO5167)
register_builder("orifice", "measured", _measured)
register_builder("valve", "cv", Valve)
register_builder("valve", "cd", ValveCd)
register_builder("valve", "measured", _measured)
register_builder("check_valve", "cv", CheckValve)
register_builder("check_valve", "cd", CheckValveCd)
register_builder("check_valve", "measured", _measured)


def conditions_from_fluid(
    fluid: object,
    p: float,
    T: float,
    signals: Mapping[str, float] | None = None,
    *,
    multiphase: bool = False,
    phase: str | None = None,
) -> FlowConditions:
    """Build :class:`FlowConditions` from a :class:`~feedtwin.props.Fluid`.

    ``phase`` is what the network *declares* the node to hold, and it wins over
    the temperature rule below: ``"gas"`` is priced at ``(p, T)`` whatever the
    temperature, ``"liquid"`` on the saturated-liquid line, ``None`` falls back
    to the rule. A drawing knows which side of a tank a line is on; a
    temperature does not, and an ethanol *vapour* line at 350 K is below
    ethanol's critical temperature and would otherwise be priced as liquid.

    The bridge between Phase 01 and Phase 03, kept as a free function so that
    components never hold a fluid and stay testable with two floats.

    Saturation pressure comes from the fluid where the state has one; above the
    critical temperature there is no saturation line, and reporting zero there
    disables the cavitation checks honestly rather than inventing a limit.

    Phase, and why it is not inferred by default
    -------------------------------------------
    Asking the property layer for ``rho(p, T)`` lets it decide the phase, and
    when the temperature reaching it is wrong that decision is *silently*
    catastrophic: oxygen at the ambient default is a gas at 40 kg/m^3 where LOX
    is 1140, so the leg solves at a thirtieth of the density and every number
    after it stays plausible. It has happened twice here, from two different
    causes, and both times it looked like a flow-rate discrepancy rather than a
    property lookup.

    So ``multiphase`` is **off**. With it off, a fluid that is below its
    critical temperature is evaluated on its saturated-liquid line at ``T`` --
    it cannot come back as a gas, whatever pressure the solve is currently
    guessing. Real feed lines run subcooled and a few per cent stiffer than
    saturated, which is well inside what a lumped ``K`` already assumes.

    Turn it on when flashing and cavitation are the subject rather than the
    hazard. It is not ready for that yet, which is the other reason it is off.
    """
    if not isinstance(fluid, Fluid):
        raise TypeError(f"expected a feedtwin.props.Fluid, got {type(fluid).__name__}")

    price_liquid = not multiphase and phase != "gas"
    cached = _liquid_state(fluid, T) if price_liquid else None
    if cached is not None:
        rho, mu, gamma, p_sat, molar_mass = cached
        return FlowConditions(
            rho=rho,
            mu=mu,
            p_upstream=p,
            p_sat=p_sat,
            p_crit=fluid.critical_pressure,
            temperature=T,
            gamma=gamma,
            r_specific=R_UNIVERSAL / molar_mass if molar_mass > 0.0 else 0.0,
            signals=dict(signals or {}),
        )

    try:
        p_sat = float(fluid.get("p", T=T, q=0.0))
    except (PropertyError, ValueError):
        p_sat = 0.0
    # Above the critical point there is no saturation line, and a backend may
    # answer with a NaN rather than declining. Zero disables the cavitation
    # checks honestly; a NaN propagates into every comparison downstream and
    # silently answers "no" to all of them.
    if not math.isfinite(p_sat):
        p_sat = 0.0

    molar_mass = fluid.constants()["molar_mass"]
    return FlowConditions(
        rho=float(fluid.get("rho", p=p, T=T)),
        mu=float(fluid.get("mu", p=p, T=T)),
        p_upstream=p,
        p_sat=p_sat,
        p_crit=fluid.critical_pressure,
        temperature=T,
        gamma=float(fluid.get("gamma", p=p, T=T)),
        r_specific=R_UNIVERSAL / molar_mass if molar_mass > 0.0 else 0.0,
        signals=dict(signals or {}),
    )


#: Saturated-liquid properties by (species, temperature). See _liquid_state.
_LIQUID_CACHE: dict[
    tuple[str, float], tuple[float, float, float, float, float] | None
] = {}

#: Temperature resolution of that cache [K]. A hundredth of a kelvin moves a
#: liquid density by parts per million and is far below anything a stand knows
#: its propellant temperature to.
_CACHE_RESOLUTION = 0.01


def _liquid_state(
    fluid: object, T: float
) -> tuple[float, float, float, float, float] | None:
    """``(rho, mu, gamma, p_sat, molar_mass)`` on the saturated-liquid line.

    ``None`` when the fluid has no liquid line at this temperature -- above the
    critical point, which is where every pressurant lives -- and the caller
    falls back to evaluating at ``(p, T)``.

    Cached because with phase inference off these depend on **temperature
    alone**: a Newton solve walks the pressures and holds the temperatures, so
    a feed line's properties are constant across the entire solve and were
    being recomputed a thousand times a tick. That was two thirds of the cost
    of a live tick, and none of it bought a different number.
    """
    if not isinstance(fluid, Fluid) or T <= 0.0 or T >= fluid.critical_temperature:
        return None
    key = (fluid.name, round(T / _CACHE_RESOLUTION) * _CACHE_RESOLUTION)
    if key in _LIQUID_CACHE:
        return _LIQUID_CACHE[key]

    quantised = key[1]
    state: tuple[float, float, float, float, float] | None
    try:
        state = (
            float(fluid.get("rho", T=quantised, q=0.0)),
            float(fluid.get("mu", T=quantised, q=0.0)),
            float(fluid.get("gamma", T=quantised, q=0.0)),
            float(fluid.get("p", T=quantised, q=0.0)),
            float(fluid.constants()["molar_mass"]),
        )
    except (PropertyError, ValueError, KeyError):
        state = None
    _LIQUID_CACHE[key] = state
    return state
