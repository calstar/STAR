"""
Core functionality for CSV to .eng conversion.
"""

from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Tuple, Optional, Dict, Any, Union

# Conversion constants
LBF_TO_N = 4.4482216152605
MS_TO_S = 0.001

# Column name patterns (case-insensitive matching)
TIME_COLUMNS = {"time", "t", "seconds", "time_s", "time_ms"}
THRUST_COLUMNS = {"thrust", "f", "force", "thrust_n", "thrust_lbf"}

# Metadata column mappings
METADATA_COLUMNS = {
    "engine_name": "name",
    "name": "name",
    "motor_name": "name",
    "diameter_mm": "diameter_mm",
    "diameter": "diameter_mm",
    "diam": "diameter_mm",
    "length_mm": "length_mm",
    "length": "length_mm",
    "len": "length_mm",
    "prop_mass_kg": "prop_mass_kg",
    "propellant_mass": "prop_mass_kg",
    "prop_mass": "prop_mass_kg",
    "total_mass_kg": "total_mass_kg",
    "total_mass": "total_mass_kg",
    "mass": "total_mass_kg",
    "manufacturer": "manufacturer",
    "mfr": "manufacturer",
    "mfg": "manufacturer",
    "delays": "delays",
    "delay": "delays",
}


@dataclass
class EngineMetadata:
    """Metadata for a rocket engine, used in .eng file header."""

    name: str = "Unknown"
    diameter_mm: float = 0.0
    length_mm: float = 0.0
    delays: str = "0"  # Kept for compatibility but not used in header
    prop_mass_kg: float = 0.0
    total_mass_kg: float = 0.0
    manufacturer: str = "Unknown"

    def header_line(self) -> str:
        """
        Generate the .eng header line.

        RASP Format (7 fields): <designation> <diameter_mm> <length_mm> <delays> <prop_mass_kg> <total_mass_kg> <manufacturer>
        """
        # Replace spaces in manufacturer with underscores
        mfr = self.manufacturer.replace(" ", "_") if self.manufacturer else "Unknown"
        name = self.name.replace(" ", "_") if self.name else "Unknown"

        return (
            f"{name} {self.diameter_mm:.0f} {self.length_mm:.0f} "
            f"{self.delays} {self.prop_mass_kg:.4f} {self.total_mass_kg:.4f} {mfr}"
        )


CurvePoints = List[Tuple[float, float]]


def _detect_column_indices(
    headers: List[str],
) -> Tuple[int, int, Dict[str, int]]:
    """
    Detect time and thrust column indices from headers.

    Returns:
        (time_idx, thrust_idx, metadata_col_indices)

    Raises:
        ValueError: If time or thrust columns cannot be identified.
    """
    headers_lower = [h.lower().strip() for h in headers]

    time_idx = -1
    thrust_idx = -1
    metadata_indices: Dict[str, int] = {}

    for i, h in enumerate(headers_lower):
        # Check for time column
        if time_idx < 0:
            for pattern in TIME_COLUMNS:
                if pattern in h or h.startswith(pattern):
                    time_idx = i
                    break

        # Check for thrust column
        if thrust_idx < 0:
            for pattern in THRUST_COLUMNS:
                if pattern in h or h.startswith(pattern):
                    thrust_idx = i
                    break

        # Check for metadata columns
        for meta_pattern, meta_name in METADATA_COLUMNS.items():
            if meta_pattern in h or h == meta_pattern:
                if meta_name not in metadata_indices:
                    metadata_indices[meta_name] = i

    # Fallback: if no headers detected, assume first two columns are time, thrust
    if time_idx < 0 and thrust_idx < 0:
        if len(headers) >= 2:
            time_idx = 0
            thrust_idx = 1
        else:
            raise ValueError(
                "Cannot detect time/thrust columns. "
                "Ensure CSV has headers like 'time,thrust' or at least 2 columns."
            )

    if time_idx < 0:
        raise ValueError("Cannot detect time column in CSV headers.")
    if thrust_idx < 0:
        raise ValueError("Cannot detect thrust column in CSV headers.")

    return time_idx, thrust_idx, metadata_indices


