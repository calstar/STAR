#include <ADS126X.h>
#include <SPI.h>
#include <Arduino.h>

// #define DRDY_PIN 45
// #define DOUT 41
// #define DIN 47
// #define SCLK 13
// #define CS 40

#define DRDY_PIN 14
#define DOUT 41 //MISO
#define DIN 5 //MOSI
#define SCLK 13
#define CS 37
#define START 43

// ADS126X instance as a global so it persists
ADS126X adc;

int pos_pin = 0;     // AIN0
int neg_pin = 0xA;   // AINCOM

#pragma pack(push, 1)
struct SampleRecord {
  uint32_t t_us;               // Time from micros()
  uint8_t  channel;            // Input channel index
  int32_t  volt_reader;        // Raw ADC code (signed)
  float    voltage;            // Calculated volts
  uint32_t read_time_us;       // Read duration (micros)
  float    samples_per_second; // 1e6 / read_time_us
};
#pragma pack(pop)

void setup() {
  Serial.begin(115200);
  // For ESP32-style SPI pin mapping; ignore on boards where SPI.begin() has no args
  SPI.begin(SCLK, DOUT, DIN, CS);

  adc.begin(CS);
  adc.startADC1();
  adc.setRate(ADS126X_RATE_38400);
  // adc.enableInternalReference();
  // adc.bypassPGA();
  pinMode(DRDY_PIN, INPUT);
  pinMode(START, OUTPUT);
  digitalWrite(START, LOW);
}

void loop() {
  Serial.print(1);
  // Read 10 channels (0..9). Adjust as needed.
    uint8_t ch = 1;
  for (uint8_t ch = 0; ch < 10; ch++) {
    // Wait for DRDY low
    long volt_reader = adc.readADC1(ch, neg_pin); // read the voltage

    for (int j=0; j<4; j++) {
       while (digitalRead(DRDY_PIN) == HIGH) {
        // wait
      }  
    }
    
    uint32_t t_start = micros();

    // Read raw code
    long raw = adc.readADC1(ch, neg_pin);

    uint32_t read_time = micros() - t_start;

    // Convert to volts. Full-scale 2^23 = 8388608, reference scaling assumed 5 V
    float volts = (float)raw * 2.5f / 2147483648.0f;

    float sps = (read_time > 0) ? (1000000.0f / (float)read_time) : 0.0f;

    SampleRecord rec;
    rec.t_us = t_start;
    rec.channel = ch;
    rec.volt_reader = (int32_t)raw;
    rec.voltage = volts;
    rec.read_time_us = read_time;
    rec.samples_per_second = sps;

    // Write the packed binary record
    Serial.write((uint8_t *)&rec, sizeof(rec));
  }
}
