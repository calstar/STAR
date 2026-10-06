"""
Feature Engineering for IMU Machine Learning Core (MLC).

Computes rolling window statistical features matching STMicroelectronics MLC hardware:
- Vector norms: accel_norm, gyro_norm, mag_norm
- Statistical operators across window:
    * mean:        Arithmetic mean over window
    * var:         Sample variance over window
    * ptp:         Peak-to-peak (Max - Min) amplitude over window
    * min:         Minimum value over window
    * max:         Maximum value over window
    * diff:        Window delta / gradient (last - first sample in window)
"""

from typing import List, Tuple
import numpy as np
import pandas as pd


# Primary sensor channels
BASE_CHANNELS = [
    "accel_x", "accel_y", "accel_z",
    "gyro_x", "gyro_y", "gyro_z",
    "mag_x", "mag_y", "mag_z",
]


def compute_vector_norms(df: pd.DataFrame) -> pd.DataFrame:
    """Computes triaxial vector magnitudes (norms) for Accel, Gyro, and Mag."""
    df_out = df.copy()
    df_out["accel_norm"] = np.sqrt(
        df_out["accel_x"] ** 2 + df_out["accel_y"] ** 2 + df_out["accel_z"] ** 2
    )
    df_out["gyro_norm"] = np.sqrt(
        df_out["gyro_x"] ** 2 + df_out["gyro_y"] ** 2 + df_out["gyro_z"] ** 2
    )
    df_out["mag_norm"] = np.sqrt(
        df_out["mag_x"] ** 2 + df_out["mag_y"] ** 2 + df_out["mag_z"] ** 2
    )
    return df_out


def compute_rolling_mlc_features(
    df: pd.DataFrame,
    window_size: int = 20,
) -> Tuple[pd.DataFrame, List[str]]:
    """
    Computes rolling window statistical features matching ST MLC sensor capabilities.

    Parameters:
        df: Input DataFrame with raw sensor channels.
        window_size: Number of samples in rolling window (default: 20 samples = 0.20s at 100 Hz).

    Returns:
        DataFrame containing computed feature columns, and the list of feature column names.
    """
    df_data = compute_vector_norms(df)

    # All channels to extract features from
    channels = [
        "accel_x", "accel_y", "accel_z", "accel_norm",
        "gyro_x", "gyro_y", "gyro_z", "gyro_norm",
        "mag_x", "mag_y", "mag_z", "mag_norm",
    ]

    features_dict = {}

    for ch in channels:
        series = df_data[ch]
        rolling = series.rolling(window=window_size, min_periods=1)

        # 1. Mean
        r_mean = rolling.mean()
        features_dict[f"{ch}_mean"] = r_mean

        # 2. Variance
        r_var = rolling.var().fillna(0.0)
        features_dict[f"{ch}_var"] = r_var

        # 3. Min & Max
        r_min = rolling.min()
        r_max = rolling.max()
        features_dict[f"{ch}_min"] = r_min
        features_dict[f"{ch}_max"] = r_max

        # 4. Peak-to-Peak (ptp)
        features_dict[f"{ch}_ptp"] = r_max - r_min

        # 5. Diff (delta over window: current minus value window_size ago)
        r_diff = series.diff(periods=window_size // 2).fillna(0.0)
        features_dict[f"{ch}_diff"] = r_diff

    feature_df = pd.DataFrame(features_dict, index=df.index)
    feature_names = list(feature_df.columns)

    return feature_df, feature_names
