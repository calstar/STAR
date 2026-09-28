"""Time-varying engine solve over a burn.

Each step advances the wall -- liner stations along the chamber, the throat (graphite insert
or liner) and the exit when it ablates -- by transient conduction under the gas-side loads of
the previous step (Bartz convection, H2O/CO2 radiation, carbon oxidation at the throat), then
rebuilds the geometry from the cumulative recession and solves Pc and thrust on it. Reaction
progress and stability are evaluated at every step on the same geometry.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Any
from dataclasses import dataclass
import numpy as np
import copy

from engine.pipeline.config_schemas import PintleEngineConfig, ensure_chamber_geometry
from engine.core.chamber_solver import ChamberSolver
from engine.core.nozzle import calculate_thrust
from engine.pipeline.reaction_chemistry import (
    calculate_chamber_reaction_progress,
)
from engine.pipeline.thermal import gas_side
from engine.pipeline.thermal.graphite_cooling import carbon_oxidation
from engine.pipeline.thermal.wall_conduction import Layer, WallModel
from engine.pipeline.constants import STEFAN_BOLTZMANN_W_M2_K4
from engine.pipeline.stability.analysis import (
    calculate_chugging_frequency,
    calculate_acoustic_modes,
)

#: Implicit sub-step of the wall conduction [s]. The liner surface reaches its ablation
#: temperature in a few tenths of a second; this resolves that rise to ~1 % (checked against
#: the constant-flux semi-infinite solution in tests/test_wall_conduction.py).
WALL_SUBSTEP_S = 0.01


@dataclass
class TimeVaryingState:
    """Complete state of the engine at a given time."""
    time: float  # [s]
    
    # Geometry (evolving)
    V_chamber: float  # [m³]
    A_throat: float  # [m²]  # CRITICAL: Stays constant with graphite insert
    A_exit: float  # [m²]
    Lstar: float  # [m]
    D_chamber: float  # [m]
    D_throat: float  # [m]  # CRITICAL: Stays constant with graphite insert
    D_exit: float  # [m]
    eps: float  # Expansion ratio
    
    # Cumulative recession
    recession_chamber: float  # [m]
    recession_throat: float  # [m]  # Ablative recession at throat (if no graphite)
    recession_exit: float  # [m]
    recession_graphite: float  # [m]  # Graphite insert recession
    graphite_thickness_remaining: float  # [m]  # Remaining graphite thickness
    
    # Reaction chemistry
    reaction_progress: Dict[str, float]  # progress_injection, progress_mid, progress_throat
    tau_residence: float  # [s]
    tau_effective: float  # [s]
    
    # Performance
    Pc: float  # [Pa]
    Tc: float  # [K]
    MR: float
    mdot_total: float  # [kg/s]
    F: float  # [N]
    Isp: float  # [s]
    v_exit: float  # [m/s]
    P_exit: float  # [Pa]
    T_exit: float  # [K]
    M_exit: float
    
    # Thermodynamics
    gamma_chamber: float
    gamma_exit: float
    R_chamber: float
    R_exit: float
    equilibrium_factor: float
    
    # Stability
    chugging_frequency: float  # [Hz]
    chugging_stability_margin: float
    stability_state: str  # "stable", "marginal", or "unstable"
    stability_score: float  # 0-1 score from comprehensive analysis
    acoustic_modes: Dict[str, float]
    feed_stability: Dict[str, float]
    
    # Heat flux and cooling
    heat_flux_chamber: float  # [W/m²]
    heat_flux_throat: float  # [W/m²]
    ablative_recession_rate: float  # [m/s]
    graphite_recession_rate: float  # [m/s]
    # Throat recession breakdown (graphite model)
    throat_oxidation_recession_rate: float  # [m/s]
    throat_ablation_recession_rate: float  # [m/s] (thermal/sublimation component)
    
    # Chamber intrinsics (TIME-VARYING - these change as geometry evolves)
    mach_number: float  # Chamber Mach number (should change over time, not hardcoded)
    eta_cstar: float  # Combustion efficiency n* (should change over time)
    reynolds_number: float  # Reynolds number
    residence_time: float  # [s]
    
    # Wall thermal state (transient conduction, engine.pipeline.thermal.wall_conduction)
    T_liner_surface: float  # [K] barrel char surface
    char_depth_chamber: float  # [m] pyrolysis isotherm below the barrel surface
    T_bondline: float  # [K] back of the liner, barrel station
    recession_liner_peak: float  # [m] cumulative, liner station that has receded most
    char_depth_peak: float  # [m] pyrolysis depth at that station
    T_bondline_peak: float  # [K] hottest liner back face along the liner
    x_liner_peak: float  # [m] throat-frame axial position of that station
    q_conv_chamber: float  # [W/m^2] barrel, at the current surface temperature
    q_rad_chamber: float  # [W/m^2]
    q_conv_throat: float  # [W/m^2] throat, blown, at the current surface temperature
    q_rad_throat: float  # [W/m^2]
    q_chem_throat: float  # [W/m^2] absorbed by the carbon-oxidiser reactions
    T_graphite_surface: float  # [K]
    T_graphite_back: float  # [K] insert back face (adiabatic: backing undeclared)
    cstar_ideal: float  # [m/s]
    cstar_actual: float  # [m/s]

    # Full diagnostics from ChamberSolver (includes ablative heat flux profiles)
    # Must be at end since it has a default value
    diagnostics: Optional[Dict[str, Any]] = None


class TimeVaryingCoupledSolver:
    """
    Fully-coupled time-varying solver for complete engine analysis.
    
    Integrates all systems simultaneously:
    - Reaction chemistry → shifting equilibrium
    - Geometry evolution → chamber dynamics
    - Ablative/graphite recession → geometry
    - Stability analysis → all time-varying effects
    """
    
    def __init__(
        self,
        config: PintleEngineConfig,
        cea_cache: Any,
        P_ambient: Optional[float] = None,
    ):
        """
        Initialize the coupled time-varying solver.

        ``P_ambient`` is the back pressure the nozzle fires into, in Pa. Explicit wins;
        otherwise it comes from ``environment.elevation`` through the same standard
        atmosphere the steady solve uses; only with neither is it sea level. This used to be
        hardcoded to 101325 Pa inside ``solve_time_step`` while ``PintleEngineRunner.evaluate``
        derived it from the site, so the two paths disagreed about the same engine by exactly
        ``(101325 - P_a) * A_exit`` -- 61.35 N on the 6.5 kN ethalox at 626.67 m -- and every
        time-series thrust, impulse and burn time was low by the pad's altitude.
        
        Parameters:
        -----------
        config : PintleEngineConfig
            Engine configuration
        cea_cache : CEACache
            CEA cache for thermochemical properties
        """
        self.config = config
        self.cea_cache = cea_cache
        if P_ambient is not None:
            self.P_ambient = float(P_ambient)
        else:
            self.P_ambient = 101325.0
            env = getattr(config, "environment", None)
            elevation = getattr(env, "elevation", None) if env is not None else None
            if elevation is not None and elevation >= 0:
                from engine.core.runner import compute_ambient_pressure_from_elevation
                self.P_ambient = float(compute_ambient_pressure_from_elevation(elevation))
        
        # Ensure chamber_geometry exists
        cg = ensure_chamber_geometry(config)
        
        # Store initial geometry
        self.V_chamber_initial = cg.volume
        self.A_throat_initial = cg.A_throat
        self.A_exit_initial = cg.A_exit
        self.L_chamber = cg.length if cg.length else 0.18
        self.L_cylindrical = cg.length_cylindrical if cg.length_cylindrical else 0.12
        self.L_contraction = cg.length_contraction if cg.length_contraction else 0.06
        # FIXED: Use chamber_diameter from unified config
        self.D_chamber_initial = cg.chamber_diameter if cg.chamber_diameter and cg.chamber_diameter > 0 else 0.08
        self.D_throat_initial = np.sqrt(max(0, 4 * self.A_throat_initial / np.pi)) if self.A_throat_initial > 0 else 0.015
        self.D_exit_initial = np.sqrt(max(0, 4 * self.A_exit_initial / np.pi)) if self.A_exit_initial > 0 else 0.1
        
        # Initialize state history
        self.state_history: List[TimeVaryingState] = []
        self._contour0 = gas_side.contour_for(cg)
        self._walls: Optional[Dict[str, Dict[str, Any]]] = None
        self._loads: Optional[Dict[str, Any]] = None

    # ------------------------------------------------------------------ walls
    def _liner_layers(self) -> List[Layer]:
        abl = self.config.ablative_cooling
        layers = [Layer(abl.initial_thickness, abl.thermal_conductivity, abl.material_density,
                        abl.specific_heat, "liner")]
        case = getattr(self.config, "stainless_steel_case", None)
        if case is not None and case.enabled:
            layers.append(Layer(case.thickness, case.thermal_conductivity, case.density,
                                case.specific_heat, "case"))
        return layers

    def _graphite_layers(self) -> List[Layer]:
        gr = self.config.graphite_insert
        layers = [Layer(gr.initial_thickness, gr.thermal_conductivity, gr.material_density,
                        gr.specific_heat, "graphite")]
        case = getattr(self.config, "stainless_steel_case", None)
        if case is not None and case.enabled:
            layers.append(Layer(case.thickness, case.thermal_conductivity, case.density,
                                case.specific_heat, "case"))
        return layers

    def liner_end(self) -> float:
        """Throat-frame x where the liner meets the graphite insert (0 without one)."""
        gr = getattr(self.config, "graphite_insert", None)
        if gr is None or not gr.enabled:
            return 0.0
        return -float(gr.axial_half_length or gr.axial_half_length_ratio * 2.0 * self._contour0.R_t)

    def _build_walls(self) -> Dict[str, Dict[str, Any]]:
        """Wall stations: liner along the chamber, the throat, and the exit if it ablates."""
        c = self._contour0
        abl = self.config.ablative_cooling
        gr = getattr(self.config, "graphite_insert", None)
        walls: Dict[str, Dict[str, Any]] = {}
        if abl is not None and abl.enabled:
            x_end = self.liner_end()
            xs = [0.5 * (c.x_face + c.x_cone_start), c.x_cone_start,
                  0.5 * (c.x_cone_start + x_end), x_end]
            for i, x in enumerate(xs):
                walls[f"liner{i}"] = {"x": float(x), "kind": "liner",
                                      "model": WallModel(self._liner_layers(), abl.ambient_temperature)}
        if gr is not None and gr.enabled:
            walls["throat"] = {"x": 0.0, "kind": "graphite",
                               "model": WallModel(self._graphite_layers(), gr.ambient_temperature or 300.0,
                                                  n_first=40, first_cell=2e-5)}
        elif abl is not None and abl.enabled:
            walls["throat"] = {"x": 0.0, "kind": "liner",
                               "model": WallModel(self._liner_layers(), abl.ambient_temperature)}
        if abl is not None and abl.enabled and abl.nozzle_ablative:
            walls["exit"] = {"x": float(c.x[-1]), "kind": "liner",
                             "model": WallModel(self._liner_layers(), abl.ambient_temperature)}
        return walls

    def _station_loads(self, gas: "gas_side.HotGasState", contour, blow: float,
                       throat_comp: Optional[Dict[str, float]]) -> Dict[str, Any]:
        """Gas-side load functions q_in(T_s) per wall station, frozen over the next interval."""
        abl = self.config.ablative_cooling
        gr = getattr(self.config, "graphite_insert", None)
        loads: Dict[str, Any] = {}
        for name, w in (self._walls or {}).items():
            model = w["model"]
            Ts_now = float(model.T[0])
            eps_w = (gr.emissivity or 0.8) if w["kind"] == "graphite" else abl.surface_emissivity
            st = gas_side.station_flux(gas, contour, w["x"], Ts_now, eps_w)
            M = st["M"]
            h_ref = st["h"] / gas_side.bartz_sigma(Ts_now, gas.T0, gas.gamma, M)
            Taw, Tg, eg, ag = st["Taw"], st["T_static"], st["eps_gas"], st["alpha_gas"]
            F_rad = eps_w / (1.0 - (1.0 - eps_w) * (1.0 - ag))
            sig = STEFAN_BOLTZMANN_W_M2_K4

            def h_of(s, h_ref=h_ref, M=M):
                return h_ref * gas_side.bartz_sigma(s, gas.T0, gas.gamma, M)

            def q_rad(s, F_rad=F_rad, eg=eg, ag=ag, Tg=Tg):
                return F_rad * sig * (eg * Tg ** 4 - ag * s ** 4)

            if w["kind"] == "graphite":
                P_t = st["P_static"]

                def chem(s, h_of=h_of, P_t=P_t):
                    return carbon_oxidation(s, P_t, throat_comp, throat_comp["MW"], h_of(s) / gas.cp, gr)

                def q_in(s, h_of=h_of, Taw=Taw, q_rad=q_rad, chem=chem):
                    ox = chem(s)
                    return ox["blowing_factor"] * h_of(s) * (Taw - s) + q_rad(s) - ox["q_chem"]

                loads[name] = {"q_in": q_in, "chem": chem, "h_of": h_of, "Taw": Taw, "q_rad": q_rad}
            else:
                def q_in(s, h_of=h_of, Taw=Taw, q_rad=q_rad):
                    return blow * h_of(s) * (Taw - s) + q_rad(s)

                loads[name] = {"q_in": q_in, "h_of": h_of, "Taw": Taw, "q_rad": q_rad}
        return loads

    def _advance_walls(self, dt: float) -> Dict[str, float]:
        """Advance every wall station over dt under the loads of the previous state."""
        rates: Dict[str, float] = {}
        if not self._walls or self._loads is None or dt <= 0:
            return {name: 0.0 for name in (self._walls or {})}
        abl = self.config.ablative_cooling
        gr = getattr(self.config, "graphite_insert", None)
        n_sub = int(np.ceil(dt / WALL_SUBSTEP_S - 1e-9))
        for name, w in self._walls.items():
            L = self._loads[name]
            model = w["model"]
            if w["kind"] == "graphite":
                if gr.sizing_only_mode:
                    out = model.advance(dt, n_sub, q_in=L["q_in"])
                else:
                    out = model.advance(dt, n_sub, q_in=L["q_in"],
                                        chemical_mass_flux=lambda s, L=L: L["chem"](s)["mass_flux"],
                                        rho_surface=gr.material_density)
                rates[name] = out["mass_flux"] / gr.material_density
            else:
                out = model.advance(dt, n_sub, q_in=L["q_in"], T_ablation=abl.ablation_surface_temperature,
                                    H_surface=abl.heat_of_ablation, rho_surface=abl.material_density)
                rates[name] = out["mass_flux"] / abl.material_density
        return rates

    def _geometry(self) -> Dict[str, float]:
        """Geometry from the cumulative wall recession: bore, volume, throat and exit."""
        c = self._contour0
        abl = self.config.ablative_cooling
        walls = self._walls or {}
        liner = sorted([(w["x"], w["model"].receded) for n, w in walls.items() if n.startswith("liner")])
        s_throat = walls["throat"]["model"].receded if "throat" in walls else 0.0
        s_exit = walls["exit"]["model"].receded if "exit" in walls else 0.0
        dV = 0.0
        s_barrel = 0.0
        if liner:
            xs = np.array([p[0] for p in liner])
            ss = np.array([p[1] for p in liner])
            s_barrel = float(ss[0])
            dA = c.area_elements()
            x_end = self.liner_end()
            lined = (c.x <= x_end + 1e-12)
            cov = float(np.clip(abl.coverage_fraction, 0.0, 1.0))
            dV += float(np.sum(np.interp(c.x[lined], xs, ss) * dA[lined])) * cov
            insert = (c.x > x_end + 1e-12) & (c.x <= 0.0)
            dV += float(np.sum(dA[insert])) * s_throat
        D_chamber = self.D_chamber_initial + 2.0 * s_barrel
        D_throat = self.D_throat_initial + 2.0 * s_throat
        A_throat = np.pi * D_throat ** 2 / 4.0
        D_exit = self.D_exit_initial + 2.0 * s_exit
        A_exit = np.pi * D_exit ** 2 / 4.0 if s_exit > 0 else self.A_exit_initial
        V = self.V_chamber_initial + dV
        return {"V_chamber": V, "A_throat": A_throat, "A_exit": A_exit, "D_chamber": D_chamber,
                "D_throat": D_throat, "D_exit": D_exit, "recession_chamber": s_barrel,
                "recession_throat": s_throat, "recession_exit": s_exit}

    def solve_time_step(
        self,
        time: float,
        dt: float,
        P_tank_O: float,
        P_tank_F: float,
        previous_state: Optional[TimeVaryingState] = None,
    ) -> TimeVaryingState:
        """
        Solve one time step (explicit in the wall, exact in the chamber):

        1. advance the wall conduction over [t - dt, t] under the previous state's gas loads;
        2. rebuild the geometry from the cumulative recession;
        3. solve Pc, and compute thrust, on that same geometry;
        4. evaluate the gas-side loads at this state for the next interval.

        ``previous_state`` None starts the walls cold (ambient) at the initial geometry.
        """
        if previous_state is None or self._walls is None:
            self._walls = self._build_walls()
            self._loads = None
            dt = 0.0
        rates = self._advance_walls(dt)
        geo = self._geometry()
        A_throat = geo["A_throat"]
        A_exit = geo["A_exit"]
        V_chamber = geo["V_chamber"]
        eps = A_exit / A_throat
        Lstar = V_chamber / A_throat

        config_current = copy.deepcopy(self.config)
        cg = ensure_chamber_geometry(config_current)
        cg.volume = V_chamber
        cg.A_throat = A_throat
        cg.A_exit = A_exit
        cg.expansion_ratio = eps
        cg.Lstar = Lstar
        cg.chamber_diameter = geo["D_chamber"]

        solver = ChamberSolver(config_current, self.cea_cache)
        Pc, diagnostics = solver.solve(P_tank_O, P_tank_F, Pc_guess=None)

        MR = diagnostics["MR"]
        mdot_total = diagnostics["mdot_total"]
        Tc = diagnostics["Tc"]
        gamma_chamber = diagnostics["gamma"]
        R_chamber = diagnostics["R"]
        cstar_actual = diagnostics["cstar_actual"]
        cstar_ideal = diagnostics["cstar_ideal"]
        eta_cstar = diagnostics["eta_cstar"]

        from engine.core.chamber_profiles import calculate_chamber_intrinsics
        chamber_intrinsics = calculate_chamber_intrinsics(
            Pc=Pc, Tc=Tc, mdot_total=mdot_total, gamma=gamma_chamber, R=R_chamber,
            V_chamber=V_chamber, A_throat=A_throat, Lstar=Lstar, MR=MR, P_back=self.P_ambient,
        )
        mach_number = chamber_intrinsics["mach_number"]

        # Residence time at the ideal Tc (shortest), kinetics at the effective Tc (slowest).
        reaction_progress_dict = calculate_chamber_reaction_progress(
            Lstar, Pc, diagnostics["Tc_ideal"], cstar_ideal, gamma_chamber, R_chamber, MR,
            self.config, spray_diagnostics=diagnostics.get("spray_diagnostics"), Tc_kinetics=Tc,
        )

        # Thrust on the geometry the Pc was solved with.
        thrust_results = calculate_thrust(Pc, MR, mdot_total, self.cea_cache, config_current,
                                          self.P_ambient, reaction_progress=reaction_progress_dict)

        # Gas-side loads at this state: reported at the current wall temperatures, and frozen
        # as the loads for the next interval.
        cool = diagnostics.get("cooling", {}) or {}
        abl_diag = cool.get("ablative", {}) or {}
        blow = float(abl_diag.get("blowing_reduction", 1.0))
        tr = self.cea_cache.aux.transport(MR, Pc, "chamber")
        comp_c = self.cea_cache.aux.composition(MR, Pc, "chamber")
        comp_t = self.cea_cache.aux.composition(MR, Pc, "throat")
        gas = gas_side.HotGasState(T0=float(diagnostics["Tc_ideal"]), P0=float(Pc), gamma=float(gamma_chamber),
                                   mass_flux_throat=float(mdot_total) / A_throat, mu=tr["mu"],
                                   cp=tr["cp"], Pr=tr["Pr"], x_H2O=comp_c["H2O"], x_CO2=comp_c["CO2"])
        contour_now = gas_side.contour_for(cg)
        self._loads = self._station_loads(gas, contour_now, blow, comp_t)
        report = self._wall_report(rates)

        # Hand the transient rates to the per-step diagnostics the UI reads.
        if abl_diag:
            abl_diag["recession_rate_quasi_steady"] = abl_diag.get("recession_rate")
            abl_diag["recession_rate"] = report["rate_barrel"]
        gr_cfg = getattr(self.config, "graphite_insert", None)
        if gr_cfg is not None and gr_cfg.enabled:
            cool["graphite"] = {"enabled": True, "oxidation_rate": report["rate_throat"],
                                "recession_rate_thermal": 0.0,
                                "surface_temperature": report["T_graphite_surface"],
                                "q_chemical": report["q_chem_throat"]}
            diagnostics["cooling"] = cool

        chugging = calculate_chugging_frequency(V_chamber, A_throat, cstar_actual, gamma_chamber, Pc,
                                                R=R_chamber, Tc=Tc)
        chugging_freq = chugging["frequency"]
        stability_margin = float("nan")
        acoustic = calculate_acoustic_modes(self.L_chamber, geo["D_chamber"], Tc, gamma_chamber, R_chamber)
        feed_stability = {"pogo_frequency": np.nan, "surge_frequency": np.nan, "stability_margin": np.nan}
        comprehensive_stability = None
        try:
            from engine.pipeline.stability.analysis import comprehensive_stability_analysis
            stability_diag = {
                "mdot_O": mdot_total * MR / (1.0 + MR),
                "mdot_F": mdot_total / (1.0 + MR),
                "P_tank_O": P_tank_O,
                "P_tank_F": P_tank_F,
            }
            comprehensive_stability = comprehensive_stability_analysis(
                config=self.config, Pc=Pc, MR=MR, mdot_total=mdot_total, cstar=cstar_actual,
                gamma=gamma_chamber, R=R_chamber, Tc=Tc, diagnostics=stability_diag,
            )
            stability_margin = comprehensive_stability.get("chugging", {}).get("stability_margin", stability_margin)
            chugging_freq = comprehensive_stability.get("chugging", {}).get("frequency", chugging_freq)
            acoustic = comprehensive_stability.get("acoustic", acoustic)
            feed_stability = comprehensive_stability.get("feed_system", feed_stability)
        except Exception as e:
            import warnings
            warnings.warn(f"Comprehensive stability analysis failed: {e}")
            comprehensive_stability = None

        gr_thick = (self._walls["throat"]["model"].thickness_first
                    if (self._walls and "throat" in self._walls and self._walls["throat"]["kind"] == "graphite")
                    else 0.0)
        return TimeVaryingState(
            time=time,
            V_chamber=V_chamber,
            A_throat=A_throat,
            A_exit=A_exit,
            Lstar=Lstar,
            D_chamber=geo["D_chamber"],
            D_throat=geo["D_throat"],
            D_exit=geo["D_exit"],
            eps=eps,
            recession_chamber=geo["recession_chamber"],
            recession_throat=geo["recession_throat"],
            recession_exit=geo["recession_exit"],
            recession_graphite=geo["recession_throat"] if (gr_cfg is not None and gr_cfg.enabled) else 0.0,
            graphite_thickness_remaining=gr_thick,
            reaction_progress={
                "progress_injection": reaction_progress_dict["progress_injection"],
                "progress_mid": reaction_progress_dict["progress_mid"],
                "progress_throat": reaction_progress_dict["progress_throat"],
            },
            tau_residence=reaction_progress_dict["tau_residence"],
            tau_effective=reaction_progress_dict["tau_effective"],
            Pc=Pc,
            Tc=Tc,
            MR=MR,
            mdot_total=mdot_total,
            F=thrust_results["F"],
            Isp=thrust_results["Isp"],
            v_exit=thrust_results["v_exit"],
            P_exit=thrust_results["P_exit"],
            T_exit=thrust_results["T_exit"],
            M_exit=thrust_results["M_exit"],
            gamma_chamber=gamma_chamber,
            gamma_exit=thrust_results["gamma_exit"],
            R_chamber=R_chamber,
            R_exit=thrust_results["R_exit"],
            equilibrium_factor=thrust_results["equilibrium_factor"],
            chugging_frequency=chugging_freq,
            chugging_stability_margin=stability_margin,
            stability_state=comprehensive_stability.get("stability_state", "unstable") if comprehensive_stability else "unstable",
            stability_score=comprehensive_stability.get("stability_score", 0.0) if comprehensive_stability else 0.0,
            acoustic_modes=acoustic,
            feed_stability=feed_stability,
            heat_flux_chamber=report["q_conv_chamber"] + report["q_rad_chamber"],
            heat_flux_throat=report["q_conv_throat"] + report["q_rad_throat"],
            ablative_recession_rate=report["rate_barrel"],
            graphite_recession_rate=report["rate_throat"] if (gr_cfg is not None and gr_cfg.enabled) else 0.0,
            throat_oxidation_recession_rate=report["rate_throat"] if (gr_cfg is not None and gr_cfg.enabled) else 0.0,
            throat_ablation_recession_rate=0.0,
            mach_number=mach_number,
            eta_cstar=eta_cstar,
            reynolds_number=chamber_intrinsics.get("reynolds_number", float("nan")),
            residence_time=chamber_intrinsics.get("residence_time", float("nan")),
            T_liner_surface=report["T_liner_surface"],
            char_depth_chamber=report["char_depth_chamber"],
            T_bondline=report["T_bondline"],
            recession_liner_peak=report["recession_liner_peak"],
            char_depth_peak=report["char_depth_peak"],
            T_bondline_peak=report["T_bondline_peak"],
            x_liner_peak=report["x_liner_peak"],
            q_conv_chamber=report["q_conv_chamber"],
            q_rad_chamber=report["q_rad_chamber"],
            q_conv_throat=report["q_conv_throat"],
            q_rad_throat=report["q_rad_throat"],
            q_chem_throat=report["q_chem_throat"],
            T_graphite_surface=report["T_graphite_surface"],
            T_graphite_back=report["T_graphite_back"],
            cstar_ideal=cstar_ideal,
            cstar_actual=cstar_actual,
            diagnostics=diagnostics,
        )

    def _wall_report(self, rates: Dict[str, float]) -> Dict[str, float]:
        """Wall read-outs at the current time, fluxes at the current surface temperatures."""
        nan = float("nan")
        out = {k: nan for k in ("T_liner_surface", "char_depth_chamber", "T_bondline",
                                "recession_liner_peak", "char_depth_peak", "T_bondline_peak",
                                "x_liner_peak", "T_graphite_surface", "T_graphite_back")}
        out.update({"q_conv_chamber": 0.0, "q_rad_chamber": 0.0, "q_conv_throat": 0.0,
                    "q_rad_throat": 0.0, "q_chem_throat": 0.0, "rate_barrel": 0.0, "rate_throat": 0.0})
        walls, loads = self._walls or {}, self._loads or {}
        abl = self.config.ablative_cooling
        liners = [(n, w) for n, w in walls.items() if n.startswith("liner")]
        if liners:
            n0, w0 = liners[0]
            m0 = w0["model"]
            Ts = float(m0.T[0])
            out["T_liner_surface"] = Ts
            out["char_depth_chamber"] = m0.depth_of_isotherm(abl.pyrolysis_temperature)
            out["T_bondline"] = m0.interface_temperature(0)
            out["rate_barrel"] = float(rates.get(n0, 0.0))
            if n0 in loads:
                L = loads[n0]
                out["q_conv_chamber"] = float(L["h_of"](Ts) * (L["Taw"] - Ts))
                out["q_rad_chamber"] = float(L["q_rad"](Ts))
            npk, wpk = max(liners, key=lambda nw: nw[1]["model"].receded)
            out["recession_liner_peak"] = float(wpk["model"].receded)
            out["char_depth_peak"] = wpk["model"].depth_of_isotherm(abl.pyrolysis_temperature)
            out["x_liner_peak"] = float(wpk["x"])
            out["T_bondline_peak"] = max(w["model"].interface_temperature(0) for _, w in liners)
        if "throat" in walls:
            m = walls["throat"]["model"]
            Ts = float(m.T[0])
            out["rate_throat"] = float(rates.get("throat", 0.0))
            if walls["throat"]["kind"] == "graphite":
                out["T_graphite_surface"] = Ts
                out["T_graphite_back"] = m.T_back
            if "throat" in loads:
                L = loads["throat"]
                q_rad = float(L["q_rad"](Ts))
                if "chem" in L:
                    ox = L["chem"](Ts)
                    out["q_conv_throat"] = float(ox["blowing_factor"] * L["h_of"](Ts) * (L["Taw"] - Ts))
                    out["q_chem_throat"] = float(ox["q_chem"])
                else:
                    out["q_conv_throat"] = float(L["h_of"](Ts) * (L["Taw"] - Ts))
                out["q_rad_throat"] = q_rad
        return out

    def soak_back(self, duration: float = 120.0) -> Dict[str, Dict[str, float]]:
        """Peak back-face and bondline temperatures while each wall's stored heat soaks back
        after shutdown (hot face adiabatic). Run after solve_time_series; the walls are copied."""
        out: Dict[str, Dict[str, float]] = {}
        for name, w in (self._walls or {}).items():
            m = copy.deepcopy(w["model"])
            out[name] = {"x": w["x"], **m.soak(duration)}
        return out

    def solve_time_series(
        self,
        times: np.ndarray,
        P_tank_O: np.ndarray,
        P_tank_F: np.ndarray,
    ) -> List[TimeVaryingState]:
        """
        Solve complete time series with full coupling.
        
        Parameters:
        -----------
        times : np.ndarray
            Time points [s]
        P_tank_O : np.ndarray
            Oxidizer tank pressures [Pa]
        P_tank_F : np.ndarray
            Fuel tank pressures [Pa]
        
        Returns:
        --------
        states : List[TimeVaryingState]
            Complete state history
        """
        if len(times) != len(P_tank_O) or len(times) != len(P_tank_F):
            raise ValueError("times, P_tank_O, and P_tank_F must have same length")
        
        states = []
        previous_state = None
        
        for i, t in enumerate(times):
            dt = times[i] - times[i-1] if i > 0 else 0.0
            
            state = self.solve_time_step(
                time=t,
                dt=dt,
                P_tank_O=P_tank_O[i],
                P_tank_F=P_tank_F[i],
                previous_state=previous_state,
            )
            
            states.append(state)
            previous_state = state
        
        self.state_history = states
        return states
    
    def get_results_dict(self) -> Dict[str, np.ndarray]:
        """
        Convert state history to results dictionary (compatible with existing code).
        
        Returns:
        --------
        results : dict
            Dictionary with arrays of all metrics
        """
        if not self.state_history:
            raise ValueError("No state history - run solve_time_series first")
        
        n = len(self.state_history)
        
        results = {
            "time": np.array([s.time for s in self.state_history]),
            "Pc": np.array([s.Pc for s in self.state_history]),
            "Tc": np.array([s.Tc for s in self.state_history]),
            "MR": np.array([s.MR for s in self.state_history]),
            "mdot_total": np.array([s.mdot_total for s in self.state_history]),
            "F": np.array([s.F for s in self.state_history]),
            "Isp": np.array([s.Isp for s in self.state_history]),
            "v_exit": np.array([s.v_exit for s in self.state_history]),
            "P_exit": np.array([s.P_exit for s in self.state_history]),
            "T_exit": np.array([s.T_exit for s in self.state_history]),
            "M_exit": np.array([s.M_exit for s in self.state_history]),
            "gamma_chamber": np.array([s.gamma_chamber for s in self.state_history]),
            "gamma_exit": np.array([s.gamma_exit for s in self.state_history]),
            "R_chamber": np.array([s.R_chamber for s in self.state_history]),
            "R_exit": np.array([s.R_exit for s in self.state_history]),
            "equilibrium_factor": np.array([s.equilibrium_factor for s in self.state_history]),
            "Lstar": np.array([s.Lstar for s in self.state_history]),
            "V_chamber": np.array([s.V_chamber for s in self.state_history]),
            "A_throat": np.array([s.A_throat for s in self.state_history]),
            "A_exit": np.array([s.A_exit for s in self.state_history]),
            "D_chamber": np.array([s.D_chamber for s in self.state_history]),
            "A_chamber": np.array([np.pi * (s.D_chamber / 2.0)**2 for s in self.state_history]),
            "contraction_ratio": np.array([(np.pi * (s.D_chamber / 2.0)**2) / s.A_throat if s.A_throat > 0 else 1.0 for s in self.state_history]),
            "eps": np.array([s.eps for s in self.state_history]),
            "recession_chamber": np.array([s.recession_chamber for s in self.state_history]),
            "recession_throat": np.array([s.recession_throat for s in self.state_history]),  # Throat recession (tracked even with graphite)
            "recession_exit": np.array([s.recession_exit for s in self.state_history]),
            "recession_graphite": np.array([s.recession_graphite for s in self.state_history]),
            "D_throat": np.array([s.D_throat for s in self.state_history]),  # Throat diameter (constant with graphite, grows without)
            "throat_area_change_pct": np.array([(s.A_throat - self.A_throat_initial) / self.A_throat_initial * 100.0 for s in self.state_history]),
            "chugging_frequency": np.array([s.chugging_frequency for s in self.state_history]),
            "chugging_stability_margin": np.array([s.chugging_stability_margin for s in self.state_history]),
            "stability_state": np.array([s.stability_state for s in self.state_history]),
            "stability_score": np.array([s.stability_score for s in self.state_history]),
            "heat_flux_chamber": np.array([s.heat_flux_chamber for s in self.state_history]),
            "heat_flux_throat": np.array([s.heat_flux_throat for s in self.state_history]),
            "ablative_recession_rate": np.array([s.ablative_recession_rate for s in self.state_history]),
            "graphite_recession_rate": np.array([s.graphite_recession_rate for s in self.state_history]),
            "throat_oxidation_recession_rate": np.array([s.throat_oxidation_recession_rate for s in self.state_history]),
            "throat_ablation_recession_rate": np.array([s.throat_ablation_recession_rate for s in self.state_history]),
            # CRITICAL: Add time-varying chamber intrinsics (these change over time!)
            "mach_number": np.array([s.mach_number for s in self.state_history]),  # TIME-VARYING - not hardcoded
            "eta_cstar": np.array([s.eta_cstar for s in self.state_history]),  # TIME-VARYING n* - changes with L*
            "reynolds_number": np.array([s.reynolds_number for s in self.state_history]),
            "residence_time": np.array([s.residence_time for s in self.state_history]),
            "T_liner_surface": np.array([s.T_liner_surface for s in self.state_history]),
            "char_depth_chamber": np.array([s.char_depth_chamber for s in self.state_history]),
            "T_bondline": np.array([s.T_bondline for s in self.state_history]),
            "recession_liner_peak": np.array([s.recession_liner_peak for s in self.state_history]),
            "char_depth_peak": np.array([s.char_depth_peak for s in self.state_history]),
            "T_bondline_peak": np.array([s.T_bondline_peak for s in self.state_history]),
            "x_liner_peak": np.array([s.x_liner_peak for s in self.state_history]),
            "q_conv_chamber": np.array([s.q_conv_chamber for s in self.state_history]),
            "q_rad_chamber": np.array([s.q_rad_chamber for s in self.state_history]),
            "q_conv_throat": np.array([s.q_conv_throat for s in self.state_history]),
            "q_rad_throat": np.array([s.q_rad_throat for s in self.state_history]),
            "q_chem_throat": np.array([s.q_chem_throat for s in self.state_history]),
            "T_graphite_surface": np.array([s.T_graphite_surface for s in self.state_history]),
            "T_graphite_back": np.array([s.T_graphite_back for s in self.state_history]),
            "cstar_ideal": np.array([s.cstar_ideal for s in self.state_history]),
            "cstar_actual": np.array([s.cstar_actual for s in self.state_history]),
        }
        
        # Extract reaction progress arrays
        results["reaction_progress_throat"] = np.array([s.reaction_progress["progress_throat"] for s in self.state_history])
        results["reaction_progress_mid"] = np.array([s.reaction_progress["progress_mid"] for s in self.state_history])
        results["reaction_progress_injection"] = np.array([s.reaction_progress["progress_injection"] for s in self.state_history])
        results["tau_residence"] = np.array([s.tau_residence for s in self.state_history])
        results["tau_effective"] = np.array([s.tau_effective for s in self.state_history])
        
        # Include full diagnostics from ChamberSolver (contains ablative heat flux profiles)
        results["diagnostics"] = [s.diagnostics for s in self.state_history]
        
        return results

