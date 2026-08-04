"""Shared flight visualization helpers used by both ui_app and optimization layers."""

from __future__ import annotations

from typing import Tuple

import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st


def _series_to_np(series_obj) -> np.ndarray:
    """Convert RocketPy Function or iterable to numpy array."""
    try:
        return np.asarray(series_obj.get_source(), dtype=float)
    except Exception:
        return np.asarray(series_obj, dtype=float)


def _to_1d(arr_like, *, column: int = 1) -> np.ndarray:
    """Convert array to 1D, extracting column when data comes from RocketPy."""
    arr = np.asarray(arr_like)
    if arr.ndim == 0:
        arr = arr.reshape(1)
    elif arr.ndim == 2 and arr.shape[1] == 2:
        arr = arr[:, column]
    elif arr.ndim > 1:
        squeezed = np.squeeze(arr)
        arr = squeezed if squeezed.ndim == 1 else np.ravel(arr)
    return arr.astype(float, copy=False)


def extract_flight_series(flight, elevation: float = 0.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return time, altitude AGL, and vertical velocity arrays aligned and 1-D."""
    z_raw = _series_to_np(getattr(flight, "z", []))
    t_series = _to_1d(z_raw, column=0)
    z_series = _to_1d(z_raw, column=1)
    z_series = z_series - elevation
    vz_series = _to_1d(_series_to_np(getattr(flight, "vz", [])), column=1)
    n = int(min(len(t_series), len(z_series), len(vz_series)))
    if n == 0:
        return np.array([]), np.array([]), np.array([])
    return t_series[:n], z_series[:n], vz_series[:n]


def plot_flight_results(t: np.ndarray, z: np.ndarray, vz: np.ndarray, *, key_suffix: str = "") -> None:
    """Plot altitude/velocity vs time if series are non-empty."""
    if t.size == 0:
        st.warning("Flight produced empty time series.")
        return
    df = pd.DataFrame({"time": t, "Altitude AGL (m)": z, "Vertical Velocity (m/s)": vz})
    st.plotly_chart(
        px.line(df, x="time", y="Altitude AGL (m)", title="Altitude AGL vs Time"),
        width="stretch",
        key=f"flight_alt_plot{key_suffix}",
    )
    st.plotly_chart(
        px.line(df, x="time", y="Vertical Velocity (m/s)", title="Vertical Velocity vs Time"),
        width="stretch",
        key=f"flight_vel_plot{key_suffix}",
    )


def render_rocket_view(flight) -> None:
    """Render a static rocket view using RocketPy's draw."""
    try:
        import matplotlib.pyplot as plt

        plt.close("all")
        result = getattr(flight, "rocket", None)
        if result is None:
            st.info("Rocket object not available for drawing.")
            return
        maybe_fig = result.draw()
        fig = maybe_fig if hasattr(maybe_fig, "savefig") else plt.gcf()
        st.pyplot(fig, clear_figure=True, width="stretch")
    except Exception as exc:
        st.info(f"Rocket view unavailable: {exc}")


def plot_additional_rocket_plots(flight, t_series: np.ndarray, *, key_suffix: str = "") -> None:
    """Try to render extra rocket/flight plots if available on the Flight object."""
    if t_series.size == 0:
        return
    plots: list[tuple[str, np.ndarray]] = []
    candidates = [
        ("ax", "Axial Acceleration"),
        ("ay", "Lateral Acceleration Y"),
        ("az", "Lateral Acceleration Z"),
        ("alpha", "Angle of Attack"),
        ("beta", "Sideslip Angle"),
        ("mach_number", "Mach Number"),
    ]
    for attr, label in candidates:
        series_obj = getattr(flight, attr, None)
        if series_obj is not None:
            try:
                vals = _to_1d(_series_to_np(series_obj), column=1)
                if vals.size > 0:
                    plots.append((label, vals))
            except Exception:
                pass
    if not plots:
        st.info("No additional flight plots available.")
        return
    for label, vals in plots:
        n = min(len(t_series), len(vals))
        if n > 0:
            df = pd.DataFrame({"time": t_series[:n], label: vals[:n]})
            st.plotly_chart(
                px.line(df, x="time", y=label, title=label),
                width="stretch",
                key=f"flight_{label.replace(' ', '_').lower()}{key_suffix}",
            )


