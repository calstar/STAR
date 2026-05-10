"""Comprehensive system diagnostics for validating all dynamics and identifying issues."""

import numpy as np
from typing import Dict, Any, Optional, List
from engine.pipeline.config_schemas import PintleEngineConfig
from engine.core.runner import PintleEngineRunner


class SystemDiagnostics:
    """Comprehensive diagnostics for engine system dynamics."""
    
    def __init__(self, config: PintleEngineConfig):
        self.config = config
        self.runner = PintleEngineRunner(config)
    
    def diagnose_all(self, P_tank_O: float, P_tank_F: float) -> Dict[str, Any]:
        """
        Run comprehensive diagnostics on all system components.
        
        Returns:
        --------
        diagnostics : dict
            Comprehensive diagnostic results with issues and recommendations
        """
        results = {}
        
        # Run engine evaluation
        try:
            engine_results = self.runner.evaluate(P_tank_O, P_tank_F)
            results["engine_evaluation"] = engine_results
        except Exception as e:
            results["engine_evaluation"] = {"error": str(e)}
            return results
        
        # Extract key parameters
        Pc = engine_results.get("Pc", 0.0)
        MR = engine_results.get("MR", 0.0)
        mdot_total = engine_results.get("mdot_total", 0.0)
        F = engine_results.get("F", 0.0)
        Isp = engine_results.get("Isp", 0.0)
        Cf_actual = engine_results.get("Cf_actual", 0.0)
        Cf_ideal = engine_results.get("Cf_ideal", 0.0)
        Cf_theoretical = engine_results.get("Cf_theoretical", 0.0)
        v_exit = engine_results.get("v_exit", 0.0)
        T_exit = engine_results.get("T_exit", 0.0)
        P_exit = engine_results.get("P_exit", 0.0)
        M_exit = engine_results.get("M_exit", 0.0)
        
        # Diagnose each component
        from engine.pipeline.config_schemas import ensure_chamber_geometry
        cg = ensure_chamber_geometry(self.config)
        results["cf_analysis"] = self._diagnose_cf(Cf_actual, Cf_ideal, Cf_theoretical, F, Pc, cg.A_throat)
        results["velocity_analysis"] = self._diagnose_velocity(v_exit, T_exit, P_exit, M_exit, engine_results)
        results["feed_system_analysis"] = self._diagnose_feed_system(P_tank_O, P_tank_F, engine_results)
        results["chamber_dynamics"] = self._diagnose_chamber_dynamics(engine_results)
        results["stability_analysis"] = self._diagnose_stability(engine_results)
        
        # Overall health check
        results["health_status"] = self._overall_health(results)
        
        return results
    
    def _diagnose_cf(self, Cf_actual: float, Cf_ideal: float, Cf_theoretical: float, 
                     F: float, Pc: float, A_throat: float) -> Dict[str, Any]:
        """Diagnose thrust coefficient calculations."""
        issues = []
        recommendations = []
        
        # Check if Cf_actual is reasonable
        if Cf_actual <= 0:
            issues.append("Cf_actual is zero or negative - thrust calculation may be wrong")
        elif Cf_actual < 1.0:
            issues.append(f"Cf_actual ({Cf_actual:.4f}) is unusually low (< 1.0)")
            recommendations.append("Check exit velocity and pressure calculations")
        elif Cf_actual > 2.5:
            issues.append(f"Cf_actual ({Cf_actual:.4f}) is unusually high (> 2.5)")
            recommendations.append("Check for calculation errors or underexpanded nozzle")
        
        # Check relationship between Cf values
        if Cf_actual > Cf_ideal * 1.2:
            issues.append(f"Cf_actual ({Cf_actual:.4f}) > Cf_ideal ({Cf_ideal:.4f}) by >20%")
            recommendations.append("May indicate underexpanded nozzle or calculation error")
        
        if abs(Cf_actual - Cf_theoretical) / max(Cf_theoretical, 0.01) > 0.1:
            issues.append(f"Cf_actual ({Cf_actual:.4f}) differs significantly from Cf_theoretical ({Cf_theoretical:.4f})")
            recommendations.append("Check momentum and pressure thrust components")
        
        # Verify thrust equation: F = Cf_actual * Pc * A_throat
        F_calculated = Cf_actual * Pc * A_throat
        if abs(F - F_calculated) / max(F, 1.0) > 0.01:
            issues.append(f"Thrust equation mismatch: F={F:.1f} N vs Cf*Pc*At={F_calculated:.1f} N")
            recommendations.append("Verify Cf_actual calculation")
        
        return {
            "Cf_actual": Cf_actual,
            "Cf_ideal": Cf_ideal,
            "Cf_theoretical": Cf_theoretical,
            "F": F,
            "F_expected": F_calculated,
            "issues": issues,
            "recommendations": recommendations,
            "status": "OK" if len(issues) == 0 else "ISSUES"
        }
    
    def _diagnose_velocity(self, v_exit: float, T_exit: float, P_exit: float, 
                           M_exit: float, engine_results: Dict) -> Dict[str, Any]:
        """Diagnose velocity and Mach number calculations."""
        issues = []
        recommendations = []
        
        # Check exit velocity
        if v_exit <= 0:
            issues.append("Exit velocity is zero or negative")
        elif v_exit < 1000:
            issues.append(f"Exit velocity ({v_exit:.1f} m/s) is unusually low")
            recommendations.append("Check exit temperature and Mach number calculations")
        elif v_exit > 5000:
            issues.append(f"Exit velocity ({v_exit:.1f} m/s) is unusually high")
            recommendations.append("Verify exit temperature and Mach number")
        
        # Check exit Mach number
        if M_exit <= 0:
            issues.append("Exit Mach number is zero or negative")
        elif M_exit < 1.0:
            issues.append(f"Exit Mach number ({M_exit:.3f}) is subsonic - should be > 1.0 for supersonic nozzle")
            recommendations.append("Check area-Mach number solver convergence")
        elif M_exit > 10.0:
            issues.append(f"Exit Mach number ({M_exit:.2f}) is unusually high (> 10)")
            recommendations.append("Verify expansion ratio and area-Mach solver")
        
        # Check exit temperature
        Tc = engine_results.get("Tc", 0.0)
        if T_exit <= 0:
            issues.append("Exit temperature is zero or negative")
        elif T_exit > Tc * 0.95:
            issues.append(f"Exit temperature ({T_exit:.1f} K) is too close to chamber temperature ({Tc:.1f} K)")
            recommendations.append("Check isentropic expansion calculation")
        elif T_exit < Tc * 0.2:
            issues.append(f"Exit temperature ({T_exit:.1f} K) is unusually low compared to chamber ({Tc:.1f} K)")
            recommendations.append("Verify Mach number and isentropic relations")
        
        # Check chamber Mach number
        chamber_intrinsics = engine_results.get("chamber_intrinsics", {})
        M_chamber = chamber_intrinsics.get("mach_number", 0.0)
        if M_chamber <= 0:
            issues.append("Chamber Mach number is zero or negative")
        elif M_chamber > 0.5:
            issues.append(f"Chamber Mach number ({M_chamber:.3f}) is unusually high (> 0.5)")
            recommendations.append("Check mean velocity calculation in chamber")
        
        # Verify velocity-Mach relationship: v = M * sqrt(gamma * R * T)
        gamma = engine_results.get("gamma", 1.2)
        R = engine_results.get("R", 300.0)
        sound_speed = np.sqrt(gamma * R * T_exit)
        v_expected = M_exit * sound_speed
        if abs(v_exit - v_expected) / max(v_exit, 1.0) > 0.01:
            issues.append(f"Velocity-Mach mismatch: v_exit={v_exit:.1f} m/s vs M*a={v_expected:.1f} m/s")
            recommendations.append("Verify exit velocity calculation consistency")
        
        return {
            "v_exit": v_exit,
            "M_exit": M_exit,
            "T_exit": T_exit,
            "P_exit": P_exit,
            "M_chamber": M_chamber,
            "issues": issues,
            "recommendations": recommendations,
            "status": "OK" if len(issues) == 0 else "ISSUES"
        }
    
    def _diagnose_feed_system(self, P_tank_O: float, P_tank_F: float, 
                             engine_results: Dict) -> Dict[str, Any]:
        """Diagnose feed system pressure losses."""
        issues = []
        recommendations = []
        
        diagnostics = engine_results.get("diagnostics", {})
        delta_p_feed_O = diagnostics.get("delta_p_feed_O", 0.0)
        delta_p_feed_F = diagnostics.get("delta_p_feed_F", 0.0)
        mdot_O = diagnostics.get("mdot_O", 0.0)
        mdot_F = diagnostics.get("mdot_F", 0.0)
        
        # Check LOX feed pressure loss
        if delta_p_feed_O == 0.0 and mdot_O > 0.01:
            issues.append(f"LOX feed pressure loss is zero with mdot_O={mdot_O:.4f} kg/s")
            recommendations.append("Check feed system configuration (d_inlet, A_hydraulic, K_eff)")
            recommendations.append("Verify delta_p_feed function is being called correctly")
        elif delta_p_feed_O < 0:
            issues.append(f"LOX feed pressure loss is negative: {delta_p_feed_O:.1f} Pa")
        elif delta_p_feed_O > P_tank_O * 0.5:
            issues.append(f"LOX feed pressure loss ({delta_p_feed_O/1e6:.2f} MPa) is >50% of tank pressure")
            recommendations.append("Check feed system geometry - may be too restrictive")
        
        # Check fuel feed pressure loss
        if delta_p_feed_F == 0.0 and mdot_F > 0.01:
            issues.append(f"Fuel feed pressure loss is zero with mdot_F={mdot_F:.4f} kg/s")
            recommendations.append("Check feed system configuration")
        elif delta_p_feed_F < 0:
            issues.append(f"Fuel feed pressure loss is negative: {delta_p_feed_F:.1f} Pa")
        elif delta_p_feed_F > P_tank_F * 0.5:
            issues.append(f"Fuel feed pressure loss ({delta_p_feed_F/1e6:.2f} MPa) is >50% of tank pressure")
            recommendations.append("Check feed system geometry")
        
        # Check injector pressures
        P_injector_O = diagnostics.get("P_injector_O", 0.0)
        P_injector_F = diagnostics.get("P_injector_F", 0.0)
        Pc = engine_results.get("Pc", 0.0)
        
        if P_injector_O <= Pc:
            issues.append(f"LOX injector pressure ({P_injector_O/1e6:.2f} MPa) <= chamber pressure ({Pc/1e6:.2f} MPa)")
            recommendations.append("Increase tank pressure or reduce feed losses")
        
        if P_injector_F <= Pc:
            issues.append(f"Fuel injector pressure ({P_injector_F/1e6:.2f} MPa) <= chamber pressure ({Pc/1e6:.2f} MPa)")
            recommendations.append("Increase tank pressure or reduce feed losses")
        
        return {
            "delta_p_feed_O": delta_p_feed_O,
            "delta_p_feed_F": delta_p_feed_F,
            "P_injector_O": P_injector_O,
            "P_injector_F": P_injector_F,
            "P_tank_O": P_tank_O,
            "P_tank_F": P_tank_F,
            "mdot_O": mdot_O,
            "mdot_F": mdot_F,
            "issues": issues,
            "recommendations": recommendations,
            "status": "OK" if len(issues) == 0 else "ISSUES"
        }
    
    def _diagnose_chamber_dynamics(self, engine_results: Dict) -> Dict[str, Any]:
        """Diagnose chamber dynamics (L*, residence time, velocities)."""
        issues = []
        recommendations = []
        
        chamber_intrinsics = engine_results.get("chamber_intrinsics", {})
        Lstar = chamber_intrinsics.get("Lstar", 0.0)
        residence_time = chamber_intrinsics.get("residence_time", 0.0)
        velocity_mean = chamber_intrinsics.get("velocity_mean", 0.0)
        velocity_throat = chamber_intrinsics.get("velocity_throat", 0.0)
        mach_number = chamber_intrinsics.get("mach_number", 0.0)
        
        # Check L*
        if Lstar <= 0:
            issues.append("L* is zero or negative")
        elif Lstar < 0.5:
            issues.append(f"L* ({Lstar:.3f} m) is unusually short (< 0.5 m)")
            recommendations.append("May cause incomplete combustion - check chamber volume")
        elif Lstar > 3.0:
            issues.append(f"L* ({Lstar:.3f} m) is unusually long (> 3.0 m)")
            recommendations.append("May cause excessive weight - optimize chamber geometry")
        
        # Check residence time
        if residence_time <= 0:
            issues.append("Residence time is zero or negative")
        elif residence_time < 1e-4:
            issues.append(f"Residence time ({residence_time*1e3:.3f} ms) is unusually short")
            recommendations.append("May cause incomplete combustion")
        elif residence_time > 0.1:
            issues.append(f"Residence time ({residence_time*1e3:.1f} ms) is unusually long")
            recommendations.append("Check mass flow and chamber volume")
        
        # Check velocities
        if velocity_mean <= 0:
            issues.append("Mean chamber velocity is zero or negative")
        elif velocity_mean > 500:
            issues.append(f"Mean chamber velocity ({velocity_mean:.1f} m/s) is unusually high")
            recommendations.append("Check mean velocity calculation")
        
        if velocity_throat <= 0:
            issues.append("Throat velocity is zero or negative")
        elif abs(velocity_throat - velocity_mean * 10) < velocity_mean:  # Rough check
            issues.append(f"Throat velocity ({velocity_throat:.1f} m/s) seems inconsistent with mean ({velocity_mean:.1f} m/s)")
        
        return {
            "Lstar": Lstar,
            "residence_time": residence_time,
            "velocity_mean": velocity_mean,
            "velocity_throat": velocity_throat,
            "mach_number": mach_number,
            "issues": issues,
            "recommendations": recommendations,
            "status": "OK" if len(issues) == 0 else "ISSUES"
        }
    
    def _diagnose_stability(self, engine_results: Dict) -> Dict[str, Any]:
        """Diagnose stability analysis results."""
        issues = []
        recommendations = []
        
        stability = engine_results.get("stability_results", {})
        is_stable = stability.get("is_stable", True)
        
        if not is_stable:
            issues.append("Engine is predicted to be unstable")
            recommendations.append("Review stability analysis results")
        
        chugging = stability.get("chugging", {})
        chugging_freq = chugging.get("frequency", 0.0)
        if chugging_freq <= 0:
            issues.append("Chugging frequency is zero or negative")
        elif chugging_freq < 1.0:
            issues.append(f"Chugging frequency ({chugging_freq:.2f} Hz) is unusually low")
        
        return {
            "is_stable": is_stable,
            "chugging_frequency": chugging_freq,
            "issues": issues,
            "recommendations": recommendations,
            "status": "OK" if is_stable and len(issues) == 0 else "ISSUES"
        }
    
    def _overall_health(self, results: Dict) -> Dict[str, Any]:
        """Overall system health assessment."""
        all_issues = []
        all_recommendations = []
        
        for component, data in results.items():
            if isinstance(data, dict) and "issues" in data:
                all_issues.extend([f"{component}: {issue}" for issue in data["issues"]])
                all_recommendations.extend([f"{component}: {rec}" for rec in data.get("recommendations", [])])
        
        status = "HEALTHY" if len(all_issues) == 0 else "NEEDS_ATTENTION"
        if len(all_issues) > 5:
            status = "CRITICAL"
        
        return {
            "status": status,
            "total_issues": len(all_issues),
            "issues": all_issues,
            "recommendations": all_recommendations
        }

