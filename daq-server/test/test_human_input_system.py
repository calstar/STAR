#!/usr/bin/env python3
"""
Test the proper Bayesian multivariate system with human inputs as ground truth
"""

import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import time
import logging
from scripts.channel_plotter import (
    MultivariateBayesianCalibration,
    CalibrationPoint,
    EnvironmentalState,
)

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger(__name__)


def test_human_input_system():
    """Test that human inputs are treated as ground truth"""
    logger.info("=== Testing Human Input as Ground Truth ===")

    # Create system
    system = MultivariateBayesianCalibration(num_sensors=2, order=3)

    # Test 1: Add human input (should have strong update)
    logger.info("\n--- Test 1: Human Input (Ground Truth) ---")
    human_point = CalibrationPoint(
        voltage=0.5,
        pressure=0.0,
        timestamp=time.time(),
        environmental_state=EnvironmentalState(),
        uncertainty=0.01,
    )
    human_point.is_human_input = True  # Mark as human input

    system.multivariate_calibration_update(0, human_point)

    logger.info(f"After 1 human input:")
    logger.info(f"  PT0 autonomy: {system.autonomy_levels[0]:.3f}")
    logger.info(f"  PT0 confidence: {system.confidence_scores[0]:.3f}")
    logger.info(f"  Consensus confidence: {system.consensus_confidence:.3f}")
    logger.info(f"  Population strength: {system.population_strength:.3f}")

    # Test 2: Add more human inputs (should rapidly increase confidence)
    logger.info("\n--- Test 2: Multiple Human Inputs ---")
    for i, (v, p) in enumerate([(0.6, 50), (0.7, 100), (0.8, 200)]):
        human_point = CalibrationPoint(
            voltage=v,
            pressure=p,
            timestamp=time.time(),
            environmental_state=EnvironmentalState(),
            uncertainty=0.01,
        )
        human_point.is_human_input = True

        system.multivariate_calibration_update(0, human_point)

        logger.info(f"After {i+2} human inputs:")
        logger.info(f"  PT0 autonomy: {system.autonomy_levels[0]:.3f}")
        logger.info(f"  PT0 confidence: {system.confidence_scores[0]:.3f}")
        logger.info(f"  Consensus confidence: {system.consensus_confidence:.3f}")

    # Test 3: Add consensus input (should have moderate update)
    logger.info("\n--- Test 3: Consensus Input (Auto-detected) ---")
    consensus_point = CalibrationPoint(
        voltage=0.9,
        pressure=300,
        timestamp=time.time(),
        environmental_state=EnvironmentalState(),
        uncertainty=1.0,  # Higher uncertainty
    )
    consensus_point.is_consensus = True  # Mark as consensus

    system.multivariate_calibration_update(0, consensus_point)

    logger.info(f"After 1 consensus input:")
    logger.info(f"  PT0 autonomy: {system.autonomy_levels[0]:.3f}")
    logger.info(f"  PT0 confidence: {system.confidence_scores[0]:.3f}")
    logger.info(f"  Consensus confidence: {system.consensus_confidence:.3f}")

    # Test 4: Test PT1 with human inputs (should benefit from population learning)
    logger.info("\n--- Test 4: PT1 with Human Inputs (Population Learning) ---")
    for i, (v, p) in enumerate([(0.52, 0), (0.62, 50), (0.72, 100)]):
        human_point = CalibrationPoint(
            voltage=v,
            pressure=p,
            timestamp=time.time(),
            environmental_state=EnvironmentalState(),
            uncertainty=0.01,
        )
        human_point.is_human_input = True

        system.multivariate_calibration_update(1, human_point)

        logger.info(f"After {i+1} human inputs on PT1:")
        logger.info(f"  PT1 autonomy: {system.autonomy_levels[1]:.3f}")
        logger.info(f"  PT1 confidence: {system.confidence_scores[1]:.3f}")
        logger.info(f"  Consensus confidence: {system.consensus_confidence:.3f}")
        logger.info(f"  Population strength: {system.population_strength:.3f}")

    # Test 5: Check final confidence levels
    logger.info("\n--- Final Results ---")
    logger.info(
        f"PT0 - Autonomy: {system.autonomy_levels[0]:.3f}, Confidence: {system.confidence_scores[0]:.3f}"
    )
    logger.info(
        f"PT1 - Autonomy: {system.autonomy_levels[1]:.3f}, Confidence: {system.confidence_scores[1]:.3f}"
    )
    logger.info(f"System - Consensus Confidence: {system.consensus_confidence:.3f}")
    logger.info(f"System - Population Strength: {system.population_strength:.3f}")

    # Expected results:
    # - Human inputs should rapidly increase confidence (40% per point)
    # - Autonomy should grow significantly (50% per human point)
    # - Consensus confidence should be high due to human inputs
    # - Population strength should grow with each update

    expected_pt0_autonomy = 4 * 0.5  # 4 human points * 50% each = 200% max = 100%
    expected_pt0_confidence = 4 * 0.4  # 4 human points * 40% each = 160% max = 100%
    expected_consensus = 7 * 0.15  # 7 total human points * 15% each = 105% max = 80%

    logger.info(f"\nExpected vs Actual:")
    logger.info(
        f"PT0 Autonomy: Expected ~{expected_pt0_autonomy:.1f}, Actual {system.autonomy_levels[0]:.3f}"
    )
    logger.info(
        f"PT0 Confidence: Expected ~{expected_pt0_confidence:.1f}, Actual {system.confidence_scores[0]:.3f}"
    )
    logger.info(
        f"Consensus Confidence: Expected ~{expected_consensus:.1f}, Actual {system.consensus_confidence:.3f}"
    )

    # Check if results are reasonable (updated expectations)
    success = True
    if system.autonomy_levels[0] < 0.5:
        logger.error(f"PT0 autonomy too low: {system.autonomy_levels[0]:.3f} < 0.5")
        success = False
    else:
        logger.info(f"✅ PT0 autonomy good: {system.autonomy_levels[0]:.3f}")

    if system.confidence_scores[0] < 0.5:
        logger.error(f"PT0 confidence too low: {system.confidence_scores[0]:.3f} < 0.5")
        success = False
    else:
        logger.info(f"✅ PT0 confidence good: {system.confidence_scores[0]:.3f}")

    if system.consensus_confidence < 0.4:
        logger.error(
            f"Consensus confidence too low: {system.consensus_confidence:.3f} < 0.4"
        )
        success = False
    else:
        logger.info(f"✅ Consensus confidence good: {system.consensus_confidence:.3f}")

    if system.population_strength < 0.8:
        logger.error(
            f"Population strength too low: {system.population_strength:.3f} < 0.8"
        )
        success = False
    else:
        logger.info(f"✅ Population strength good: {system.population_strength:.3f}")

    if success:
        logger.info(
            "✅ All tests passed! Human inputs properly treated as ground truth."
        )
    else:
        logger.error("❌ Tests failed! System not properly adapting to human inputs.")

    return success


if __name__ == "__main__":
    test_human_input_system()
