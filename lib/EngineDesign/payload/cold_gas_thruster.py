"""
Cold Gas Thruster (CGT) analysis module.

Design: 4 CO₂ cold-gas thrusters at the nosecone, sharing the same nozzle
geometry, firing perpendicular to the rocket's longitudinal axis (±Y, ±Z).

Given a converging-diverging nozzle geometry (throat + exit areas, bell%)
and an inlet CO₂ stagnation pressure, computes:
  - Thrust per thruster (momentum + pressure thrust)
  - Specific impulse
  - Mass flow rate
  - Nozzle exit conditions (Mach, temperature, pressure, velocity)
  - Torque and angular acceleration about the rocket CG

Reuses:
  - engine.core.mach_solver.solve_mach_robust  (isentropic area-Mach solver)
  - engine.core.nozzle_solver.rao              (Rao bell nozzle contour)
"""

from __future__ import annotations

import numpy as np
from dataclasses import dataclass, field
from typing import Optional, Dict, Any

from engine.core.mach_solver import solve_mach_robust
from engine.core.chamber_geometry import generate_nozzle
from engine.core.chamber_geometry_solver import solved_chamber_plot


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
R_UNIVERSAL = 8.314462618  # J/(mol·K)
G0 = 9.80665              # m/s² standard gravity

# CO₂ ideal-gas defaults
CO2_GAMMA = 1.289
CO2_MOLAR_MASS = 0.04401  # kg/mol  → R_specific = 188.92 J/(kg·K)

# 12 psi in Pascals
PSI_TO_PA = 6894.757
DEFAULT_AMBIENT_PA = 12.0 * PSI_TO_PA  # 82 737 Pa


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
@dataclass
class ColdGasThrusterConfig:
    """All inputs for one cold-gas thruster analysis.

    Nozzle geometry
    ---------------
    throat_diameter : float   — Throat diameter [m]
    exit_diameter   : float   — Exit diameter [m]
    bell_percent    : float   — Rao bell length fraction (default 0.80)
    nozzle_method   : str     — 'garcia' or 'top' (default 'garcia')

    Gas state
    ---------
    inlet_pressure    : float — CO₂ stagnation (total) pressure [Pa]
    inlet_temperature : float — CO₂ stagnation temperature [K]  (default 293)
    gamma             : float — Specific heat ratio  (default 1.289 for CO₂)
    molar_mass        : float — Molar mass [kg/mol]  (default 0.04401)
    nozzle_efficiency : float — Velocity efficiency factor (default 0.95)

    Thruster arrangement
    --------------------
    num_thrusters    : int   — Number of thrusters (default 4)
    ambient_pressure : float — Back-pressure [Pa]  (default 12 psi = 82 737 Pa)

    Rocket geometry (for torque calculation)
    ----------------------------------------
    rocket_length : float — Total length tail→nose [m]  (default 7.5)
    rocket_radius : float — Body tube radius [m]        (default 0.1015)
    rocket_mass   : float — Total mass [kg]             (default 130.0)
    cg_from_tail  : float — CG position from tail [m]   (default 3.0)
    """

    # --- Nozzle geometry (user must fill in) ---
    throat_diameter: float = 0.0
    exit_diameter: float = 0.0
    bell_percent: float = 0.80
    nozzle_method: str = "top"

    # --- Gas state ---
    inlet_pressure: float = 0.0          # Pa — user must fill in
    inlet_temperature: float = 293.0     # K
    gamma: float = CO2_GAMMA
    molar_mass: float = CO2_MOLAR_MASS
    nozzle_efficiency: float = 0.95

    # --- Thruster arrangement ---
    num_thrusters: int = 4
    ambient_pressure: float = DEFAULT_AMBIENT_PA  # 12 psi

    # --- Rocket geometry ---
    rocket_length: float = 5.9182   # 233 in
    rocket_radius: float = 0.1015   # 4 in
    rocket_mass: float = 63.5029    # 140 lbs
    cg_from_tail: float = 2.6162    # (233 - 130) = 103 in from tail (moment arm = 130 in)

    # --- Chamber geometry (optional for performance, used for contour) ---
    chamber_diameter: float = 0.010   # 10 mm
    chamber_length: float = 0.015     # 15 mm

    # --- Geometry for solved_chamber_plot (purely geometric contour) ---
    # Set volume_chamber > 0 to use the solved path instead of the hand-rolled fallback.
    volume_chamber: float = 0.0       # Chamber volume [m³] (0 = not set → auto-compute)
    Lstar: float = 0.0                # Characteristic length L* [m] (informational)

    # --- Derived (computed at runtime) ---
    @property
    def R_specific(self) -> float:
        """Specific gas constant R = R_universal / molar_mass  [J/(kg·K)]."""
        return R_UNIVERSAL / self.molar_mass

    @property
    def A_throat(self) -> float:
        """Throat area [m²]."""
        return np.pi / 4.0 * self.throat_diameter ** 2

    @property
    def A_exit(self) -> float:
        """Exit area [m²]."""
        return np.pi / 4.0 * self.exit_diameter ** 2

    @property
    def expansion_ratio(self) -> float:
        """Area ratio ε = A_exit / A_throat."""
        if self.A_throat == 0:
            return 0.0
        return self.A_exit / self.A_throat

    @property
    def A_chamber(self) -> float:
        """Chamber area [m²]."""
        return np.pi / 4.0 * self.chamber_diameter ** 2

    @property
    def _effective_volume_chamber(self) -> float:
        """Chamber volume [m³].  If not explicitly set, estimate from A_chamber × length."""
        if self.volume_chamber > 0:
            return self.volume_chamber
        return self.A_chamber * self.chamber_length

    @property
    def _use_solved_plot(self) -> bool:
        """True when the caller has provided enough geometry for solved_chamber_plot."""
        return self.volume_chamber > 0

    @property
    def moment_arm(self) -> float:
        """Distance from nosecone (thruster location) to CG [m]."""
        return self.rocket_length - self.cg_from_tail


# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------
@dataclass
class ColdGasThrusterResult:
    """Full output of one CGT analysis."""

    # Per-thruster performance
    thrust: float = 0.0              # F per thruster [N]
    mass_flow: float = 0.0           # ṁ per thruster [kg/s]
    specific_impulse: float = 0.0    # Isp [s]
    momentum_thrust: float = 0.0     # ṁ·v_exit [N]
    pressure_thrust: float = 0.0     # (Pe-Pa)·Ae [N]

    # Exit conditions
    exit_mach: float = 0.0
    exit_velocity: float = 0.0       # v_exit actual [m/s]
    exit_temperature: float = 0.0    # T_exit [K]
    exit_pressure: float = 0.0       # P_exit [Pa]
    inlet_pressure: float = 0.0      # P0 [Pa]
    ambient_pressure: float = 0.0    # Pa [Pa]

    # Throat conditions
    throat_mach: float = 1.0         # Mach number at throat
    is_choked: bool = True           # Whether flow is choked (M=1 at throat)
    critical_pressure_ratio: float = 0.0

    # Nozzle geometry
    throat_area: float = 0.0         # A_t [m²]
    exit_area: float = 0.0           # A_e [m²]
    expansion_ratio: float = 0.0

    # Chamber geometry
    chamber_diameter: float = 0.0    # [m]
    chamber_length: float = 0.0      # [m]

    # Totals (all thrusters)
    total_thrust: float = 0.0        # N (single axis — 1 thruster at a time)
    total_mass_flow: float = 0.0     # kg/s if ALL fire

    # Torque / angular dynamics (per single thruster)
    moment_arm: float = 0.0          # [m]
    torque: float = 0.0              # τ = F × arm [N·m]
    moi_estimate: float = 0.0        # I simplified [kg·m²]
    angular_accel: float = 0.0       # α = τ / I [rad/s²]

    # Nozzle contour (optional)
    nozzle_contour: Optional[np.ndarray] = None

    def summary(self) -> str:
        """Human-readable summary of results."""
        lines = [
            "=" * 60,
            "  COLD GAS THRUSTER ANALYSIS  —  CO₂",
            "=" * 60,
            "",
            "── Nozzle Geometry ─────────────────────────────────",
            f"  Throat diameter    : {np.sqrt(self.throat_area * 4 / np.pi) * 1e3:.3f} mm",
            f"  Exit diameter      : {np.sqrt(self.exit_area * 4 / np.pi) * 1e3:.3f} mm",
            f"  Expansion ratio ε  : {self.expansion_ratio:.4f}",
            f"  Throat area        : {self.throat_area * 1e6:.4f} mm²",
            f"  Exit area          : {self.exit_area * 1e6:.4f} mm²",
            "",
            "── Chamber Geometry ────────────────────────────────",
            f"  Chamber diameter   : {self.chamber_diameter * 1e3:.3f} mm",
            f"  Chamber length     : {self.chamber_length * 1e3:.3f} mm",
            "",
            "── Exit Conditions ─────────────────────────────────",
            f"  Exit Mach          : {self.exit_mach:.4f}",
            f"  Exit velocity      : {self.exit_velocity:.2f} m/s",
            f"  Exit temperature   : {self.exit_temperature:.2f} K",
            f"  Exit pressure      : {self.exit_pressure:.2f} Pa  ({self.exit_pressure / PSI_TO_PA:.2f} psi)",
            "",
            "── Throat Flow Check ───────────────────────────────",
            f"  Throat Mach        : {self.throat_mach:.4f}",
            f"  Flow is choked     : {self.is_choked}",
            f"  Min Pr for choking : {self.critical_pressure_ratio:.4f}",
            f"  Actual Pr (P0/Pa)  : {self.inlet_pressure/self.ambient_pressure if self.ambient_pressure > 0 else float('inf'):.4f}",
            "",
            "── Per-Thruster Performance ────────────────────────",
            f"  Mass flow rate ṁ   : {self.mass_flow * 1e3:.4f} g/s",
            f"  Momentum thrust    : {self.momentum_thrust:.4f} N",
            f"  Pressure thrust    : {self.pressure_thrust:.4f} N",
            f"  TOTAL THRUST       : {self.thrust:.4f} N",
            f"  Specific impulse   : {self.specific_impulse:.2f} s",
            "",
            "── Torque / Angular Dynamics (single thruster) ────",
            f"  Moment arm (nose→CG): {self.moment_arm:.3f} m",
            f"  Torque             : {self.torque:.4f} N·m",
            f"  MOI estimate       : {self.moi_estimate:.2f} kg·m²",
            f"  Angular accel α    : {self.angular_accel:.6f} rad/s²"
            f"  ({np.degrees(self.angular_accel):.4f} °/s²)",
            "",
            "=" * 60,
        ]
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main analysis class
# ---------------------------------------------------------------------------
class ColdGasThruster:
    """Cold-gas thruster performance analyser.

    Usage
    -----
    >>> cfg = ColdGasThrusterConfig(
    ...     throat_diameter=0.005,
    ...     exit_diameter=0.010,
    ...     inlet_pressure=500_000,
    ... )
    >>> cgt = ColdGasThruster(cfg)
    >>> result = cgt.compute()
    >>> print(result.summary())
    """

    def __init__(self, config: ColdGasThrusterConfig):
        self.cfg = config

    # ------------------------------------------------------------------
    # Core analysis
    # ------------------------------------------------------------------
    def compute(self) -> ColdGasThrusterResult:
        """Run the full isentropic cold-gas analysis and return results."""
        cfg = self.cfg
        g = cfg.gamma
        R = cfg.R_specific
        P0 = cfg.inlet_pressure
        T0 = cfg.inlet_temperature
        A_t = cfg.A_throat
        A_e = cfg.A_exit
        eps = cfg.expansion_ratio
        Pa = cfg.ambient_pressure
        eta = cfg.nozzle_efficiency

        # -- 1. Exit Mach number from expansion ratio ----------------------
        M_exit, converged = solve_mach_robust(eps, g, supersonic=True)
        if not converged:
            raise RuntimeError(
                f"Mach solver did not converge for ε={eps:.4f}, γ={g:.4f}"
            )

        # -- 2. Isentropic exit conditions ---------------------------------
        # T_exit / T0 = [1 + (γ-1)/2 · M²]⁻¹
        T_exit = T0 / (1.0 + (g - 1.0) / 2.0 * M_exit ** 2)

        # P_exit / P0 = [1 + (γ-1)/2 · M²]^(-γ/(γ-1))
        P_exit = P0 * (1.0 + (g - 1.0) / 2.0 * M_exit ** 2) ** (-g / (g - 1.0))

        # v_exit = M · √(γ R T_exit)  (ideal), then apply efficiency
        v_exit_ideal = M_exit * np.sqrt(g * R * T_exit)
        v_exit = v_exit_ideal * eta

        # -- 3. Throat Flow Check ------------------------------------------
        # Flow is choked if P0/Pa > ((gamma+1)/2)^(gamma/(gamma-1))
        critical_pr = ((g + 1.0) / 2.0) ** (g / (g - 1.0))
        actual_pr = P0 / Pa if Pa > 0 else float('inf')
        is_choked = actual_pr >= critical_pr

        # -- 4. Mass flow rate ---------------------------------------------
        # ṁ = P0 · A_t · √(γ / (R·T0)) · [2/(γ+1)]^((γ+1)/(2(γ-1)))
        mass_flow_factor = (2.0 / (g + 1.0)) ** ((g + 1.0) / (2.0 * (g - 1.0)))
        mdot = P0 * A_t * np.sqrt(g / (R * T0)) * mass_flow_factor

        # -- 4. Thrust (per thruster) --------------------------------------
        momentum_thrust = mdot * v_exit
        pressure_thrust = (P_exit - Pa) * A_e
        thrust = momentum_thrust + pressure_thrust

        # -- 5. Specific impulse -------------------------------------------
        Isp = thrust / (mdot * G0) if mdot > 0 else 0.0

        # -- 6. Torque / angular acceleration (single thruster at nosecone)
        arm = cfg.moment_arm
        torque = thrust * arm

        # Simplified MOI: slender rod about CM  → I = (1/12)·m·L²
        I_rod = (1.0 / 12.0) * cfg.rocket_mass * cfg.rocket_length ** 2
        alpha = torque / I_rod if I_rod > 0 else 0.0

        return ColdGasThrusterResult(
            thrust=thrust,
            mass_flow=mdot,
            specific_impulse=Isp,
            momentum_thrust=momentum_thrust,
            pressure_thrust=pressure_thrust,
            exit_mach=M_exit,
            exit_velocity=v_exit,
            exit_temperature=T_exit,
            exit_pressure=P_exit,
            inlet_pressure=P0,
            ambient_pressure=Pa,
            throat_mach=1.0 if is_choked else 0.0,  # Simplified: assume M=1 if choked
            is_choked=is_choked,
            critical_pressure_ratio=critical_pr,
            throat_area=A_t,
            exit_area=A_e,
            expansion_ratio=eps,
            chamber_diameter=cfg.chamber_diameter,
            chamber_length=cfg.chamber_length,
            total_thrust=thrust,  # single-axis, one thruster at a time
            total_mass_flow=mdot * cfg.num_thrusters,
            moment_arm=arm,
            torque=torque,
            moi_estimate=I_rod,
            angular_accel=alpha,
        )

    # ------------------------------------------------------------------
    # Nozzle contour generation
    # ------------------------------------------------------------------
    def generate_nozzle_contour(
        self,
        steps: int = 200,
        do_plot: bool = True,
        color_segments: bool = True,
    ) -> np.ndarray:
        """Generate the converging-diverging nozzle + chamber contour.

        Two paths are available:

        **Solved path** (preferred): when ``config.volume_chamber > 0``, calls
        :func:`engine.core.chamber_geometry_solver.solved_chamber_plot` which is
        purely geometric — no CEA or thermodynamic iteration required.  Requires:
        ``A_throat``, ``A_exit``, ``volume_chamber``, ``chamber_diameter``, and
        ``chamber_length`` (``Lstar`` is optional / informational).

        **Fallback path**: when ``volume_chamber`` is not set, the original
        hand-rolled contour (cylindrical section + 45° contraction + Rao bell) is
        used for backward-compatibility.

        Parameters
        ----------
        steps : int
            Number of points per contour segment.
        do_plot : bool
            Whether to save a plot to ``payload/cgt_nozzle.png``.
        color_segments : bool
            Colour-code sections in the plot (fallback path only).

        Returns
        -------
        pts : np.ndarray, shape (N, 2)
            Contour points (axial x [m], radius y [m]).
        """
        import matplotlib.pyplot as plt
        import os

        cfg = self.cfg

        # ------------------------------------------------------------------
        # Choose contour generation path
        # ------------------------------------------------------------------
        if cfg._use_solved_plot:
            # ── Solved path ────────────────────────────────────────────────
            # All inputs are purely geometric; no thermodynamics needed.
            lstar_val = cfg.Lstar if cfg.Lstar > 0 else cfg._effective_volume_chamber / cfg.A_throat
            pts, _table, _lengths = solved_chamber_plot(
                area_throat=cfg.A_throat,
                area_exit=cfg.A_exit,
                volume_chamber=cfg._effective_volume_chamber,
                lstar=lstar_val,
                chamber_diameter=cfg.chamber_diameter,
                length=cfg.chamber_length,
                do_plot=False,
                steps=steps,
            )
        else:
            # ── Fallback path (backward-compatible hand-rolled geometry) ───
            pts, nozzle_x_first, nozzle_y_first = generate_nozzle(
                cfg.A_throat, cfg.A_exit, steps=steps
            )

            r_c = cfg.chamber_diameter / 2.0
            x_cyl_start = nozzle_x_first + nozzle_y_first - r_c

            x_contraction = np.linspace(x_cyl_start, nozzle_x_first, steps)
            y_contraction = r_c - x_contraction + x_cyl_start

            x_cyl_end = x_cyl_start - cfg.chamber_length
            x_cyl = np.linspace(x_cyl_end, x_cyl_start, steps)
            y_cyl = np.full_like(x_cyl, r_c)

            pts = np.vstack([
                np.column_stack((x_cyl, y_cyl)),
                np.column_stack((x_contraction[1:], y_contraction[1:])),
                pts,
            ])

        # ------------------------------------------------------------------
        # Optional plot
        # ------------------------------------------------------------------
        if do_plot:
            x_mm = pts[:, 0] * 1e3
            y_mm = pts[:, 1] * 1e3
            x_span = x_mm.max() - x_mm.min()
            y_span = 2.0 * y_mm.max()

            margin = 0.20
            fig_w = x_span * (1.0 + 2 * margin)
            fig_h = y_span * (1.0 + 2 * margin)
            scale = 10.0 / max(fig_w, fig_h)
            fig_w_in = max(fig_w * scale, 4.0)
            fig_h_in = max(fig_h * scale, 2.0)

            fig, ax = plt.subplots(figsize=(fig_w_in, fig_h_in))
            ax.plot(x_mm,  y_mm, "k-", linewidth=2)
            ax.plot(x_mm, -y_mm, "k-", linewidth=2)
            ax.axhline(0, color="grey", linewidth=0.5, linestyle="--")
            ax.set_aspect("equal", adjustable="box")
            ax.set_xlabel("Axial position [mm]")
            ax.set_ylabel("Radius [mm]")
            path_label = "solved" if cfg._use_solved_plot else "hand-rolled"
            ax.set_title(f"Cold Gas Thruster — Full Contour ({path_label})")
            ax.grid(True, alpha=0.3)

            vol_str = (
                f"Vol = {cfg._effective_volume_chamber*1e6:.3f} cm³\n"
                if cfg._use_solved_plot else ""
            )
            info = (
                f"Chamber ∅ {cfg.chamber_diameter*1e3:.1f} mm\n"
                f"Throat  ∅ {cfg.throat_diameter*1e3:.2f} mm\n"
                f"Exit    ∅ {cfg.exit_diameter*1e3:.2f} mm\n"
                f"ε = {cfg.expansion_ratio:.2f}\n"
                + vol_str
            )
            ax.text(
                0.02, 0.98, info,
                transform=ax.transAxes,
                fontsize=8, va="top",
                bbox=dict(boxstyle="round", facecolor="white", alpha=0.85),
            )

            os.makedirs("payload", exist_ok=True)
            fig.savefig("payload/cgt_nozzle.png", dpi=150, bbox_inches="tight")
            plt.close(fig)

        return pts


