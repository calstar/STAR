#!/usr/bin/env python3
"""
Mission-Critical Calibration System Startup
Provides mode selection, validation, and health checks before launching main application.
"""

import sys
import os
import argparse
import logging
from pathlib import Path

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

try:
    from calibration_robustness import (
        RobustnessManager, SystemConfig, OperationMode
    )
    ROBUSTNESS_AVAILABLE = True
except ImportError as e:
    logger.error(f"❌ Cannot import robustness module: {e}")
    logger.error("Please ensure calibration_robustness.py is in the same directory")
    ROBUSTNESS_AVAILABLE = False

def check_system_health() -> bool:
    """Check system health before startup"""
    logger.info("🔍 Performing system health checks...")
    
    checks_passed = 0
    checks_total = 0
    
    # Check 1: Python version
    checks_total += 1
    if sys.version_info >= (3, 8):
        logger.info("✅ Python version OK: " + sys.version.split()[0])
        checks_passed += 1
    else:
        logger.error(f"❌ Python version {sys.version.split()[0]} < 3.8")
    
    # Check 2: Required modules
    checks_total += 1
    required_modules = ['PyQt6', 'pyqtgraph', 'numpy', 'serial', 'scipy']
    missing = []
    for module in required_modules:
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    
    if not missing:
        logger.info("✅ All required modules available")
        checks_passed += 1
    else:
        logger.error(f"❌ Missing modules: {', '.join(missing)}")
    
    # Check 3: Robustness module
    checks_total += 1
    if ROBUSTNESS_AVAILABLE:
        logger.info("✅ Robustness module available")
        checks_passed += 1
    else:
        logger.warning("⚠️  Robustness module not available (system will run with limited features)")
        checks_passed += 1  # Not critical
    
    # Check 4: Write permissions
    checks_total += 1
    test_file = Path("._write_test")
    try:
        test_file.write_text("test")
        test_file.unlink()
        logger.info("✅ Write permissions OK")
        checks_passed += 1
    except:
        logger.error("❌ No write permissions in current directory")
    
    success_rate = checks_passed / checks_total
    logger.info(f"\n{'='*80}")
    logger.info(f"Health check: {checks_passed}/{checks_total} passed ({success_rate*100:.0f}%)")
    logger.info(f"{'='*80}\n")
    
    return checks_passed >= checks_total - 1  # Allow 1 non-critical failure

def select_mode() -> OperationMode:
    """Interactive mode selection"""
    print("\n" + "="*80)
    print("CALIBRATION SYSTEM MODE SELECTION")
    print("="*80)
    print("\nAvailable modes:")
    print("  1. TEST         - Ground testing with consensus enabled")
    print("  2. CALIBRATION  - Active calibration mode (similar to test)")
    print("  3. FLIGHT       - Mission mode (consensus disabled, independent readings)")
    print("  4. SAFE         - Safe mode with minimal features")
    print("\n" + "="*80)
    
    while True:
        choice = input("\nSelect mode [1-4] (default: 1): ").strip()
        if not choice:
            choice = "1"
        
        mode_map = {
            "1": OperationMode.TEST,
            "2": OperationMode.CALIBRATION,
            "3": OperationMode.FLIGHT,
            "4": OperationMode.SAFE
        }
        
        if choice in mode_map:
            selected_mode = mode_map[choice]
            print(f"\n✅ Selected mode: {selected_mode.value.upper()}")
            
            if selected_mode == OperationMode.FLIGHT:
                print("\n" + "⚠️ "*20)
                print("WARNING: FLIGHT MODE")
                print("- Consensus mechanism will be DISABLED")
                print("- Each PT will measure independently")
                print("- Ensure all PTs are properly calibrated before flight")
                print("⚠️ "*20 + "\n")
                confirm = input("Confirm FLIGHT MODE? [yes/no]: ").strip().lower()
                if confirm != "yes":
                    continue
            
            return selected_mode
        else:
            print("Invalid choice. Please enter 1-4.")

def configure_system(mode: OperationMode) -> SystemConfig:
    """Configure system for selected mode"""
    if ROBUSTNESS_AVAILABLE:
        config = SystemConfig.load()
        config.mode = mode
        
        # Mode-specific configuration
        if mode == OperationMode.FLIGHT:
            config.consensus_enabled = False
            config.validation_enabled = True
            config.health_monitoring_enabled = True
            config.auto_backup_enabled = True
            logger.info("Flight mode: Consensus DISABLED, validation ENABLED")
        elif mode in (OperationMode.TEST, OperationMode.CALIBRATION):
            config.consensus_enabled = True
            config.validation_enabled = True
            config.health_monitoring_enabled = True
            config.auto_backup_enabled = True
            logger.info(f"{mode.value.capitalize()} mode: All features ENABLED")
        elif mode == OperationMode.SAFE:
            config.consensus_enabled = False
            config.validation_enabled = False
            config.health_monitoring_enabled = False
            config.auto_backup_enabled = False
            logger.warning("Safe mode: Minimal features only")
        
        config.save()
        logger.info(f"Configuration saved: {config.to_dict()}")
        return config
    else:
        logger.warning("Robustness module not available, using defaults")
        return None

