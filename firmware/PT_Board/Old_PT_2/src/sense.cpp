#ifdef RUN_SENSE_TEST
#include <ADS126X.h>
#include <SPI.h>
#include <Arduino.h>

#define DRDY_PIN 22
#define DOUT 21   // MISO
#define DIN 19    // MOSI
#define SCLK 20
#define CS 17

#define DRDY_PIN 22  // brown 15
// #define AINCOM 3
// #define AVSS 5
#define DOUT 21  // purple 14
#define DIN 19   // yellow 7
#define SCLK 20 // green 13
#define CS 17   // blue 6
int i = 0;         // ADS126X pin AIN0, for positive input
int pos_pin = 0;   // ADS126X pin AIN0, for positive input
// int pos_pin = ADS126X_AIN0;

int neg_pin = 0xA; // ADS1263 pin AINCOM, for negative input

unsigned long totalReadTime = 0;
unsigned long minReadTime = ULONG_MAX;
unsigned long maxReadTime = 0;
int readCount = 0;
unsigned long readTime = 0;
unsigned long start_time = 0;

void setup() {
  ADS126X adc;
  Serial.begin(115200);
  Serial.println("Here:");
  SPI.begin(SCLK, DOUT, DIN, CS);

  adc.begin(CS);          // setup with chip select pin
  adc.startADC1();        // start conversion on ADC1
  adc.setRate(ADS126X_RATE_38400);

  pinMode(DRDY_PIN, INPUT);

  Serial.println("Reading Voltages:");
}

void loop() {
  ADS126X adc;
  // REAL FOR LOOP
  for (int i = 0; i < 10; i++) {
    totalReadTime += readTime;
    readCount++;
    start_time = micros();
    unsigned long readTime = 0;

    long volt_reader = adc.readADC1(i, neg_pin);        // read the voltage
    float voltage = (float)(volt_reader) * 5 / 8388608; // 2^23 = 8388608

    while (digitalRead(DRDY_PIN) == HIGH) {
      // wait
    }
    delayMicroseconds(150);
    // if drdy doesnt work, use this and comment out drdy

    volt_reader = adc.readADC1(i, neg_pin); // read the voltage
    Serial.print(i);
    Serial.print(": ");
    Serial.println(volt_reader);            // send voltage through serial
    voltage = (float)(volt_reader) * 5 / 8388608;
    Serial.print(i);
    Serial.print(": ");
    Serial.print(voltage, 6);
    Serial.println(" V");

    while (digitalRead(DRDY_PIN) == HIGH) {
      // wait
    }

    delayMicroseconds(150);
    // if drdy doesnt work, use this and comment out drdy

    readTime = micros() - start_time;
    Serial.println("\nTiming statistics:");
    Serial.print("Current read time: ");
    Serial.print(readTime);
    Serial.println(" Aµs");

    // Calculate effective sampling rate
    float samplesPerSecond = 10000000.0 / readTime;
    Serial.print("Effective sampling rate: ");
    Serial.print(samplesPerSecond, 2);
    Serial.println(" samples per second");

    Serial.print("Total samples read: ");
    Serial.println(readCount * 10);
  }
}
#endif // RUN_SENSE_TEST
