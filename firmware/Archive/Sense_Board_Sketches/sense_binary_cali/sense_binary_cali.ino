#include <ADS126X.h>
#include <SPI.h>
#include <Arduino.h>

// #define DRDY_PIN 45
// #define DOUT 41
// #define DIN 47
// #define SCLK 13
// #define CS 40

#define DRDY_PIN 14
#define DOUT 41 // MISO
#define DIN 5   // MOSI
#define SCLK 13
#define CS 37
#define START 43

// 1 = ASCII voltages for the Python calibration script
// 0 = packed binary records (original behavior)
#define TEXT_OUTPUT 0
#define NUM_PTS 10

ADS126X adc;

int pos_pin = 0;     // AIN0
int neg_pin = 0xA;   // AINCOM

#pragma pack(push, 1)
struct SampleRecord {
  uint32_t t_us;
  uint8_t  channel;
  int32_t  volt_reader;        // Raw ADC code (signed)
  float    voltage;            // Volts
  uint32_t read_time_us;
  float    samples_per_second;
};
#pragma pack(pop)

void setup() {
  Serial.begin(115200);
  SPI.begin(SCLK, DOUT, DIN, CS);

  adc.begin(CS);
  adc.startADC1();
  adc.setRate(ADS126X_RATE_38400);
  adc.enableInternalReference();
  // adc.bypassPGA(); // enable if you want to bypass the PGA
  pinMode(DRDY_PIN, INPUT);
  pinMode(START, OUTPUT);
  digitalWrite(START, LOW);
}

void loop() {
  float voltages[NUM_PTS];

  for (uint8_t ch = 0; ch < NUM_PTS; ch++) {

    long raw_wase = adc.readADC1(ch, neg_pin);

    // Wait until DRDY is low
    for (int j = 0; j < 4; j++) {
      while (digitalRead(DRDY_PIN) == HIGH) {
        // wait
      }
    }

    uint32_t t_start = micros();

    long raw = adc.readADC1(ch, neg_pin);
    uint32_t read_time = micros() - t_start;

    // Convert to volts. Signed 32-bit full-scale assumed, Vref = 2.5 V
    float volts = (float)raw * 2.5f / 2147483648.0f;
    voltages[ch] = volts;

    if (!TEXT_OUTPUT) {
      float sps = (read_time > 0) ? (1000000.0f / (float)read_time) : 0.0f;

      SampleRecord rec;
      rec.t_us = t_start;
      rec.channel = ch;
      rec.volt_reader = (int32_t)raw;
      rec.voltage = volts;
      rec.read_time_us = read_time;
      rec.samples_per_second = sps;

      Serial.write((uint8_t *)&rec, sizeof(rec));
    }
  }

  if (TEXT_OUTPUT) {
    for (int i = 0; i < NUM_PTS; i++) {
      Serial.print(voltages[i], 6);
      if (i < NUM_PTS - 1) Serial.print(" ");
    }
    Serial.print("\r\n"); // CRLF as expected by the Python script
  }
}
