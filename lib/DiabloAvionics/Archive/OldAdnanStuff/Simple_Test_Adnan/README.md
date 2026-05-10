# ADS126X Simple Test

## What It Does

Tests a single ADC channel, using a chosen pin. Note that this script currently only does single ended measurements, referenced to AINCOM. 
So it works for testing the PT / TC, but results may vary with LC and RTD depending on if the AINCOM is grounded. 

## Usage
1. Supply at external voltage, under 2.5V, to the chosen pin, relative to GND (technically AINCOM)
2. Upload `main.cpp`
3. Open Serial Monitor (115200 baud) 
4. Check that the voltages printed are as expected

## Configuration

In main, change the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
```cpp
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board
```
Additionally, change the following lines to set what connectors and pin you want to ouse
```cpp
#define TEST_CONNECTOR 3
#define TEST_PIN 1

```