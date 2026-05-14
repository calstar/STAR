# GUI Fixes and PT Calibration Integration

## Issues Fixed

### 1. Actuator Data Parsing
**Problem**: Actuator current sense readings were being treated as pressure sensors.

**Solution**:
- **Actuator board** (IP: `192.168.2.201`) sends current sense readings with `sensor_id` 0-9 (0-indexed)
- **PT board** (IP: `192.168.2.101`) sends pressure sensor data with `sensor_id` 1-10 (1-indexed)
- GUI now filters by source IP:
  - `SensorPlotWidget` only accepts data from PT board (`192.168.2.101`)
  - `ActuatorControlWidget` only accepts data from actuator board (`192.168.2.201`)
- Actuator sensor_id 0-9 maps to actuators 1-10

### 2. PT Calibration Integration
**Problem**: No calibration was applied to convert ADC codes to PSI.

**Solution**:
- Integrated PT calibration framework from `scripts/calibration/pt_calibration_gui.py`
- Supports both CSV and JSON calibration formats:
  - **CSV**: From PT board calibration files (path: `firmware/PT_Board/Calibration/`)
  - **JSON**: From calibration GUI output (path: `scripts/calibration/calibrations/*.json`)
- Calibration uses cubic polynomial: `psi = A * (adc_code^3) + B * (adc_code^2) + C * adc_code + D`
- Calibration is automatically loaded on GUI startup
- Only calibrated sensors show PSI values and are plotted

### 3. Data Source Identification
**Problem**: Couldn't distinguish between PT board and actuator board data.

**Solution**:
- Added `filter_source_ip` configuration
- `SensorPlotWidget.filter_source_ip` = `192.168.2.101` (PT board)
- `ActuatorControlWidget.device_ip` = `192.168.2.201` (actuator board)
- Each widget only processes data from its designated source

## Calibration Framework Usage

### Running PT Calibration
```bash
python3 scripts/calibration/pt_calibration_gui.py
```

### Calibration Process
1. Connect to serial port (ESP32 board)
2. Collect calibration points at known pressures
3. Fit polynomial coefficients (A, B, C, D) for each sensor
4. Save calibration to JSON: `scripts/calibration/calibrations/calibration_YYYY-MM-DD.json`

### Loading Calibration in GUI
The GUI automatically loads calibration in this order:
1. **JSON files** from `scripts/calibration/calibrations/` (most recent first)
2. **CSV files** from `firmware/PT_Board/Calibration/`

### Calibration Format

**JSON Format** (from calibration GUI):
```json
{
  "calibration_polynomials": {
    "1": [A, B, C, D],  // Sensor 1 coefficients
    "2": [A, B, C, D],  // Sensor 2 coefficients
    ...
  }
}
```

**CSV Format** (from DiabloAvionics):
- Columns: `PT{N} Coefficient 0`, `PT{N} Coefficient 1`, `PT{N} Coefficient 2`, `PT{N} Coefficient 3`
- Uses last row for final calibration coefficients

## Configuration

### Network Settings
```json
{
  "network": {
    "actuator_ip": "192.168.2.201",      // Actuator board IP
    "sensor_ip_filter": "192.168.2.101", // PT board IP (for filtering)
    "actuator_port": 5005,
    "receive_port": 5006,
    "bind_address": "0.0.0.0"
  }
}
```

## Testing PT Calibration

1. **Run calibration GUI**:
   ```bash
   python3 scripts/calibration/pt_calibration_gui.py
   ```

2. **Collect calibration points**:
   - Apply known reference pressures
   - Record voltage readings
   - Fit polynomial coefficients

3. **Save calibration**:
   - Calibration GUI saves to `scripts/calibration/calibrations/`

4. **Run main GUI**:
   ```bash
   python3 scripts/gui/combined_fsw_gui.py
   ```

5. **Verify**:
   - Calibrated sensors show PSI values (not just voltage)
   - Pressure plots appear for calibrated sensors only
   - Actuator voltage readings come from actuator board (separate from PT sensors)

## Next Steps

1. **Complete calibration** for all PT sensors
2. **Test priorities** - develop priority system for sensor readings
3. **System response testing** - verify how system responds to calibrated pressures
4. **Integration** - ensure calibration is applied in FSW control logic
