"""Regression tests for the 2026-09-26 stability/feed audit (STAB-1..10, FEED-1, FEED-4).

Every expected value comes from outside the code under test: a closed form worked here, a
quadrature, a root-find of an independently written characteristic equation, or CoolProp.
"""

import math
import unittest

import numpy as np
from scipy.optimize import fsolve

from engine.pipeline.stability import acoustic, analysis, chug, core
from engine.pipeline.stability.acoustic import GasState
from engine.pipeline.stability.chug import ChugChamber, ChugStream, Regulator
from engine.pipeline.io import load_config
from engine.pipeline.config_schemas import ensure_chamber_geometry

PSI = 6894.757

# 6500 N LOX/ethanol chamber state (runner evaluation at 584.27 psia tanks, 2026-09-26).
GAS_6500 = dict(gamma=1.1375, a_sound=1166.0, nu_g=1.6e-5, mach_nozzle_entrance=0.072)
D_6500, L_6500 = 0.127, 0.131

COMMON = dict(Pc=2.4e6, MR=2.8, mdot_total=2.71, cstar=1800.0, gamma=1.18, R=350.0, Tc=3500.0)


def synth_diagnostics(Pc=2.4e6, **kw):
    d = {"mdot_O": 2.0, "mdot_F": 0.71,
         "delta_p_injector_O": 0.25 * Pc, "delta_p_injector_F": 0.25 * Pc,
         "delta_p_feed_O": 0.10 * Pc, "delta_p_feed_F": 0.12 * Pc,
         "D32_O": 60e-6, "D32_F": 50e-6}
    d.update(kw)
    return d


class TestRayleighDriving(unittest.TestCase):
    """STAB-2: the driving is the part of q' in phase with p', n(1 - cos wt), not n sin wt."""

    def test_quadrature_of_p_q(self):
        f, n, gamma, ov = 1000.0, 0.5, 1.2, 1.0
        w = 2 * np.pi * f
        t = np.linspace(0.0, 1.0 / f, 40001)[:-1]
        for wt in (0.3, np.pi / 2, np.pi, 1.5 * np.pi, 2 * np.pi - 0.1):
            tau = wt / w
            p = np.cos(w * t)
            q = n * (np.cos(w * t) - np.cos(w * (t - tau)))       # Crocco: n[p(t) - p(t - tau)]
            in_phase = np.mean(p * q) / np.mean(p * p)
            expected = 0.5 * w * (gamma - 1.0) * ov * in_phase
            got = acoustic.mode_driving_rate(f, gamma, ov, n, tau)
            self.assertAlmostEqual(got, expected, delta=1e-6 * abs(w))

    def test_peak_at_omega_tau_pi(self):
        f = 1000.0
        self.assertAlmostEqual(acoustic.mode_driving_rate(f, 1.2, 1.0, 0.5, 0.5 / f),
                               np.pi * f * 0.2 * 0.5 * 2.0, places=6)     # 628.3 1/s


class TestAcousticGateCanFail(unittest.TestCase):
    """STAB-1: at n = 0.5 the LOX/hydrocarbon 1L mode can now be driven for some lag."""

    def test_some_lag_drives_1L(self):
        gas = GasState(**GAS_6500)
        taus = np.linspace(1e-5, 5e-3, 5001)
        worst = max(acoustic.fast_acoustic(D_6500, L_6500, gas, n=0.5, tau_sens=tt)["alpha_max"]
                    for tt in taus)
        # Hand: 1L = a/2L = 4450 Hz; driving at w*tau = pi is w(g-1)(0.7)(0.5) = 1345 1/s against
        # 0.05 pi f = 699 plus a nozzle term a(g-1)M/(2L) = 44 1/s.
        self.assertGreater(worst, 0.0)

    def test_worst_phase_margin_is_n_min_over_n(self):
        gas = GasState(**GAS_6500)
        f1L = GAS_6500["a_sound"] / (2 * L_6500)
        m = acoustic.mode_growth_rate(f1L, "1L", D_6500, L_6500, gas, n=0.5, tau_sens=1e-4)
        drive_max = 2 * np.pi * f1L * (GAS_6500["gamma"] - 1.0) * 0.7 * 0.5
        self.assertAlmostEqual(m["margin_worst_phase"], m["damping_total"] / drive_max, places=9)
        # at n = n_min the mode is neutral at w*tau = pi
        tau_pi = 0.5 / f1L
        m_crit = acoustic.mode_growth_rate(f1L, "1L", D_6500, L_6500, gas, n=m["n_min"], tau_sens=tau_pi)
        self.assertAlmostEqual(m_crit["alpha"], 0.0, delta=1e-6 * m_crit["damping_total"])


