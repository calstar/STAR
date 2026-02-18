#!/usr/bin/env python3
"""
Engine Simulation Bridge for SITL

Bridges between C++ SITL simulator and Python engine simulation.
Follows Betaflight SITL pattern for real-time simulation integration.
"""

import sys
import os
import time
import json
import socket
import struct
from typing import Dict, Optional, Tuple
from dataclasses import dataclass
from pathlib import Path

# Add engine_sim to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "engine_sim"))

try:
    from engine.core.runner import PintleEngineRunner
    from engine.pipeline.io import load_config
    from engine.control.robust_ddp import (
        RobustDDPController,
        ControllerConfig,
        Measurement,
        NavState,
        Command,
        CommandType,
        ActuationCommand,
    )
except ImportError as e:
    print(f"Error importing engine simulation: {e}")
    print("Make sure engine_sim submodule is initialized:")
    print("  git submodule update --init --recursive")
    sys.exit(1)


@dataclass
class EngineState:
    """Current engine simulation state."""

    P_copv: float = 0.0
    P_reg: float = 0.0
    P_u_fuel: float = 0.0
    P_u_ox: float = 0.0
    P_d_fuel: float = 0.0
    P_d_ox: float = 0.0
    P_chamber: float = 0.0
    thrust: float = 0.0
    mass_flow_fuel: float = 0.0
    mass_flow_ox: float = 0.0
    mixture_ratio: float = 0.0


class EngineSimBridge:
    """Bridge between C++ SITL and Python engine simulation."""

    def __init__(
        self, engine_config_path: str, controller_config_path: Optional[str] = None
    ):
        """
        Initialize engine simulation bridge.

        Args:
            engine_config_path: Path to engine configuration YAML
            controller_config_path: Path to controller configuration (optional)
        """
        # Load engine configuration
        print(f"Loading engine config from {engine_config_path}")
        self.engine_config = load_config(engine_config_path)
        self.runner = PintleEngineRunner(self.engine_config)

        # Initialize controller if config provided
        self.controller = None
        if controller_config_path and os.path.exists(controller_config_path):
            print(f"Loading controller config from {controller_config_path}")
            # TODO: Load controller config from YAML
            # For now, use defaults
            controller_cfg = ControllerConfig()
            self.controller = RobustDDPController(controller_cfg, self.engine_config)

        # Current state
        self.state = EngineState()

        # Initial tank pressures
        self.P_tank_fuel = 974.0 * 6894.76  # Pa (974 psi)
        self.P_tank_ox = 1305.0 * 6894.76  # Pa (1305 psi)

        # Actuation commands (from controller or manual)
        self.duty_fuel = 0.0
        self.duty_ox = 0.0

    def evaluate(self, P_tank_fuel: float, P_tank_ox: float) -> Dict:
        """
        Evaluate engine at given tank pressures.

        Args:
            P_tank_fuel: Fuel tank pressure [Pa]
            P_tank_ox: Oxidizer tank pressure [Pa]

        Returns:
            Dictionary with engine performance metrics
        """
        self.P_tank_fuel = P_tank_fuel
        self.P_tank_ox = P_tank_ox

        # Run engine evaluation
        results = self.runner.evaluate(P_tank_ox, P_tank_fuel)

        # Update state
        self.state.P_chamber = results.get("Pc", 0.0)
        self.state.thrust = results.get("F", 0.0)
        self.state.mass_flow_fuel = results.get("mdot_F", 0.0)
        self.state.mass_flow_ox = results.get("mdot_O", 0.0)
        self.state.mixture_ratio = results.get("MR", 0.0)

        # Estimate pressures (simplified model)
        # In real implementation, this would come from feed system dynamics
        self.state.P_u_fuel = P_tank_fuel * 0.95  # Pressure drop in feed line
        self.state.P_u_ox = P_tank_ox * 0.95
        self.state.P_d_fuel = self.state.P_chamber + results.get(
            "injector_dp_F", 100000.0
        )
        self.state.P_d_ox = self.state.P_chamber + results.get(
            "injector_dp_O", 100000.0
        )
        self.state.P_reg = P_tank_ox * 0.8  # Regulator pressure
        self.state.P_copv = P_tank_ox * 1.2  # COPV pressure

        return results

    def controller_step(
        self, measurement: Measurement, nav_state: NavState, command: Command
    ) -> Tuple[ActuationCommand, Dict]:
        """
        Run controller step.

        Args:
            measurement: Sensor measurements
            nav_state: Navigation state
            command: Control command

        Returns:
            Tuple of (actuation_command, diagnostics)
        """
        if self.controller is None:
            # No controller, return zero actuation
            actuation = ActuationCommand(duty_F=0.0, duty_O=0.0)
            return actuation, {}

        actuation, diagnostics = self.controller.step(measurement, nav_state, command)
        self.duty_fuel = actuation.duty_F
        self.duty_ox = actuation.duty_O

        return actuation, diagnostics

    def get_state(self) -> EngineState:
        """Get current engine state."""
        return self.state


