#!/usr/bin/env python3
"""
Sense conversions: K-type thermocouple, Pt100/Pt1000 RTD, load cell.
Ported from web-gui/frontend/lib/sense-conversions.ts (DiabloAvionics sense_testing_gui.py).

Used by calibration_server.py as fallback when RobustCalibrationFramework has no calibration
points, or for quick raw→physical conversion. Single source of truth for calibration service.
"""

from __future__ import annotations

import math
from typing import Optional

# K-type thermocouple: voltage (V) -> temperature (°C), ITS-90 rational polynomial (Mosaic/NIST-style)
# Each row: (v_min_mV, v_max_mV, T0, V0, p1, p2, p3, p4, q1, q2, q3)
K_TYPE_INVERSE: list[tuple[float, ...]] = [
    (
        -6.404,
        -3.554,
        -121.47164,
        -4.1790858,
        36.069513,
        30.722076,
        7.791386,
        0.52593997,
        0.93939547,
        0.2779128,
        0.02516334,
    ),
    (
        -3.554,
        4.096,
        -8.7935962,
        -0.34489914,
        25.678719,
        -0.49887904,
        -0.44705222,
        -0.044869202,
        0.00023893439,
        -0.02039775,
        -0.0018424107,
    ),
    (
        4.096,
        16.397,
        310.18976,
        12.631386,
        24.061949,
        4.0158622,
        0.26853917,
        -0.0097188544,
        0.16995872,
        0.011413069,
        -0.00039275155,
    ),
    (
        16.397,
        33.275,
        605.72562,
        25.148718,
        23.539401,
        0.046547228,
        0.0134444,
        0.0005923685,
        0.00083445513,
        0.0004612144,
        0.00002548812,
    ),
    (
        33.275,
        69.553,
        1018.4705,
        41.99385,
        25.783239,
        -1.8363403,
        0.05617666,
        0.000185324,
        -0.074803355,
        0.002384186,
        0,
    ),
]

# Pt100/Pt1000 RTD: R(T) = R0*(1 + A*T + B*T^2) for T >= 0; solve for T (IEC 60751)
PT_A = 3.9083e-3
PT_B = -5.775e-7
PT1000_R0 = 1000.0
PT100_R0 = 100.0
RTD_EXCITATION_UA = 1000.0

ADC32_FULL_SCALE = 2147483648.0


def _uint32_to_int32(u: int) -> int:
    """Interpret uint32 as int32 (for 32-bit signed ADC codes)."""
    u = u & 0xFFFFFFFF
    return u - 0x100000000 if u > 0x7FFFFFFF else u


# ── K-type thermocouple ────────────────────────────────────────────────────


def k_type_voltage_to_temp_c(v_volts: float) -> Optional[float]:
    """
    Convert K-type thermocouple voltage (V) to temperature (°C).
    Returns None if out of range.
    """
    v_mv = v_volts * 1000.0
    for row in K_TYPE_INVERSE:
        v_lo, v_hi, t0, v0, p1, p2, p3, p4, q1, q2, q3 = row
        if v_lo <= v_mv <= v_hi:
            x = v_mv - v0
            num = p1 + x * (p2 + x * (p3 + x * p4))
            den = 1.0 + x * (q1 + x * (q2 + x * q3))
            if abs(den) < 1e-20:
                return None
            return t0 + (x * num) / den
    return None


def k_type_adc_to_temp_c(
    adc_code: int,
    adc_ref_voltage: float = 2.5,
    adc_full_scale: float = ADC32_FULL_SCALE,
) -> Optional[float]:
    """
    Convert K-type TC raw ADC code to temperature (°C).
    Assumes 32-bit signed ADC: voltage = (adc / adc_full_scale) * adc_ref_voltage.
    """
    code = _uint32_to_int32(adc_code & 0xFFFFFFFF)
    v_volts = (code / adc_full_scale) * adc_ref_voltage
    return k_type_voltage_to_temp_c(v_volts)


# ── RTD (Pt100/Pt1000) ──────────────────────────────────────────────────────


def rtd_resistance_to_temp_c(r_ohm: float, r0: float = PT1000_R0) -> Optional[float]:
    """
    Convert RTD resistance (Ω) to temperature (°C). IEC 60751.
    Supports Pt100 (r0=100) and Pt1000 (r0=1000) via r0 parameter.
    Returns None if out of range.
    """
    rr = r_ohm / r0
    d = PT_A * PT_A - 4 * PT_B * (1.0 - rr)
    if d < 0:
        return None
    sqrt_d = math.sqrt(d)
    t = (-PT_A + sqrt_d) / (2 * PT_B)
    if -400 <= t <= 1100:
        return t
    return None


