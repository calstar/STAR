# Autonomous PT Calibration System

## Overview

The Autonomous PT Calibration System automatically calibrates pressure transducers by:
1. Listening to PT messages from Elodin (via DAQ bridge)
2. Collecting calibration points at known reference pressures
3. Automatically fitting calibration polynomials
4. Validating calibration quality
5. Saving calibration coefficients automatically

## Features

- **Automatic Data Collection**: Listens to Elodin PT messages (raw and calibrated)
- **Reference Pressure Input**: Accepts reference pressures from gauges, regulators, or manual input
- **Automatic Fitting**: Fits cubic polynomial (`psi = A*adc³ + B*adc² + C*adc + D`) when enough points are collected
- **Quality Validation**: Uses R² to assess calibration quality
- **Confidence Levels**: LOW → MEDIUM → HIGH → MAXIMUM based on points and R²
- **Automatic Saving**: Saves calibrations to JSON files automatically
- **Real-time Status**: Shows calibration progress and statistics

## Usage

### Basic Usage

```bash
# Start with reference pressures for specific sensors
python3 scripts/calibration/autonomous_pt_calibration.py \
    --sensor 1 --pressure 10.0 \
    --sensor 2 --pressure 20.0 \
    --sensor 3 --pressure 30.0
```

### Using Reference Pressure File

Create a JSON file with reference pressures:

```json
{
    "1": 10.0,
    "2": 20.0,
    "3": 30.0,
    "4": 40.0
}
```

Then run:

```bash
python3 scripts/calibration/autonomous_pt_calibration.py \
    --reference-pressures reference_pressures.json
```

### Options

- `--elodin-host`: Elodin host (default: 127.0.0.1)
- `--elodin-port`: Elodin port (default: 2240)
- `--reference-pressures`: JSON file with reference pressures
- `--sensor`: Sensor ID to calibrate (can be repeated)
- `--pressure`: Reference pressure in PSI (can be repeated, must match sensors)
- `--status-interval`: Status print interval in seconds (default: 10.0)

## How It Works

1. **Connection**: Connects to Elodin database and subscribes to PT messages (0x2000, 0x2001)

2. **Data Collection**: 
   - Receives PT messages with raw ADC codes
   - When a reference pressure is set for a sensor, collects calibration points
   - Stores: ADC code, reference pressure, timestamp

3. **Automatic Fitting**:
   - When ≥5 points collected, automatically fits cubic polynomial
   - Calculates R² for quality assessment
   - Updates confidence level based on points and R²

4. **Quality Thresholds**:
   - Minimum: 5 points, R² ≥ 0.95 → MEDIUM confidence
   - Target: 10 points, R² ≥ 0.99 → MAXIMUM confidence
   - Maximum: 20 points kept (oldest removed)

5. **Automatic Saving**:
   - Saves calibrations every 60 seconds
   - Filename: `autonomous_calibration_YYYYMMDD_HHMMSS.json`
   - Format compatible with calibration GUI

## Calibration Procedure

### Step 1: Start Elodin and DAQ Bridge

```bash
# Terminal 1: Start Elodin
./scripts/startup/startup_daq_db.sh

# Terminal 2: Start DAQ bridge
./build/daq_bridge
```

### Step 2: Set Reference Pressures

You need to provide reference pressures from:
- **Pressure gauges**: Manual reading
- **Pressure regulators**: Set to known values
- **Calibration standards**: Certified reference

### Step 3: Run Autonomous Calibration

```bash
# Example: Calibrate sensors 1-4 at different pressures
python3 scripts/calibration/autonomous_pt_calibration.py \
    --sensor 1 --pressure 0.0 \
    --sensor 2 --pressure 5.0 \
    --sensor 3 --pressure 10.0 \
    --sensor 4 --pressure 15.0
```

### Step 4: Change Pressures and Collect More Points

1. Change reference pressure (via regulator, etc.)
2. Update reference pressure in calibrator (or restart with new values)
3. System automatically collects more points
4. Calibration automatically refits when enough points collected

### Step 5: Verify Calibration

The system prints status every 10 seconds showing:
- Number of points collected
- R² value
- Confidence level
- Calibration status

## Output Format

Calibrations are saved as JSON:

```json
{
  "version": "1.0",
  "saved_at": "2024-02-04T12:34:56",
  "calibrations": {
    "1": {
      "sensor_id": 1,
      "polynomial_coeffs": [A, B, C, D],
      "r_squared": 0.995,
      "confidence_level": "HIGH",
      "num_points": 12,
      "last_updated": 1707045896.0,
      "is_calibrated": true
    }
  }
}
```

This format is compatible with:
- Calibration GUI (`pt_calibration_gui.py`)
- DAQ bridge (auto-loads from `scripts/calibration/calibrations/`)
- Main GUI (`combined_fsw_gui.py`)

## Integration with Calibration GUI

The autonomous system can work alongside the calibration GUI:

1. **Autonomous system** collects points automatically
2. **Calibration GUI** can load and display the calibrations
3. Both save to the same directory: `scripts/calibration/calibrations/`

## Advanced Usage

### Multiple Pressure Points

To collect multiple points at different pressures:

1. Start calibrator with initial pressure
2. Wait for points to be collected
3. Stop calibrator (Ctrl+C)
4. Restart with new pressure
5. System will add to existing points

Or use a script to automate:

```python
import subprocess
import time

pressures = [0.0, 5.0, 10.0, 15.0, 20.0]

for pressure in pressures:
    # Set pressure via regulator/gauge
    set_pressure(pressure)
    time.sleep(5)  # Wait for stabilization
    
    # Run calibrator for 30 seconds
    subprocess.run([
        "python3", "scripts/calibration/autonomous_pt_calibration.py",
        "--sensor", "1", "--pressure", str(pressure)
    ], timeout=30)
```

## Troubleshooting

### No Messages Received

- Check Elodin is running: `./scripts/startup/startup_daq_db.sh`
- Check DAQ bridge is running: `./build/daq_bridge`
- Verify Elodin connection: Should see "✅ Connected to Elodin"

### No Calibration Points Collected

- Ensure reference pressure is set: `--sensor X --pressure Y`
- Check sensor ID matches Elodin messages
- Verify PT messages are being published (check DAQ bridge logs)

### Low R² Values

- Collect more points (aim for 10+)
- Ensure reference pressures are accurate
- Check for sensor drift or noise
- Verify ADC codes are stable

### Calibration Not Saving

- Check write permissions: `scripts/calibration/calibrations/`
- Verify calibrations exist: Check `is_calibrated` status
- Check logs for errors

## Status Output

Example status output:

```
============================================================
🤖 Autonomous PT Calibration Status
============================================================
Elodin: ✅ Connected
Running: ✅ Yes

Statistics:
  Messages received: 1234
  Calibration points: 45
  Calibrations completed: 3

Sensors:
  Sensor 1: 12 points, ✅ Calibrated, R²=0.9950, HIGH (ref: 10.00 PSI)
  Sensor 2: 8 points, ⏳ Collecting, R²=0.0000, LOW (ref: 20.00 PSI)
  Sensor 3: 15 points, ✅ Calibrated, R²=0.9980, MAXIMUM (ref: 30.00 PSI)
============================================================
```

## Next Steps

1. **Integrate with pressure regulators**: Automatically set reference pressures
2. **Add validation checks**: Verify calibration against known standards
3. **Drift detection**: Monitor calibration drift over time
4. **Multi-sensor coordination**: Calibrate multiple sensors simultaneously
5. **Environmental compensation**: Account for temperature, humidity, etc.
