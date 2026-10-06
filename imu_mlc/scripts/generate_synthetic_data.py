#!/usr/bin/env python3
"""
Synthetic 6-DOF IMU + Magnetometer Flight Data Generator for Rocket Avionics MLC.

Simulates realistic rocket flight profiles sampled at 100 Hz (10 ms intervals):
- Sensors:
    * Triaxial Accelerometer: accel_x, accel_y, accel_z (in g)
    * Triaxial Gyroscope:     gyro_x, gyro_y, gyro_z (in dps - degrees per second)
    * Triaxial Magnetometer:  mag_x, mag_y, mag_z (in gauss)
- Flight Phases (Sequential):
    1. Pad: Static 1g upright, low sensor noise.
    2. Boost: High axial acceleration (8g-14g), combustion vibration, roll stabilization.
    3. Coast: Motor burnout, drag decel transitioning to near-0g, free flight.
    4. Apogee: Near 0g transition, pitch/yaw rollover turnover maneuver.
    5. First Chute (Drogue): Deceleration shock spike (-5g to -9g), pendulum oscillations.
    6. Main Chute: Slower steady descent, reduced angular rates and vibration.
    7. Landed: Impact spike settling to static 1g ground state.
- Simulated In-Flight Anomalies:
    * Violent tumbling: High spin rates > 1000 dps, high variance across axes.
    * Sudden attitude shifts: Rapid geomagnetic / angular vector shifts (antenna pointing loss).
    * Abort / Emergency chute conditions.
- Ground-truth target columns generated for all 8 MLC trees.
"""

import os
import sys

# Auto-bootstrap .venv if launched outside the virtual environment
if sys.prefix == getattr(sys, "base_prefix", sys.prefix):
    venv_py = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".venv", "bin", "python"))
    if os.path.exists(venv_py) and os.path.realpath(sys.executable) != os.path.realpath(venv_py):
        os.execv(venv_py, [venv_py] + sys.argv)

import argparse
import numpy as np
import pandas as pd



