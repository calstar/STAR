"""Engine wrapper backed by a precomputed LUT.

Stems from engine config + tank pressure range. Provides everything the robust DDP
needs (F, MR, mdot, injector_dp, stability) via fast multilinear interpolation
instead of calling the physics pipeline.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np

from .engine_wrapper import EngineEstimate


class EngineLUTWrapper:
    """EngineWrapper interface backed by a precomputed engine performance LUT.

    Loads .npz from generate_controller_lut (engine-only mode). Axes: P_u_fuel, P_u_ox.
    Outputs: F, MR, P_ch, mdot_F, mdot_O, injector_dp_F, injector_dp_O, stability_score,
    injector_stiffness_ok.
    """

    def __init__(self, lut_path: str | Path):
        path = Path(lut_path)
        data = np.load(path, allow_pickle=True)
        if "meta" not in data:
            raise ValueError(f"LUT {path} missing 'meta' entry")
        meta = json.loads(data["meta"].tolist())
        self._axes = []
        for ax in meta.get("axes", []):
            name = ax["name"]
            key = f"axes/{name}"
            if key not in data:
                raise ValueError(f"LUT missing axis '{name}'")
            self._axes.append({"name": name, "values": np.asarray(data[key], dtype=float)})
        self._outputs: Dict[str, np.ndarray] = {}
        for out_name in meta.get("outputs", []):
            key = f"data/{out_name}"
            if key in data:
                self._outputs[out_name] = np.asarray(data[key], dtype=float)
        self.meta = meta
        self.path = path

    def estimate_from_pressures(
        self,
        P_d_F: float,
        P_d_O: float,
        use_cache: bool = True,
    ) -> EngineEstimate:
        """
        Estimate engine performance from tank/ullage pressures via LUT lookup.

        Parameters P_d_F, P_d_O are tank pressures (P_u_fuel, P_u_ox).
        """
        point = {"P_u_fuel": P_d_F, "P_u_ox": P_d_O}
        out = self._evaluate(point)

        stability_metrics: Optional[Dict[str, Any]] = None
        if "stability_score" in out or "injector_stiffness_ok" in out:
            stability_metrics = {}
            if "stability_score" in out and np.isfinite(out["stability_score"]):
                stability_metrics["stability_score"] = out["stability_score"]
            if "injector_stiffness_ok" in out:
                ok = out["injector_stiffness_ok"]
                stability_metrics["injector_stiffness_ok"] = bool(ok > 0.5) if np.isfinite(ok) else False

        return EngineEstimate(
            P_ch=float(out.get("P_ch", np.nan)),
            F=float(out.get("F", np.nan)),
            mdot_F=float(out.get("mdot_F", np.nan)),
            mdot_O=float(out.get("mdot_O", np.nan)),
            MR=float(out.get("MR", np.nan)),
            injector_dp_F=float(out.get("injector_dp_F", np.nan)),
            injector_dp_O=float(out.get("injector_dp_O", np.nan)),
            stability_metrics=stability_metrics,
            diagnostics=None,
        )

    def _evaluate(self, point: Dict[str, float]) -> Dict[str, float]:
        """Multilinear interpolation at point."""
        n = len(self._axes)
        indices = []
        weights = []
        for ax in self._axes:
            name = ax["name"]
            x = point.get(name, np.nan)
            grid = ax["values"]
            hi = int(np.searchsorted(grid, x))
            if hi <= 0:
                hi = 1
            if hi >= len(grid):
                hi = len(grid) - 1
            lo = hi - 1
            x0, x1 = grid[lo], grid[hi]
            t = 0.0 if x1 == x0 else float(np.clip((x - x0) / (x1 - x0), 0.0, 1.0))
            indices.append((lo, hi))
            weights.append((1.0 - t, t))

        result = {k: 0.0 for k in self._outputs}
        n_corners = 1 << n
        for corner in range(n_corners):
            w = 1.0
            idx = []
            for i in range(n):
                lo, hi = indices[i]
                w0, w1 = weights[i]
                if (corner >> i) & 1:
                    idx.append(hi)
                    w *= w1
                else:
                    idx.append(lo)
                    w *= w0
            if w < 1e-10:
                continue
            for name, arr in self._outputs.items():
                val = arr[tuple(idx)]
                if np.isfinite(val):
                    result[name] += w * float(val)
        return result
