#!/usr/bin/env python3
"""
Avionics IMU Machine Learning Core (MLC) Flight Classification Pipeline.

Unified Command-Line Interface to:
  --generate-data : Simulates 100 Hz 6-DOF IMU + Magnetometer rocket flight logs.
  --train         : Extracts rolling MLC features, trains 8 trees, exports Unico-GUI rules.
  --evaluate      : Evaluates test set accuracy, F1, leaf counts, and hardware node budget.
  (default: runs full end-to-end pipeline if no specific flag is provided)
"""

import sys
import os

# Auto-bootstrap .venv if launched outside the virtual environment
if sys.prefix == getattr(sys, "base_prefix", sys.prefix):
    venv_py = os.path.abspath(os.path.join(os.path.dirname(__file__), ".venv", "bin", "python"))
    if os.path.exists(venv_py) and os.path.realpath(sys.executable) != os.path.realpath(venv_py):
        os.execv(venv_py, [venv_py] + sys.argv)

import argparse
from typing import Dict, Any

from scripts.generate_synthetic_data import generate_flight_dataset
from src.train_mlc_trees import train_and_evaluate_mlc_trees, TOTAL_NODE_BUDGET



DATA_PATH = "data/simulated_flight.csv"
EXPORTS_DIR = "exports"


def print_banner():
    banner = """
========================================================================================
       🚀 STAR-IMU-MLC: AVIONICS MACHINE LEARNING CORE CLASSIFIER PIPELINE 🚀          
            Embedded Decision Tree Architecture for Ultra-Low-Power IMUs                 
========================================================================================
"""
    print(banner)


def format_summary_table(pipeline_summary: Dict[str, Any]):
    """Renders a formatted terminal table showing tree metrics and hardware node budget."""
    results = pipeline_summary["results"]
    total_nodes = pipeline_summary["total_nodes"]
    budget = pipeline_summary["budget"]
    budget_passed = pipeline_summary["budget_passed"]

    header = (
        f"+-----+-----------------------------+------------+-----------+-------+-------+----------+---------+\n"
        f"| ID  | Target / Task Name          | Type       | Leaf Budg | Leaves| Nodes | Accuracy | F1-Score|\n"
        f"+-----+-----------------------------+------------+-----------+-------+-------+----------+---------+"
    )
    print("\n" + "=" * 90)
    print("                     8-TREE MLC CLASSIFICATION PIPELINE SUMMARY                     ")
    print("=" * 90)
    print(header)

    for r in results:
        tree_id = f"T{r['tree_id']}"
        name = r['name'][:27]
        ttype = r['type'][:10]
        leaf_b = r['leaf_budget']
        leaves = r['leaves_used']
        nodes = r['nodes_used']
        acc = f"{r['accuracy'] * 100:.2f}%"
        f1 = f"{r['f1_score'] * 100:.2f}%"

        row = (
            f"| {tree_id:<3} | {name:<27} | {ttype:<10} | {leaf_b:<9} | "
            f"{leaves:<5} | {nodes:<5} | {acc:<8} | {f1:<7} |"
        )
        print(row)

    print(f"+-----+-----------------------------+------------+-----------+-------+-------+----------+---------+")

    # Node Budget Meter
    pct_used = (total_nodes / budget) * 100.0
    bar_width = 30
    filled = int(bar_width * (total_nodes / budget))
    bar = "█" * filled + "░" * (bar_width - filled)

    status_str = "PASSED (Compliant with ST MLC Hardware)" if budget_passed else "FAILED (Exceeds Budget!)"

    print("\n" + "-" * 90)
    print(" HARDWARE NODE BUDGET VERIFICATION:")
    print(f"  • Total Decision Tree Nodes Used : {total_nodes} / {budget} nodes ({pct_used:.1f}%)")
    print(f"  • MLC Memory Budget Meter        : [{bar}]")
    print(f"  • Hardware Feasibility Status    : {status_str}")
    print(f"  • Total Rolling Features Extracted: {pipeline_summary['feature_count']} channels")
    print(f"  • Target Platform Compatibility  : STMicroelectronics LSM6DSOX / LSM6DSRX / ISM330DHCX")
    print("-" * 90)

    print("\n EXPORTED UNICO-GUI RULES (ready for import):")
    for r in results:
        print(f"  [✓] {os.path.join(EXPORTS_DIR, r['export_file'])} ({r['nodes_used']} nodes)")
    print("=" * 90 + "\n")


def main():
    parser = argparse.ArgumentParser(
        description="Avionics IMU Machine Learning Core (MLC) Flight Classification Pipeline."
    )
    parser.add_argument(
        "--generate-data",
        action="store_true",
        help="Generate synthetic 6-DOF IMU + Magnetometer flight data (100 Hz).",
    )
    parser.add_argument(
        "--train",
        action="store_true",
        help="Train 8 MLC Decision Trees and export Unico-GUI rule files.",
    )
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="Evaluate model performance on test set and verify node budget.",
    )
    parser.add_argument(
        "--data-file",
        type=str,
        default=DATA_PATH,
        help=f"Path to flight data CSV (default: {DATA_PATH})",
    )
    parser.add_argument(
        "--export-dir",
        type=str,
        default=EXPORTS_DIR,
        help=f"Directory for exported tree rules (default: {EXPORTS_DIR})",
    )

    args = parser.parse_args()

    # If no flags are given, execute the complete pipeline end-to-end
    run_all = not (args.generate_data or args.train or args.evaluate)

    print_banner()

    # Step 1: Generate Data
    if args.generate_data or run_all or not os.path.exists(args.data_file):
        print(f"[*] Step 1: Generating synthetic flight dataset at '{args.data_file}'...")
        generate_flight_dataset(output_path=args.data_file)
        print("[✓] Flight dataset generated successfully.\n")

    # Step 2 & 3: Train & Evaluate
    if args.train or args.evaluate or run_all:
        print(f"[*] Step 2: Training 8 MLC Decision Trees & Enforcing <= {TOTAL_NODE_BUDGET} Node Budget...")
        summary = train_and_evaluate_mlc_trees(
            csv_path=args.data_file,
            export_dir=args.export_dir,
        )
        print("[✓] Training, verification, and rule export complete.\n")

        print("[*] Step 3: Presenting Model Performance & Hardware Budget Evaluation...")
        format_summary_table(summary)


if __name__ == "__main__":
    main()
