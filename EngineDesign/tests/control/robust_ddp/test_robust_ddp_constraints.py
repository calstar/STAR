"""Unit tests for robust DDP controller constraints."""

import unittest
import numpy as np

from engine.control.robust_ddp.constraints import (
    is_safe,
    constraint_values,
    get_constraint_summary,
)
from engine.control.robust_ddp.data_models import ControllerConfig
from engine.control.robust_ddp.engine_wrapper import EngineEstimate
from engine.control.robust_ddp.dynamics import (
    IDX_P_COPV,
    IDX_P_REG,
    IDX_P_U_F,
    IDX_P_U_O,
    IDX_P_D_F,
    IDX_P_D_O,
)


class TestConstraints(unittest.TestCase):
    """Test constraint checking."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.config = ControllerConfig(
            P_copv_min=1e6,      # 1 MPa minimum
            P_u_max=10e6,        # 10 MPa maximum
            MR_min=1.5,
            MR_max=3.0,
            eps_i=1e-3,          # 0.1% minimum injector pressure drop fraction
            headroom_dp_min=0.05e6,  # 0.05 MPa minimum headroom
        )
    
    def create_state(self, **kwargs) -> np.ndarray:
        """Create test state vector with optional overrides."""
        from engine.control.robust_ddp.dynamics import IDX_V_U_F, IDX_V_U_O
        
        defaults = {
            IDX_P_COPV: 30e6,    # 30 MPa COPV
            IDX_P_REG: 24e6,     # 24 MPa regulator
            IDX_P_U_F: 3e6,      # 3 MPa fuel ullage
            IDX_P_U_O: 3.5e6,    # 3.5 MPa oxidizer ullage
            IDX_P_D_F: 2.5e6,    # 2.5 MPa fuel feed
            IDX_P_D_O: 3e6,      # 3 MPa oxidizer feed
            IDX_V_U_F: 0.01,     # V_u_F
            IDX_V_U_O: 0.01,     # V_u_O
        }
        defaults.update(kwargs)
        x = np.zeros(8)
        for idx, val in defaults.items():
            x[idx] = val
        return x
    
    def create_estimate(self, **kwargs) -> EngineEstimate:
        """Create test engine estimate with optional overrides."""
        defaults = {
            "P_ch": 2e6,         # 2 MPa chamber pressure
            "F": 1000.0,         # 1 kN thrust
            "mdot_F": 0.5,       # 0.5 kg/s fuel
            "mdot_O": 1.0,       # 1.0 kg/s oxidizer
            "MR": 2.0,           # O/F = 2.0
            "injector_dp_F": 0.5e6,  # 0.5 MPa injector drop
            "injector_dp_O": 1.0e6,  # 1.0 MPa injector drop
        }
        defaults.update(kwargs)
        return EngineEstimate(**defaults)
    
    def test_copv_minimum_constraint(self):
        """Test COPV minimum pressure constraint."""
        # Safe case: P_copv > P_copv_min
        x = self.create_state(**{IDX_P_COPV: 5e6})  # 5 MPa > 1 MPa min
        eng_est = self.create_estimate()
        
        constraints = constraint_values(x, eng_est, self.config)
        self.assertLess(constraints["copv_min"], 0)  # Negative = satisfied
        self.assertGreater(constraints["copv_margin"], 0)  # Positive margin
        
        self.assertTrue(is_safe(x, eng_est, self.config))
        
        # Violation case: P_copv < P_copv_min
        x = self.create_state(**{IDX_P_COPV: 0.5e6})  # 0.5 MPa < 1 MPa min
        constraints = constraint_values(x, eng_est, self.config)
        self.assertGreater(constraints["copv_min"], 0)  # Positive = violated
        self.assertLess(constraints["copv_margin"], 0)  # Negative margin
        
        self.assertFalse(is_safe(x, eng_est, self.config))
    
    def test_ullage_maximum_constraints(self):
        """Test ullage maximum pressure constraints."""
        # Safe case: P_u < P_u_max
        x = self.create_state(**{IDX_P_U_F: 5e6, IDX_P_U_O: 6e6})  # Both < 10 MPa max
        eng_est = self.create_estimate()
        
        constraints = constraint_values(x, eng_est, self.config)
        self.assertLess(constraints["ullage_max_F"], 0)  # Negative = satisfied
        self.assertLess(constraints["ullage_max_O"], 0)
        self.assertGreater(constraints["ullage_margin_F"], 0)  # Positive margin
        self.assertGreater(constraints["ullage_margin_O"], 0)
        
        self.assertTrue(is_safe(x, eng_est, self.config))
        
        # Violation case: P_u > P_u_max
        x = self.create_state(**{IDX_P_U_F: 12e6, IDX_P_U_O: 11e6})  # Both > 10 MPa max
        constraints = constraint_values(x, eng_est, self.config)
        self.assertGreater(constraints["ullage_max_F"], 0)  # Positive = violated
        self.assertGreater(constraints["ullage_max_O"], 0)
        self.assertLess(constraints["ullage_margin_F"], 0)  # Negative margin
        self.assertLess(constraints["ullage_margin_O"], 0)
        
        self.assertFalse(is_safe(x, eng_est, self.config))
    
    def test_mixture_ratio_constraints(self):
        """Test mixture ratio constraints."""
        # Safe case: MR_min <= MR <= MR_max
        x = self.create_state()
        eng_est = self.create_estimate(MR=2.0)  # 1.5 <= 2.0 <= 3.0
        
        constraints = constraint_values(x, eng_est, self.config)
        self.assertLess(constraints["MR_min"], 0)  # Negative = satisfied
        self.assertLess(constraints["MR_max"], 0)
        self.assertGreater(constraints["MR_margin_low"], 0)  # Positive margin
        self.assertGreater(constraints["MR_margin_high"], 0)
        
        self.assertTrue(is_safe(x, eng_est, self.config))
        
        # Violation case: MR < MR_min
        eng_est = self.create_estimate(MR=1.0)  # 1.0 < 1.5 min
        constraints = constraint_values(x, eng_est, self.config)
        self.assertGreater(constraints["MR_min"], 0)  # Positive = violated
        self.assertLess(constraints["MR_margin_low"], 0)  # Negative margin
        
        self.assertFalse(is_safe(x, eng_est, self.config))
        
        # Violation case: MR > MR_max
        eng_est = self.create_estimate(MR=4.0)  # 4.0 > 3.0 max
        constraints = constraint_values(x, eng_est, self.config)
        self.assertGreater(constraints["MR_max"], 0)  # Positive = violated
        self.assertLess(constraints["MR_margin_high"], 0)  # Negative margin
        
        self.assertFalse(is_safe(x, eng_est, self.config))
    
    def test_injector_stiffness_constraints(self):
        """Test injector stiffness constraints."""
        # Constraint: (P_d_i - P_ch) >= eps_i * P_ch
        # With eps_i = 1e-3 and P_ch = 2e6, required dp = 2e3 Pa
        
        # Safe case: injector_dp >= required
        x = self.create_state(**{IDX_P_D_F: 2.5e6, IDX_P_D_O: 3e6})
        eng_est = self.create_estimate(
            P_ch=2e6,
            injector_dp_F=0.5e6,  # 0.5 MPa > 2e3 Pa required
            injector_dp_O=1.0e6,  # 1.0 MPa > 2e3 Pa required
        )
        
        constraints = constraint_values(x, eng_est, self.config)
        self.assertLess(constraints["injector_stiffness_F"], 0)  # Negative = satisfied
        self.assertLess(constraints["injector_stiffness_O"], 0)
        self.assertGreater(constraints["injector_stiffness_margin_F"], 0)
        self.assertGreater(constraints["injector_stiffness_margin_O"], 0)
        
        self.assertTrue(is_safe(x, eng_est, self.config))
        
        # Violation case: injector_dp < required
        eng_est = self.create_estimate(
            P_ch=2e6,
            injector_dp_F=1e3,  # 1e3 Pa < 2e3 Pa required
            injector_dp_O=1e3,  # 1e3 Pa < 2e3 Pa required
        )
        constraints = constraint_values(x, eng_est, self.config)
        self.assertGreater(constraints["injector_stiffness_F"], 0)  # Positive = violated
        self.assertGreater(constraints["injector_stiffness_O"], 0)
        self.assertLess(constraints["injector_stiffness_margin_F"], 0)
        self.assertLess(constraints["injector_stiffness_margin_O"], 0)
        
        self.assertFalse(is_safe(x, eng_est, self.config))
    
    def test_headroom_constraints(self):
        """Test headroom constraints for actuation effectiveness."""
        # Constraint: (P_reg - P_u_i) >= dp_min for effective pressurization
        
        # Sufficient headroom case
        x = self.create_state(
            **{IDX_P_REG: 5e6, IDX_P_U_F: 4e6, IDX_P_U_O: 4.5e6}
        )  # Headroom: 1 MPa and 0.5 MPa > 0.05 MPa min
        eng_est = self.create_estimate()
        
        constraints = constraint_values(x, eng_est, self.config)
        self.assertEqual(constraints["headroom_insufficient_F"], 0.0)  # Sufficient
        self.assertEqual(constraints["headroom_insufficient_O"], 0.0)
        self.assertGreater(constraints["headroom_margin_F"], 0)  # Positive margin
        self.assertGreater(constraints["headroom_margin_O"], 0)
        
        # Insufficient headroom case
        x = self.create_state(
            **{IDX_P_REG: 3.01e6, IDX_P_U_F: 3e6, IDX_P_U_O: 3e6}
        )  # Headroom: 0.01 MPa < 0.05 MPa min
        constraints = constraint_values(x, eng_est, self.config)
        self.assertEqual(constraints["headroom_insufficient_F"], 1.0)  # Insufficient
        self.assertEqual(constraints["headroom_insufficient_O"], 1.0)
        self.assertLess(constraints["headroom_margin_F"], 0)  # Negative margin
        self.assertLess(constraints["headroom_margin_O"], 0)
    
    def test_all_constraints_safe(self):
        """Test that all constraints can be satisfied simultaneously."""
        x = self.create_state(
            **{
                IDX_P_COPV: 30e6,    # > 1 MPa min
                IDX_P_REG: 24e6,     # High regulator
                IDX_P_U_F: 3e6,      # < 10 MPa max
                IDX_P_U_O: 3.5e6,    # < 10 MPa max
                IDX_P_D_F: 2.5e6,    # Sufficient for injector stiffness
                IDX_P_D_O: 3e6,      # Sufficient for injector stiffness
            }
        )
        eng_est = self.create_estimate(
            P_ch=2e6,
            MR=2.0,  # Within [1.5, 3.0]
            injector_dp_F=0.5e6,  # > eps_i * P_ch
            injector_dp_O=1.0e6,  # > eps_i * P_ch
        )
        
        self.assertTrue(is_safe(x, eng_est, self.config))
        
        constraints = constraint_values(x, eng_est, self.config)
        summary = get_constraint_summary(constraints)
        self.assertTrue(summary["safe"])
        self.assertEqual(len(summary["violations"]), 0)
    
    def test_multiple_violations(self):
        """Test detection of multiple constraint violations."""
        x = self.create_state(
            **{
                IDX_P_COPV: 0.5e6,   # < 1 MPa min (violation)
                IDX_P_U_F: 12e6,     # > 10 MPa max (violation)
                IDX_P_U_O: 11e6,     # > 10 MPa max (violation)
            }
        )
        eng_est = self.create_estimate(
            MR=0.5,  # < 1.5 min (violation)
            injector_dp_F=1e3,  # < required (violation)
        )
        
        self.assertFalse(is_safe(x, eng_est, self.config))
        
        constraints = constraint_values(x, eng_est, self.config)
        summary = get_constraint_summary(constraints)
        self.assertFalse(summary["safe"])
        self.assertGreater(len(summary["violations"]), 1)
    
    def test_nan_handling(self):
        """Test handling of NaN values in engine estimate."""
        x = self.create_state()
        eng_est = self.create_estimate(
            P_ch=np.nan,
            MR=np.nan,
            injector_dp_F=np.nan,
            injector_dp_O=np.nan,
        )
        
        constraints = constraint_values(x, eng_est, self.config)
        
        # MR constraints should be infinite (violation)
        self.assertTrue(np.isinf(constraints["MR_min"]))
        self.assertTrue(np.isinf(constraints["MR_max"]))
        
        # Injector stiffness should be infinite (violation)
        self.assertTrue(np.isinf(constraints["injector_stiffness_F"]))
        self.assertTrue(np.isinf(constraints["injector_stiffness_O"]))
        
        self.assertFalse(is_safe(x, eng_est, self.config))
    
    def test_constraint_summary(self):
        """Test constraint summary generation."""
        # Safe case
        x = self.create_state()
        eng_est = self.create_estimate()
        
        constraints = constraint_values(x, eng_est, self.config)
        summary = get_constraint_summary(constraints)
        
        self.assertTrue(summary["safe"])
        self.assertEqual(len(summary["violations"]), 0)
        self.assertIn("margins", summary)
        self.assertIn("headroom_flags", summary)
        self.assertFalse(summary["headroom_flags"]["insufficient_F"])
        self.assertFalse(summary["headroom_flags"]["insufficient_O"])
        
        # Violation case
        x = self.create_state(**{IDX_P_COPV: 0.5e6})
        constraints = constraint_values(x, eng_est, self.config)
        summary = get_constraint_summary(constraints)
        
        self.assertFalse(summary["safe"])
        self.assertIn("copv_min", summary["violations"])
    
    def test_edge_cases(self):
        """Test edge cases (boundary conditions)."""
        # Exactly at COPV minimum
        x = self.create_state(**{IDX_P_COPV: 1e6})  # Exactly at minimum
        eng_est = self.create_estimate()
        constraints = constraint_values(x, eng_est, self.config)
        self.assertAlmostEqual(constraints["copv_min"], 0.0, places=3)
        self.assertAlmostEqual(constraints["copv_margin"], 0.0, places=3)
        self.assertTrue(is_safe(x, eng_est, self.config))  # Boundary is safe
        
        # Exactly at ullage maximum
        x = self.create_state(**{IDX_P_U_F: 10e6})  # Exactly at maximum
        constraints = constraint_values(x, eng_est, self.config)
        self.assertAlmostEqual(constraints["ullage_max_F"], 0.0, places=3)
        self.assertAlmostEqual(constraints["ullage_margin_F"], 0.0, places=3)
        self.assertTrue(is_safe(x, eng_est, self.config))  # Boundary is safe
        
        # Exactly at MR bounds
        eng_est = self.create_estimate(MR=1.5)  # Exactly at minimum
        constraints = constraint_values(x, eng_est, self.config)
        self.assertAlmostEqual(constraints["MR_min"], 0.0, places=3)
        self.assertAlmostEqual(constraints["MR_margin_low"], 0.0, places=3)
        self.assertTrue(is_safe(x, eng_est, self.config))
        
        eng_est = self.create_estimate(MR=3.0)  # Exactly at maximum
        constraints = constraint_values(x, eng_est, self.config)
        self.assertAlmostEqual(constraints["MR_max"], 0.0, places=3)
        self.assertAlmostEqual(constraints["MR_margin_high"], 0.0, places=3)
        self.assertTrue(is_safe(x, eng_est, self.config))
        
        # Exactly at headroom minimum
        x = self.create_state(
            **{IDX_P_REG: 3.05e6, IDX_P_U_F: 3e6}
        )  # Headroom = 0.05 MPa (exactly at minimum)
        constraints = constraint_values(x, eng_est, self.config)
        self.assertAlmostEqual(constraints["headroom_margin_F"], 0.0, places=3)
        self.assertEqual(constraints["headroom_insufficient_F"], 0.0)  # Sufficient (>=)


if __name__ == '__main__':
    unittest.main()

