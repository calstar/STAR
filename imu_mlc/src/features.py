"""
Pad/idle MLC features for ISM330DHCX (6-DOF only).

v1 feature set (alignment plan):
  - accel_norm_var: variance of |a| over the window
  - accel_z_zcr:    zero-crossing rate of mean-removed a_z

No magnetometer channels (chip has none). Gyro optional for logging only.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

import numpy as np
import pandas as pd

# Allowed MLC ODRs (EMB_FUNC_ODR_CFG_C); independent of firmware 833 Hz sensor ODR.
MLC_ODR_HZ_CHOICES: Sequence[float] = (12.5, 26.0, 52.0, 104.0)

DEFAULT_MLC_ODR_HZ = 26.0
DEFAULT_WINDOW_S = 1.0

PAD_FEATURE_NAMES = ["accel_norm_var", "accel_z_zcr"]


def window_samples(
    odr_hz: float = DEFAULT_MLC_ODR_HZ, window_s: float = DEFAULT_WINDOW_S
) -> int:
    if odr_hz not in MLC_ODR_HZ_CHOICES:
        raise ValueError(f"odr_hz must be one of {MLC_ODR_HZ_CHOICES}, got {odr_hz}")
    n = int(round(odr_hz * window_s))
    return max(n, 2)


def _zero_crossing_rate(x: np.ndarray) -> float:
    if x.size < 2:
        return 0.0
    x = x - np.mean(x)
    signs = np.sign(x)
    # Treat exact zeros as previous sign to avoid spurious crossings.
    for i in range(1, signs.size):
        if signs[i] == 0:
            signs[i] = signs[i - 1]
    crossings = np.count_nonzero(signs[1:] * signs[:-1] < 0)
    return float(crossings) / float(x.size - 1)


def compute_pad_mlc_features(
    df: pd.DataFrame,
    odr_hz: float = DEFAULT_MLC_ODR_HZ,
    window_s: float = DEFAULT_WINDOW_S,
) -> Tuple[pd.DataFrame, List[str]]:
    """
    Rolling pad/idle features at MLC ODR.

    Expects columns accel_x, accel_y, accel_z in g (training scale = firmware ±16 g).
    """
    for col in ("accel_x", "accel_y", "accel_z"):
        if col not in df.columns:
            raise KeyError(f"missing required column '{col}'")

    w = window_samples(odr_hz, window_s)
    accel_norm = np.sqrt(
        df["accel_x"].to_numpy(dtype=float) ** 2
        + df["accel_y"].to_numpy(dtype=float) ** 2
        + df["accel_z"].to_numpy(dtype=float) ** 2
    )
    accel_z = df["accel_z"].to_numpy(dtype=float)

    n = len(df)
    var_out = np.zeros(n, dtype=float)
    zcr_out = np.zeros(n, dtype=float)

    for i in range(n):
        start = max(0, i - w + 1)
        segment_n = accel_norm[start : i + 1]
        segment_z = accel_z[start : i + 1]
        var_out[i] = float(np.var(segment_n, ddof=1)) if segment_n.size > 1 else 0.0
        zcr_out[i] = _zero_crossing_rate(segment_z)

    feature_df = pd.DataFrame(
        {
            "accel_norm_var": var_out,
            "accel_z_zcr": zcr_out,
        },
        index=df.index,
    )
    return feature_df, list(PAD_FEATURE_NAMES)
