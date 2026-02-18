#!/usr/bin/env python3
"""
Mission-Critical Calibration System Startup
Provides mode selection, validation, and health checks before launching
calibration tools for PT, TC, RTD, and LC sensors.

Usage:
  # Interactive mode selection
  python3 start_calibration_system.py

  # Launch specific autonomous calibration tool directly
  python3 start_calibration_system.py --tool autonomous_pt_calibration --udp-port 5006 --board-ip 192.168.2.101
  python3 start_calibration_system.py --tool autonomous_tc_calibration --udp-port 5006 --board-ip 192.168.2.103 -i
  python3 start_calibration_system.py --tool autonomous_rtd_calibration --udp-port 5006 --board-ip 192.168.2.104 -i
  python3 start_calibration_system.py --tool autonomous_lc_calibration  --udp-port 5006 --board-ip 192.168.2.105 -i

  # Launch calibration GUI
  python3 start_calibration_system.py --tool pt_calibration_gui --mode calibration
"""

import sys
import os
import argparse
import logging
import subprocess
from pathlib import Path

# Setup logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# ── Config loader (single source of truth) ────────────────────────────────
try:
    from config_loader import (
        load_config,
        get_board_by_type,
        get_sensor_port,
        get_boards,
        print_config_summary,
    )

    _cfg_loaded = True
except ImportError:
    _cfg_loaded = False

# Try to import robustness module (optional)
ROBUSTNESS_AVAILABLE = False
OperationMode = None
SystemConfig = None
try:
    from calibration_robustness import (
        RobustnessManager,
        SystemConfig as _SC,
        OperationMode as _OM,
    )

    ROBUSTNESS_AVAILABLE = True
    OperationMode = _OM
    SystemConfig = _SC
except ImportError:
    logger.warning("⚠️  Robustness module not available (non-critical)")

# Calibration directory (where this script lives)
CALIBRATION_DIR = Path(__file__).parent.resolve()


def _board_ip_for(sensor_type: str) -> str:
    """Get default board IP for a sensor type from config, with hardcoded fallbacks."""
    fallbacks = {
        "PT": "192.168.2.101",
        "LC": "192.168.2.102",
        "TC": "192.168.2.103",
        "RTD": "192.168.2.104",
    }
    if _cfg_loaded:
        b = get_board_by_type(sensor_type)
        if b:
            return b.get("ip", fallbacks.get(sensor_type, ""))
    return fallbacks.get(sensor_type, "")


def _default_udp_port() -> int:
    if _cfg_loaded:
        return get_sensor_port()
    return 5006


