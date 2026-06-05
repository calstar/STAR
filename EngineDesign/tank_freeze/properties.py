"""NIST-quality fluid properties for the tank-freeze model, via CoolProp.

Liquid properties (rho, mu, k, cp, beta) are tabulated once per fluid on the
saturated-liquid line (the tank liquids are essentially incompressible, so the
saturation line is an excellent proxy for any modest tank pressure) and then
interpolated with numpy. Queries outside the tabulated range are clamped to
the nearest edge and a one-time flag is recorded, per the guide ("flag if T
leaves the tabulated range").

CoolProp's EOS are sourced from the same multiparameter formulations NIST
REFPROP uses (ethanol: Schroeder et al.; oxygen: Schmidt & Wagner; methane:
Setzmann & Wagner), each valid from the triple point up the saturation line.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from CoolProp.CoolProp import PropsSI

# ---------------------------------------------------------------------------
# Fluid registry: UI key -> CoolProp name + solid-phase constants (cited).
# The "solid" entries describe the frozen bulk fluid; they are the defaults
# for the overridable material inputs.
# ---------------------------------------------------------------------------
FLUIDS = {
    "ethanol": dict(
        coolprop="Ethanol",
        label="Ethanol",
        solid=dict(
            # k_s:   Talon et al., PRB 65 012203 (2002): monoclinic crystal
            #        ethanol ~0.4-0.6 W/mK over 90-159 K; 0.5 chosen (the
            #        HIGH side is conservative: faster freeze AND more ice).
            # rho_s: ~1025 kg/m^3 (crystal, cryogenic).
            # c_p_s: ~1200 J/kgK mean over 90-159 K (Kelley 1929).
            # L_fus: 4.931 kJ/mol / 46.07 g/mol (NIST WebBook); guide 1.05e5.
            # T_fr:  159 K (guide; EOS triple point 159.1 K).
            k_s=0.5, rho_s=1025.0, c_p_s=1200.0, L_fus=1.05e5, T_fr=159.0,
        ),
    ),
    "lox": dict(
        coolprop="Oxygen",
        label="LOX",
        solid=dict(
            # Solid oxygen (gamma phase near the triple point). Unreachable
            # as the freezing bulk in any supported mixed combo (no colder
            # sink available), included for completeness.
            # L_fus: 0.444 kJ/mol / 32.0 g/mol = 1.39e4 J/kg (NIST WebBook).
            k_s=0.2, rho_s=1334.0, c_p_s=900.0, L_fus=1.39e4, T_fr=54.36,
        ),
    ),
    "methane": dict(
        coolprop="Methane",
        label="Methane",
        solid=dict(
            # Solid methane (phase I, near the 90.69 K triple point).
            # L_fus: 0.94 kJ/mol / 16.04 g/mol = 5.87e4 J/kg (NIST WebBook).
            # rho_s: ~522 kg/m^3 (solid I near triple; liquid is ~451).
            # c_p_s: ~2100 J/kgK (Colwell et al. 1963 solid-CH4 calorimetry).
            # k_s:   ~0.3 W/mK order of magnitude near 90 K — LOWER
            #        confidence than the ethanol constants; override if a
            #        better source is available.
            k_s=0.3, rho_s=522.0, c_p_s=2100.0, L_fus=5.87e4, T_fr=90.69,
        ),
    ),
}


def coolprop_name(fluid: str) -> str:
    try:
        return FLUIDS[fluid]["coolprop"]
    except KeyError:
        raise ValueError(f"Unknown fluid {fluid!r}; expected one of {sorted(FLUIDS)}")


def solid_constants(fluid: str) -> dict:
    coolprop_name(fluid)  # validates
    return dict(FLUIDS[fluid]["solid"])


def fluid_label(fluid: str) -> str:
    coolprop_name(fluid)  # validates
    return FLUIDS[fluid]["label"]


@dataclass(frozen=True)
class LiquidProps:
    """Saturated-liquid properties at a single temperature (SI units)."""

    rho: float    # density [kg/m^3]
    mu: float     # dynamic viscosity [Pa s]
    k: float      # thermal conductivity [W/m K]
    cp: float     # isobaric specific heat [J/kg K]
    beta: float   # volumetric thermal expansion coefficient [1/K]


class SaturatedLiquidTable:
    """Interpolated saturated-liquid property table for one fluid."""

    def __init__(self, fluid: str, T_max: float, n: int = 400):
        name = coolprop_name(fluid)
        self.fluid = fluid
        T_min = PropsSI("Tmin", name)  # triple point
        # cp (and transport fits) blow up approaching the critical point;
        # keep the grid safely below it.
        T_cap = PropsSI("Tcrit", name) - 5.0
        T_max = min(max(float(T_max), T_min + 20.0), T_cap)
        self.T_grid = np.linspace(T_min, T_max, n)
        self.rho_grid = np.array([PropsSI("D", "T", T, "Q", 0, name) for T in self.T_grid])
        self.mu_grid = np.array([PropsSI("V", "T", T, "Q", 0, name) for T in self.T_grid])
        self.k_grid = np.array([PropsSI("L", "T", T, "Q", 0, name) for T in self.T_grid])
        self.cp_grid = np.array([PropsSI("C", "T", T, "Q", 0, name) for T in self.T_grid])
        # beta = -(1/rho) drho/dT, finite-differenced from the density table.
        # Along the saturation line this matches the isobaric coefficient to
        # well under 1% for a liquid far from critical, and it is robust to
        # EOS backends that do not expose the coefficient at saturation.
        self.beta_grid = -np.gradient(self.rho_grid, self.T_grid) / self.rho_grid

        self.T_min = float(self.T_grid[0])
        self.T_max = float(self.T_grid[-1])
        self.out_of_range = False  # one-time flag, checked by the model

    def _clamp(self, T: float) -> float:
        if T < self.T_min or T > self.T_max:
            self.out_of_range = True
            return min(max(T, self.T_min), self.T_max)
        return T

    def props(self, T: float) -> LiquidProps:
        T = self._clamp(float(T))
        return LiquidProps(
            rho=float(np.interp(T, self.T_grid, self.rho_grid)),
            mu=float(np.interp(T, self.T_grid, self.mu_grid)),
            k=float(np.interp(T, self.T_grid, self.k_grid)),
            cp=float(np.interp(T, self.T_grid, self.cp_grid)),
            beta=float(np.interp(T, self.T_grid, self.beta_grid)),
        )

    def mu(self, T: float) -> float:
        return float(np.interp(self._clamp(float(T)), self.T_grid, self.mu_grid))

    def cp(self, T: float) -> float:
        return float(np.interp(self._clamp(float(T)), self.T_grid, self.cp_grid))


_table_cache: dict[str, SaturatedLiquidTable] = {}


def get_liquid_table(fluid: str, T_max: float = 350.0) -> SaturatedLiquidTable:
    """Lazily built, module-cached property table (rebuilt if too short)."""
    cached = _table_cache.get(fluid)
    if cached is None or (cached.T_max < T_max and cached.T_max < PropsSI("Tcrit", coolprop_name(fluid)) - 5.0):
        cached = SaturatedLiquidTable(fluid, T_max)
        _table_cache[fluid] = cached
    cached.out_of_range = False  # fresh flag for each run
    return cached


def get_ethanol_table(T_max: float = 350.0) -> SaturatedLiquidTable:
    """Back-compat alias for the original single-fluid API."""
    return get_liquid_table("ethanol", T_max)


def sat_temperature(fluid: str, P_pa: float) -> float:
    """Saturation temperature [K] of a fluid at tank pressure."""
    return float(PropsSI("T", "P", float(P_pa), "Q", 0, coolprop_name(fluid)))


def oxygen_Tsat(P_pa: float) -> float:
    """Back-compat alias: LOX saturation temperature (~90.2 K at 1 atm)."""
    return sat_temperature("lox", P_pa)


def chf_zuber(fluid: str, P_pa: float, g: float = 9.81) -> float:
    """Pool-boiling critical heat flux via the Zuber correlation.

    q''_CHF = 0.131 * h_fg * sqrt(rho_v) * [sigma * g * (rho_l - rho_v)]^(1/4)

    (Rohsenow et al., Handbook of Heat Transfer). ~2e5 W/m^2 for O2 at 1 atm.
    Used only as a sanity guard on the fixed-T sink / nucleate-boiling
    assumption for the sink fluid.
    """
    name = coolprop_name(fluid)
    P = float(P_pa)
    rho_l = PropsSI("D", "P", P, "Q", 0, name)
    rho_v = PropsSI("D", "P", P, "Q", 1, name)
    h_fg = PropsSI("H", "P", P, "Q", 1, name) - PropsSI("H", "P", P, "Q", 0, name)
    sigma = PropsSI("surface_tension", "P", P, "Q", 0, name)
    return float(0.131 * h_fg * np.sqrt(rho_v) * (sigma * g * (rho_l - rho_v)) ** 0.25)


def oxygen_chf_zuber(P_pa: float, g: float = 9.81) -> float:
    """Back-compat alias for the original single-fluid API."""
    return chf_zuber("lox", P_pa, g)