def _detect_units_from_header(header: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Detect units from column header suffix.

    Returns:
        (time_unit, thrust_unit) - None if not detected
    """
    h = header.lower().strip()
    time_unit = None
    thrust_unit = None

    if "_ms" in h or h.endswith("ms"):
        time_unit = "ms"
    elif "_s" in h or h.endswith("s"):
        time_unit = "s"

    if "_lbf" in h or h.endswith("lbf"):
        thrust_unit = "lbf"
    elif "_n" in h or h.endswith("n"):
        thrust_unit = "N"

    return time_unit, thrust_unit


def _is_comment_line(line: str) -> bool:
    """Check if a line is a comment."""
    stripped = line.strip()
    return stripped.startswith("#") or stripped.startswith("//")


def _parse_numeric(value: str) -> Optional[float]:
    """Parse a string to float, returning None on failure."""
    try:
        return float(value.strip())
    except (ValueError, TypeError):
        return None


def read_csv_curve(
    path: Union[str, Path],
    time_units: Optional[str] = None,
    thrust_units: Optional[str] = None,
) -> Tuple[EngineMetadata, CurvePoints]:
    """
    Read a CSV file containing thrust curve data.

    Args:
        path: Path to the CSV file.
        time_units: Force time units ("s" or "ms"). Auto-detected if None.
        thrust_units: Force thrust units ("N" or "lbf"). Auto-detected if None.

    Returns:
        Tuple of (EngineMetadata, list of (time_s, thrust_N) tuples)

    Raises:
        FileNotFoundError: If file doesn't exist.
        ValueError: If CSV format is invalid.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"CSV file not found: {path}")

    metadata = EngineMetadata()
    points: CurvePoints = []

    # Read and filter out comment lines
    with open(path, "r", newline="", encoding="utf-8") as f:
        lines = [line for line in f if not _is_comment_line(line)]

    if not lines:
        raise ValueError(f"CSV file is empty or contains only comments: {path}")

    # Parse CSV content
    reader = csv.reader(lines)
    rows = list(reader)

    if not rows:
        raise ValueError(f"No data rows in CSV: {path}")

    # Detect if first row is a header
    first_row = rows[0]
    has_header = False

    # Check if first row looks like a header (contains non-numeric values in expected positions)
    for cell in first_row[:2]:
        if _parse_numeric(cell) is None:
            has_header = True
            break

    if has_header:
        headers = first_row
        data_rows = rows[1:]
    else:
        # No header - assume columns are time, thrust
        headers = ["time", "thrust"]
        data_rows = rows

    # Detect column indices
    time_idx, thrust_idx, meta_indices = _detect_column_indices(headers)

    # Auto-detect units from headers if not specified
    if time_units is None:
        detected_time, _ = _detect_units_from_header(headers[time_idx])
        time_units = detected_time or "s"
    if thrust_units is None:
        _, detected_thrust = _detect_units_from_header(headers[thrust_idx])
        thrust_units = detected_thrust or "N"

    # Parse data rows
    metadata_extracted = False

    for row_num, row in enumerate(data_rows, start=2 if has_header else 1):
        if len(row) <= max(time_idx, thrust_idx):
            continue  # Skip incomplete rows

        # Strip whitespace from all cells
        row = [cell.strip() for cell in row]

        # Parse time and thrust
        time_val = _parse_numeric(row[time_idx])
        thrust_val = _parse_numeric(row[thrust_idx])

        if time_val is None or thrust_val is None:
            continue  # Skip rows with invalid numeric data

        # Convert units
        if time_units == "ms":
            time_val *= MS_TO_S
        if thrust_units == "lbf":
            thrust_val *= LBF_TO_N

        # Validate values
        if time_val < 0:
            raise ValueError(f"Negative time value at row {row_num}: {time_val}")

        # Clamp negative thrust to 0 (with warning possible)
        if thrust_val < 0:
            thrust_val = 0.0

        points.append((time_val, thrust_val))

        # Extract metadata from first data row
        if not metadata_extracted:
            for meta_name, col_idx in meta_indices.items():
                if col_idx < len(row) and row[col_idx]:
                    val = row[col_idx]
                    if meta_name in ("diameter_mm", "length_mm", "prop_mass_kg", "total_mass_kg"):
                        numeric_val = _parse_numeric(val)
                        if numeric_val is not None:
                            setattr(metadata, meta_name, numeric_val)
                    else:
                        setattr(metadata, meta_name, val)
            metadata_extracted = True

    if not points:
        raise ValueError(f"No valid data points found in CSV: {path}")

    return metadata, points


