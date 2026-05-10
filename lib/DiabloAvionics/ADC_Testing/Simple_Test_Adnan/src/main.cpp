#include <Arduino.h>
#include <SPI.h>
#include "STAR_ADS126X.h"

// Change the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board

// These lines MUST be after the #define PINS_ACTIVE_LAYOUT or they will overwrite it with the default value!
#include "sense_board_pins.h"
#include "connector_adc_map.h"

// Pin on each connector to test (always 1)
#define TEST_PIN 1

using namespace sense_board_pins;

static ADS126X ads126x;

// Buffer configuration
// Magic (4 bytes) + 83 samples × 3 channels × (4 bytes timestamp + 4 bytes reading) = 1996 bytes
#define BUFFER_SIZE 1996
#define MAGIC_SIZE 4
#define SAMPLES_PER_BUFFER 83
#define NUM_CHANNELS 3

static uint8_t txBuffer[BUFFER_SIZE];
static const uint8_t MAGIC[MAGIC_SIZE] = {'A', 'D', '2', '6'};

void setup() {
  Serial.begin(115200);

  // Setup SPI
  SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);

  // Due to the ADC output having valid data on FALLING CLK edges
  SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  // Setup ADC
  ads126x.begin(Pins.ADC_CS_1);

  // Stop it while we config it, as suggested by datasheet
  ads126x.stopADC1();

  // Bypass the PGA, so it does not affect measurements 
  ads126x.bypassPGA();

  // Set the filter. You can change this to try different filters
  ads126x.setFilter(ADS126X_SINC4);

  // Set the datarate. You can change this, but the options depends on the filter
  ads126x.setRate(ADS126X_RATE_1200);

  // Start ADC now that configuration is done
  ads126x.startADC1();

  // Initialize buffer with magic bytes
  memcpy(txBuffer, MAGIC, MAGIC_SIZE);
}

void loop() {
  // Pointer to data section (after magic bytes)
  uint8_t* dataPtr = txBuffer + MAGIC_SIZE;
  
  // Collect 83 samples to fill the buffer
  for (int sample = 0; sample < SAMPLES_PER_BUFFER; sample++) {
    // Loop through connectors 1, 2, 3
    for (int connector = 1; connector <= NUM_CHANNELS; connector++) {
      // Set the mux for this connector
      ads126x.setInputMux(getAdcChannel(connector, TEST_PIN), ADS126X_AINCOM);

      // Wait for DRDY pin (allow settle time after mux change)
      while(digitalRead(Pins.ADC_DRDY_1) != LOW) {
        delayMicroseconds(10);
      }
      
      delayMicroseconds(25);

      // Capture timestamp right before reading
      uint32_t timestamp = micros();
      
      // Get the reading
      const auto reading = ads126x.readADC1();
      int32_t readingValue = reading.value;
      
      // Store timestamp (little-endian format)
      *dataPtr++ = (timestamp >>  0) & 0xFF;
      *dataPtr++ = (timestamp >>  8) & 0xFF;
      *dataPtr++ = (timestamp >> 16) & 0xFF;
      *dataPtr++ = (timestamp >> 24) & 0xFF;
      
      // Store reading (little-endian format)
      *dataPtr++ = (readingValue >>  0) & 0xFF;
      *dataPtr++ = (readingValue >>  8) & 0xFF;
      *dataPtr++ = (readingValue >> 16) & 0xFF;
      *dataPtr++ = (readingValue >> 24) & 0xFF;
    }
  }
  
  // Send the complete buffer
  Serial.write(txBuffer, BUFFER_SIZE);
}
