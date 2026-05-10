#include "my_ADS126X.h"
#include <Arduino.h>
#include <SPI.h>

// Chnage the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board

// This line MUST be after the #define PINS_ACTIVE_LAYOUT or it will override it
#include "sense_board_pins.h"

using sense_board_pins::Pins;

static ADS126X ads126x;

float convert_code_to_voltage(int32_t code) {
  // Assumes the 2.5V internal reference is being used! 
  return ((float)code * 2.5f) / 2147483648.0f;
}

void setup() {
  Serial.begin(115200);

  // Setup SPI
  SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);

  // You can set the freq if you want, or just use the default
  // SPI.setFrequency(1'000'000);

  // Due to the ADC output having valid data on FALLING CLK edges
  SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  // Setup ADC
  ads126x.begin(Pins.ADC_CS_1);

  // Stop it while we config it, as suggested by datasheet
  ads126x.stopADC1();

  // If the two lines below are uncommented, the TDACs
  // will be connected to AIN6 and AIN7. This is useful for probing,
  // but makes the TDACs "see" our analog front end which could cause issues
  // ads126x.setOutputTDACP(1);
  // ads126x.setOutputTDACN(1);

  // Sets the positive TDAC to 3V, since we have 5V power
  ads126x.setOutputmagnitudeTDACP(ADS126X_TDAC_DIV_0_6);

  // Sets the negative TDAC to 2.5V, since we have 5V power
  ads126x.setOutputmagnitudeTDACN(ADS126X_TDAC_DIV_0_5);

  // Set the input to ADC1 to be the TDAC 
  ads126x.setInputMux(ADS126X_TDAC, ADS126X_TDAC);

  // Bypas the PGA, so it does not affect measurements 
  ads126x.bypassPGA();

  // Set the filter. You can change this to try different filters
  ads126x.setFilter(ADS126X_SINC4);

  // Set the datarate. You can change this, but the options depends on the filter
  // I do not know what happens if you program an invalid data rate for a given filter
  ads126x.setRate(ADS126X_RATE_38400);

  // Start ADC now that configuration is done
  ads126x.startADC1();
}

void loop() {
  // Wait for DRDY pin
  while(digitalRead(Pins.ADC_DRDY_1) != LOW) {
    delayMicroseconds(10);
  }
  
  delayMicroseconds(25);

  // Get the most recent value 
  const auto reading = ads126x.readADC1();
  Serial.print(F("TDAC reading: "));
  Serial.print(convert_code_to_voltage(reading.value), 6);
  Serial.println(" V");

  // Checks for invalid checksums, which signal corruption 
  if (!reading.checksumValid) {
    Serial.println("Bad checksum!");
  }
}