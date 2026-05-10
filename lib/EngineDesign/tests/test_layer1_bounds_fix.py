"""Test to verify Layer 1 optimizer bounds are correct after bug fix."""

import sys


def test_layer1_config_bounds_validation():
    """Verify Layer1OptimizerConfig validates bounds correctly."""
    from engine.optimizer.layers.layer1_static_optimization import Layer1OptimizerConfig
    
    # Should succeed with default (now correct) bounds
    config = Layer1OptimizerConfig()
    
    # Verify bounds are in correct order
    assert config.min_d_pintle_m < config.max_d_pintle_m, \
        f"Pintle bounds swapped: min={config.min_d_pintle_m} >= max={config.max_d_pintle_m}"
    
    assert config.min_d_orifice_m < config.max_d_orifice_m, \
        f"Orifice bounds swapped: min={config.min_d_orifice_m} >= max={config.max_d_orifice_m}"
    
    assert config.min_h_gap_m < config.max_h_gap_m, \
        f"Gap bounds swapped: min={config.min_h_gap_m} >= max={config.max_h_gap_m}"
    
    assert config.min_n_orifices <= config.max_n_orifices, \
        f"Orifice count bounds swapped: min={config.min_n_orifices} > max={config.max_n_orifices}"
    
    # Verify reasonable physical values
    assert 0.020 <= config.min_d_pintle_m <= 0.030, \
        f"Min pintle diameter should be ~25mm, got {config.min_d_pintle_m*1000:.1f}mm"
    assert 0.070 <= config.max_d_pintle_m <= 0.090, \
        f"Max pintle diameter should be ~80mm, got {config.max_d_pintle_m*1000:.1f}mm"
    
    print("✓ All bounds are correctly ordered")
    print(f"  Pintle diameter: {config.min_d_pintle_m*1000:.1f}mm to {config.max_d_pintle_m*1000:.1f}mm")
    print(f"  Orifice diameter: {config.min_d_orifice_m*1000:.1f}mm to {config.max_d_orifice_m*1000:.1f}mm")
    print(f"  Gap height: {config.min_h_gap_m*1000:.1f}mm to {config.max_h_gap_m*1000:.1f}mm")
    print(f"  Orifice count: {config.min_n_orifices} to {config.max_n_orifices}")


def test_layer1_config_validation_catches_swapped_bounds():
    """Verify __post_init__ validation catches swapped bounds."""
    from engine.optimizer.layers.layer1_static_optimization import Layer1OptimizerConfig
    
    # Try to create config with swapped values (should raise ValueError)
    try:
        bad_config = Layer1OptimizerConfig(
            min_d_pintle_m=0.080,  # Wrong: min > max
            max_d_pintle_m=0.025,  # Wrong: max < min
        )
        # If we get here, validation didn't work
        assert False, "Validation should have raised ValueError for swapped bounds"
    except ValueError as e:
        if "Pintle diameter bounds are swapped" in str(e):
            print("✓ Validation correctly catches swapped pintle bounds")
        else:
            raise
    
    print("✓ Validation correctly catches swapped pintle bounds")


def test_bounds_array_generation():
    """Verify bounds array used by optimizer has correct order."""
    from engine.optimizer.layers.layer1_static_optimization import Layer1OptimizerConfig
    
    config = Layer1OptimizerConfig()
    
    # Simulate bounds array generation from line 912-923
    bounds = [
        (1e-5, 3.0e-3),  # A_throat (placeholder)
        (0.95, 1.27),    # Lstar
        (6.0, 12.0),     # expansion_ratio
        (0.05, 0.15),    # outer diameter (placeholder)
        (config.min_d_pintle_m, config.max_d_pintle_m),  # d_pintle_tip
        (config.min_h_gap_m, config.max_h_gap_m),        # h_gap
        (config.min_n_orifices, config.max_n_orifices),  # n_orifices
        (config.min_d_orifice_m, config.max_d_orifice_m), # d_orifice
        (200, 600),      # P_O_start_psi (placeholder)
        (200, 800),      # P_F_start_psi (placeholder)
    ]
    
    # Verify all bounds have lower < upper
    for i, (lower, upper) in enumerate(bounds):
        assert lower <= upper, \
            f"Bound {i} has lower ({lower}) > upper ({upper})"
        
        # Calculate span
        span = upper - lower
        assert span >= 0, f"Bound {i} has negative span: {span}"
    
    # Specifically check pintle bounds (index 4)
    pintle_lower, pintle_upper = bounds[4]
    assert pintle_lower == 0.025, f"Pintle lower bound should be 0.025, got {pintle_lower}"
    assert pintle_upper == 0.080, f"Pintle upper bound should be 0.080, got {pintle_upper}"
    
    print("✓ Bounds array is correctly ordered")
    print(f"  Pintle bounds [4]: [{pintle_lower*1000:.1f}mm, {pintle_upper*1000:.1f}mm] (span: {(pintle_upper-pintle_lower)*1000:.1f}mm)")


if __name__ == "__main__":
    print("="*70)
    print("Testing Layer 1 Optimizer Bounds Fix")
    print("="*70)
    print()
    
    test_layer1_config_bounds_validation()
    print()
    
    test_layer1_config_validation_catches_swapped_bounds()
    print()
    
    test_bounds_array_generation()
    print()
    
    print("="*70)
    print("All tests passed! ✓")
    print("="*70)