class TestHalfWaveAndNozzleAdmittance(unittest.TestCase):
    """STAB-4 (and the nozzle term of STAB-1): closed duct with a compact choked nozzle."""

    def test_modes_are_half_wave(self):
        self.assertEqual(core.longitudinal_mode_frequencies(1000.0, 0.5, 2), [1000.0, 2000.0])
        res = analysis.calculate_acoustic_modes(0.131, 0.127, 3200.0, 1.1375, 373.6)
        a = res["sound_speed"]
        self.assertAlmostEqual(res["longitudinal_modes"][0], a / (2 * 0.131), places=6)

    def test_against_the_admittance_eigenproblem(self):
        # p = cos(kx), rigid at x = 0, rho a u'/p' = Y at x = L  =>  tan(kL) = i Y. Solve for complex
        # kL near pi: its real part is the frequency, its imaginary part the nozzle decay rate.
        g, M, a, L = 1.1375, 0.0724, 1159.85, 0.131
        Y = 0.5 * (g - 1.0) * M

        def res(x):
            z = complex(x[0], x[1])
            r = np.tan(z) - 1j * Y
            return [r.real, r.imag]
        zr, zi = fsolve(res, [np.pi, 0.0], xtol=1e-14)
        f1 = a * zr / (2 * np.pi * L)
        decay = a * abs(zi) / L
        self.assertAlmostEqual(core.longitudinal_mode_frequencies(a, L, 1)[0], f1, delta=1e-6 * f1)
        self.assertAlmostEqual(core.nozzle_damping_rate(a, L, M, g), decay, delta=1e-4 * decay)

    def test_kirchhoff_wall_layer(self):
        f, D, nu, g, Pr = 4450.0, 0.127, 1.6e-5, 1.1375, 0.75
        w = 2 * np.pi * f
        expected = np.sqrt(w * nu / 2.0) / (D / 2.0) * (1.0 + (g - 1.0) / np.sqrt(Pr))
        self.assertAlmostEqual(core.viscous_damping_rate(f, D, nu, g, Pr), expected, places=9)


class TestNyquistAllCrossings(unittest.TestCase):
    """STAB-5: a -3pi crossing the old -pi-only test missed (GM read 4.27, loop unstable)."""

    Pc = 3.61e6
    O = dict(mdot=0.9907, eta=0.3745, dPf=648654.0, L=0.6093, A=1.534e-4, tau=1.638e-3)
    F = dict(mdot=0.7122, eta=0.1775, dPf=625208.0, L=0.9913, A=3.534e-4, tau=13.85e-3)
    cstar, At, Lstar, gamma = 1872.7, 4.353e-4, 1.093, 1.178

    def case(self):
        mk = lambda n, d: ChugStream(n, mdot=d["mdot"], eta_inj=d["eta"], Pc=self.Pc, dP_feed=d["dPf"],
                                     feed_length=d["L"], feed_area=d["A"], tau_conv=d["tau"])
        return [mk("O", self.O), mk("F", self.F)], ChugChamber(self.cstar, self.At, self.Lstar, self.gamma)

    def L_indep(self, s):
        """Open loop written here from eq. 3.3, not imported."""
        G = np.sqrt(self.gamma) * (2 / (self.gamma + 1)) ** ((self.gamma + 1) / (2 * (self.gamma - 1)))
        th = self.Lstar / (G * G * self.cstar)
        acc = 0.0
        for d in (self.O, self.F):
            Z = d["L"] / d["A"] * s + 2 * d["dPf"] / d["mdot"] + 2 * d["eta"] * self.Pc / d["mdot"]
            acc = acc + np.exp(-s * d["tau"]) / Z
        return self.cstar / self.At / (th * s + 1) * acc

    def test_gain_margin_catches_minus_3pi(self):
        w = 2 * np.pi * np.logspace(np.log10(2), np.log10(2000), 200001)
        Lw = self.L_indep(1j * w)
        im = Lw.imag
        i = np.flatnonzero(im[:-1] * im[1:] < 0)
        fr = im[i] / (im[i] - im[i + 1])
        re = Lw.real[i] + fr * (Lw.real[i + 1] - Lw.real[i])
        gm_ref = 1.0 / np.max(-re[re < 0])                      # ~0.90: unstable
        streams, ch = self.case()
        r = chug.chug_margin_fast(streams, ch)
        self.assertLess(gm_ref, 1.0)
        self.assertAlmostEqual(r["gain_margin"], gm_ref, delta=0.02 * gm_ref)
        self.assertFalse(r["stable"])

    def test_rich_tier_finds_the_growing_root(self):
        def res(x):
            F = 1 + self.L_indep(complex(x[0], x[1]))
            return [F.real, F.imag]
        a_ref, w_ref = fsolve(res, [0.0, 2 * np.pi * 100.0], xtol=1e-12)
        self.assertGreater(a_ref, 0.0)                           # +7.4 1/s at 102.6 Hz
        streams, ch = self.case()
        r = chug.chug_growth_rate(streams, ch)
        self.assertAlmostEqual(r["alpha"], a_ref, delta=0.05 * abs(a_ref))
        self.assertAlmostEqual(r["f_chug_hz"], w_ref / (2 * np.pi), delta=0.5)


