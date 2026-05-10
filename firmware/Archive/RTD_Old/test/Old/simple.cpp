// #include <ADS126X.h>
// #include <SPI.h>
// #include <Arduino.h>
// #include "board_pins.h"
// #include "adcs.h"

// void setup() {
//   Serial.begin(230400);
//   SPI.begin(SCLK, MISOp, MOSIp, CS);

//   if (!adcs::init())    { while (1) { delay(1000); } }
//   if (!adcs::configure()){ while (1) { delay(1000); } }
// }

// void loop() {
//   const uint8_t channel = 7;
//   auto result = adcs::read(channel);

//   if (result.ok) {
//     Serial.print("Channel: "); Serial.println(channel);
//     Serial.print("Raw value: "); Serial.println(result.raw);
//     Serial.print("Sample time (us): "); Serial.println(result.sample_time);
//     Serial.print("Read duration (us): "); Serial.println(result.read_time_dur);
//     Serial.print("Conversion time (us): "); Serial.println(result.conv_time_dur);
//     Serial.println("-------------");
//   } else {
//     Serial.println("ADC read failed or timed out.");
//   }

//   delay(500); // half second delay between reads
// }