# ---------------------------------------------------------------------------
# CLI entry-point — run as:  python -m payload.cold_gas_thruster
# ---------------------------------------------------------------------------
def main():
    """Example analysis with placeholder inputs."""
    print("Cold Gas Thruster Analysis")
    print("=" * 40)
    print()
    print("Configure your thruster in ColdGasThrusterConfig.")
    print("Example usage:")
    print()
    print("  from payload import ColdGasThruster, ColdGasThrusterConfig")
    print()
    print("  cfg = ColdGasThrusterConfig(")
    print("      throat_diameter = <your value>,   # [m]")
    print("      exit_diameter   = <your value>,   # [m]")
    print("      inlet_pressure  = <your value>,   # [Pa]")
    print("  )")
    print("  cgt = ColdGasThruster(cfg)")
    print("  result = cgt.compute()")
    print("  print(result.summary())")
    print()

    # --- Quick demo with sample values (remove / replace as needed) ---
    demo_cfg = ColdGasThrusterConfig(
        throat_diameter=0.005,    # 3 mm throat
        exit_diameter=0.015,      # 8 mm exit
        inlet_pressure=800_000,   # 800 kPa (~116 psi)
        chamber_diameter=0.012,   # 12 mm
        chamber_length=0.020,     # 20 mm
        volume_chamber=np.pi / 4 * 0.012**2 * 0.020,  # ← enables solved path
    )
    cgt = ColdGasThruster(demo_cfg)
    result = cgt.compute()
    print(result.summary())

    # Generate nozzle contour plot
    print(f"\nGenerating nozzle contour plot...")
    pts = cgt.generate_nozzle_contour(do_plot=True)
    print(f"Nozzle contour saved to payload/cgt_nozzle.png  ({len(pts)} points)")
    
    # Try to open/show the plot
    import matplotlib.pyplot as plt
    print("Opening plot window...")
    plt.show()


if __name__ == "__main__":
    main()
