"""
Command-line interface for csv_to_eng.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .core import convert


def main(argv: list[str] | None = None) -> int:
    """
    Main CLI entrypoint.

    Args:
        argv: Command line arguments (defaults to sys.argv[1:])

    Returns:
        Exit code (0 for success, non-zero for error)
    """
    parser = argparse.ArgumentParser(
        prog="csv_to_eng",
        description="Convert CSV thrust curve data to RASP .eng engine file format.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic conversion:
  python -m csv_to_eng --input curve.csv --output motor.eng

  # With metadata overrides:
  python -m csv_to_eng --input curve.csv --output motor.eng \\
      --name "K1000" --diameter-mm 54 --length-mm 326 \\
      --manufacturer "Acme Rocketry"

  # Specify units explicitly:
  python -m csv_to_eng --input curve.csv --output motor.eng \\
      --thrust-units lbf --time-units ms
        """,
    )

    # Required arguments
    parser.add_argument(
        "-i", "--input",
        required=True,
        type=Path,
        metavar="CSV",
        help="Input CSV file containing thrust curve data",
    )
    parser.add_argument(
        "-o", "--output",
        required=True,
        type=Path,
        metavar="ENG",
        help="Output .eng file path",
    )

    # Metadata overrides
    metadata_group = parser.add_argument_group("Metadata Overrides")
    metadata_group.add_argument(
        "--name",
        type=str,
        metavar="NAME",
        help="Engine name (e.g., 'K1000')",
    )
    metadata_group.add_argument(
        "--diameter-mm",
        type=float,
        metavar="MM",
        help="Engine diameter in millimeters",
    )
    metadata_group.add_argument(
        "--length-mm",
        type=float,
        metavar="MM",
        help="Engine length in millimeters",
    )
    metadata_group.add_argument(
        "--prop-mass-kg",
        type=float,
        metavar="KG",
        help="Propellant mass in kilograms",
    )
    metadata_group.add_argument(
        "--total-mass-kg",
        type=float,
        metavar="KG",
        help="Total loaded mass in kilograms",
    )
    metadata_group.add_argument(
        "--manufacturer",
        type=str,
        metavar="MFR",
        help="Manufacturer name",
    )
    metadata_group.add_argument(
        "--delays",
        type=str,
        metavar="DELAYS",
        help="Delay charges (e.g., '6-10-14' or 'P' for plugged)",
    )

    # Unit specifications
    units_group = parser.add_argument_group("Unit Specifications")
    units_group.add_argument(
        "--thrust-units",
        type=str,
        choices=["N", "lbf"],
        metavar="{N,lbf}",
        help="Thrust units in input CSV (default: auto-detect, fallback N)",
    )
    units_group.add_argument(
        "--time-units",
        type=str,
        choices=["s", "ms"],
        metavar="{s,ms}",
        help="Time units in input CSV (default: auto-detect, fallback s)",
    )

    # Format options
    format_group = parser.add_argument_group("Format Options")
    format_group.add_argument(
        "--format",
        type=str,
        choices=["rasp"],
        default="rasp",
        metavar="{rasp}",
        help="Output format (default: rasp)",
    )
    format_group.add_argument(
        "--time-decimals",
        type=int,
        default=3,
        metavar="N",
        help="Decimal places for time values (default: 3)",
    )
    format_group.add_argument(
        "--thrust-decimals",
        type=int,
        default=1,
        metavar="N",
        help="Decimal places for thrust values (default: 1)",
    )
    format_group.add_argument(
        "--header-mode",
        type=str,
        choices=["auto", "none", "row0_json"],
        default="auto",
        metavar="{auto,none,row0_json}",
        help="Header detection mode (default: auto)",
    )

    args = parser.parse_args(argv)

    # Validate input file exists
    if not args.input.exists():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        return 1

    # Perform conversion
    try:
        convert(
            csv_path=args.input,
            eng_path=args.output,
            name=args.name,
            diameter_mm=args.diameter_mm,
            length_mm=args.length_mm,
            delays=args.delays,
            prop_mass_kg=args.prop_mass_kg,
            total_mass_kg=args.total_mass_kg,
            manufacturer=args.manufacturer,
            time_units=args.time_units,
            thrust_units=args.thrust_units,
            time_decimals=args.time_decimals,
            thrust_decimals=args.thrust_decimals,
        )

        print(f"Successfully converted: {args.input} -> {args.output}")
        return 0

    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"Error: Invalid data - {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Error: Unexpected error - {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
