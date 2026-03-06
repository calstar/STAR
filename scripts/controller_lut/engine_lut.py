from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence

import json
import numpy as np


@dataclass
class LoadedAxis:
    """Runtime representation of a single LUT axis."""

    name: str
    values: np.ndarray  # 1D monotonically increasing grid
    units: str = ""
    description: str = ""


class EngineLUT:
    """
    N-dimensional engine/controller lookup table with multilinear interpolation.

    This class is intentionally independent of engine_sim internal types so it
    can be used from both Python tooling and (via a thin wrapper) C++ FSW.
    """

    def __init__(self, path: str | Path):
        path = Path(path)
        data = np.load(path, allow_pickle=True)

        if "meta" not in data:
            raise ValueError(f"LUT file {path} is missing required 'meta' entry")

        meta_raw = data["meta"].tolist()
        meta: Dict[str, Any] = json.loads(meta_raw)

        axes_meta: Sequence[Mapping[str, Any]] = meta.get("axes", [])
        self._axes: List[LoadedAxis] = []
        for axis_meta in axes_meta:
            name = axis_meta["name"]
            key = f"axes/{name}"
            if key not in data:
                raise ValueError(
                    f"LUT file {path} missing axis array for '{name}' (key '{key}')"
                )
            values = np.asarray(data[key], dtype=float)
            self._axes.append(
                LoadedAxis(
                    name=name,
                    values=values,
                    units=axis_meta.get("units", ""),
                    description=axis_meta.get("description", ""),
                )
            )

        self._axis_name_to_index = {axis.name: i for i, axis in enumerate(self._axes)}

        # Load data arrays for each output quantity
        outputs_meta: Iterable[str] = meta.get("outputs", [])
        self._outputs: Dict[str, np.ndarray] = {}
        expected_shape: tuple[int, ...] | None = None

        for out_name in outputs_meta:
            key = f"data/{out_name}"
            if key not in data:
                raise ValueError(
                    f"LUT file {path} missing data array for output '{out_name}' (key '{key}')"
                )
            arr = np.asarray(data[key], dtype=float)
            if expected_shape is None:
                expected_shape = arr.shape
            elif arr.shape != expected_shape:
                raise ValueError(
                    f"All output arrays must have the same shape. "
                    f"Got {arr.shape} for '{out_name}', expected {expected_shape}."
                )
            self._outputs[out_name] = arr

        # Validate shape consistency with axes
        axis_sizes = tuple(len(axis.values) for axis in self._axes)
        if expected_shape is not None and expected_shape != axis_sizes:
            raise ValueError(
                f"LUT data shape {expected_shape} does not match axes sizes {axis_sizes}"
            )

        self.meta = meta
        self.path = path

    @property
    def axes(self) -> List[LoadedAxis]:
        return list(self._axes)

    @property
    def outputs(self) -> List[str]:
        return list(self._outputs.keys())

    def evaluate(self, point: Mapping[str, float]) -> Dict[str, float]:
        """
        Evaluate the LUT at an arbitrary point using multilinear interpolation.

        Parameters
        ----------
        point:
            Mapping from axis name -> coordinate value in that axis' units.
            All axes defined in the LUT must be present; extra keys are ignored.

        Returns
        -------
        dict:
            Mapping from output name -> interpolated value.
        """
        if not self._axes:
            raise ValueError("LUT has no axes defined")

        # Pre-compute indices and interpolation weights for each axis
        indices: List[tuple[int, int]] = []
        weights: List[tuple[float, float]] = []

        for axis in self._axes:
            if axis.name not in point:
                raise KeyError(
                    f"Point is missing coordinate for axis '{axis.name}'. "
                    f"Required axes: {list(self._axis_name_to_index.keys())}"
                )

            x = float(point[axis.name])
            grid = axis.values

            # Find insertion point
            hi = int(np.searchsorted(grid, x))
            if hi <= 0:
                hi = 1
            if hi >= len(grid):
                hi = len(grid) - 1
            lo = hi - 1

            x0 = grid[lo]
            x1 = grid[hi]
            if x1 == x0:
                t = 0.0
            else:
                t = float((x - x0) / (x1 - x0))

            # Clamp interpolation parameter
            if t < 0.0:
                t = 0.0
            elif t > 1.0:
                t = 1.0

            indices.append((lo, hi))
            weights.append((1.0 - t, t))

        n_axes = len(self._axes)
        if n_axes > 20:
            raise ValueError(
                f"Too many axes for multilinear interpolation: {n_axes} (max 20)"
            )

        result: Dict[str, float] = {name: 0.0 for name in self._outputs.keys()}

        # Enumerate all 2^N corners of the hyper-rectangle
        n_corners = 1 << n_axes
        for corner in range(n_corners):
            w = 1.0
            idx: List[int] = []

            for axis_idx in range(n_axes):
                lo, hi = indices[axis_idx]
                w0, w1 = weights[axis_idx]
                if (corner >> axis_idx) & 1:
                    idx.append(hi)
                    w *= w1
                else:
                    idx.append(lo)
                    w *= w0

                if w == 0.0:
                    break

            if w == 0.0:
                continue

            idx_tuple = tuple(idx)
            for out_name, arr in self._outputs.items():
                val = arr[idx_tuple]
                if np.isfinite(val):
                    result[out_name] += w * float(val)

        return result
