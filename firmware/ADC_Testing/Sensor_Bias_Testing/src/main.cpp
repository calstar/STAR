#include <Arduino.h>
#include <SPI.h>
#include "STAR_ADS126X.h"

// Change the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
#define PINS_ACTIVE_LAYOUT sense_board_pins::RTD_Board

// These lines MUST be after the #define PINS_ACTIVE_LAYOUT or they will overwrite it with the default value!
#include "sense_board_pins.h"
#include "connector_adc_map.h"

using namespace sense_board_pins;

static ADS126X ads126x;

float convert_code_to_voltage(int32_t code) {
  // Assumes the 2.5V internal reference is being used! 
  return ((float)code * 2.5f) / 2147483648.0f;
}

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    delay(10);
  }

  delay(1000);

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

  // Set the input to ADC1 to be the whatever pin you want
  ads126x.setInputMux(getAdcChannel(2, 1), getAdcChannel(2, 2));
  
  // Bypas the PGA, so it does not affect measurements 
  ads126x.bypassPGA();

  // Set the filter. You can change this to try different filters
  ads126x.setFilter(ADS126X_SINC4);

  // Set the datarate. You can change this, but the options depends on the filter
  // I do not know what happens if you program an invalid data rate for a given filter
  ads126x.setRate(ADS126X_RATE_1200);
  
  ads126x.setBiasMagnitude(ADS126X_BIAS_MAG_10M);

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
  Serial.print(F("Current reading: "));
  Serial.print(convert_code_to_voltage(reading.value), 6);
  Serial.println(" V");

  // Checks for invalid checksums, which signal corruption 
  if (!reading.checksumValid) {
    Serial.println("Bad checksum!");
  }
}