def simulate_flight_profile(
    profile_id: int = 1,
    has_tumbling_anomaly: bool = False,
    has_antenna_misalignment: bool = False,
    has_emergency_abort: bool = False,
    seed: int = 42,
) -> pd.DataFrame:
    """Simulates a single 6-DOF rocket flight profile at 100 Hz."""
    rng = np.random.default_rng(seed)
    sample_rate_hz = 100
    dt = 1.0 / sample_rate_hz

    # Phase durations (in seconds)
    pad_dur = 4.0
    boost_dur = 3.5
    coast_dur = 6.5
    apogee_dur = 3.0
    drogue_dur = 10.0
    main_dur = 12.0
    landed_dur = 5.0

    total_dur = (
        pad_dur + boost_dur + coast_dur + apogee_dur + drogue_dur + main_dur + landed_dur
    )
    n_samples = int(total_dur * sample_rate_hz)
    time = np.linspace(0, total_dur, n_samples, endpoint=False)

    # Initialize sensor arrays
    accel_x = np.zeros(n_samples)
    accel_y = np.zeros(n_samples)
    accel_z = np.zeros(n_samples)

    gyro_x = np.zeros(n_samples)
    gyro_y = np.zeros(n_samples)
    gyro_z = np.zeros(n_samples)

    mag_x = np.zeros(n_samples)
    mag_y = np.zeros(n_samples)
    mag_z = np.zeros(n_samples)

    # Targets
    flight_phase = []
    signal_drop_risk = np.zeros(n_samples, dtype=int)
    apogee_turnover = np.zeros(n_samples, dtype=int)
    first_chute_verified = np.zeros(n_samples, dtype=int)
    main_chute_deployed = np.zeros(n_samples, dtype=int)
    touchdown_confirmed = np.zeros(n_samples, dtype=int)
    extreme_tumbling = np.zeros(n_samples, dtype=int)
    emergency_chute_trigger = np.zeros(n_samples, dtype=int)

    # Earth magnetic field baseline (in gauss)
    # Norm ~ 0.5 Gauss (inclination ~ 60 deg)
    b_earth = np.array([0.18, 0.06, 0.45])

    # Time phase markers
    t_pad_end = pad_dur
    t_boost_end = t_pad_end + boost_dur
    t_coast_end = t_boost_end + coast_dur
    t_apogee_end = t_coast_end + apogee_dur
    t_drogue_end = t_apogee_end + drogue_dur
    t_main_end = t_drogue_end + main_dur

    for i, t in enumerate(time):
        # 1. PAD (Static on launch pad, upright along Z-axis)
        if t < t_pad_end:
            phase = "Pad"
            # 1g static along Z
            accel_x[i] = rng.normal(0.0, 0.008)
            accel_y[i] = rng.normal(0.0, 0.008)
            accel_z[i] = 1.0 + rng.normal(0.0, 0.012)

            gyro_x[i] = rng.normal(0.0, 0.4)
            gyro_y[i] = rng.normal(0.0, 0.4)
            gyro_z[i] = rng.normal(0.0, 0.4)

            mag_x[i] = b_earth[0] + rng.normal(0.0, 0.003)
            mag_y[i] = b_earth[1] + rng.normal(0.0, 0.003)
            mag_z[i] = b_earth[2] + rng.normal(0.0, 0.003)

        # 2. BOOST (High axial acceleration + vibration + roll)
        elif t < t_boost_end:
            phase = "Boost"
            progress = (t - t_pad_end) / boost_dur
            # Thrust curve: initial spike, plateau around 11g, burnout taper
            thrust_g = 1.0 + 10.5 * np.sin(progress * np.pi) + 2.0 * (1.0 - progress)
            # Motor acoustic vibration (wideband 30-100Hz ripple)
            vib_x = rng.normal(0.0, 0.55)
            vib_y = rng.normal(0.0, 0.55)
            vib_z = rng.normal(0.0, 0.85)

            accel_x[i] = vib_x
            accel_y[i] = vib_y
            accel_z[i] = thrust_g + vib_z

            # Stabilizing roll spin (ramps up to ~120 dps)
            roll_rate = 120.0 * progress
            gyro_x[i] = rng.normal(0.0, 15.0)
            gyro_y[i] = rng.normal(0.0, 15.0)
            gyro_z[i] = roll_rate + rng.normal(0.0, 5.0)

            # Mag rotates around Z axis due to roll
            roll_angle = 0.5 * 120.0 * progress * (t - t_pad_end) * (np.pi / 180.0)
            mag_x[i] = b_earth[0] * np.cos(roll_angle) - b_earth[1] * np.sin(roll_angle) + rng.normal(0, 0.006)
            mag_y[i] = b_earth[0] * np.sin(roll_angle) + b_earth[1] * np.cos(roll_angle) + rng.normal(0, 0.006)
            mag_z[i] = b_earth[2] + rng.normal(0, 0.005)

        # 3. COAST (Motor burnout, drag deceleration decaying toward near 0g)
        elif t < t_coast_end:
            phase = "Coast"
            progress = (t - t_boost_end) / coast_dur
            # Net sensed accel: aerodynamic drag is opposing velocity, decaying from ~ -0.4g to ~0.0g
            drag_z = -0.35 * (1.0 - progress) ** 1.5

            accel_x[i] = rng.normal(0.0, 0.03)
            accel_y[i] = rng.normal(0.0, 0.03)
            accel_z[i] = drag_z + rng.normal(0.0, 0.04)

            # Gyro decaying roll, slight fin wobble
            gyro_x[i] = 12.0 * np.sin(2.5 * progress * 2 * np.pi) + rng.normal(0.0, 3.0)
            gyro_y[i] = 10.0 * np.cos(2.5 * progress * 2 * np.pi) + rng.normal(0.0, 3.0)
            gyro_z[i] = 40.0 * (1.0 - progress) + rng.normal(0.0, 4.0)

            roll_angle = (40.0 * progress) * (np.pi / 180.0)
            mag_x[i] = b_earth[0] * np.cos(roll_angle) + rng.normal(0, 0.005)
            mag_y[i] = b_earth[1] * np.sin(roll_angle) + rng.normal(0, 0.005)
            mag_z[i] = b_earth[2] + rng.normal(0, 0.005)

            # Injected Anomaly during Coast: Violent tumbling / telemetry drop
            if has_tumbling_anomaly and (0.35 < progress < 0.75):
                # Extreme spin rate > 1000 dps
                tumble_scale = np.sin((progress - 0.35) / 0.40 * np.pi)
                rate_x = 1150.0 * tumble_scale + rng.normal(0.0, 90.0)
                rate_y = 1280.0 * tumble_scale + rng.normal(0.0, 110.0)
                rate_z = 950.0 * tumble_scale + rng.normal(0.0, 80.0)

                gyro_x[i] = rate_x
                gyro_y[i] = rate_y
                gyro_z[i] = rate_z

                # Centripetal acceleration from high spin radius
                accel_x[i] += 4.5 * tumble_scale + rng.normal(0.0, 0.4)
                accel_y[i] += 3.8 * tumble_scale + rng.normal(0.0, 0.4)
                accel_z[i] += rng.normal(0.0, 0.5)

                # Wild magnetic fluctuation
                mag_x[i] = 0.45 * np.sin(t * 15.0) + rng.normal(0, 0.02)
                mag_y[i] = 0.45 * np.cos(t * 18.0) + rng.normal(0, 0.02)
                mag_z[i] = 0.30 * np.sin(t * 12.0) + rng.normal(0, 0.02)

                extreme_tumbling[i] = 1
                signal_drop_risk[i] = 1
                if has_emergency_abort:
                    emergency_chute_trigger[i] = 1

            elif has_antenna_misalignment and (0.50 < progress < 0.85):
                # Sudden attitude shift: large pitch excursion causing antenna cone misalignment
                gyro_y[i] = 420.0 + rng.normal(0.0, 45.0)
                gyro_x[i] = 310.0 + rng.normal(0.0, 35.0)
                mag_x[i] = 0.40 * np.sin(t * 8.0) + rng.normal(0, 0.01)
                signal_drop_risk[i] = 1

        # 4. APOGEE (Near 0g transition, pitch/yaw turnover / rollover maneuver)
        elif t < t_apogee_end:
            phase = "Apogee"
            progress = (t - t_coast_end) / apogee_dur
            # Near 0g transition (free fall / ballistic apex)
            accel_x[i] = rng.normal(0.0, 0.02)
            accel_y[i] = rng.normal(0.0, 0.02)
            accel_z[i] = rng.normal(0.0, 0.025)  # Near 0g

            # Pitchover / rollover maneuver: rocket tilts from nose-up to horizontal/nose-down
            # Characteristic turnover rotation ~ 40-75 dps
            pitch_rate = 65.0 * np.sin(progress * np.pi)
            gyro_x[i] = rng.normal(0.0, 3.0)
            gyro_y[i] = pitch_rate + rng.normal(0.0, 4.0)
            gyro_z[i] = rng.normal(0.0, 3.0)

            # Attitude flip shifts magnetic vector projection
            pitch_angle = progress * np.pi
            mag_x[i] = b_earth[0] * np.cos(pitch_angle) - b_earth[2] * np.sin(pitch_angle) + rng.normal(0, 0.005)
            mag_y[i] = b_earth[1] + rng.normal(0, 0.005)
            mag_z[i] = b_earth[0] * np.sin(pitch_angle) + b_earth[2] * np.cos(pitch_angle) + rng.normal(0, 0.005)

            apogee_turnover[i] = 1

        # 5. FIRST CHUTE / DROGUE (High deceleration shock spike + pendulum oscillation)
        elif t < t_drogue_end:
            phase = "Descent"
            progress = (t - t_apogee_end) / drogue_dur
            first_chute_verified[i] = 1

            # Shock spike right at ejection (first 0.25 seconds)
            if progress < (0.25 / drogue_dur):
                shock_time = progress / (0.25 / drogue_dur)
                # Spike: -7.5g shock pulse
                spike_accel = -7.5 * np.sin(shock_time * np.pi)
                accel_z[i] = spike_accel + rng.normal(0.0, 0.4)
                accel_x[i] = rng.normal(0.0, 1.2)
                accel_y[i] = rng.normal(0.0, 1.2)

                gyro_x[i] = rng.normal(0.0, 85.0)
                gyro_y[i] = rng.normal(0.0, 95.0)
                gyro_z[i] = rng.normal(0.0, 60.0)
            else:
                # Drogue descent: steady gravity + high speed drogue drag + pendulum oscillations
                # Frequency ~ 1.2 Hz pendulum swing
                omega = 2.0 * np.pi * 1.2
                theta = omega * (t - t_apogee_end)

                accel_x[i] = 0.45 * np.sin(theta) + rng.normal(0.0, 0.08)
                accel_y[i] = 0.35 * np.cos(theta) + rng.normal(0.0, 0.08)
                # Sensed acceleration under parachute points upwards (+1g to counteract gravity in steady state)
                accel_z[i] = 1.0 + 0.30 * np.sin(2 * theta) + rng.normal(0.0, 0.10)

                gyro_x[i] = 45.0 * np.cos(theta) + rng.normal(0.0, 5.0)
                gyro_y[i] = 40.0 * np.sin(theta) + rng.normal(0.0, 5.0)
                gyro_z[i] = 15.0 * np.sin(0.5 * theta) + rng.normal(0.0, 4.0)

            # Inverted magnetic field (rocket hanging tail-first)
            mag_x[i] = -b_earth[0] + rng.normal(0, 0.008)
            mag_y[i] = b_earth[1] + rng.normal(0, 0.008)
            mag_z[i] = -b_earth[2] + rng.normal(0, 0.008)

        # 6. MAIN CHUTE (Secondary shock, slower descent, smaller oscillations)
        elif t < t_main_end:
            phase = "Descent"
            progress = (t - t_drogue_end) / main_dur
            first_chute_verified[i] = 1
            main_chute_deployed[i] = 1

            # Main deployment shock pulse (first 0.35 seconds)
            if progress < (0.35 / main_dur):
                shock_time = progress / (0.35 / main_dur)
                spike_accel = -3.8 * np.sin(shock_time * np.pi)
                accel_z[i] = spike_accel + rng.normal(0.0, 0.25)
                accel_x[i] = rng.normal(0.0, 0.5)
                accel_y[i] = rng.normal(0.0, 0.5)
                gyro_x[i] = rng.normal(0.0, 35.0)
                gyro_y[i] = rng.normal(0.0, 35.0)
                gyro_z[i] = rng.normal(0.0, 20.0)
            else:
                # Steady gentle descent (5 m/s terminal velocity)
                omega_main = 2.0 * np.pi * 0.6  # Slower gentle pendulum
                theta_m = omega_main * (t - t_drogue_end)

                accel_x[i] = 0.12 * np.sin(theta_m) + rng.normal(0.0, 0.03)
                accel_y[i] = 0.10 * np.cos(theta_m) + rng.normal(0.0, 0.03)
                accel_z[i] = 1.0 + 0.08 * np.sin(theta_m) + rng.normal(0.0, 0.04)

                gyro_x[i] = 12.0 * np.cos(theta_m) + rng.normal(0.0, 2.0)
                gyro_y[i] = 10.0 * np.sin(theta_m) + rng.normal(0.0, 2.0)
                gyro_z[i] = 4.0 * np.sin(0.3 * theta_m) + rng.normal(0.0, 1.5)

            mag_x[i] = -b_earth[0] + rng.normal(0, 0.006)
            mag_y[i] = b_earth[1] + rng.normal(0, 0.006)
            mag_z[i] = -b_earth[2] + rng.normal(0, 0.006)

        # 7. LANDED / TOUCHDOWN (Impact spike settling into static 1g ground resting state)
        else:
            phase = "Touchdown"
            progress = (t - t_main_end) / landed_dur
            first_chute_verified[i] = 1
            main_chute_deployed[i] = 1
            touchdown_confirmed[i] = 1

            # Touchdown impact spike (first 0.10 s)
            if progress < (0.10 / landed_dur):
                impact_spike = 4.2 * np.sin((progress / (0.10 / landed_dur)) * np.pi)
                accel_z[i] = impact_spike + rng.normal(0.0, 0.3)
                accel_x[i] = rng.normal(0.0, 0.6)
                accel_y[i] = rng.normal(0.0, 0.6)
                gyro_x[i] = rng.normal(0.0, 25.0)
                gyro_y[i] = rng.normal(0.0, 25.0)
                gyro_z[i] = rng.normal(0.0, 20.0)
            else:
                # Resting on ground tilted (e.g. 45 deg tilt on hillside)
                accel_x[i] = 0.65 + rng.normal(0.0, 0.005)
                accel_y[i] = 0.20 + rng.normal(0.0, 0.005)
                accel_z[i] = 0.73 + rng.normal(0.0, 0.006)  # norm = sqrt(0.65^2 + 0.2^2 + 0.73^2) ~ 1.0g

                gyro_x[i] = rng.normal(0.0, 0.25)
                gyro_y[i] = rng.normal(0.0, 0.25)
                gyro_z[i] = rng.normal(0.0, 0.25)

            mag_x[i] = 0.25 + rng.normal(0, 0.004)
            mag_y[i] = 0.15 + rng.normal(0, 0.004)
            mag_z[i] = 0.38 + rng.normal(0, 0.004)

        flight_phase.append(phase)

    df = pd.DataFrame(
        {
            "timestamp": np.round(time, 3),
            "accel_x": np.round(accel_x, 5),
            "accel_y": np.round(accel_y, 5),
            "accel_z": np.round(accel_z, 5),
            "gyro_x": np.round(gyro_x, 4),
            "gyro_y": np.round(gyro_y, 4),
            "gyro_z": np.round(gyro_z, 4),
            "mag_x": np.round(mag_x, 5),
            "mag_y": np.round(mag_y, 5),
            "mag_z": np.round(mag_z, 5),
            "flight_phase": flight_phase,
            "signal_drop_risk": signal_drop_risk,
            "apogee_turnover": apogee_turnover,
            "first_chute_verified": first_chute_verified,
            "main_chute_deployed": main_chute_deployed,
            "touchdown_confirmed": touchdown_confirmed,
            "extreme_tumbling": extreme_tumbling,
            "emergency_chute_trigger": emergency_chute_trigger,
        }
    )
    df["flight_id"] = profile_id
    return df