# ── Available calibration tools ────────────────────────────────────────────
TOOL_REGISTRY = {
    # ── ORCHESTRATOR (recommended) ──
    "orchestrator": {
        "script": "calibration_orchestrator.py",
        "description": "Unified calibration lifecycle — Phase 1 (cal) + Phase 2 (monitor)",
        "sensor_type": "ALL",
        "gui": False,
    },
    "orchestrator_monitor": {
        "script": "calibration_orchestrator.py",
        "description": "Self-recalibration monitor only (loads existing cal, skips Phase 1)",
        "sensor_type": "ALL",
        "gui": False,
        "extra_args": ["--skip-phase1"],
    },
    # ── PT (Pressure Transducer) ──
    "pt_calibration_gui": {
        "script": "pt_calibration_gui.py",
        "description": "Interactive PT calibration GUI (PyQt6)",
        "sensor_type": "PT",
        "gui": True,
    },
    "robust_pt_calibration_gui": {
        "script": "robust_pt_calibration_gui.py",
        "description": "Robust PT calibration GUI with consensus",
        "sensor_type": "PT",
        "gui": True,
    },
    "autonomous_pt_calibration": {
        "script": "autonomous_pt_calibration.py",
        "description": "Autonomous PT calibration via UDP (no GUI)",
        "sensor_type": "PT",
        "gui": False,
    },
    # ── TC (Thermocouple) ──
    "autonomous_tc_calibration": {
        "script": "autonomous_tc_calibration.py",
        "description": "Autonomous TC calibration via UDP (no GUI)",
        "sensor_type": "TC",
        "gui": False,
    },
    # ── RTD (Resistance Temperature Detector) ──
    "autonomous_rtd_calibration": {
        "script": "autonomous_rtd_calibration.py",
        "description": "Autonomous RTD calibration via UDP (no GUI)",
        "sensor_type": "RTD",
        "gui": False,
    },
    # ── LC (Load Cell) ──
    "autonomous_lc_calibration": {
        "script": "autonomous_lc_calibration.py",
        "description": "Autonomous LC calibration via UDP (no GUI)",
        "sensor_type": "LC",
        "gui": False,
    },
    # ── IMU ──
    "imu_calibration_gui": {
        "script": "imu_calibration_gui.py",
        "description": "IMU calibration GUI",
        "sensor_type": "IMU",
        "gui": True,
    },
}


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
    required_modules = ["numpy"]
    optional_modules = ["PyQt6", "pyqtgraph", "serial", "scipy"]
    missing_required = []
    missing_optional = []

    for module in required_modules:
        try:
            __import__(module)
        except ImportError:
            missing_required.append(module)

    for module in optional_modules:
        try:
            __import__(module)
        except ImportError:
            missing_optional.append(module)

    if not missing_required:
        logger.info("✅ All required modules available")
        if missing_optional:
            logger.warning(
                f"⚠️  Optional modules missing: {', '.join(missing_optional)}"
            )
        checks_passed += 1
    else:
        logger.error(f"❌ Missing required modules: {', '.join(missing_required)}")

    # Check 3: Write permissions for calibration directory
    checks_total += 1
    calib_dir = CALIBRATION_DIR / "calibrations"
    calib_dir.mkdir(parents=True, exist_ok=True)
    test_file = calib_dir / "._write_test"
    try:
        test_file.write_text("test")
        test_file.unlink()
        logger.info("✅ Calibration directory write permissions OK")
        checks_passed += 1
    except Exception:
        logger.error(f"❌ No write permissions in calibration directory: {calib_dir}")

    # Check 4: Network socket availability (for UDP-based calibration)
    checks_total += 1
    try:
        import socket

        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.close()
        logger.info("✅ UDP socket creation OK")
        checks_passed += 1
    except Exception as e:
        logger.error(f"❌ UDP socket test failed: {e}")

    success_rate = checks_passed / checks_total if checks_total > 0 else 0
    logger.info(f"\n{'='*80}")
    logger.info(
        f"Health check: {checks_passed}/{checks_total} passed ({success_rate*100:.0f}%)"
    )
    logger.info(f"{'='*80}\n")

    return checks_passed >= checks_total - 1  # Allow 1 non-critical failure


def list_available_tools():
    """List all available calibration tools and their status."""
    print("\n" + "=" * 80)
    print("AVAILABLE CALIBRATION TOOLS")
    print("=" * 80)

    by_type = {}
    for name, info in TOOL_REGISTRY.items():
        by_type.setdefault(info["sensor_type"], []).append((name, info))

    for sensor_type in ["ALL", "PT", "TC", "RTD", "LC", "IMU"]:
        tools = by_type.get(sensor_type, [])
        if not tools:
            continue
        print(f"\n  ── {sensor_type} ──")
        for name, info in tools:
            script_path = CALIBRATION_DIR / info["script"]
            exists = "✅" if script_path.exists() else "❌"
            kind = "GUI" if info.get("gui") else "CLI"
            print(f"    {exists} {name:<35s} [{kind}]  {info['description']}")

    print("\n" + "=" * 80)