class TestChamberTimeConstant(unittest.TestCase):
    """STAB-9: theta_c = m_gas/mdot = L* c*/(R T) with the delivered c*."""

    def test_theta_from_state(self):
        ch = ChugChamber(cstar=1639.13, A_t=1.5337e-3, Lstar=1.0, gamma=1.1375, R_gas=373.56, T_c=3198.8)
        self.assertAlmostEqual(ch.theta_c(), 1639.13 / (373.56 * 3198.8), places=12)   # 1.3717 ms

    def test_inputs_carry_the_state(self):
        cfg = load_config("configs/default.yaml")
        inp = analysis.build_stability_inputs(cfg, diagnostics=synth_diagnostics(),
                                              cg=ensure_chamber_geometry(cfg), **COMMON)
        ch = inp["chamber"]
        self.assertAlmostEqual(ch.theta_c(), ch.Lstar * COMMON["cstar"] / (COMMON["R"] * COMMON["Tc"]),
                               places=12)


class TestRegulatorStatus(unittest.TestCase):
    """STAB-10: Z_hf = 0 is 'not modelled', not a with/without pair of identical numbers."""

    def _case(self, Z_hf):
        Pc = 2.4e6
        reg = Regulator(corner_hz=3.0, Z_hf=Z_hf, enabled=True)
        s = [ChugStream("O", 2.0, 0.2, Pc, 0.1 * Pc, 0.305, 1.43e-4, 4e-3, regulator=reg),
             ChugStream("F", 0.71, 0.2, Pc, 0.1 * Pc, 0.305, 7.1e-5, 4e-3, regulator=reg)]
        return s, ChugChamber(1800.0, 9.44e-4, 0.8, 1.18)

    def test_unset_impedance_is_not_modelled(self):
        r = chug.chug_growth_rate(*self._case(0.0))
        self.assertEqual(r["regulator_status"], "not_modelled")
        self.assertIsNone(r["alpha_no_reg"])

    def test_measured_impedance_is_compared(self):
        r = chug.chug_growth_rate(*self._case(5.0e5))
        self.assertEqual(r["regulator_status"], "modelled")
        self.assertTrue(np.isfinite(r["alpha_no_reg"]))


