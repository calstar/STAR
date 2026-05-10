// adc.h
// Minimal interface for fast multi-channel ADS1263 reads

#ifndef ADCS_H_
#define ADCS_H_

#include "board_pins.h"
#include <ADS126X.h>
#include <Arduino.h>
#include <SPI.h>
#include <stddef.h>
#include <stdint.h>

namespace adcs {

// ADC RTD Configuration
static constexpr uint8_t RTD1_IDAC1 = ADS126X_IDAC_AIN1;
static constexpr uint8_t RTD1_AINP = ADS126X_IDAC_AIN2;
static constexpr uint8_t RTD1_AINN = ADS126X_IDAC_AIN3;
static constexpr uint8_t RTD1_IDAC2 = ADS126X_IDAC_AIN4;

static constexpr uint8_t RTD2_IDAC1 = ADS126X_IDAC_AIN5;
static constexpr uint8_t RTD2_AINP = ADS126X_IDAC_AIN6;
static constexpr uint8_t RTD2_AINN = ADS126X_IDAC_AIN7;
static constexpr uint8_t RTD2_IDAC2 = ADS126X_IDAC_AIN8;

static constexpr uint8_t RTD_IDAC_MAG = ADS126X_IDAC_MAG_50;

// Sentinels for “skip this setting”
static constexpr uint8_t REF_SKIP = 0xFF;
static constexpr uint8_t FILT_SKIP = 0xFF;

// ADC Read Struct
struct ReadResult {
  int32_t raw;            // signed ADC code
  uint32_t sample_time;   // Sample read abs time
  uint32_t read_time_dur; // SPI read time in us. Total time of adc::read()
  uint32_t conv_time_dur; // Conversion time. Time from startADC to DRDY
  bool ok;                // true if DRDY arrived
};

struct ChannelRead {
  uint8_t channel_pos;
  uint8_t channel_neg;
  ReadResult result;
};

constexpr size_t MAX_CHANNELS = 10;

struct AllResults {
  ChannelRead samples[MAX_CHANNELS]; // outputs of read(chs[i])
  size_t count;                      // how many entries are valid
  uint32_t total_time;               // total sweep time (us)
  uint32_t failures;                 // number of channels where ok == false
};

// Call once at startup. Sets up SPI, pins, resets the ADC, waits for DRDY.
// Returns true if the ADC responds. Initializes the ADS1263.
bool init();

// Chop mode corresponds to chop + idac rotation enabled
bool configure(uint8_t negativeReference = REF_SKIP,
               uint8_t positiveReference = REF_SKIP, bool bypassPGA = false,
               uint8_t gainPGA = 1, uint8_t chopMode = ADS126X_CHOP_3,
               uint8_t sincFilter = FILT_SKIP,
               uint8_t rate = ADS126X_RATE_38400);

ReadResult readRTD1();
ReadResult readRTD2();

ADS126X &device(void);

void setChannel(
    uint8_t channel); // Checks if MUX has changed, if so -> sets new MUX. This
                      // uses moloriouses adcread1 rn... but it should not take
                      // up extra time, as no conversion has happened yet

// Read one channel once, blocking until DRDY.
// Returns signed 32-bit raw ADC code and 32-bit unsigned read time
ReadResult read(uint8_t channel, uint8_t neg_channel = neg_pin);

AllResults readAll(const uint8_t *channels, size_t num_channels);

} // namespace adcs

#endif // ADCS_H_
