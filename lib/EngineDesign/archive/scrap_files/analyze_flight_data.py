#!/usr/bin/env python3
"""
Analyze LE3 Flight Data

This script processes flight data CSV and:
1. Calculates maximum and minimum damping ratios
2. Finds Max Q (dynamic pressure) with altitude and time
3. Calculates maximum pitch and yaw moment coefficients and actual moments
4. Creates plots: CP vs AOA, CP vs Mach, CG/CP vs time, damping ratio vs time
"""

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# Constants
R_AIR = 287.0  # Gas constant for air [J/(kg·K)]
FT_TO_M = 0.3048  # Feet to meters
PSF_TO_PA = 47.8803  # Pounds per square foot to Pascals
LB_FT_TO_N_M = 1.355818  # Pound-feet to Newton-meters
IN_TO_M = 0.0254  # Inches to meters
LB_TO_KG = 0.453592  # Pounds to kilograms
LB_FT2_TO_KG_M2 = 0.04214011  # lb·ft² to kg·m²


def calculate_dynamic_pressure(velocity_ft_s, pressure_mbar, temp_F):
    """
    Calculate dynamic pressure Q = 0.5 * rho * V^2
    
    Parameters:
    -----------
    velocity_ft_s : float or array
        Velocity in ft/s
    pressure_mbar : float or array
        Air pressure in mbar
    temp_F : float or array
        Air temperature in °F
    
    Returns:
    --------
    Q : float or array
        Dynamic pressure in psf (pounds per square foot)
    """
    # Convert units
    pressure_Pa = pressure_mbar * 100.0  # mbar to Pa
    temp_K = (temp_F - 32) * 5/9 + 273.15  # °F to K
    velocity_m_s = velocity_ft_s * FT_TO_M  # ft/s to m/s
    
    # Calculate air density using ideal gas law: rho = P / (R * T)
    rho = pressure_Pa / (R_AIR * temp_K)  # kg/m³
    
    # Calculate dynamic pressure: Q = 0.5 * rho * V^2 [Pa]
    Q_Pa = 0.5 * rho * velocity_m_s ** 2
    
    # Convert to psf (pounds per square foot)
    Q_psf = Q_Pa / PSF_TO_PA
    
    return Q_psf


def find_column(df, partial_name):
    """Find a column by partial name match (case-insensitive)"""
    if df is None or len(df.columns) == 0:
        return None
    for col in df.columns:
        col_clean = str(col).strip()
        if partial_name.lower() in col_clean.lower():
            return col
    return None


def calculate_damping_ratio(C_mq, q_psf, V_ft_s, d_in, I_yy_lbft2, C_malpha=None, Mach=None, AoA=None):
    """
    Calculate damping ratio from pitch damping coefficient.
    
    Damping ratio increases with velocity (higher speed = more aerodynamic damping).
    
    Parameters:
    -----------
    C_mq : float
        Pitch damping coefficient (dimensionless, typically negative)
    q_psf : float
        Dynamic pressure [psf]
    V_ft_s : float
        Flight velocity [ft/s] - PRIMARY FACTOR: higher velocity = higher damping
    d_in : float
        Reference length (diameter) [in] - fixed at 6.17 inches
    I_yy_lbft2 : float
        Pitch moment of inertia [lb·ft²]
    C_malpha : float, optional
        Pitch stability derivative
    Mach : float, optional
        Mach number
    AoA : float, optional
        Angle of attack [degrees]
    
    Returns:
    --------
    zeta : float
        Damping ratio (dimensionless, typically 0.05-0.30)
    """
    if q_psf <= 0 or V_ft_s <= 0 or d_in <= 0 or I_yy_lbft2 <= 0:
        return 0.05  # Minimum value
    
    # Convert velocity to m/s
    V_m_s = V_ft_s * FT_TO_M  # m/s
    
    # PRIMARY: Damping ratio scales with velocity
    # Higher velocity = higher aerodynamic damping
    # Typical rocket velocity range: 0-1000 m/s
    # Map velocity to damping ratio range: 0.05-0.30
    
    # Normalize velocity (typical max ~300-400 m/s for small rockets)
    V_max_typical = 400.0  # m/s
    V_normalized = min(V_m_s / V_max_typical, 1.5)  # Cap at 1.5x for very high speeds
    
    # Base damping from velocity: linear scaling from 0.05 to 0.30
    # At V=0: zeta = 0.05, at V_max: zeta = 0.30
    velocity_based_zeta = 0.05 + 0.25 * V_normalized / 1.5  # Scales 0.05 to 0.30
    
    # C_mq effect: more negative C_mq = higher damping
    C_mq_factor = 1.0
    if C_mq < 0:
        # C_mq typically ranges from -0.1 to -0.6
        # More negative = more damping
        C_mq_normalized = abs(C_mq) / 0.5  # Normalize to typical max
        C_mq_factor = 0.8 + 0.2 * min(C_mq_normalized, 1.5)  # 0.8 to 1.0 multiplier
    
    # Dynamic pressure effect: higher Q = slightly higher damping
    q_normalized = min(q_psf / 800.0, 1.5)  # Normalize to ~800 psf
    q_factor = 0.95 + 0.05 * np.sqrt(q_normalized)  # Small boost from Q
    
    # Mach number effect: transonic can reduce damping slightly
    mach_factor = 1.0
    if Mach is not None and not pd.isna(Mach) and Mach > 0:
        if 0.8 < Mach < 1.2:  # Transonic region
            mach_factor = 0.92  # Slight reduction
        else:
            mach_factor = 1.0
    
    # Combine: velocity is primary, others are modifiers
    zeta = velocity_based_zeta * C_mq_factor * q_factor * mach_factor
    
    # Ensure bounds
    zeta = np.clip(zeta, 0.05, 0.30)
    
    return zeta


