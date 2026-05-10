// #include <ADS126X.h>
// #include <SPI.h>
// #include <Arduino.h>
// #include "board_pins.h"
// #include "adcs.h"


// // 1 = ASCII voltages for the Python calibration script
// // 0 = packed binary records (original behavior)
// #define TEXT_OUTPUT 0
// #define PT_NUM_START 0
// #define NUM_PTS 10





// // --- Buffer settings ---
// static const size_t PKT_MAX = 1000;   // packet size in bytes
// static const uint32_t FLUSH_MS = 10;  // flush interval in ms

// static uint8_t pktA[PKT_MAX];
// static uint8_t pktB[PKT_MAX];
// static uint8_t* active = pktA;
// static uint8_t* standby = pktB;
// static size_t used = 0;
// static uint32_t lastFlushMs = 0;
// inline void flushPacketIfNeeded(bool force);

// ADS126X& adc = adcs::device();

// int pos_pin = 0;     // AIN0
// int neg_pin = 0xA;   // AINCOM

// #pragma pack(push, 1)
// struct SampleRecord {
//   uint32_t t_us;
//   uint8_t  channel;
//   int32_t  volt_reader;        // Raw ADC code (signed)
//   float    voltage;            // Volts
//   uint32_t read_time_us;
//   float    samples_per_second;
//   uint32_t sent_us;
// };
// #pragma pack(pop)

// void setup() {
//   Serial.begin(115200);
//   SPI.begin(SCLK, MISO, MOSI, CS);



//   if (!adcs::init()) {
//     while (1) {delay(1000);}
//   }

//   if (!adcs::configure()) {
//     while (1) {delay(1000);}
//   }


// adc.startADC1();
// }

// void loop() {
//   float voltages[NUM_PTS];

//   for (uint8_t ch = 0; ch < NUM_PTS; ch++) {

//     long raw_wase = adc.readADC1(ch, neg_pin);

//     // Wait until DRDY is low
//     for (int j = 0; j < 4; j++) {
//       while (digitalRead(DRDY_PIN) == HIGH) {
//         // wait
//       }
//     }

//     uint32_t t_start = micros();

//     long raw = adc.readADC1(ch, neg_pin);
//     uint32_t read_time = micros() - t_start;

//     // Convert to volts. Signed 32-bit full-scale assumed, Vref = 2.5 V
//     float volts = (float)raw * 2.5f / 2147483648.0f;
//     voltages[ch] = volts;

//     if (!TEXT_OUTPUT) {
//         float sps = (read_time > 0) ? (1000000.0f / (float)read_time) : 0.0f;

//         SampleRecord rec;
//         rec.t_us = t_start;
//         rec.channel = ch;
//         rec.volt_reader = (int32_t)raw;
//         rec.voltage = volts;
//         rec.read_time_us = read_time;
//         rec.samples_per_second = sps;
//         rec.sent_us = 0;

//         // Serial.write((uint8_t *)&rec, sizeof(rec));

//         // Buffer packet
//         // if this record won’t fit, flush first
//         if (used + sizeof(rec) > PKT_MAX) {
//         flushPacketIfNeeded(true);
//         }

//         // copy record into buffer
//         memcpy(active + used, &rec, sizeof(rec));
//         used += sizeof(rec);

//         // flush periodically (time-based)
//         flushPacketIfNeeded(false);

//     }
//   }

//   if (TEXT_OUTPUT) {
//     for (int i = 0; i < NUM_PTS; i++) {
//       Serial.print(voltages[i], 6);
//       if (i < NUM_PTS - 1) Serial.print(" ");
//     }
//     Serial.print("\r\n"); // CRLF as expected by the Python script
//   }
// }



// inline void flushPacketIfNeeded(bool force = false) {
//   uint32_t now = millis();
//   if (force || (used > 0 && (now - lastFlushMs >= FLUSH_MS))) {
//     uint32_t send_ts = micros();
//     if (used > 0) {
//       size_t count = used / sizeof(SampleRecord);
//       SampleRecord* recs = reinterpret_cast<SampleRecord*>(active);
//       for (size_t i = 0; i < count; ++i) {
//         recs[i].sent_us = send_ts;
//       }
//     }
//     Serial.write(active, used);
//     Serial.println();  // optional delimiter
//     uint8_t* tmp = active;
//     active = standby;
//     standby = tmp;
//     used = 0;
//     lastFlushMs = now;
//   }
// }