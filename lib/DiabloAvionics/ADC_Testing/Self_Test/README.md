# ADS126X Self Test

## What It Does

Tests the ADC using its internal TDAC. The internal TDAC can generate a voltage, and then we can read it with the ADC, as a simple self-test of the chip 

## Usage

1. Upload `main.cpp`
2. Open Serial Monitor (115200 baud) 
3. Check that the voltages printed are as expected

## Configuration

In main, change the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
```cpp
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board
```