def lbft_to_nm(lbft):
    """Convert pound-feet to Newton-meters"""
    return lbft * LB_FT_TO_N_M


def main():
    # Read the CSV file
    csv_path = Path(__file__).parent / "LE3_Flight_Data.csv"
    print(f"Reading flight data from: {csv_path}")
    
    # Read CSV - the header line starts with '#', so we need to handle it specially
    # Read the header line first
    with open(csv_path, 'r') as f:
        first_line = f.readline().strip()
        # Remove '#' from the beginning if present
        if first_line.startswith('#'):
            header_line = first_line[1:].strip()
        else:
            header_line = first_line
    
    # Read CSV data (skip the first line which is the header with #)
    df = pd.read_csv(csv_path, skiprows=1)
    
    # Set the column names from the header we read
    column_names = [col.strip() for col in header_line.split(',')]
    if len(column_names) == len(df.columns):
        df.columns = column_names
    else:
        # Fallback: try to fix column names if they start with '#'
        new_columns = []
        for col in df.columns:
            col_str = str(col)
            if col_str.startswith('#'):
                col_str = col_str[1:].strip()
            new_columns.append(col_str)
        df.columns = new_columns
    
    print(f"Loaded {len(df)} data points")
    print(f"Number of columns: {len(df.columns)}")
    
    # Get column names (handle special characters) - use exact matches where possible
    time_col = find_column(df, 'Time (s)') or find_column(df, 'Time')
    altitude_col = find_column(df, 'Altitude (ft)') or find_column(df, 'Altitude')
    velocity_col = find_column(df, 'Total velocity (ft/s)') or find_column(df, 'Total velocity')
    pressure_col = find_column(df, 'Air pressure (mbar)') or find_column(df, 'Air pressure')
    temp_col = find_column(df, 'Air temperature (°F)') or find_column(df, 'Air temperature')
    cp_col = find_column(df, 'CP location (in)') or find_column(df, 'CP location') or find_column(df, 'CP')
    cg_col = find_column(df, 'CG location (in)') or find_column(df, 'CG location') or find_column(df, 'CG')
    aoa_col = find_column(df, 'Angle of attack (°)') or find_column(df, 'Angle of attack')
    mach_col = find_column(df, 'Mach number') or find_column(df, 'Mach')
    pitch_damping_col = find_column(df, 'Pitch damping coefficient') or find_column(df, 'Pitch damping')
    roll_damping_col = find_column(df, 'Roll damping coefficient') or find_column(df, 'Roll damping')
    pitch_moment_col = find_column(df, 'Pitch moment coefficient') or find_column(df, 'Pitch moment')
    yaw_moment_col = find_column(df, 'Yaw moment coefficient') or find_column(df, 'Yaw moment')
    ref_length_col = find_column(df, 'Reference length (in)') or find_column(df, 'Reference length')
    ref_area_col = find_column(df, 'Reference area') or find_column(df, 'Reference area')
    inertia_col = find_column(df, 'Longitudinal moment of inertia') or find_column(df, 'moment of inertia')
    mass_col = find_column(df, 'Mass (lb)') or find_column(df, 'Mass')
    normal_force_col = find_column(df, 'Normal force coefficient') or find_column(df, 'Normal force')
    
    # Print column names for debugging
    print(f"\nColumn names found:")
    print(f"  Time: {time_col}")
    print(f"  CP: {cp_col}")
    print(f"  CG: {cg_col}")
    print(f"  Mach: {mach_col}")
    print(f"  Pitch Damping: {pitch_damping_col}")
    print(f"  Pitch Moment: {pitch_moment_col}")
    print(f"  Yaw Moment: {yaw_moment_col}")
    
    if time_col:
        print(f"Time range: {df[time_col].min():.2f} to {df[time_col].max():.2f} seconds")
    
    # Clean column names (remove special characters) - keep original names too
    df.columns = df.columns.str.strip()
    
    # Calculate dynamic pressure
    print("\nCalculating dynamic pressure...")
    if velocity_col and pressure_col and temp_col:
        df['Q (psf)'] = calculate_dynamic_pressure(
            df[velocity_col].values,
            df[pressure_col].values,
            df[temp_col].values
        )
        
        # Find Max Q
        max_q_idx = df['Q (psf)'].idxmax()
        max_q = df.loc[max_q_idx, 'Q (psf)']
        max_q_time = df.loc[max_q_idx, time_col] if time_col else 0
        max_q_altitude = df.loc[max_q_idx, altitude_col] if altitude_col else 0
    else:
        print("Warning: Could not find required columns for Q calculation")
        max_q = 0
        max_q_time = 0
        max_q_altitude = 0
    
    print(f"\n{'='*60}")
    print("MAX Q ANALYSIS")
    print(f"{'='*60}")
    print(f"Maximum Dynamic Pressure (Q): {max_q:.2f} psf")
    print(f"  Time: {max_q_time:.3f} seconds")
    print(f"  Altitude: {max_q_altitude:.2f} ft")
    print(f"{'='*60}\n")
    
    # Analyze damping ratios
    # Calculate damping ratio from damping coefficient
    print(f"{'='*60}")
    print("DAMPING RATIO ANALYSIS")
    print(f"{'='*60}")
    
    # Filter out NaN values for damping coefficient
    pitch_damping_coeff = pd.Series(dtype=float)
    roll_damping_coeff = pd.Series(dtype=float)
    
    if pitch_damping_col:
        pitch_damping_coeff = df[pitch_damping_col].dropna()
    
    if roll_damping_col:
        roll_damping_coeff = df[roll_damping_col].dropna()
    
    # Calculate damping ratios
    max_pitch_damping_ratio = None
    min_pitch_damping_ratio = None
    max_pitch_ratio_time = None
    min_pitch_ratio_time = None
    
    # Get reference dimensions for damping ratio calculation
    # Reference diameter fixed at 6.17 inches (per user requirement)
    ref_diameter = 6.17  # inches
    inertia_val = df[inertia_col].iloc[0] if inertia_col and len(df) > 0 else None
    
    # Store damping ratios for plotting
    df['Pitch Damping Ratio'] = np.nan
    damping_ratio_series = None
    
    # Calculate C_malpha from pitch moment coefficient vs angle of attack relationship
    # We'll estimate it from stability margin or compute from moment/alpha relationship
    # For now, let's use a more stable calculation that doesn't rely on C_malpha directly
    
    if len(pitch_damping_coeff) > 0 and 'Q (psf)' in df.columns and velocity_col and inertia_val:
        # Calculate damping ratio for each data point using full form with velocity
        # Use stability margin to infer C_malpha if available, or use a normalized form
        damping_ratios = []
        
        # Try to calculate C_malpha from pitch moment coefficient and angle of attack
        # C_malpha ≈ d(C_m)/d(alpha) ≈ (C_m at different alphas) / (delta alpha)
        # We can use a running average or estimate from stability margin
        
        stability_margin_col = find_column(df, 'Stability margin')
        
        for idx in pitch_damping_coeff.index:
            C_mq = df.loc[idx, pitch_damping_col]
            q_val = df.loc[idx, 'Q (psf)'] if 'Q (psf)' in df.columns else 0
            V_val = df.loc[idx, velocity_col] if velocity_col else 0
            I_val = df.loc[idx, inertia_col] if inertia_col and inertia_col in df.columns else inertia_val
            
            # Get additional parameters for better variation
            Mach_val = df.loc[idx, mach_col] if mach_col and mach_col in df.columns else None
            AoA_val = df.loc[idx, aoa_col] if aoa_col and aoa_col in df.columns else None
            
            if q_val > 0 and V_val > 0:
                zeta = calculate_damping_ratio(C_mq, q_val, V_val, ref_diameter, I_val, 
                                               C_malpha=None, Mach=Mach_val, AoA=AoA_val)
                damping_ratios.append((idx, zeta))
                df.loc[idx, 'Pitch Damping Ratio'] = zeta
        
        if damping_ratios:
            # Create series from calculated values
            damping_ratio_series_raw = pd.Series({idx: zeta for idx, zeta in damping_ratios})
            
            # Apply smoothing to reduce jaggedness
            # Use a rolling window average with appropriate window size
            # Sort by index to ensure proper ordering
            damping_ratio_series_sorted = damping_ratio_series_raw.sort_index()
            
                # Apply heavy smoothing for very smooth curve
            # Use a much larger window size for significant smoothing
            # Calculate window as percentage of data (aim for ~5-10% of data points)
            data_length = len(damping_ratio_series_sorted)
            window_size = max(30, min(50, data_length // 10))  # 30-50 point window, or 10% of data
            
            if window_size >= 3:
                # First pass: large rolling mean
                damping_ratio_series_smoothed = damping_ratio_series_sorted.rolling(
                    window=window_size, 
                    center=True, 
                    min_periods=1
                ).mean()
                
                # Second pass: additional smoothing
                window_size2 = max(15, window_size // 2)
                damping_ratio_series_smoothed = damping_ratio_series_smoothed.rolling(
                    window=window_size2,
                    center=True,
                    min_periods=1
                ).mean()
                
                # Third pass: final polish
                window_size3 = max(7, window_size2 // 2)
                damping_ratio_series_smoothed = damping_ratio_series_smoothed.rolling(
                    window=window_size3,
                    center=True,
                    min_periods=1
                ).mean()
            else:
                damping_ratio_series_smoothed = damping_ratio_series_sorted
            
            # Update the dataframe with smoothed values
            for idx in damping_ratio_series_smoothed.index:
                df.loc[idx, 'Pitch Damping Ratio'] = damping_ratio_series_smoothed.loc[idx]
            
            # Use smoothed series for min/max calculations
            damping_ratio_series = damping_ratio_series_smoothed
            
            max_pitch_damping_ratio = damping_ratio_series.max()
            min_pitch_damping_ratio = damping_ratio_series.min()
            max_pitch_ratio_idx = damping_ratio_series.idxmax()
            min_pitch_ratio_idx = damping_ratio_series.idxmin()
            max_pitch_ratio_time = df.loc[max_pitch_ratio_idx, time_col] if time_col else 0
            min_pitch_ratio_time = df.loc[min_pitch_ratio_idx, time_col] if time_col else 0
            
            print(f"Maximum Pitch Damping Ratio: {max_pitch_damping_ratio:.6f}")
            print(f"  Time: {max_pitch_ratio_time:.3f} seconds")
            print(f"Minimum Pitch Damping Ratio: {min_pitch_damping_ratio:.6f}")
            print(f"  Time: {min_pitch_ratio_time:.3f} seconds")
        else:
            print("Warning: Could not calculate damping ratios (missing data)")
    else:
        print("Warning: Insufficient data to calculate damping ratios")
    
    print(f"{'='*60}\n")
    
    # Analyze pitch and yaw moments
    print(f"{'='*60}")
    print("PITCH AND YAW MOMENT ANALYSIS")
    print(f"{'='*60}")
    
    pitch_moment = pd.Series(dtype=float)
    yaw_moment = pd.Series(dtype=float)
    
    if pitch_moment_col:
        pitch_moment = df[pitch_moment_col].dropna()
    
    if yaw_moment_col:
        yaw_moment = df[yaw_moment_col].dropna()
    
    max_pitch_moment = None
    min_pitch_moment = None
    max_pitch_moment_time = None
    min_pitch_moment_time = None
    
    if len(pitch_moment) > 0:
        max_pitch_moment = pitch_moment.max()
        min_pitch_moment = pitch_moment.min()
        max_pitch_moment_idx = pitch_moment.idxmax()
        min_pitch_moment_idx = pitch_moment.idxmin()
        max_pitch_moment_time = df.loc[max_pitch_moment_idx, time_col] if time_col else 0
        min_pitch_moment_time = df.loc[min_pitch_moment_idx, time_col] if time_col else 0
        
        print(f"Maximum Pitch Moment Coefficient: {max_pitch_moment:.6f}")
        print(f"  Time: {max_pitch_moment_time:.3f} seconds")
        if altitude_col:
            max_pitch_moment_alt = df.loc[max_pitch_moment_idx, altitude_col]
            print(f"  Altitude: {max_pitch_moment_alt:.2f} ft")
        print(f"Minimum Pitch Moment Coefficient: {min_pitch_moment:.6f}")
        print(f"  Time: {min_pitch_moment_time:.3f} seconds")
        if altitude_col:
            min_pitch_moment_alt = df.loc[min_pitch_moment_idx, altitude_col]
            print(f"  Altitude: {min_pitch_moment_alt:.2f} ft")
    
    max_yaw_moment = None
    min_yaw_moment = None
    max_yaw_moment_time = None
    min_yaw_moment_time = None
    
    if len(yaw_moment) > 0:
        max_yaw_moment = yaw_moment.max()
        min_yaw_moment = yaw_moment.min()
        max_yaw_moment_idx = yaw_moment.idxmax()
        min_yaw_moment_idx = yaw_moment.idxmin()
        max_yaw_moment_time = df.loc[max_yaw_moment_idx, time_col] if time_col else 0
        min_yaw_moment_time = df.loc[min_yaw_moment_idx, time_col] if time_col else 0
        
        print(f"\nMaximum Yaw Moment Coefficient: {max_yaw_moment:.6f}")
        print(f"  Time: {max_yaw_moment_time:.3f} seconds")
        if altitude_col:
            max_yaw_moment_alt = df.loc[max_yaw_moment_idx, altitude_col]
            print(f"  Altitude: {max_yaw_moment_alt:.2f} ft")
        print(f"Minimum Yaw Moment Coefficient: {min_yaw_moment:.6f}")
        print(f"  Time: {min_yaw_moment_time:.3f} seconds")
        if altitude_col:
            min_yaw_moment_alt = df.loc[min_yaw_moment_idx, altitude_col]
            print(f"  Altitude: {min_yaw_moment_alt:.2f} ft")
    
    # Initialize calculated moment variables
    max_pitch_moment_actual = None
    min_pitch_moment_actual = None
    max_pitch_moment_actual_time = None
    min_pitch_moment_actual_time = None
    max_yaw_moment_actual = None
    min_yaw_moment_actual = None
    max_yaw_moment_actual_time = None
    min_yaw_moment_actual_time = None
    
    # Find max AoA for context
    max_aoa = None
    max_aoa_time = None
    if aoa_col:
        aoa_data = df[aoa_col].dropna()
        if len(aoa_data) > 0:
            max_aoa_idx = aoa_data.idxmax()
            max_aoa = aoa_data.max()
            max_aoa_time = df.loc[max_aoa_idx, time_col] if time_col else 0
    
    # Calculate actual moments if we have Q and reference dimensions
    if 'Q (psf)' in df.columns and ref_length_col and ref_area_col:
        print(f"\n{'='*60}")
        print("PITCH AND YAW MOMENTS")
        print(f"{'='*60}")
        
        # Get reference dimensions
        ref_length = df[ref_length_col].iloc[0] if len(df) > 0 else None
        ref_area = df[ref_area_col].iloc[0] if len(df) > 0 else None
        
        if ref_length and ref_area and not pd.isna(ref_length) and not pd.isna(ref_area):
            # Calculate moments where we have all data
            cols_needed = [time_col, pitch_moment_col, yaw_moment_col, 'Q (psf)']
            if aoa_col:
                cols_needed.append(aoa_col)
            valid_moment_data = df[cols_needed].dropna() if all(col for col in cols_needed if col) else pd.DataFrame()
            
            if len(valid_moment_data) > 0:
                # Convert Q from psf to psi (divide by 144: 1 ft² = 144 in²)
                Q_psi = valid_moment_data['Q (psf)'] / 144.0
                
                # Calculate pitch moment: Cm * Q * A_ref * L_ref [lb·in]
                pitch_moments = valid_moment_data[pitch_moment_col] * Q_psi * ref_area * ref_length
                # Convert to lb·ft, then to N·m
                pitch_moments_lbft = pitch_moments / 12.0
                pitch_moments_nm = pitch_moments_lbft.apply(lbft_to_nm)
                
                # Calculate yaw moment: Cn * Q * A_ref * L_ref [lb·in]
                yaw_moments = valid_moment_data[yaw_moment_col] * Q_psi * ref_area * ref_length
                # Convert to lb·ft, then to N·m
                yaw_moments_lbft = yaw_moments / 12.0
                yaw_moments_nm = yaw_moments_lbft.apply(lbft_to_nm)
                
                # Find maximum pitch moment
                max_pitch_moment_actual_nm = pitch_moments_nm.max()
                min_pitch_moment_actual_nm = pitch_moments_nm.min()
                max_pitch_moment_actual_idx = pitch_moments_nm.idxmax()
                min_pitch_moment_actual_idx = pitch_moments_nm.idxmin()
                max_pitch_moment_actual_time = valid_moment_data.loc[max_pitch_moment_actual_idx, time_col]
                min_pitch_moment_actual_time = valid_moment_data.loc[min_pitch_moment_actual_idx, time_col]
                
                # Get AoA at max moment times
                max_pitch_aoa_at_moment = valid_moment_data.loc[max_pitch_moment_actual_idx, aoa_col] if aoa_col and aoa_col in valid_moment_data.columns else None
                is_near_max_aoa = abs(max_pitch_moment_actual_time - max_aoa_time) < 0.1 if max_aoa_time else False
                
                # Format output like "72 N·m at 0.6 s during max AoA"
                max_pitch_context = ""
                if is_near_max_aoa:
                    max_pitch_context = f" during max AoA ({max_aoa:.1f}° at {max_aoa_time:.3f} s)"
                elif max_pitch_aoa_at_moment is not None and not pd.isna(max_pitch_aoa_at_moment):
                    max_pitch_context = f" at AoA {max_pitch_aoa_at_moment:.1f}°"
                
                # Longitudinal moment = Pitch moment (rotation about lateral/y-axis)
                print(f"Maximum Longitudinal (Pitch) Moment: {max_pitch_moment_actual_nm:.1f} N·m at {max_pitch_moment_actual_time:.3f} s{max_pitch_context}")
                print(f"Minimum Longitudinal (Pitch) Moment: {min_pitch_moment_actual_nm:.1f} N·m at {min_pitch_moment_actual_time:.3f} s")
                print(f"\n(Also reported as Pitch Moment above)")
                
                # Find maximum yaw moment
                max_yaw_moment_actual_nm = yaw_moments_nm.max()
                min_yaw_moment_actual_nm = yaw_moments_nm.min()
                max_yaw_moment_actual_idx = yaw_moments_nm.idxmax()
                min_yaw_moment_actual_idx = yaw_moments_nm.idxmin()
                max_yaw_moment_actual_time = valid_moment_data.loc[max_yaw_moment_actual_idx, time_col]
                min_yaw_moment_actual_time = valid_moment_data.loc[min_yaw_moment_actual_idx, time_col]
                
                max_yaw_aoa_at_moment = valid_moment_data.loc[max_yaw_moment_actual_idx, aoa_col] if aoa_col and aoa_col in valid_moment_data.columns else None
                is_near_max_aoa_yaw = abs(max_yaw_moment_actual_time - max_aoa_time) < 0.1 if max_aoa_time else False
                
                max_yaw_context = ""
                if is_near_max_aoa_yaw:
                    max_yaw_context = f" during max AoA ({max_aoa:.1f}° at {max_aoa_time:.3f} s)"
                elif max_yaw_aoa_at_moment is not None and not pd.isna(max_yaw_aoa_at_moment):
                    max_yaw_context = f" at AoA {max_yaw_aoa_at_moment:.1f}°"
                
                print(f"\nMaximum Yaw Moment: {max_yaw_moment_actual_nm:.1f} N·m at {max_yaw_moment_actual_time:.3f} s{max_yaw_context}")
                print(f"Minimum Yaw Moment: {min_yaw_moment_actual_nm:.1f} N·m at {min_yaw_moment_actual_time:.3f} s")
                
                # Store for summary
                max_pitch_moment_actual = max_pitch_moment_actual_nm
                min_pitch_moment_actual = min_pitch_moment_actual_nm
                max_yaw_moment_actual = max_yaw_moment_actual_nm
                min_yaw_moment_actual = min_yaw_moment_actual_nm
    
    print(f"{'='*60}\n")
    
    # Create plots
    print("Creating plots...")
    
    # Set up the figure with subplots
    fig = plt.figure(figsize=(16, 12))
    
    # Filter out NaN values for plotting
    valid_cp_aoa = pd.DataFrame()
    valid_cp_mach = pd.DataFrame()
    valid_cg_cp = pd.DataFrame()
    valid_damping = pd.DataFrame()
    
    if cp_col and aoa_col:
        valid_cp_aoa = df[[cp_col, aoa_col]].dropna()
    
    if cp_col and mach_col:
        valid_cp_mach = df[[cp_col, mach_col]].dropna()
    
    if time_col and cg_col and cp_col:
        valid_cg_cp = df[[time_col, cg_col, cp_col]].dropna()
    
    # Use damping ratio if available, otherwise use coefficient
    damping_col_for_plot = 'Pitch Damping Ratio' if 'Pitch Damping Ratio' in df.columns else pitch_damping_col
    if time_col and damping_col_for_plot:
        valid_damping = df[[time_col, damping_col_for_plot]].dropna()
    
    # Plot 1: CP vs AOA
    ax1 = plt.subplot(2, 2, 1)
    if len(valid_cp_aoa) > 0 and aoa_col and cp_col:
        ax1.scatter(valid_cp_aoa[aoa_col], 
                   valid_cp_aoa[cp_col],
                   alpha=0.6, s=10)
        ax1.set_xlabel('Angle of Attack (°)')
        ax1.set_ylabel('CP Location (in)')
        ax1.set_title('Center of Pressure vs Angle of Attack')
        ax1.grid(True, alpha=0.3)
    else:
        ax1.text(0.5, 0.5, 'No valid CP/AOA data', 
                ha='center', va='center', transform=ax1.transAxes)
        ax1.set_title('Center of Pressure vs Angle of Attack (No Data)')
    
    # Plot 2: CP vs Mach number
    ax2 = plt.subplot(2, 2, 2)
    if len(valid_cp_mach) > 0 and mach_col and cp_col:
        ax2.scatter(valid_cp_mach[mach_col], 
                   valid_cp_mach[cp_col],
                   alpha=0.6, s=10)
        ax2.set_xlabel('Mach Number')
        ax2.set_ylabel('CP Location (in)')
        ax2.set_title('Center of Pressure vs Mach Number')
        ax2.grid(True, alpha=0.3)
    else:
        ax2.text(0.5, 0.5, 'No valid CP/Mach data', 
                ha='center', va='center', transform=ax2.transAxes)
        ax2.set_title('Center of Pressure vs Mach Number (No Data)')
    
    # Plot 3: CG and CP vs time
    ax3 = plt.subplot(2, 2, 3)
    if len(valid_cg_cp) > 0 and time_col and cg_col and cp_col:
        ax3.plot(valid_cg_cp[time_col], valid_cg_cp[cg_col],
                label='CG Location', linewidth=1.5, alpha=0.8)
        ax3.plot(valid_cg_cp[time_col], valid_cg_cp[cp_col],
                label='CP Location', linewidth=1.5, alpha=0.8)
        ax3.set_xlabel('Time (s)')
        ax3.set_ylabel('Location (in)')
        ax3.set_title('Center of Gravity and Center of Pressure vs Time')
        ax3.legend()
        ax3.grid(True, alpha=0.3)
    else:
        ax3.text(0.5, 0.5, 'No valid CG/CP data', 
                ha='center', va='center', transform=ax3.transAxes)
        ax3.set_title('CG and CP vs Time (No Data)')
    
    # Plot 4: Damping ratio vs time
    ax4 = plt.subplot(2, 2, 4)
    if len(valid_damping) > 0 and time_col and damping_col_for_plot:
        ax4.plot(valid_damping[time_col], 
                valid_damping[damping_col_for_plot],
                linewidth=1.5, alpha=0.8, color='green')
        ax4.set_xlabel('Time (s)')
        ylabel = 'Pitch Damping Ratio' if damping_col_for_plot == 'Pitch Damping Ratio' else 'Pitch Damping Coefficient'
        ax4.set_ylabel(ylabel)
        ax4.set_title(f'{ylabel} vs Time')
        ax4.grid(True, alpha=0.3)
    else:
        ax4.text(0.5, 0.5, 'No valid damping data', 
                ha='center', va='center', transform=ax4.transAxes)
        ax4.set_title('Damping Ratio vs Time (No Data)')
    
    plt.tight_layout()
    
    # Save the figure
    output_path = Path(__file__).parent / "flight_data_analysis.png"
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"Plots saved to: {output_path}")
    
    # Also save individual plots
    print("\nCreating individual plot files...")
    
    # CP vs AOA
    fig1, ax = plt.subplots(figsize=(10, 6))
    if len(valid_cp_aoa) > 0 and aoa_col and cp_col:
        ax.scatter(valid_cp_aoa[aoa_col], 
                  valid_cp_aoa[cp_col],
                  alpha=0.6, s=10)
        ax.set_xlabel('Angle of Attack (°)', fontsize=12)
        ax.set_ylabel('CP Location (in)', fontsize=12)
        ax.set_title('Center of Pressure vs Angle of Attack', fontsize=14)
        ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(Path(__file__).parent / "cp_vs_aoa.png", dpi=300, bbox_inches='tight')
    plt.close()
    
    # CP vs Mach
    fig2, ax = plt.subplots(figsize=(10, 6))
    if len(valid_cp_mach) > 0 and mach_col and cp_col:
        ax.scatter(valid_cp_mach[mach_col], 
                  valid_cp_mach[cp_col],
                  alpha=0.6, s=10)
        ax.set_xlabel('Mach Number', fontsize=12)
        ax.set_ylabel('CP Location (in)', fontsize=12)
        ax.set_title('Center of Pressure vs Mach Number', fontsize=14)
        ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(Path(__file__).parent / "cp_vs_mach.png", dpi=300, bbox_inches='tight')
    plt.close()
    
    # CG and CP vs time
    fig3, ax = plt.subplots(figsize=(10, 6))
    if len(valid_cg_cp) > 0 and time_col and cg_col and cp_col:
        ax.plot(valid_cg_cp[time_col], valid_cg_cp[cg_col],
               label='CG Location', linewidth=2, alpha=0.8)
        ax.plot(valid_cg_cp[time_col], valid_cg_cp[cp_col],
               label='CP Location', linewidth=2, alpha=0.8)
        ax.set_xlabel('Time (s)', fontsize=12)
        ax.set_ylabel('Location (in)', fontsize=12)
        ax.set_title('Center of Gravity and Center of Pressure vs Time', fontsize=14)
        ax.legend(fontsize=11)
        ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(Path(__file__).parent / "cg_cp_vs_time.png", dpi=300, bbox_inches='tight')
    plt.close()
    
    # Damping ratio vs time
    fig4, ax = plt.subplots(figsize=(10, 6))
    damping_col_for_plot = 'Pitch Damping Ratio' if 'Pitch Damping Ratio' in df.columns else pitch_damping_col
    if len(valid_damping) > 0 and time_col and damping_col_for_plot:
        ax.plot(valid_damping[time_col], 
               valid_damping[damping_col_for_plot],
               linewidth=2, alpha=0.8, color='green')
        ax.set_xlabel('Time (s)', fontsize=12)
        ylabel = 'Pitch Damping Ratio' if damping_col_for_plot == 'Pitch Damping Ratio' else 'Pitch Damping Coefficient'
        ax.set_ylabel(ylabel, fontsize=12)
        ax.set_title(f'{ylabel} vs Time', fontsize=14)
        ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig(Path(__file__).parent / "damping_vs_time.png", dpi=300, bbox_inches='tight')
    plt.close()
    
    print("All plots created successfully!")
    
    # Print summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"Max Q: {max_q:.2f} psf at {max_q_time:.3f} s, altitude {max_q_altitude:.2f} ft")
    
    if max_pitch_damping_ratio is not None:
        print(f"\nPitch Damping Ratio:")
        print(f"  Max: {max_pitch_damping_ratio:.6f} (at {max_pitch_ratio_time:.3f} s)")
        print(f"  Min: {min_pitch_damping_ratio:.6f} (at {min_pitch_ratio_time:.3f} s)")
    
    if max_pitch_moment is not None:
        print(f"\nPitch Moment Coefficient:")
        print(f"  Max: {max_pitch_moment:.6f} (at {max_pitch_moment_time:.3f} s)")
        print(f"  Min: {min_pitch_moment:.6f} (at {min_pitch_moment_time:.3f} s)")
    
    if max_yaw_moment is not None:
        print(f"\nYaw Moment Coefficient:")
        print(f"  Max: {max_yaw_moment:.6f} (at {max_yaw_moment_time:.3f} s)")
        print(f"  Min: {min_yaw_moment:.6f} (at {min_yaw_moment_time:.3f} s)")
    
    if max_pitch_moment_actual is not None:
        print(f"\nLongitudinal (Pitch) Moment:")
        print(f"  Max: {max_pitch_moment_actual:.1f} N·m (at {max_pitch_moment_actual_time:.3f} s)")
        print(f"  Min: {min_pitch_moment_actual:.1f} N·m (at {min_pitch_moment_actual_time:.3f} s)")
    
    if max_yaw_moment_actual is not None:
        print(f"\nYaw Moment:")
        print(f"  Max: {max_yaw_moment_actual:.1f} N·m (at {max_yaw_moment_actual_time:.3f} s)")
        print(f"  Min: {min_yaw_moment_actual:.1f} N·m (at {min_yaw_moment_actual_time:.3f} s)")
    
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()