def main():
    """Main entry point for engine simulation bridge."""
    import argparse

    parser = argparse.ArgumentParser(description="Engine Simulation Bridge for SITL")
    parser.add_argument(
        "--engine-config",
        default="engine_sim/configs/default.yaml",
        help="Path to engine configuration",
    )
    parser.add_argument(
        "--controller-config", default=None, help="Path to controller configuration"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=5555,
        help="TCP port for communication with C++ SITL",
    )

    args = parser.parse_args()

    # Initialize bridge
    bridge = EngineSimBridge(args.engine_config, args.controller_config)

    # Create TCP server for communication with C++ SITL
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", args.port))
    sock.listen(1)

    print(f"Engine simulation bridge listening on port {args.port}")
    print("Waiting for SITL simulator connection...")

    conn, addr = sock.accept()
    print(f"Connected to SITL simulator at {addr}")

    try:
        while True:
            # Receive request from C++ SITL
            data = conn.recv(1024)
            if not data:
                break

            # Parse request (simple protocol: "EVAL <P_fuel> <P_ox>" or "GET_STATE")
            request = data.decode("utf-8").strip()

            if request.startswith("EVAL"):
                parts = request.split()
                if len(parts) == 3:
                    P_fuel = float(parts[1])
                    P_ox = float(parts[2])
                    results = bridge.evaluate(P_fuel, P_ox)

                    # Send results as JSON
                    response = json.dumps(
                        {
                            "P_chamber": bridge.state.P_chamber,
                            "thrust": bridge.state.thrust,
                            "mass_flow_fuel": bridge.state.mass_flow_fuel,
                            "mass_flow_ox": bridge.state.mass_flow_ox,
                            "mixture_ratio": bridge.state.mixture_ratio,
                            "P_u_fuel": bridge.state.P_u_fuel,
                            "P_u_ox": bridge.state.P_u_ox,
                            "P_d_fuel": bridge.state.P_d_fuel,
                            "P_d_ox": bridge.state.P_d_ox,
                            "P_reg": bridge.state.P_reg,
                            "P_copv": bridge.state.P_copv,
                        }
                    )
                    conn.sendall(response.encode("utf-8") + b"\n")

            elif request == "GET_STATE":
                state = bridge.get_state()
                response = json.dumps(
                    {
                        "P_copv": state.P_copv,
                        "P_reg": state.P_reg,
                        "P_u_fuel": state.P_u_fuel,
                        "P_u_ox": state.P_u_ox,
                        "P_d_fuel": state.P_d_fuel,
                        "P_d_ox": state.P_d_ox,
                        "P_chamber": state.P_chamber,
                        "thrust": state.thrust,
                        "mass_flow_fuel": state.mass_flow_fuel,
                        "mass_flow_ox": state.mass_flow_ox,
                        "mixture_ratio": state.mixture_ratio,
                    }
                )
                conn.sendall(response.encode("utf-8") + b"\n")

            else:
                conn.sendall(b"ERROR: Unknown command\n")

    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        conn.close()
        sock.close()


if __name__ == "__main__":
    main()
