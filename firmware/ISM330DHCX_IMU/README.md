# STMicroelectronics ISM330DHCX Avionics Firmware Driver with Embedded Machine Learning Core (MLC)

A portable, production-grade C/C++ firmware driver and header package for the **STMicroelectronics ISM330DHCX** 6-DOF Inertial Measurement Unit (IMU), specifically tailored for high-dynamic avionics and rocketry flight classification.

---

## 🚀 Features & Sensor Specs

| Feature | Specification |
|---|---|
| **Part** | STMicroelectronics `ISM330DHCXTR` (LGA-14L, 2.5 × 3.0 × 0.83 mm) |
| **JLCPCB Part ID** | [C2655101](https://jlcpcb.com/partdetail/STMicroelectronics-ISM330DHCXTR/C2655101) |
| **Accelerometer Full Scale** | Selectable: $\pm2\text{ g}$, $\pm4\text{ g}$, $\pm8\text{ g}$, $\pm16\text{ g}$ |
| **Accel Sensitivity** | **$0.061\text{ mg/LSB}$** at $\pm2\text{ g}$; $0.488\text{ mg/LSB}$ at $\pm16\text{ g}$ |
| **Gyroscope Full Scale** | $\pm125$, $\pm250$, $\pm500$, $\pm1000$, $\pm2000$, $\pm4000\text{ dps}$ |
| **Gyro Sensitivity** | $4.375\text{ mdps/LSB}$ ($\pm125\text{ dps}$) to $140\text{ mdps/LSB}$ ($\pm4000\text{ dps}$) |
| **Max ODR** | Up to **$6.66\text{ kHz}$** for both Accelerometer and Gyroscope |
| **FIFO Buffer** | **$3\text{ KB}$** standard (up to **$9\text{ KB}$** with hardware compression) |
| **Interfaces** | $\text{I}^2\text{C}$ (up to $1\text{ MHz}$ Fast Mode+), SPI 3/4-wire (up to $10\text{ MHz}$), MIPI I3C, Aux SPI |
| **ML Engine** | **Machine Learning Core (MLC)** with up to 8 independent decision trees running in-hardware |

---

## 📁 Repository Structure

```
ism330dhcx_firmware/
├── include/
│   ├── ism330dhcx_regs.h         # Complete datasheet register map, bit masks & sensitivity constants
│   ├── ism330dhcx_mlc.h          # MLC UCF structures, 8 decision tree output mappings & enums
│   ├── ism330dhcx.h              # Clean, platform-agnostic C driver API
│   └── mlc_avionics_config.h     # Pre-compiled on-chip 8-tree avionics decision tree stream
├── src/
│   └── ism330dhcx.c              # High-performance, MISRA-compliant implementation
├── examples/
│   └── main_avionics_firmware.c  # Runnable avionics application with telemetry & MLC classification
├── CMakeLists.txt                # CMake build config
├── Makefile                      # Quick build & test script
└── README.md
```

---

## 🧠 Machine Learning Core (MLC) Integration

The ISM330DHCX embeds a hardware **Machine Learning Core** running on low-power silicon logic independently of the main MCU. The driver programs up to **8 concurrent decision trees** into the embedded memory pages:

1. **Tree 0 - Flight Phase Classifier**:
   - `PAD (0x00)`: 1g static pre-launch
   - `BOOST (0x01)`: High axial acceleration ($>10\text{ g}$) + roll stabilization
   - `COAST (0x02)`: Ballistic arc, low drag
   - `APOGEE (0x03)`: Near zero-g rollover inversion
   - `DROGUE (0x04)`: First chute deployment deceleration shock
   - `MAIN (0x05)`: Terminal steady-rate descent
   - `TOUCHDOWN (0x06)`: Ground landing settlement
2. **Tree 1 - Signal Drop Risk**: Evaluates high angular velocity variance and rapid geomagnetic shifts indicating antenna pointing misalignment.
3. **Tree 2 - Apogee Turnover**: Micro-g inversion confirmation.
4. **Tree 3 - First Chute Verification**: Deceleration shock verification.
5. **Tree 4 - Main Chute Deployment**: Low-speed steady descent transition.
6. **Tree 5 - Touchdown Confirmed**: Static 1g impact settlement.
7. **Tree 6 - Extreme Tumbling / Flight Abort**: High spin rate ($>1000\text{ dps}$) anomaly detection.
8. **Tree 7 - Emergency Chute Trigger**: Redundant hardware safety release.

---

## 🛠️ Porting to Your MCU (Hardware Abstraction Layer)

The driver requires 3 simple callback functions (`read_reg`, `write_reg`, and `delay_ms`).

### Example: STM32 HAL (I2C)

```c
#include "ism330dhcx.h"
#include "stm32f4xx_hal.h"

extern I2C_HandleTypeDef hi2c1;

static int32_t stm32_i2c_write(void *handle, uint8_t reg, const uint8_t *data, uint16_t len) {
    I2C_HandleTypeDef *hi2c = (I2C_HandleTypeDef *)handle;
    return (HAL_I2C_Mem_Write(hi2c, (ISM330DHCX_I2C_ADD_L << 1), reg, I2C_MEMADD_SIZE_8BIT,
                              (uint8_t *)data, len, 100) == HAL_OK) ? 0 : -1;
}

static int32_t stm32_i2c_read(void *handle, uint8_t reg, uint8_t *data, uint16_t len) {
    I2C_HandleTypeDef *hi2c = (I2C_HandleTypeDef *)handle;
    return (HAL_I2C_Mem_Read(hi2c, (ISM330DHCX_I2C_ADD_L << 1), reg, I2C_MEMADD_SIZE_8BIT,
                             data, len, 100) == HAL_OK) ? 0 : -1;
}

static void stm32_delay(uint32_t ms) {
    HAL_Delay(ms);
}

int init_imu(void) {
    ism330dhcx_ctx_t imu;
    imu.handle    = &hi2c1;
    imu.write_reg = stm32_i2c_write;
    imu.read_reg  = stm32_i2c_read;
    imu.delay_ms  = stm32_delay;
    imu.i2c_addr  = ISM330DHCX_I2C_ADD_L;

    if (ism330dhcx_init(&imu) != ISM330DHCX_OK) {
        return -1;
    }
    
    // Configure avionics scales
    ism330dhcx_set_accel_config(&imu, ISM330DHCX_XL_ODR_416Hz, ISM330DHCX_XL_FS_16G);
    ism330dhcx_set_gyro_config(&imu, ISM330DHCX_GY_ODR_416Hz, ISM330DHCX_GY_FS_4000DPS);
    
    // Load on-chip Machine Learning Core model
    ism330dhcx_mlc_load_config(&imu, ism330dhcx_avionics_mlc_config, ISM330DHCX_AVIONICS_MLC_CONFIG_LEN);
    ism330dhcx_mlc_enable(&imu, true, ISM330DHCX_MLC_ODR_26Hz);

    return 0;
}
```

---

## ⚡ Quick Start & Verification

To compile and run the flight simulation test harness on your workstation:

```bash
cd ism330dhcx_firmware
make run
```