def select_tool_interactive() -> str:
    """Interactive tool selection."""
    list_available_tools()

    tools_list = list(TOOL_REGISTRY.keys())
    print("\nEnter tool number or name:")
    for i, name in enumerate(tools_list, 1):
        info = TOOL_REGISTRY[name]
        print(f"  {i:>2d}. {name} ({info['sensor_type']})")

    while True:
        choice = input("\nSelect tool [1-{}]: ".format(len(tools_list))).strip()
        if not choice:
            continue
        # Try as number
        try:
            idx = int(choice) - 1
            if 0 <= idx < len(tools_list):
                return tools_list[idx]
        except ValueError:
            pass
        # Try as name
        if choice in TOOL_REGISTRY:
            return choice
        print(f"  ⚠️  Invalid choice: {choice}")


def build_tool_command(tool_name: str, args) -> list:
    """Build subprocess command for the selected tool."""
    info = TOOL_REGISTRY[tool_name]
    script_path = CALIBRATION_DIR / info["script"]
    cmd = [sys.executable, str(script_path.resolve())]

    # Extra args baked into the registry entry (e.g. --skip-phase1)
    if info.get("extra_args"):
        cmd.extend(info["extra_args"])

    # For autonomous / CLI calibration tools, pass UDP arguments
    if not info.get("gui"):
        # Orchestrator doesn't take --board-ip (it reads config directly)
        is_orchestrator = "orchestrator" in info.get("script", "")

        if args.udp_port and not is_orchestrator:
            cmd.extend(["--port", str(args.udp_port)])
        if is_orchestrator and args.udp_port:
            cmd.extend(["--port", str(args.udp_port)])

        if not is_orchestrator:
            if args.board_ip:
                cmd.extend(["--board-ip", args.board_ip])
            else:
                default_ip = _board_ip_for(info["sensor_type"])
                if default_ip:
                    cmd.extend(["--board-ip", default_ip])

        if args.ref_all is not None and not is_orchestrator:
            cmd.extend(["--ref-all", str(args.ref_all)])
        if args.collect_time and not is_orchestrator:
            cmd.extend(["--collect-time", str(args.collect_time)])
        if args.interactive_cal and not is_orchestrator:
            cmd.append("--interactive")

        # Pass through --sensor / --temp or --sensor / --force pairs
        if args.sensor and not is_orchestrator:
            for s in args.sensor:
                cmd.extend(["--sensor", str(s)])
        if args.ref_value and not is_orchestrator:
            flag = "--force" if info["sensor_type"] == "LC" else "--temp"
            for v in args.ref_value:
                cmd.extend([flag, str(v)])

        # For orchestrator, pass --sensors if user specified a type
        if is_orchestrator and info["sensor_type"] != "ALL":
            cmd.extend(["--sensors", info["sensor_type"]])

    return cmd