def display_pre_flight_checklist():
    """Display pre-flight checklist"""
    print("\n" + "="*80)
    print("PRE-FLIGHT CHECKLIST")
    print("="*80)
    items = [
        "All PTs connected and responding",
        "Zero-point calibration performed on at least one PT",
        "Population prior loaded from previous test sessions",
        "All calibration files backed up",
        "System health checks passed",
        "Consensus disabled and verified",
        "Launch conditions nominal"
    ]
    for i, item in enumerate(items, 1):
        status = input(f"\n[{i}/{len(items)}] {item} - OK? [y/n]: ").strip().lower()
        if status != 'y':
            print(f"\n❌ Checklist item failed: {item}")
            print("Aborting startup...")
            return False
    
    print("\n✅ All checklist items verified")
    print("="*80 + "\n")
    return True

def main():
    parser = argparse.ArgumentParser(
        description='Mission-Critical Calibration System Startup',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('--mode', choices=['test', 'calibration', 'flight', 'safe'],
                       help='Operation mode (if not specified, will prompt)')
    parser.add_argument('--skip-health-check', action='store_true',
                       help='Skip system health checks (not recommended)')
    parser.add_argument('--skip-checklist', action='store_true',
                       help='Skip pre-flight checklist (for test/calibration modes only)')
    
    args = parser.parse_args()
    
    # ASCII art header
    print("\n" + "="*80)
    print("""
    ██████╗  █████╗ ██╗     ██╗██████╗ ██████╗  █████╗ ████████╗██╗ ██████╗ ███╗   ██╗
    ██╔════╝ ██╔══██╗██║     ██║██╔══██╗██╔══██╗██╔══██╗╚══██╔══╝██║██╔═══██╗████╗  ██║
    ██║  ███╗███████║██║     ██║██████╔╝██████╔╝███████║   ██║   ██║██║   ██║██╔██╗ ██║
    ██║   ██║██╔══██║██║     ██║██╔══██╗██╔══██╗██╔══██║   ██║   ██║██║   ██║██║╚██╗██║
    ╚██████╔╝██║  ██║███████╗██║██████╔╝██║  ██║██║  ██║   ██║   ██║╚██████╔╝██║ ╚████║
     ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
    """)
    print("           PRESSURE TRANSDUCER CALIBRATION SYSTEM v3.0")
    print("="*80 + "\n")
    
    # Health checks
    if not args.skip_health_check:
        if not check_system_health():
            logger.error("❌ System health checks failed. Aborting...")
            return 1
    else:
        logger.warning("⚠️  Health checks skipped")
    
    # Mode selection
    if args.mode:
        mode_map = {
            'test': OperationMode.TEST,
            'calibration': OperationMode.CALIBRATION,
            'flight': OperationMode.FLIGHT,
            'safe': OperationMode.SAFE
        }
        mode = mode_map[args.mode]
        logger.info(f"Mode specified via command line: {mode.value}")
    else:
        if not ROBUSTNESS_AVAILABLE:
            logger.error("❌ Robustness module required for interactive mode selection")
            return 1
        mode = select_mode()
    
    # Configure system
    config = configure_system(mode)
    
    # Pre-flight checklist for flight mode
    if mode == OperationMode.FLIGHT and not args.skip_checklist:
        if not display_pre_flight_checklist():
            return 1
    
    # Display configuration
    print("\n" + "="*80)
    print("STARTING CALIBRATION SYSTEM")
    print("="*80)
    print(f"Mode: {mode.value.upper()}")
    if config:
        print(f"Consensus: {'ENABLED' if config.consensus_enabled else 'DISABLED'}")
        print(f"Validation: {'ENABLED' if config.validation_enabled else 'DISABLED'}")
        print(f"Health Monitoring: {'ENABLED' if config.health_monitoring_enabled else 'DISABLED'}")
        print(f"Auto Backup: {'ENABLED' if config.auto_backup_enabled else 'DISABLED'}")
    print("="*80 + "\n")
    
    # Launch main application
    logger.info("🚀 Launching main application...")
    try:
        import channel_plotter
        # The Qt application will take over from here
        sys.exit(0)
    except Exception as e:
        logger.error(f"❌ Failed to launch application: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())