class TestIntegration(unittest.TestCase):
    """STAB-3/6/7/8 through analysis on a real config."""

    @classmethod
    def setUpClass(cls):
        cls.cfg = load_config("configs/default.yaml")
        cls.cg = ensure_chamber_geometry(cls.cfg)

    def test_chug_gate_is_the_gain_margin_band_minimum(self):
        # STAB-3 + STAB-8: the gate is the Nyquist GM itself, at the low end of the mixing band.
        res = analysis.comprehensive_stability_analysis(config=self.cfg, diagnostics=synth_diagnostics(), **COMMON)
        band = res["chugging"]["chug_gm_band"]
        self.assertIsNotNone(band)
        self.assertEqual(res["chugging"]["stability_margin"], band["min"])
        # Independent path: recompute the lags with the band's ends as overrides (compute_lags
        # again, not the shift the band uses) and read GM straight off the Nyquist scan.
        for frac, gm_band in ((band["fractions"][0], band["gain_margins"][0]),
                              (band["fractions"][-1], band["gain_margins"][-1])):
            inp = analysis.build_stability_inputs(self.cfg, diagnostics=synth_diagnostics(), cg=self.cg,
                                                  overrides={"mixing_lag_fraction": frac}, **COMMON)
            # same scan path as the band (accelerated when on), so only the lag shift is under test
            gm = analysis._chug_fast(inp["streams"], inp["chamber"])["gain_margin"]
            self.assertAlmostEqual(gm_band, gm, delta=1e-6 * gm)
        self.assertLessEqual(band["min"], res["chugging"]["chug_gain_margin"])
        self.assertGreaterEqual(band["max"], res["chugging"]["chug_gain_margin"])

    def test_requirement_above_1p3_is_expressible(self):
        # The tanh gate saturated at 1.3: no GM could satisfy min_stability_margin 1.3.
        self.assertEqual(analysis.classify_stability(2.5, 2.0, float("inf"), -1.0, False, 1.5), "stable")
        self.assertEqual(analysis.classify_stability(2.5, 1.4, float("inf"), -1.0, False, 1.5), "marginal")

    def test_model_error_fails_closed(self):
        # STAB-6: an exception in the physical model is 'unknown', never a neutral 'stable' 1.10.
        orig = analysis.compute_physical_stability

        def boom(*a, **k):
            raise RuntimeError("synthetic")
        analysis.compute_physical_stability = boom
        try:
            res = analysis.comprehensive_stability_analysis(config=self.cfg, diagnostics=synth_diagnostics(), **COMMON)
        finally:
            analysis.compute_physical_stability = orig
        self.assertEqual(res["stability_state"], "unknown")
        self.assertEqual(res["stability_score"], 0.0)
        self.assertTrue(math.isnan(res["chugging"]["stability_margin"]))
        self.assertFalse(analysis.stability_state_ok(res["stability_state"], False))

    def test_missing_injector_drop_is_recorded_and_zero_is_zero(self):
        # STAB-7: a published 0.0 is zero stiffness; an absent key is a recorded assumption.
        from engine.pipeline import assumptions
        diag = synth_diagnostics(delta_p_injector_O=0.0)
        diag.pop("delta_p_injector_F")
        with assumptions.scope() as used:
            inp = analysis.build_stability_inputs(self.cfg, diagnostics=diag, cg=self.cg, **COMMON)
        self.assertEqual(inp["eta_inj_O"], 0.0)
        self.assertIn("stability.delta_p_injector_F", used)
        self.assertNotIn("stability.delta_p_injector_O", used)

    def test_acoustic_report_only_by_default(self):
        # STAB-1: the uncalibrated HF model gates nothing unless asked; gated, it can fail.
        res = analysis.comprehensive_stability_analysis(config=self.cfg, diagnostics=synth_diagnostics(), **COMMON)
        self.assertEqual(res["acoustic"]["gate_status"], "report_only")
        self.assertEqual(res["acoustic"]["stability_margin"], float("inf"))
        cfg = self.cfg.model_copy(deep=True)
        cfg.stability.acoustic_gate = "worst_phase"
        cfg.stability.n_interaction = 0.9            # past n_min for 1L: every lag can drive it
        gated = analysis.comprehensive_stability_analysis(config=cfg, diagnostics=synth_diagnostics(), **COMMON)
        self.assertLess(gated["acoustic"]["stability_margin"], 1.0)
        self.assertEqual(gated["stability_state"], "unstable")