def normalize_curve(
    points: CurvePoints,
    time_decimals: int = 3,
    thrust_decimals: int = 1,
) -> CurvePoints:
    """
    Normalize thrust curve data.

    Operations:
    1. Sort by time (ascending)
    2. Remove duplicate time entries (keep last value for each time)
    3. Ensure curve starts at t=0 (insert if missing)
    4. Ensure curve ends with thrust=0 at burnout (append if needed)
    5. Round values to specified decimal places

    Args:
        points: List of (time_s, thrust_N) tuples.
        time_decimals: Decimal places for time (default 3).
        thrust_decimals: Decimal places for thrust (default 1).

    Returns:
        Normalized list of (time_s, thrust_N) tuples.
    """
    if not points:
        return [(0.0, 0.0)]

    # Sort by time
    sorted_points = sorted(points, key=lambda p: p[0])

    # De-duplicate times (keep last occurrence)
    time_to_thrust: Dict[float, float] = {}
    for t, f in sorted_points:
        rounded_t = round(t, time_decimals)
        time_to_thrust[rounded_t] = round(f, thrust_decimals)

    # Convert back to sorted list
    deduped = sorted(time_to_thrust.items(), key=lambda p: p[0])

    # Ensure start at t=0
    if deduped[0][0] > 0:
        # Insert t=0 with thrust=0 (motor hasn't ignited yet)
        deduped.insert(0, (0.0, 0.0))

    # Ensure end with thrust=0
    if deduped[-1][1] != 0.0:
        last_time = deduped[-1][0]
        # Append a point slightly after with thrust=0
        # Use a small delta to indicate burnout
        burnout_time = round(last_time + 0.001, time_decimals)
        deduped.append((burnout_time, 0.0))

    return deduped


def write_eng(
    path: Union[str, Path],
    metadata: EngineMetadata,
    points: CurvePoints,
    time_decimals: int = 3,
    thrust_decimals: int = 1,
    include_comment: bool = True,
) -> None:
    """
    Write thrust curve data to a RASP .eng file.

    Args:
        path: Output file path.
        metadata: Engine metadata for header line.
        points: List of (time_s, thrust_N) tuples.
        time_decimals: Decimal places for time output (default 3).
        thrust_decimals: Decimal places for thrust output (default 1).
        include_comment: Include generator comment at top (default True).
    """
    path = Path(path)

    # Ensure parent directory exists
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        # Optional comment line
        if include_comment:
            f.write("; Generated by csv_to_eng\n")

        # Header line
        f.write(metadata.header_line() + "\n")

        # Data lines
        time_fmt = f"{{:.{time_decimals}f}}"
        thrust_fmt = f"{{:.{thrust_decimals}f}}"

        for t, thrust in points:
            f.write(f"{time_fmt.format(t)} {thrust_fmt.format(thrust)}\n")


def convert(
    csv_path: Union[str, Path],
    eng_path: Union[str, Path],
    # Metadata overrides
    name: Optional[str] = None,
    diameter_mm: Optional[float] = None,
    length_mm: Optional[float] = None,
    delays: Optional[str] = None,
    prop_mass_kg: Optional[float] = None,
    total_mass_kg: Optional[float] = None,
    manufacturer: Optional[str] = None,
    # Unit specifications
    time_units: Optional[str] = None,
    thrust_units: Optional[str] = None,
    # Formatting options
    time_decimals: int = 3,
    thrust_decimals: int = 1,
) -> None:
    """
    Convert a CSV thrust curve file to RASP .eng format.

    This is the high-level convenience function that combines read, normalize,
    and write operations.

    Args:
        csv_path: Input CSV file path.
        eng_path: Output .eng file path.
        name: Engine name override.
        diameter_mm: Engine diameter in mm override.
        length_mm: Engine length in mm override.
        delays: Delay charges string override.
        prop_mass_kg: Propellant mass in kg override.
        total_mass_kg: Total loaded mass in kg override.
        manufacturer: Manufacturer name override.
        time_units: Force time units ("s" or "ms").
        thrust_units: Force thrust units ("N" or "lbf").
        time_decimals: Decimal places for time (default 3).
        thrust_decimals: Decimal places for thrust (default 1).
    """
    # Read CSV
    metadata, points = read_csv_curve(
        csv_path,
        time_units=time_units,
        thrust_units=thrust_units,
    )

    # Apply overrides
    if name is not None:
        metadata.name = name
    if diameter_mm is not None:
        metadata.diameter_mm = diameter_mm
    if length_mm is not None:
        metadata.length_mm = length_mm
    if delays is not None:
        metadata.delays = delays
    if prop_mass_kg is not None:
        metadata.prop_mass_kg = prop_mass_kg
    if total_mass_kg is not None:
        metadata.total_mass_kg = total_mass_kg
    if manufacturer is not None:
        metadata.manufacturer = manufacturer

    # Normalize curve
    points = normalize_curve(points, time_decimals, thrust_decimals)

    # Write output
    write_eng(eng_path, metadata, points, time_decimals, thrust_decimals)