def main():
    parser = argparse.ArgumentParser(
        description="Mission-Critical Calibration System Startup",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Interactive menu
  python3 start_calibration_system.py

  # Launch autonomous PT calibration interactively
  python3 start_calibration_system.py --tool autonomous_pt_calibration -i

  # Collect TC calibration at 100°C for 15 seconds
  python3 start_calibration_system.py --tool autonomous_tc_calibration --ref-all 100.0 --collect-time 15

  # LC zero-cal
  python3 start_calibration_system.py --tool autonomous_lc_calibration --ref-all 0.0 --collect-time 10
""",
    )
    parser.add_argument(
        "--tool",
        choices=list(TOOL_REGISTRY.keys()),
        help="Calibration tool to launch",
    )
    parser.add_argument(
        "--mode",
        choices=["test", "calibration", "flight", "safe"],
        help="Operation mode (for GUI tools)",
    )
    parser.add_argument(
        "--skip-health-check",
        action="store_true",
        help="Skip system health checks",
    )
    # ── UDP / autonomous calibration arguments ──
    parser.add_argument(
        "--udp-port",
        type=int,
        default=_default_udp_port(),
        help=f"UDP port for board data (default: {_default_udp_port()} from config.toml)",
    )
    parser.add_argument(
        "--board-ip",
        default=None,
        help="Filter packets to this board IP (e.g. 192.168.2.101)",
    )
    parser.add_argument(
        "--ref-all",
        type=float,
        default=None,
        help="Set reference value for all channels (PSI / °C / lbs)",
    )
    parser.add_argument(
        "--collect-time",
        type=float,
        default=5.0,
        help="Collection duration in seconds (default: 5)",
    )
    parser.add_argument(
        "--sensor",
        type=int,
        action="append",
        help="Sensor channel (repeatable, paired with --ref-value)",
    )
    parser.add_argument(
        "--ref-value",
        type=float,
        action="append",
        help="Reference value per sensor (repeatable, paired with --sensor)",
    )
    parser.add_argument(
        "-i",
        "--interactive-cal",
        action="store_true",
        help="Run autonomous calibration in interactive CLI mode",
    )
    parser.add_argument(
        "--list-tools",
        action="store_true",
        help="List all available calibration tools and exit",
    )

    args = parser.parse_args()

    # ── Header ──
    print("\n" + "=" * 80)
    print(
        """
    ██████╗  █████╗ ██╗     ██╗██████╗ ██████╗  █████╗ ████████╗██╗ ██████╗ ███╗   ██╗
    ██╔════╝ ██╔══██╗██║     ██║██╔══██╗██╔══██╗██╔══██╗╚══██╔══╝██║██╔═══██╗████╗  ██║
    ██║  ███╗███████║██║     ██║██████╔╝██████╔╝███████║   ██║   ██║██║   ██║██╔██╗ ██║
    ██║   ██║██╔══██║██║     ██║██╔══██╗██╔══██╗██╔══██║   ██║   ██║██║   ██║██║╚██╗██║
    ╚██████╔╝██║  ██║███████╗██║██████╔╝██║  ██║██║  ██║   ██║   ██║╚██████╔╝██║ ╚████║
     ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
    """
    )
    print("           SENSOR CALIBRATION SYSTEM v5.0")
    print("           PT · TC · RTD · LC  |  UDP Pipeline")
    print("=" * 80 + "\n")

    if _cfg_loaded:
        print_config_summary()

    if args.list_tools:
        list_available_tools()
        return 0

    # ── Health check ──
    if not args.skip_health_check:
        if not check_system_health():
            logger.error(
                "❌ System health checks failed. Use --skip-health-check to override."
            )
            return 1
    else:
        logger.warning("⚠️  Health checks skipped")

    # ── Tool selection ──
    tool_name = args.tool
    if not tool_name:
        tool_name = select_tool_interactive()

    info = TOOL_REGISTRY[tool_name]
    script_path = CALIBRATION_DIR / info["script"]

    if not script_path.exists():
        logger.error(f"❌ Tool script not found: {script_path}")
        list_available_tools()
        return 1

    # ── Build command ──
    cmd = build_tool_command(tool_name, args)

    print(f"\n{'─'*80}")
    print(f"🚀 Launching: {tool_name}")
    print(f"   Script:  {script_path}")
    print(f"   Sensor:  {info['sensor_type']}")
    print(f"   Type:    {'GUI' if info.get('gui') else 'CLI / Autonomous'}")
    if not info.get("gui"):
        print(f"   UDP:     0.0.0.0:{args.udp_port}")
        board = args.board_ip or _board_ip_for(info["sensor_type"]) or "any"
        print(
            f"   Board:   {board}  (from {'CLI' if args.board_ip else 'config.toml'})"
        )
    print(f"   Cmd:     {' '.join(cmd)}")
    print(f"{'─'*80}\n")

    try:
        result = subprocess.run(cmd, cwd=str(CALIBRATION_DIR))
        return result.returncode
    except KeyboardInterrupt:
        logger.info("\n🛑 Calibration system stopped by user")
        return 0
    except Exception as e:
        logger.error(f"❌ Failed to launch calibration tool: {e}")
        import traceback

        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
