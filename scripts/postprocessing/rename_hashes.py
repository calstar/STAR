#!/usr/bin/env python3
"""
rename_hashes.py
Renames legacy numeric Elodin CSV files to their actual string component names.
Elodin DB uses a 64-bit FNV-1a hash algorithm for component string names.
Before the ControllerService was updated to broadcast set_component_name packets,
the database exported CONTROLLER fields exclusively under their hash numbers.
This script computes the FNV-1a hash of all known controller variables and renames
matching files in the given export directory so analyze_run.py can plot them!
"""

import sys
import os
from pathlib import Path


def fnv1a_64(data: bytes) -> int:
    hash_val = 0xCBF29CE484222325
    prime = 0x100000001B3
    for byte in data:
        hash_val ^= byte
        hash_val = (hash_val * prime) & 0xFFFFFFFFFFFFFFFF
    return hash_val


def main():
    if len(sys.argv) < 2:
        print("Usage: ./rename_hashes.py <export_dir>")
        sys.exit(1)

    export_dir = Path(sys.argv[1])
    if not export_dir.exists():
        print(f"Error: Directory {export_dir} not found.")
        sys.exit(1)

    # All known controller fields that might be missing their names in old runs.
    controller_fields = [
        "CONTROLLER.actuation.timestamp_ns",
        "CONTROLLER.actuation.duty_F",
        "CONTROLLER.actuation.duty_O",
        "CONTROLLER.actuation.u_F_on",
        "CONTROLLER.actuation.u_O_on",
        "CONTROLLER.actuation.valid",
        "CONTROLLER.diagnostics.timestamp_ns",
        "CONTROLLER.diagnostics.F_ref",
        "CONTROLLER.diagnostics.MR_ref",
        "CONTROLLER.diagnostics.F_estimated",
        "CONTROLLER.diagnostics.MR_estimated",
        "CONTROLLER.diagnostics.P_ch",
        "CONTROLLER.diagnostics.cost",
        "CONTROLLER.diagnostics.solver_iters",
        "CONTROLLER.diagnostics.safety_filtered",
        "CONTROLLER.diagnostics.cutoff_active",
        "CONTROLLER.measurement.timestamp_ns",
        "CONTROLLER.measurement.P_copv",
        "CONTROLLER.measurement.P_reg",
        "CONTROLLER.measurement.P_u_fuel",
        "CONTROLLER.measurement.P_u_ox",
        "CONTROLLER.measurement.P_d_fuel",
        "CONTROLLER.measurement.P_d_ox",
        "CONTROLLER.measurement.P_ch_mp1",
        "CONTROLLER.measurement.P_ch_mp2",
        "CONTROLLER.state.timestamp_ns",
        "CONTROLLER.state.from_state",
        "CONTROLLER.state.to_state",
        "CONTROLLER.state.reason",
        "CONTROLLER.fire.timestamp_ns",
        "CONTROLLER.fire.fire_active",
        "CONTROLLER.fire.duty_F",
        "CONTROLLER.fire.duty_O",
    ]

    # Pre-compute hashes mapping to names
    hash_to_name = {}
    for name in controller_fields:
        h = fnv1a_64(name.encode("utf-8"))
        # The FNV hash in rust might be signed or unsigned matching.
        # Python computes unsigned 64-bit int. Elodin exports it as a signed or unsigned string.
        # Let's map both strings just in case!
        unsigned_str = str(h)
        signed_h = h - (1 << 64) if h >= (1 << 63) else h
        signed_str = str(signed_h)
        hash_to_name[unsigned_str] = name
        hash_to_name[signed_str] = name

    renamed_count = 0
    for file_path in export_dir.glob("*.csv"):
        filename = file_path.stem  # e.g. "1399096562196883797"
        if filename in hash_to_name:
            real_name = hash_to_name[filename]
            new_path = export_dir / f"{real_name}.csv"

            # Read and rename the column inside the CSV too!
            # Since elodin-db flatten makes the column name the hash as well.
            try:
                content = file_path.read_text(encoding="utf-8")
                lines = content.splitlines()
                if len(lines) > 0:
                    header = lines[0]
                    # Replace the hash with the real name in the header
                    new_header = header.replace(filename, real_name)
                    lines[0] = new_header

                new_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                file_path.unlink()  # delete old file
                print(f"✅ Renamed {filename}.csv -> {real_name}.csv")
                renamed_count += 1
            except Exception as e:
                print(f"Failed to process {file_path.name}: {e}")

    print(f"\nSuccessfully recovered {renamed_count} controller variables!")


if __name__ == "__main__":
    main()
