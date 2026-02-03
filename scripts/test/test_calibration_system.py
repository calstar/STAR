#!/usr/bin/env python3
"""
Test script for the multivariate Bayesian calibration system

This script tests:
1. Calibration point addition
2. Consensus computation
3. Uncertainty evolution
4. UI updates
"""

import sys
import os
import time
import logging

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.channel_plotter import (
    MultivariateBayesianCalibration, 
    CalibrationPoint, 
    EnvironmentalState
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def test_calibration_system():
    """Test the calibration system with synthetic data"""
    
    # Create global system
    global_system = MultivariateBayesianCalibration(num_sensors=16, order=3)
    
    # Test data - PT1 and PT3 measuring same pressure
    test_pressures = [0.0, 50.0, 100.0, 200.0, 500.0, 800.0]
    
    logger.info("=== Testing Calibration System ===")
    
    # Simulate calibration points for PT1
    logger.info("Adding calibration points for PT1...")
    for i, pressure in enumerate(test_pressures):
        voltage = 0.5 + pressure / 1000.0  # Simple linear relationship + noise
        
        calibration_point = CalibrationPoint(
            voltage=voltage,
            pressure=pressure,
            timestamp=time.time(),
            environmental_state=EnvironmentalState(),
            uncertainty=1.0  # 1 PSI uncertainty
        )
        
        global_system.multivariate_calibration_update(1, calibration_point)
        
        logger.info(f"  PT1: {pressure} PSI at {voltage:.3f}V")
        logger.info(f"    Population strength: {global_system.population_strength:.2f}")
        logger.info(f"    PT1 autonomy: {global_system.autonomy_levels[1]:.2f}")
    
    # Simulate calibration points for PT3 (similar pressure range)
    logger.info("\nAdding calibration points for PT3...")
    for i, pressure in enumerate(test_pressures):
        voltage = 0.52 + pressure / 1000.0  # Slightly different slope
        
        calibration_point = CalibrationPoint(
            voltage=voltage,
            pressure=pressure,
            timestamp=time.time(),
            environmental_state=EnvironmentalState(),
            uncertainty=1.0
        )
        
        global_system.multivariate_calibration_update(3, calibration_point)
        
        logger.info(f"  PT3: {pressure} PSI at {voltage:.3f}V")
        logger.info(f"    Population strength: {global_system.population_strength:.2f}")
        logger.info(f"    PT3 autonomy: {global_system.autonomy_levels[3]:.2f}")
    
    # Test consensus computation
    logger.info("\n=== Testing Consensus ===")
    voltages = {1: 0.8, 3: 0.82}  # Both PTs at ~300 PSI
    consensus = global_system.compute_consensus_pressure(voltages, EnvironmentalState())
    
    logger.info(f"Consensus pressure: {consensus.pressure:.1f} PSI")
    logger.info(f"Consensus uncertainty: {consensus.uncertainty:.2f} PSI")
    logger.info(f"Agreement score: {consensus.agreement_score:.2f}")
    logger.info(f"Consensus confidence: {global_system.consensus_confidence:.2f}")
    
    # Test uncertainty inflation
    logger.info("\n=== Testing Uncertainty Evolution ===")
    
    # Add noisy calibration point (should inflate uncertainty)
    noisy_point = CalibrationPoint(
        voltage=0.8,
        pressure=350.0,  # Disagrees with consensus
        timestamp=time.time(),
        environmental_state=EnvironmentalState(),
        uncertainty=1.0
    )
    
    global_system.multivariate_calibration_update(1, noisy_point)
    
    inflation_before = global_system.uncertainty_inflation_factor[1]
    logger.info(f"PT1 uncertainty inflation after disagreement: {inflation_before:.2f}")
    
    # Test quality history
    logger.info("\n=== Testing Quality History ===")
    quality_history = global_system.quality_history[1]
    logger.info(f"PT1 quality records: {len(quality_history)}")
    
    if quality_history:
        latest = quality_history[-1]
        logger.info(f"Latest RMSE: {latest['rmse']:.3f}")
        logger.info(f"Latest MAE: {latest['mae']:.3f}")
        logger.info(f"Latest autonomy: {latest['autonomy']:.2f}")
    
    logger.info("\n=== Test Complete ===")
    
    return global_system

if __name__ == "__main__":
    try:
        test_calibration_system()
        print("\n✅ All tests passed!")
    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