def generate_flight_dataset(
    output_path: str = "data/simulated_flight.csv",
    n_profiles: int = 5,
    seed: int = 100,
) -> pd.DataFrame:
    """
    Generates a multi-flight training dataset combining nominal flights,
    high-turbulence flights, tumbling anomalies, and emergency aborts.
    """
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    profiles = [
        # Flight 1: Clean nominal flight profile
        {"has_tumbling_anomaly": False, "has_antenna_misalignment": False, "has_emergency_abort": False},
        # Flight 2: Flight with severe tumbling anomaly in coast (>1000 dps abort)
        {"has_tumbling_anomaly": True, "has_antenna_misalignment": True, "has_emergency_abort": True},
        # Flight 3: Flight with attitude misalignment & signal drop risk
        {"has_tumbling_anomaly": False, "has_antenna_misalignment": True, "has_emergency_abort": False},
        # Flight 4: Flight with moderate tumbling and emergency recovery trigger
        {"has_tumbling_anomaly": True, "has_antenna_misalignment": True, "has_emergency_abort": True},
        # Flight 5: Secondary nominal profile with windy drift
        {"has_tumbling_anomaly": False, "has_antenna_misalignment": False, "has_emergency_abort": False},
    ]

    all_dfs = []
    base_time_offset = 0.0

    print(f"Generating synthetic 6-DOF IMU + Magnetometer flight data ({len(profiles)} profiles at 100 Hz)...")
    for idx, cfg in enumerate(profiles):
        df_profile = simulate_flight_profile(
            profile_id=idx + 1,
            has_tumbling_anomaly=cfg["has_tumbling_anomaly"],
            has_antenna_misalignment=cfg["has_antenna_misalignment"],
            has_emergency_abort=cfg["has_emergency_abort"],
            seed=seed + idx * 37,
        )
        df_profile["timestamp"] = np.round(df_profile["timestamp"] + base_time_offset, 3)
        base_time_offset = df_profile["timestamp"].iloc[-1] + 1.0
        all_dfs.append(df_profile)

    combined_df = pd.concat(all_dfs, ignore_index=True)
    combined_df.to_csv(output_path, index=False)
    print(f"Saved {len(combined_df):,} samples across {len(profiles)} flights to '{output_path}'.")
    print(f"Channels: accel [x,y,z], gyro [x,y,z], mag [x,y,z]")
    print(f"Phase distribution:\n{combined_df['flight_phase'].value_counts().to_string()}")
    print("Anomaly flags summary:")
    for col in [
        "signal_drop_risk",
        "apogee_turnover",
        "first_chute_verified",
        "main_chute_deployed",
        "touchdown_confirmed",
        "extreme_tumbling",
        "emergency_chute_trigger",
    ]:
        print(f"  - {col}: {combined_df[col].sum()} positive samples ({combined_df[col].mean()*100:.2f}%)")

    return combined_df


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic rocket IMU + Magnetometer flight logs.")
    parser.add_argument(
        "--output",
        type=str,
        default="data/simulated_flight.csv",
        help="Path to output CSV file (default: data/simulated_flight.csv)",
    )
    parser.add_argument(
        "--profiles",
        type=int,
        default=5,
        help="Number of flight profiles to generate (default: 5)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=100,
        help="Random seed for reproducibility",
    )
    args = parser.parse_args()
    generate_flight_dataset(output_path=args.output, n_profiles=args.profiles, seed=args.seed)


if __name__ == "__main__":
    main()
