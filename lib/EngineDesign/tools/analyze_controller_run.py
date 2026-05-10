#!/usr/bin/env python3
"""Analyze controller run logs and generate plots.

Loads controller logs and plots:
- F_ref vs F_hat
- MR
- P_copv, P_reg, P_u_i, P_d_i
- duty / valve states
- constraint margins
"""

import argparse
import sys
from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.control.robust_ddp.logging import ControllerLogger


def load_logs(filepath: str):
    """Load logs from file."""
    return ControllerLogger.load(filepath)


def extract_data(logs):
    """Extract data arrays from logs."""
    n = len(logs)
    
    data = {
        "tick": np.array([log["tick"] for log in logs]),
        "timestamp": np.array([log["timestamp"] for log in logs]),
        "P_copv": np.array([log["pressures"]["P_copv"] for log in logs]),
        "P_reg": np.array([log["pressures"]["P_reg"] for log in logs]),
        "P_u_fuel": np.array([log["pressures"]["P_u_fuel"] for log in logs]),
        "P_u_ox": np.array([log["pressures"]["P_u_ox"] for log in logs]),
        "P_d_fuel": np.array([log["pressures"]["P_d_fuel"] for log in logs]),
        "P_d_ox": np.array([log["pressures"]["P_d_ox"] for log in logs]),
        "P_ch": np.array([log["engine"]["P_ch"] if log["engine"]["P_ch"] is not None else np.nan for log in logs]),
        "F": np.array([log["engine"]["F"] if log["engine"]["F"] is not None else np.nan for log in logs]),
        "MR": np.array([log["engine"]["MR"] if log["engine"]["MR"] is not None else np.nan for log in logs]),
        "duty_F": np.array([log["control"]["duty_F"] for log in logs]),
        "duty_O": np.array([log["control"]["duty_O"] for log in logs]),
        "u_F_onoff": np.array([log["control"]["u_F_onoff"] for log in logs]),
        "u_O_onoff": np.array([log["control"]["u_O_onoff"] for log in logs]),
        "F_ref": np.array([log["reference"]["F_ref"] if log["reference"]["F_ref"] is not None else np.nan for log in logs]),
        "MR_ref": np.array([log["reference"]["MR_ref"] if log["reference"]["MR_ref"] is not None else np.nan for log in logs]),
    }
    
    # Extract constraint margins
    constraint_keys = set()
    for log in logs:
        constraint_keys.update(log["constraints"].keys())
    
    for key in constraint_keys:
        data[f"constraint_{key}"] = np.array([
            log["constraints"].get(key, np.nan) for log in logs
        ])
    
    # Extract w_bar (use first component as example)
    if logs and "robustness" in logs[0] and "w_bar" in logs[0]["robustness"]:
        w_bar = logs[0]["robustness"]["w_bar"]
        if len(w_bar) > 0:
            data["w_bar_0"] = np.array([
                log["robustness"]["w_bar"][0] if len(log["robustness"]["w_bar"]) > 0 else np.nan
                for log in logs
            ])
    
    return data


