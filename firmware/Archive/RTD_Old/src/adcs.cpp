// adc.cpp
// Abstraction for adc library

#include "adcs.h"

#include "board_pins.h"
#include <Arduino.h>

static ADS126X ads;

namespace adcs {
// -----------------------------------------------------------------------------
// init
// -----------------------------------------------------------------------------
bool init() {
  // Pins
  pinMode(START, OUTPUT);
  pinMode(DRDY, INPUT);
  digitalWrite(START, LOW); // START will stay low forever as START1 cmd over
                            // SPI will be used instead

  ads.begin(CS);
  ads.enableInternalReference(); // 2.5V
  delay(50);                     // Delay for settling

  return true;
}

// -----------------------------------------------------------------------------
// configure
//   Default: 38.4 kSPS, SINCn ignored at this rate, CHOP off, pulse mode
//   Also runs self-offset calibration at the end.
// -----------------------------------------------------------------------------
bool configure(uint8_t negativeReference, uint8_t positiveReference,
               bool bypassPGA, uint8_t gainPGA, uint8_t chopMode,
               uint8_t sincFilter, uint8_t rate) {

  if (negativeReference != REF_SKIP && positiveReference != REF_SKIP) {
    ads.setReference(negativeReference, positiveReference);
  }
  if (bypassPGA) {
    ads.bypassPGA(); // COMMENT OUT
  } else if (!bypassPGA && gainPGA) {
    ads.enablePGA();
    ads.setGain(gainPGA);
  } else {
    ads.bypassPGA();
  }
  ads.setChopMode(chopMode);

  if (sincFilter != FILT_SKIP) {
    ads.setFilter(sincFilter);
  }
  ads.setRate(rate);
  // ads.setPulseMode(); cts
  ads.setContinuousMode();
  ads.calibrateSelfOffsetADC1();
  delay(50);
  ads.startADC1();

  return true;
}

ADS126X &device() { return ads; }

ReadResult read(uint8_t channel, uint8_t neg_channel) {
  uint32_t read_start = micros();
  ads.readADC1(channel, neg_channel); // TODO: adnan this is dummy read right?
  uint32_t conv_start = micros();

  // Data Ready
  uint32_t t_wait = micros();
  for (int i = 0; i < 5; ++i) {
    while (digitalRead(DRDY) == HIGH) {
      if (micros() - t_wait > 100000) { // 100 ms timeout guard
        return {INT32_MIN, 0u, 0u, 0u, false};
      }
    }
    // short pause so we sample again to confirm DRDY stayed low
    // delayMicroseconds(2);
  }
  uint32_t conv_time_dur = micros() - conv_start;

  long raw = ads.readADC1(channel, neg_channel);

  uint32_t read_time_dur = micros() - read_start;
  uint32_t sample_time = t_wait + (conv_time_dur >> 1);

  return ReadResult{raw, sample_time, read_time_dur, conv_time_dur, true};
}

ReadResult readRTD1() {
  ads.setIDAC1Pin(RTD1_IDAC1);
  ads.setIDAC2Pin(RTD1_IDAC2);
  ads.setIDAC1Mag(RTD_IDAC_MAG);
  ads.setIDAC2Mag(RTD_IDAC_MAG);

  return read(RTD1_AINP, RTD1_AINN);
}

ReadResult readRTD2() {
  ads.setIDAC1Pin(RTD2_IDAC1);
  ads.setIDAC2Pin(RTD2_IDAC2);
  ads.setIDAC1Mag(RTD_IDAC_MAG);
  ads.setIDAC2Mag(RTD_IDAC_MAG);

  return read(RTD2_AINP, RTD2_AINN);
}

AllResults readAll(const uint8_t *channels, size_t num_channels) {
  AllResults results{};
  const uint32_t read_start = micros();

  const size_t results_size =
      (num_channels <= MAX_CHANNELS) ? num_channels : MAX_CHANNELS;
  results.count = results_size;

  // Sweep channels
  for (size_t i = 0; i < results_size; ++i) {
    const uint8_t ch = channels[i];
    results.samples[i].channel_pos = ch;
    results.samples[i].channel_neg = neg_pin;
    results.samples[i].result = read(ch);
    if (!results.samples[i].result.ok) {
      results.failures++;
    }
  }

  results.total_time = micros() - read_start;

  return results;
}

AllResults readAllRTD() {
  AllResults results{};
  const uint32_t read_start = micros();

  const size_t results_size = 2;
  results.count = results_size;

  // Read both RTD
  results.samples[0].channel_pos = RTD1_AINP;
  results.samples[0].channel_neg = RTD1_AINN;
  results.samples[0].result = readRTD1();
  if (!results.samples[0].result.ok) {
    results.failures++;
  }

  results.samples[1].channel_pos = RTD2_AINP;
  results.samples[1].channel_neg = RTD2_AINN;
  results.samples[1].result = readRTD2();
  if (!results.samples[1].result.ok) {
    results.failures++;
  }

  results.total_time = micros() - read_start;

  return results;
}

} // namespace adcs
