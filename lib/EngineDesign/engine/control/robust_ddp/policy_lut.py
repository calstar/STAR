"""Controller policy look-up table (LUT) for DDP stack.

Precomputes optimal control u = [u_F, u_O] over a grid of (P_u_F, P_u_O, F_ref, MR_ref)
and provides fast runtime interpolation. Use when online DDP is too slow.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple, List
import numpy as np

from .dynamics import N_CONTROL, IDX_P_U_F, IDX_P_U_O


def _make_interpolator(
    axes: List[np.ndarray],
    u_grid: np.ndarray,
    bounds_mode: str = "clip",
) -> "RegularGridInterpolator":
    """Create RegularGridInterpolator for u lookup."""
    from scipy.interpolate import RegularGridInterpolator

    return RegularGridInterpolator(
        axes,
        u_grid,
        method="linear",
        bounds_error=False,
        fill_value=None,
    )


class PolicyLUT:
    """Look-up table for controller policy u = f(P_u_F, P_u_O, F_ref, MR_ref)."""

    def __init__(
        self,
        axes: List[np.ndarray],
        u_grid: np.ndarray,
        bounds_mode: str = "clip",
    ):
        """
        Parameters:
        -----------
        axes : List[np.ndarray]
            Grid axes [P_u_F, P_u_O, F_ref, MR_ref], each 1D sorted
        u_grid : np.ndarray
            Control values shape (n_P_u_F, n_P_u_O, n_F_ref, n_MR_ref, N_CONTROL)
        bounds_mode : str
            "clip" = clamp query to grid bounds; "nearest" = use nearest boundary value
        """
        self.axes = axes
        self.u_grid = u_grid
        self.bounds_mode = bounds_mode

        # Build interpolator for each control dimension
        self._interp_u_F = _make_interpolator(
            axes, u_grid[..., 0], bounds_mode
        )
        self._interp_u_O = _make_interpolator(
            axes, u_grid[..., 1], bounds_mode
        )

    def lookup(
        self,
        P_u_F: float,
        P_u_O: float,
        F_ref: float,
        MR_ref: float,
    ) -> np.ndarray:
        """
        Interpolate optimal control at query point.

        Parameters:
        -----------
        P_u_F : float
            Fuel ullage pressure [Pa]
        P_u_O : float
            Oxidizer ullage pressure [Pa]
        F_ref : float
            Reference thrust [N]
        MR_ref : float
            Reference mixture ratio

        Returns:
        --------
        u : np.ndarray, shape (N_CONTROL,)
            [u_F, u_O] in [0, 1]
        """
        point = np.array([[P_u_F, P_u_O, F_ref, MR_ref]], dtype=np.float64)

        if self.bounds_mode == "clip":
            for i, ax in enumerate(self.axes):
                point[0, i] = np.clip(point[0, i], ax.min(), ax.max())

        u_F = float(self._interp_u_F(point)[0])
        u_O = float(self._interp_u_O(point)[0])

        # Handle NaN from extrapolation
        if not np.isfinite(u_F):
            u_F = 0.1
        if not np.isfinite(u_O):
            u_O = 0.1

        u = np.array([u_F, u_O], dtype=np.float64)
        return np.clip(u, 0.0, 1.0)

    def save(self, filepath: str) -> None:
        """Save LUT to .npz file."""
        path = Path(filepath)
        path.parent.mkdir(parents=True, exist_ok=True)

        np.savez_compressed(
            path,
            axes_0=self.axes[0],
            axes_1=self.axes[1],
            axes_2=self.axes[2],
            axes_3=self.axes[3],
            u_grid=self.u_grid,
            bounds_mode=np.array([self.bounds_mode], dtype=object),
        )

    @classmethod
    def load(cls, filepath: str) -> "PolicyLUT":
        """Load LUT from .npz file."""
        data = np.load(filepath, allow_pickle=True)
        axes = [
            data["axes_0"],
            data["axes_1"],
            data["axes_2"],
            data["axes_3"],
        ]
        u_grid = data["u_grid"]
        bounds_mode = str(data["bounds_mode"][0]) if "bounds_mode" in data else "clip"
        return cls(axes=axes, u_grid=u_grid, bounds_mode=bounds_mode)

    @property
    def grid_shape(self) -> Tuple[int, ...]:
        """Return grid shape (n_P_u_F, n_P_u_O, n_F_ref, n_MR_ref)."""
        return self.u_grid.shape[:-1]