def rtd_voltage_to_temp_c(
    v_volts: float,
    r0: float = PT1000_R0,
    excitation_ua: float = RTD_EXCITATION_UA,
) -> Optional[float]:
    """
    Convert RTD differential voltage (V) to temperature (°C).
    excitation_ua = IDAC current in µA (default 1000).
    """
    if excitation_ua <= 0:
        return None
    r_ohm = (abs(v_volts) * 1e6) / excitation_ua
    return rtd_resistance_to_temp_c(r_ohm, r0)


def raw_rtd_to_temp_c(
    raw_value: float,
    r0: float = PT100_R0,
    scale_to_ohms: float = 0.001,
) -> Optional[float]:
    """
    Convert raw resistance counts (often 24-bit or 32-bit milliohms) to temperature (°C).
    Default assumes value is milliohms (scale_to_ohms=0.001).
    """
    if raw_value is None or not math.isfinite(raw_value):
        return None
    r_ohm = raw_value * scale_to_ohms
    return rtd_resistance_to_temp_c(r_ohm, r0)


def raw_rtd_adc_to_temp_c(
    adc_code: int,
    r0: float = PT1000_R0,
    excitation_ua: float = RTD_EXCITATION_UA,
    adc_ref_voltage: float = 2.5,
    adc_full_scale: float = ADC32_FULL_SCALE,
) -> Optional[float]:
    """
    Convert RTD raw ADC code to temperature (°C).
    Assumes ADC measures differential voltage across RTD with known excitation current.
    """
    code = _uint32_to_int32(adc_code & 0xFFFFFFFF)
    v_volts = (code / adc_full_scale) * adc_ref_voltage
    return rtd_voltage_to_temp_c(v_volts, r0, excitation_ua)


# ── Load cell ──────────────────────────────────────────────────────────────


def code_to_force(
    code_uint32: int,
    sensitivity_mv_per_v: float,
    pga_gain: float,
    full_scale_value: float,
) -> Optional[float]:
    """
    Ratiometric load-cell force from raw 32-bit ADC code.
    Reference = excitation, so voltage cancels.
    full_scale_value is in desired units (e.g. lbf, kg).
    Returns None if invalid params.
    """
    if pga_gain <= 0 or sensitivity_mv_per_v <= 0:
        return None
    code_int32 = _uint32_to_int32(code_uint32 & 0xFFFFFFFF)
    code_fs = (sensitivity_mv_per_v / 1000.0) * pga_gain * ADC32_FULL_SCALE
    if code_fs <= 0:
        return None
    return (code_int32 / code_fs) * full_scale_value


# ── Convenience: raw conversion by sensor type ───────────────────────────────


def raw_to_physical(
    stype: str,
    raw_value: int,
    *,
    # RTD (raw is ADC counts; convert via voltage)
    rtd_r0: float = PT1000_R0,
    rtd_adc_ref_v: float = 2.5,
    rtd_excitation_ua: float = RTD_EXCITATION_UA,
    # TC
    tc_adc_ref_v: float = 2.5,
    # LC
    lc_sensitivity_mv_per_v: float = 2.0,
    lc_pga_gain: float = 128.0,
    lc_full_scale_value: float = 100.0,
) -> Optional[float]:
    """
    Convert raw value to physical unit by sensor type.
    Returns °C for TC/RTD, force (lbf/kg) for LC, or None if conversion fails.
    RTD raw_value is ADC counts (not milliohms); uses raw_rtd_adc_to_temp_c.
    """
    if stype == "RTD":
        return raw_rtd_adc_to_temp_c(
            raw_value,
            r0=rtd_r0,
            adc_ref_voltage=rtd_adc_ref_v,
            excitation_ua=rtd_excitation_ua,
        )
    if stype == "TC":
        return k_type_adc_to_temp_c(raw_value, adc_ref_voltage=tc_adc_ref_v)
    if stype == "LC":
        return code_to_force(
            raw_value,
            sensitivity_mv_per_v=lc_sensitivity_mv_per_v,
            pga_gain=lc_pga_gain,
            full_scale_value=lc_full_scale_value,
        )
    return None
