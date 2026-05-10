# ADS126X Filter/Rate Sweep Test

## What It Does

Automatically sweeps through different filter and data rate combinations, measuring ADC noise performance for each:
- Tests SINC1, SINC2, SINC3, SINC4, and FIR filters
- Tests multiple data rates (2.5 to 19200 SPS)
- Adaptive sample count (100-1000 samples based on rate)
- Calculates: RMS noise, Peak-to-Peak, ENOB, Noise-free bits

## Usage

1. Upload `main.cpp`
2. Open Serial Monitor (115200 baud) within 5 seconds
3. **Wait** - test runs automatically through all configurations
4. View results table when complete

**Test Duration:** ~2-3 minutes (17 configurations, adaptive sample counts)

## Configuration

```cpp
#define USE_ADC1 1     // 1 = ADC1 (32-bit), 0 = ADC2 (24-bit)
#define USE_CHOP 0     // 1 = Enable chop mode, 0 = Disable
```

Edit `testConfigs[]` array to customize which filter/rate combinations to test.

