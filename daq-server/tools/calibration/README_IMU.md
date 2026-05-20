# IMU Calibration System

Python-based calibration system for IMU sensors (accelerometer, gyroscope, magnetometer), following the PT calibration pattern.

## Files

- `imu_calibration.py` - Core calibration library
- `imu_calibration_gui.py` - Interactive GUI for calibration
- `accelerometer_calibration.py` - Accelerometer-specific calibration script
- `gyroscope_calibration.py` - Gyroscope-specific calibration script
- `magnetometer_calibration.py` - Magnetometer-specific calibration script

## Usage

### Accelerometer Calibration

**Static Position Method:**
```bash
python accelerometer_calibration.py --interactive --output accel_cal.json
```

Place sensor in 6+ orientations where gravity is the only acceleration:
- +X, -X, +Y, -Y, +Z, -Z axes up

### Gyroscope Calibration

**Zero-Velocity Method:**
```bash
python gyroscope_calibration.py --duration 60 --output gyro_cal.json
```

Keep sensor stationary for specified duration. Calibration estimates bias.

### Magnetometer Calibration

**Ellipsoid Fitting Method:**
```bash
python magnetometer_calibration.py --interactive --output mag_cal.json
```

Rotate sensor through 12+ orientations. Calibration estimates hard iron (bias) and soft iron (scale/misalignment).

### GUI Mode

```bash
python imu_calibration_gui.py --sensor-type accel --port 5008
```

Interactive GUI for real-time calibration with live plots.

## Calibration Parameters

Each calibration produces:
- **Bias**: Offset correction [sensor units]
- **Scale Matrix**: Scale factors and misalignment [3x3]
- **Temperature Coefficient**: Temperature compensation
- **Quality Metric**: Calibration quality (0-1)

## Integration with FSW

Calibration parameters can be loaded in C++ FSW:

```cpp
#include "calibration/IMUCalibration.hpp"

// Load calibration from JSON
auto calibrator = std::make_shared<IMUCalibration>(SensorType::ACCELEROMETER, "imu_0");
// Would need JSON loader in C++
```

Or use Python calibration results directly in Python-based systems.

## References

- PT Calibration: `firmware/PT_Board/Calibration/pt_cali.py`
- LC Calibration GUI: `firmware/LC_Board/LC_Calibration/LC_Calibration_Gui/`
