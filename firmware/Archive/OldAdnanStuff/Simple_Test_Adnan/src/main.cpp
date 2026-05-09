#include <Arduino.h>
#include <SPI.h>
#include "STAR_ADS126X.h"
#include "adc_mappings.h"

// Change the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board

// These lines MUST be after the #define PINS_ACTIVE_LAYOUT or they will overwrite it with the default value!
#include "sense_board_pins.h"
#include "connector_adc_map.h"

// Pin on each connector to test (always 1)
#define TEST_PIN 1

// Import shared config - ensure this matches adc_config.py in the GUI
#include "adc_config.h"

// Configuration constants
#define FILTER    ADS126X_SINC4
#define DATA_RATE ADS126X_RATE_7200
// READINGS_PER_MUX is defined in adc_config.h

using namespace sense_board_pins;

static ADS126X ads126x;

// Buffer configuration constants
#define MAGIC_SIZE 4
#define SAMPLES_PER_BUFFER 20  // Reduced from 83 to make packets smaller and less bursty
#define NUM_CHANNELS 3
// Buffer size: Magic (4 bytes) + SAMPLES_PER_BUFFER samples × NUM_CHANNELS channels × READINGS_PER_MUX × (4 bytes timestamp + 4 bytes reading)
// For SAMPLES_PER_BUFFER=20, NUM_CHANNELS=3, READINGS_PER_MUX=10: 4 + 20 × 3 × 10 × 8 = 4 + 4800 = 4804 bytes
#define BUFFER_SIZE (MAGIC_SIZE + SAMPLES_PER_BUFFER * NUM_CHANNELS * READINGS_PER_MUX * 8)

static uint8_t txBuffer[BUFFER_SIZE];
static const uint8_t MAGIC[MAGIC_SIZE] = {'A', 'D', '2', '6'};

// Forward declarations
void read_data(int count, uint8_t** dataPtr);
void flush_cycles(int cycles);

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
  ads126x.setFilter(FILTER);

  // Set the datarate. You can change this, but the options depends on the filter
  ads126x.setRate(DATA_RATE);

  // Set the reference
  ads126x.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);

  // Start ADC now that configuration is done
  ads126x.startADC1();

  // Initialize buffer with magic bytes
  memcpy(txBuffer, MAGIC, MAGIC_SIZE);
}

void loop() {
  // Pointer to data section (after magic bytes)
  uint8_t* dataPtr = txBuffer + MAGIC_SIZE;
  
  // Set initial mux for first connector and let it settle
  uint8_t nextChannel = getAdcChannel(1, TEST_PIN);
  ads126x.setInputMux(nextChannel, ADS126X_AINCOM);
  flush_cycles(settlePulses(FILTER, DATA_RATE));
  
  // Collect 83 samples to fill the buffer
  // Structure: 83 samples × 3 channels × READINGS_PER_MUX readings per channel
  for (int sample = 0; sample < SAMPLES_PER_BUFFER; sample++) {
    // Loop through connectors 1, 2, 3
    for (int connector = 1; connector <= NUM_CHANNELS; connector++) {
      // Read data from current mux (which was set and settled in previous iteration)
      read_data(READINGS_PER_MUX, &dataPtr);
      
      // Set mux for next connector (or wrap around to first for next sample)
      if (connector < NUM_CHANNELS) {
        nextChannel = getAdcChannel(connector + 1, TEST_PIN);
      } else {
        // Last connector of this sample, next will be first connector of next sample
        nextChannel = getAdcChannel(1, TEST_PIN);
      }
      ads126x.setInputMux(nextChannel, ADS126X_AINCOM);
      
      // Flush cycles to let mux settle (discards unsettled data)
      flush_cycles(settlePulses(FILTER, DATA_RATE));
    }
  }
  
  // Send the complete buffer
  Serial.write(txBuffer, BUFFER_SIZE);
}

void read_data(int count, uint8_t** dataPtr) {
  for (int i = 0; i < count; i++) {
    // Keep reading until we get a valid checksum
    bool validReading = false;
    uint32_t timestamp;
    int32_t readingValue;
    
    while (!validReading) {
      // Wait for data 
      while(digitalRead(Pins.ADC_DRDY_1) != LOW) {
        delayMicroseconds(1);
      }

      // Capture timestamp right before reading
      timestamp = micros();

      // Get reading
      const auto reading = ads126x.readADC1();

      // Only use if checksum is valid
      if (reading.checksumValid) {
        readingValue = reading.value;
        validReading = true;
      }
    }
    
    // Store timestamp (little-endian format)
    *(*dataPtr)++ = (timestamp >>  0) & 0xFF;
    *(*dataPtr)++ = (timestamp >>  8) & 0xFF;
    *(*dataPtr)++ = (timestamp >> 16) & 0xFF;
    *(*dataPtr)++ = (timestamp >> 24) & 0xFF;
    
    // Store reading (little-endian format)
    *(*dataPtr)++ = (readingValue >>  0) & 0xFF;
    *(*dataPtr)++ = (readingValue >>  8) & 0xFF;
    *(*dataPtr)++ = (readingValue >> 16) & 0xFF;
    *(*dataPtr)++ = (readingValue >> 24) & 0xFF;
  }
}

void flush_cycles(int cycles) {
  for (int i = 0; i < cycles; i++) {
    // Wait for data 
    while(digitalRead(Pins.ADC_DRDY_1) != LOW) {
      delayMicroseconds(1);
    }
    // Read and discard the data to clear the pipeline
    ads126x.readADC1();
  }
}