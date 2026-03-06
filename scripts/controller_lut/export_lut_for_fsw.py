#!/usr/bin/env python3
"""
Export controller LUT from .npz to a C++-readable binary format.

The binary format is designed for ControllerLUT.cpp:
  - Magic "LUTC" (4 bytes)
  - Version u8 = 1
  - num_axes u8, num_outputs u8
  - For each axis: name_len u8, name bytes, grid_len u32, grid (float64 LE)
  - For each output: name_len u8, name bytes, shape (num_axes × u32), data (float64 LE)

Usage:
  python -m scripts.controller_lut.export_lut_for_fsw --input output/lut/controller_lut_ddp_small.npz --output output/lut/controller_lut.bin
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np

MAGIC = b"LUTC"
VERSION = 1


def export_lut(npz_path: Path, out_path: Path) -> None:
    """Export .npz LUT to FSW binary format."""
    data = np.load(npz_path, allow_pickle=True)
    if "meta" not in data:
        raise ValueError(f"LUT file {npz_path} missing required 'meta' entry")

    meta_raw = data["meta"].tolist()
    meta = json.loads(meta_raw)
    axes_meta = meta.get("axes", [])
    outputs_meta = meta.get("outputs", [])

    axes: list[tuple[str, np.ndarray]] = []
    for ax in axes_meta:
        name = ax["name"]
        key = f"axes/{name}"
        if key not in data:
            raise ValueError(f"LUT missing axis '{name}'")
        axes.append((name, np.asarray(data[key], dtype=np.float64)))

    outputs: list[tuple[str, np.ndarray]] = []
    for out_name in outputs_meta:
        key = f"data/{out_name}"
        if key not in data:
            raise ValueError(f"LUT missing output '{out_name}'")
        arr = np.asarray(data[key], dtype=np.float64)
        if arr.shape != tuple(len(ax[1]) for ax in axes):
            raise ValueError(f"Output '{out_name}' shape {arr.shape} != axes")
        outputs.append((out_name, arr))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<BBB", VERSION, len(axes), len(outputs)))
        f.write(b"\x00")  # reserved

        for name, grid in axes:
            name_bytes = name.encode("utf-8")
            f.write(struct.pack("<B", min(len(name_bytes), 255)))
            f.write(name_bytes[:255])
            f.write(struct.pack("<I", len(grid)))
            f.write(grid.astype(np.float64).tobytes())

        for name, arr in outputs:
            name_bytes = name.encode("utf-8")
            f.write(struct.pack("<B", min(len(name_bytes), 255)))
            f.write(name_bytes[:255])
            shape = np.array(arr.shape, dtype=np.uint32)
            f.write(shape.tobytes())
            f.write(arr.astype(np.float64).tobytes())

    print(f"[export] Wrote {out_path} ({len(axes)} axes, {len(outputs)} outputs)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export controller LUT for FSW")
    parser.add_argument(
        "--input", "-i", type=Path, required=True, help="Input .npz LUT path"
    )
    parser.add_argument(
        "--output", "-o", type=Path, required=True, help="Output .bin path"
    )
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="Project root (for resolving relative paths)",
    )
    args = parser.parse_args()
    inp = args.input if args.input.is_absolute() else args.project_root / args.input
    out = args.output if args.output.is_absolute() else args.project_root / args.output
    export_lut(inp, out)


if __name__ == "__main__":
    main()