def plot_controller_run(data, output_file: str = None):
    """Plot controller run data."""
    fig = plt.figure(figsize=(16, 12))
    gs = GridSpec(4, 2, figure=fig, hspace=0.3, wspace=0.3)
    
    time = data["timestamp"]
    
    # Plot 1: F_ref vs F_hat
    ax1 = fig.add_subplot(gs[0, 0])
    ax1.plot(time, data["F_ref"] / 1000, 'b--', label='F_ref', linewidth=2)
    ax1.plot(time, data["F"] / 1000, 'r-', label='F_hat', linewidth=1.5)
    ax1.set_xlabel('Time [s]')
    ax1.set_ylabel('Thrust [kN]')
    ax1.set_title('Thrust Tracking')
    ax1.legend()
    ax1.grid(True, alpha=0.3)
    
    # Plot 2: MR
    ax2 = fig.add_subplot(gs[0, 1])
    ax2.plot(time, data["MR_ref"], 'b--', label='MR_ref', linewidth=2)
    ax2.plot(time, data["MR"], 'r-', label='MR_hat', linewidth=1.5)
    ax2.set_xlabel('Time [s]')
    ax2.set_ylabel('Mixture Ratio (O/F)')
    ax2.set_title('Mixture Ratio')
    ax2.legend()
    ax2.grid(True, alpha=0.3)
    
    # Plot 3: Pressures (COPV, Regulator)
    ax3 = fig.add_subplot(gs[1, 0])
    ax3.plot(time, data["P_copv"] / 1e6, 'b-', label='P_copv', linewidth=1.5)
    ax3.plot(time, data["P_reg"] / 1e6, 'g-', label='P_reg', linewidth=1.5)
    ax3.set_xlabel('Time [s]')
    ax3.set_ylabel('Pressure [MPa]')
    ax3.set_title('COPV and Regulator Pressures')
    ax3.legend()
    ax3.grid(True, alpha=0.3)
    
    # Plot 4: Ullage Pressures
    ax4 = fig.add_subplot(gs[1, 1])
    ax4.plot(time, data["P_u_fuel"] / 1e6, 'b-', label='P_u_fuel', linewidth=1.5)
    ax4.plot(time, data["P_u_ox"] / 1e6, 'r-', label='P_u_ox', linewidth=1.5)
    ax4.set_xlabel('Time [s]')
    ax4.set_ylabel('Pressure [MPa]')
    ax4.set_title('Ullage Pressures')
    ax4.legend()
    ax4.grid(True, alpha=0.3)
    
    # Plot 5: Feed Pressures
    ax5 = fig.add_subplot(gs[2, 0])
    ax5.plot(time, data["P_d_fuel"] / 1e6, 'b-', label='P_d_fuel', linewidth=1.5)
    ax5.plot(time, data["P_d_ox"] / 1e6, 'r-', label='P_d_ox', linewidth=1.5)
    ax5.plot(time, data["P_ch"] / 1e6, 'g-', label='P_ch', linewidth=1.5)
    ax5.set_xlabel('Time [s]')
    ax5.set_ylabel('Pressure [MPa]')
    ax5.set_title('Feed and Chamber Pressures')
    ax5.legend()
    ax5.grid(True, alpha=0.3)
    
    # Plot 6: Duty Cycles
    ax6 = fig.add_subplot(gs[2, 1])
    ax6.plot(time, data["duty_F"], 'b-', label='duty_F', linewidth=1.5)
    ax6.plot(time, data["duty_O"], 'r-', label='duty_O', linewidth=1.5)
    ax6.set_xlabel('Time [s]')
    ax6.set_ylabel('Duty Cycle [0-1]')
    ax6.set_title('Solenoid Duty Cycles')
    ax6.set_ylim([-0.1, 1.1])
    ax6.legend()
    ax6.grid(True, alpha=0.3)
    
    # Plot 7: Constraint Margins
    ax7 = fig.add_subplot(gs[3, :])
    constraint_keys = [k for k in data.keys() if k.startswith("constraint_")]
    if constraint_keys:
        for key in constraint_keys:
            constraint_name = key[len("constraint_"):]
            ax7.plot(time, data[key], label=constraint_name, linewidth=1.5, alpha=0.7)
        ax7.axhline(y=0, color='k', linestyle='--', linewidth=1, alpha=0.5)
        ax7.set_xlabel('Time [s]')
        ax7.set_ylabel('Constraint Margin (positive = violation)')
        ax7.set_title('Constraint Margins')
        ax7.legend(ncol=3, fontsize=8)
        ax7.grid(True, alpha=0.3)
    else:
        ax7.text(0.5, 0.5, 'No constraint data', ha='center', va='center', transform=ax7.transAxes)
        ax7.set_title('Constraint Margins')
    
    plt.suptitle('Controller Run Analysis', fontsize=16, y=0.995)
    
    if output_file:
        plt.savefig(output_file, dpi=150, bbox_inches='tight')
        print(f"Plot saved to {output_file}")
    else:
        plt.show()


def main():
    """Main function."""
    parser = argparse.ArgumentParser(description='Analyze controller run logs')
    parser.add_argument('log_file', type=str, help='Path to log file (JSON or CSV)')
    parser.add_argument('-o', '--output', type=str, default=None, help='Output plot file (default: show)')
    
    args = parser.parse_args()
    
    # Load logs
    print(f"Loading logs from {args.log_file}...")
    logs = load_logs(args.log_file)
    print(f"Loaded {len(logs)} log entries")
    
    # Extract data
    data = extract_data(logs)
    
    # Plot
    plot_controller_run(data, args.output)


if __name__ == "__main__":
    main()



