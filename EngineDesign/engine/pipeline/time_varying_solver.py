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
from engine.pipeline.thermal.graphite_properties import SPECIFIC_HEAT_MODELS
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

    # Every wall station's state at this time (TimeVaryingCoupledSolver._station_report):
    # recession, thickness left, surface/back/interface temperatures and the gas-side flux at the
    # current surface temperature. A read-out only; nothing in it feeds the solve.
    stations: Optional[Dict[str, Dict[str, Any]]] = None


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
        chug_eroded_geometry: bool = False,
    ):
        """
        Initialize the coupled time-varying solver.

        ``chug_eroded_geometry`` (default off: the previous behaviour exactly) hands the stability
        analysis the eroded geometry of each step -- throat area, chamber volume, L*, bore, exit
        and expansion ratio, the copy the chamber was solved on -- instead of the as-built design.
        Off, the chug loop's K_c and theta_c rest on the design-point A_t and L* while the chamber
        it describes has eroded (Layer X audit D7-D, coupling-map row 19).

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
        self.chug_eroded_geometry = bool(chug_eroded_geometry)
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
                        gr.specific_heat, "graphite",
                        cp_of=SPECIFIC_HEAT_MODELS[gr.specific_heat_model])]
        case = getattr(self.config, "stainless_steel_case", None)
        if case is not None and case.enabled:
            backing = self._insert_backing()
            if backing is not None:
                layers.append(backing)
            layers.append(Layer(case.thickness, case.thermal_conductivity, case.density,
                                case.specific_heat, "case"))
        return layers

    def _insert_backing(self) -> Optional[Layer]:
        """What sits between the graphite insert and the case at the throat.

        The case is a cylinder at the chamber bore plus the liner (``D_chamber/2 + t_liner``); the
        insert's outside is the throat radius plus its thickness. The gap between them is filled with
        the liner's material, the only other material the config declares (assumed: the config does
        not say what backs the insert). Without it the graphite sat directly on the steel, which
        sank its heat into the case: LE4's throat growth fell from ~4 % to ~1.5 % (2026-10-03). None
        when there is no liner or no gap."""
        abl = getattr(self.config, "ablative_cooling", None)
        gr = self.config.graphite_insert
        if abl is None or not abl.enabled:
            return None
        gap = 0.5 * float(self.D_chamber_initial) + float(abl.initial_thickness) \
            - (0.5 * float(self.D_throat_initial) + float(gr.initial_thickness))
        if gap <= 0.0:
            return None
        return Layer(gap, abl.thermal_conductivity, abl.material_density, abl.specific_heat, "backing")

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
            # The closure's own injector and feed drops and SMDs: without them the stability
            # analysis falls back to 0.30*Pc / 0.10*Pc and 80/60 um, which put the chug margin 13 %
            # under forward mode's at the same point (GM 1.290 vs 1.479 on the 6.8 kN engine).
            stability_diag = {
                **diagnostics,
                "mdot_O": mdot_total * MR / (1.0 + MR),
                "mdot_F": mdot_total / (1.0 + MR),
                "P_tank_O": P_tank_O,
                "P_tank_F": P_tank_F,
            }
            # Off by default: the design-point geometry, as before. On: the geometry this step's
            # chamber was solved on (eroded A_t, V, L*, bore, A_e, eps).
            stability_config = config_current if self.chug_eroded_geometry else self.config
            comprehensive_stability = comprehensive_stability_analysis(
                config=stability_config, Pc=Pc, MR=MR, mdot_total=mdot_total, cstar=cstar_actual,
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
            stations=self._station_report(),
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

    def _station_report(self) -> Dict[str, Dict[str, Any]]:
        """Every wall station now: recession, first-layer thickness left, surface, back-face and
        first-interface temperatures, and the gas-side flux at the current surface temperature
        under the loads just built for the next interval (the same evaluation ``_wall_report``
        makes for the barrel and throat). Read-only: nothing here feeds the solve.

        ``q_conv`` is the convection the wall model takes (blown: pyrolysis blowing on the liner,
        the oxidation blowing factor on graphite), ``q_chem`` the heat the carbon-oxidiser
        reactions absorb (graphite only), ``q_net = q_conv + q_rad - q_chem`` the surface load."""
        nan = float("nan")
        walls, loads = self._walls or {}, self._loads or {}
        out: Dict[str, Dict[str, Any]] = {}
        for name, w in walls.items():
            m = w["model"]
            Ts = float(m.T[0])
            rec: Dict[str, Any] = {
                "x": float(w["x"]), "kind": w["kind"], "receded": float(m.receded),
                "remaining": float(m.thickness_first), "T_surface": Ts, "T_back": float(m.T_back),
                "T_interface": float(m.interface_temperature(0)),
                "q_conv": nan, "q_rad": nan, "q_chem": 0.0, "q_net": nan,
            }
            L = loads.get(name)
            if L is not None:
                q_rad = float(L["q_rad"](Ts))
                if "chem" in L:
                    ox = L["chem"](Ts)
                    q_conv = float(ox["blowing_factor"] * L["h_of"](Ts) * (L["Taw"] - Ts))
                    q_chem = float(ox["q_chem"])
                else:
                    q_conv = float(L["q_in"](Ts)) - q_rad
                    q_chem = 0.0
                rec.update(q_conv=q_conv, q_rad=q_rad, q_chem=q_chem, q_net=q_conv + q_rad - q_chem)
            out[name] = rec
        return out

    def wall_layers(self) -> Dict[str, Dict[str, Any]]:
        """Each wall station's layer stack as built (hot face first) and its position: what the
        conduction model was given, so a report can list it with its provenance."""
        out: Dict[str, Dict[str, Any]] = {}
        for name, w in (self._walls or {}).items():
            m = w["model"]
            out[name] = {"x": float(w["x"]), "kind": w["kind"], "T_init": float(m.T_init),
                         "layers": [{"name": lay.name, "thickness": float(lay.thickness), "k": float(lay.k),
                                     "rho": float(lay.rho), "cp": float(lay.cp),
                                     "cp_of_T": lay.cp_of is not None} for lay in m.layers]}
        return out

    def soak_back(self, duration: float = 120.0) -> Dict[str, Dict[str, float]]:
        """Peak back-face and bondline temperatures while each wall's stored heat soaks back
        after shutdown (hot face adiabatic). Run after solve_time_series; the walls are copied."""
        out: Dict[str, Dict[str, float]] = {}
        for name, w in (self._walls or {}).items():
            m = copy.deepcopy(w["model"])
            out[name] = {"x": w["x"], **m.soak(duration)}
        return out

    def soak_duration(self, factor: float = 3.0) -> Dict[str, Any]:
        """``factor`` times the longest conduction time L^2/alpha over every layer of every wall
        station, from the wall models' own properties: L the layer's current thickness (the hot
        layer less its recession), alpha = k/(rho cp). A layer with cp(T) takes the larger of
        its stated cp and cp at its hottest node, the slower diffusion.

        The slowest mode of a slab with both faces adiabatic decays as exp(-pi^2 alpha t / L^2)
        (the Fourier-series solution for a slab with insulated faces; Carslaw & Jaeger, Conduction
        of Heat in Solids, 2nd ed., 1959, ch. III), so after 3 L^2/alpha it is down by
        exp(-3 pi^2) ~ 1e-13: the stored heat has finished arriving."""
        best: Dict[str, Any] = {"tau_s": 0.0, "station": None, "layer": None}
        for name, w in (self._walls or {}).items():
            m = w["model"]
            for i, lay in enumerate(m.layers):
                L = lay.thickness - (m.receded if i == 0 else 0.0)
                if L <= 0.0 or lay.k <= 0.0:
                    continue
                cp = float(lay.cp)
                if lay.cp_of is not None:
                    cp = max(cp, float(np.max(lay.cp_of(np.array([float(np.max(m.T))])))))
                tau = L * L * lay.rho * cp / lay.k
                if tau > best["tau_s"]:
                    best = {"tau_s": float(tau), "station": name, "layer": lay.name or f"layer {i}"}
        best["factor"] = float(factor)
        best["duration_s"] = float(factor) * best["tau_s"]
        return best

    def soak_back_history(self, duration: Optional[float] = None, factor: float = 3.0,
                          first_step: float = 1.0e-2, growth: float = 1.05,
                          steps_per_duration: int = 1200, peak_resolution_K: float = 0.05) -> Dict[str, Any]:
        """Soak-back after shutdown, with the time each peak is reached.

        Each station's wall is copied and continued with its hot face adiabatic (no gas, no
        re-radiation: an upper bound on what reaches the back) and its back face adiabatic as
        always (wall_conduction.py: no backing is modelled behind the last layer). Backward Euler
        on the same grid, with a step that grows geometrically from ``first_step`` to
        ``duration / steps_per_duration``: the stack is fully implicit, so the long steps are
        stable, and the short ones resolve the first seconds when a thin insert equilibrates.
        Backward Euler slows a mode of rate lambda by ~lambda*h/2; at the default 1200 steps over
        3 L^2/alpha the slowest mode (lambda = pi^2 alpha/L^2) has lambda*h = 0.025, so its clock
        runs ~1 % slow. With constant properties the stored heat, and so the soaked peak, is
        conserved exactly (both faces adiabatic); a cp(T) layer (graphite) has its capacity lagged
        one step, as in the burn, so its energy is conserved to that lag.

        ``soak_duration`` sizes the window from the slowest *single layer*. For a stack of layers
        the slowest mode is slower than any one layer's: by eigen-decomposition of this grid, a
        12 mm liner at the schema's default properties (k 0.35, rho 1600, cp 1500) on a 1/4 in
        steel case (k 16, rho 8000, cp 500, typical 300-series) is 2.3x slower than the liner alone, and 3x the liner's L^2/alpha still leaves ~3e-6 of that mode; a 6 mm
        graphite insert on the same case, 1.6x and ~2e-8. Inside the window for such stacks.

        ``duration`` None is :meth:`soak_duration` (``factor`` x the longest L^2/alpha).

        Per station: the peak back-face and first-interface temperatures and when they occur
        (``t_*_peak_s``: the first time within ``peak_resolution_K`` of the peak, so a plateau
        reached early is dated when it was reached, not by round-off along it), and
        ``t_back_95_s``, when the back face had made 95 % of its rise. With both faces adiabatic
        the back face rises monotonically to the stored-heat equilibrium; the 95 % time says when
        it gets there."""
        size = self.soak_duration(factor)
        if duration is None:
            duration = size["duration_s"]
        duration = float(duration)
        out: Dict[str, Any] = {"duration_s": duration, "sizing": size, "stations": {}}
        if duration <= 0.0:
            return out
        h_max = max(duration / max(int(steps_per_duration), 1), first_step)
        for name, w in (self._walls or {}).items():
            m = copy.deepcopy(w["model"])
            t = 0.0
            ts = [0.0]
            back = [float(m.T_back)]
            bond = [float(m.interface_temperature(0))]
            h = float(first_step)
            while t < duration - 1e-12:
                step = min(h, duration - t)
                m.step(step, q_in=lambda s: 0.0)
                t += step
                ts.append(t)
                back.append(float(m.T_back))
                bond.append(float(m.interface_temperature(0)))
                h = min(h * growth, h_max)
            back_a, bond_a, t_a = np.asarray(back), np.asarray(bond), np.asarray(ts)
            tol = float(peak_resolution_K)
            ib = int(np.argmax(back_a >= float(np.max(back_a)) - tol))
            ii = int(np.argmax(bond_a >= float(np.max(bond_a)) - tol))
            rise = float(np.max(back_a)) - back_a[0]
            t95 = float(t_a[int(np.argmax(back_a >= back_a[0] + 0.95 * rise))]) if rise > 0 else 0.0
            out["stations"][name] = {
                "x": float(w["x"]), "kind": w["kind"],
                "T_back_start": float(back_a[0]), "T_back_peak": float(np.max(back_a)), "t_back_peak_s": float(t_a[ib]),
                "t_back_95_s": t95,
                "T_interface_start": float(bond_a[0]), "T_interface_peak": float(np.max(bond_a)),
                "t_interface_peak_s": float(t_a[ii]),
                "T_surface_end": float(m.T[0]), "steps": len(ts) - 1,
            }
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
        # Per wall station, per step (a list like diagnostics), and the stacks the walls were
        # built from (one dict for the run).
        results["stations"] = [s.stations for s in self.state_history]
        results["wall_layers"] = self.wall_layers()

        return results

