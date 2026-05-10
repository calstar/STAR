// // adc.h
// // Minimal interface for fast multi-channel ADS1263 reads

// #ifndef ADCS_H_
// #define ADCS_H_

// #include <Arduino.h>
// #include <ADS126X.h>
// #include <SPI.h>
// #include <stdint.h>
// #include <stddef.h>

// namespace adcs {

// // Sentinels for “skip this setting”
// static constexpr uint8_t REF_SKIP   = 0xFF;
// static constexpr uint8_t FILT_SKIP  = 0xFF;

// // ADC Read Struct
//   struct ReadResult {
//     int32_t  raw;       // signed ADC code
//     uint32_t sample_time; //Sample read abs time
//     uint32_t read_time_dur;   // SPI read time in us. Total time of adc::read()
//     uint32_t conv_time_dur;   // Conversion time. Time from startADC to DRDY
//     bool     ok;        // true if DRDY arrived
//   };

//   struct ChannelRead {
//       uint8_t    channel;
//       ReadResult result;
//   };

//   constexpr size_t MAX_CHANNELS = 10;

//   struct AllResults {
//     ChannelRead samples[MAX_CHANNELS];  // outputs of read(chs[i])
//     size_t      count;                  // how many entries are valid
//     uint32_t    total_time;             // total sweep time (us)
//     uint32_t    failures;               // number of channels where ok == false
//   };



// // Call once at startup. Sets up SPI, pins, resets the ADC, waits for DRDY.
// // Returns true if the ADC responds. Initializes the ADS1263.
// bool init();
    

// bool configure(uint8_t negativeReference = REF_SKIP,
//                uint8_t positiveReference = REF_SKIP,
//                bool    bypassPGA         = false,
//                uint8_t gainPGA           = 1,
//                uint8_t chopMode          = ADS126X_CHOP_0,
//                uint8_t sincFilter        = FILT_SKIP,
//                uint8_t rate              = ADS126X_RATE_38400);



// ADS126X& device(void);

// void setChannel(uint8_t channel); // Checks if MUX has changed, if so -> sets new MUX. This uses moloriouses adcread1 rn... 
//                                   // but it should not take up extra time, as no conversion has happened yet

// // Read one channel once, blocking until DRDY.
// // Returns signed 32-bit raw ADC code and 32-bit unsigned read time
// ReadResult read(uint8_t channel);



// AllResults readAll(const uint8_t* channels, size_t num_channels);



// } // namespace adcs

// #endif // ADCS_H_