class TestFeedLineAcoustics(unittest.TestCase):
    """FEED-4: CoolProp bulk modulus, Korteweg wall compliance, closure-time water hammer."""

    def test_lox_quarter_wave_with_wall(self):
        from CoolProp.CoolProp import PropsSI
        rho = PropsSI("D", "T", 90.0, "P", 4.03e6, "Oxygen")
        a = PropsSI("A", "T", 90.0, "P", 4.03e6, "Oxygen")          # 924.3 m/s
        K = rho * a * a
        D, e, E, L = 0.010922, 0.035 * 0.0254, 193e9, 0.1016
        a_eff = a / np.sqrt(1.0 + K * D / (E * e))
        r = analysis.analyze_feed_system_stability(L, D, rho, K, 15.8,
                                                   wall_modulus_pa=E, wall_thickness_m=e)
        self.assertAlmostEqual(r["pogo_frequency"], a_eff / (4 * L), delta=1e-6 * a_eff)   # ~2200 Hz

    def test_bulk_modulus_from_coolprop_when_unset(self):
        from CoolProp.CoolProp import PropsSI
        cfg = load_config("configs/default.yaml").model_copy(deep=True)
        cfg.fluids["oxidizer"].bulk_modulus_pa = None
        cfg.fluids["oxidizer"].temperature = 90.0
        K = analysis._liquid_bulk_modulus(cfg, "oxidizer", 4.03e6, "test.K")
        ref = PropsSI("D", "T", 90.0, "P", 4.03e6, "Oxygen") * PropsSI("A", "T", 90.0, "P", 4.03e6, "Oxygen") ** 2
        self.assertAlmostEqual(K, ref, delta=0.01 * ref)                   # 0.98 GPa, not 1.5

    def test_slow_closure_is_michaud(self):
        rho, K, v, L = 790.0, 1.1e9, 15.0, 0.9144
        a = np.sqrt(K / rho)
        tc = 50e-3                                                          # >> 2L/a = 1.5 ms
        r = analysis.analyze_feed_system_stability(L, 0.0109, rho, K, v, valve_closure_time_s=tc)
        self.assertAlmostEqual(r["water_hammer_pressure"], 2 * rho * L * v / tc, places=6)
        r0 = analysis.analyze_feed_system_stability(L, 0.0109, rho, K, v)
        self.assertAlmostEqual(r0["water_hammer_pressure"], rho * a * v, places=6)

    def test_both_lines_reported(self):
        cfg = load_config("configs/default.yaml")
        res = analysis.comprehensive_stability_analysis(config=cfg, diagnostics=synth_diagnostics(), **COMMON)
        lines = res["feed_system"]["feed_lines"]
        self.assertEqual(set(lines), {"oxidizer", "fuel"})
        self.assertNotIn("water_hammer_margin", res["feed_system"])


class TestDomeRegulatedCurve(unittest.TestCase):
    """FEED-1: no invented ripple or inlet; SPE is the regulator's, acting on the COPV's drop."""

    def test_no_inlet_history_is_the_flat_setpoint(self):
        from engine.optimizer.feed_pressure_model import dome_regulated_tank_pair
        P = 584.27 * PSI
        _, P_O, P_F = dome_regulated_tank_pair(P, P, 4.0, 200)
        self.assertLess(np.max(np.abs(P_O - P)), 1.0)
        self.assertLess(np.max(np.abs(P_F - P)), 1.0)

    def test_supply_pressure_effect_on_copv_drop(self):
        from engine.optimizer.feed_pressure_model import (RegulatorModel,
                                                          generate_dome_regulated_pressure_curve)
        P = 584.27 * PSI
        _, Pt = generate_dome_regulated_pressure_curve(
            P, burn_time_s=4.0, P_inlet_0_pa=4015 * PSI, P_inlet_end_pa=1800 * PSI,
            regulator=RegulatorModel(supply_pressure_effect=0.017, source="TB 1031"))
        self.assertAlmostEqual((Pt[-1] - P) / PSI, 0.017 * (4015 - 1800), places=6)     # 37.66 psi
        self.assertTrue(np.all(np.diff(Pt) >= 0))

    def test_inlet_below_setpoint_raises(self):
        from engine.optimizer.feed_pressure_model import (RegulatorDropout, RegulatorModel,
                                                          dome_regulated_tank_pair)
        P = 584.27 * PSI
        with self.assertRaises(RegulatorDropout):
            dome_regulated_tank_pair(P, P, 4.0, 200, copv_initial_pa=1.2 * P, copv_end_pa=0.84 * P,
                                     regulator=RegulatorModel(supply_pressure_effect=0.010))


if __name__ == "__main__":
    unittest.main()
