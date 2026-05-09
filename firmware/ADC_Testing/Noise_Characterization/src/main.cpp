#include "constants.h"
#include "noise_analyzer.h"
#include <Arduino.h>
#include <SPI.h>
#include "my_ADS126X.h"

#define USE_ADC1 1  // 1 = ADC1 (32-bit), 0 = ADC2 (24-bit)
#define USE_CHOP 0  // Chop mode currently not working

// Chnage the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board

// This line MUST be after the #define PINS_ACTIVE_LAYOUT or it will override it
#include "sense_board_pins.h"

using sense_board_pins::Pins;

static ADS126X ads126x;
NoiseAnalyzer noiseAnalyzer;

// Configuration sweep arrays
struct TestConfig {
  uint8_t filter;
  uint8_t rate;
  const char* filterName;
  const char* rateName;
  uint16_t expectedSPS;  // For timing calculations
};

// Define test configurations (filter x rate combinations)
TestConfig testConfigs[] = {
  // SINC1 - Fast, low rejection
  {ADS126X_SINC1, ADS126X_RATE_2_5,   "SINC1", "2.5 SPS",    3},
  {ADS126X_SINC1, ADS126X_RATE_100,   "SINC1", "100 SPS",    100},
  {ADS126X_SINC1, ADS126X_RATE_1200,  "SINC1", "1200 SPS",   1200},
  {ADS126X_SINC1, ADS126X_RATE_19200, "SINC1", "19200 SPS",  19200},
  
  // SINC2 - Moderate rejection
  {ADS126X_SINC2, ADS126X_RATE_10,    "SINC2", "10 SPS",     10},
  {ADS126X_SINC2, ADS126X_RATE_100,   "SINC2", "100 SPS",    100},
  {ADS126X_SINC2, ADS126X_RATE_1200,  "SINC2", "1200 SPS",   1200},
  
  // SINC3 - Good rejection, typical choice
  {ADS126X_SINC3, ADS126X_RATE_10,    "SINC3", "10 SPS",     10},
  {ADS126X_SINC3, ADS126X_RATE_100,   "SINC3", "100 SPS",    100},
  {ADS126X_SINC3, ADS126X_RATE_1200,  "SINC3", "1200 SPS",   1200},
  
  // SINC4 - Best rejection
  {ADS126X_SINC4, ADS126X_RATE_10,    "SINC4", "10 SPS",     10},
  {ADS126X_SINC4, ADS126X_RATE_100,   "SINC4", "100 SPS",    100},
  {ADS126X_SINC4, ADS126X_RATE_1200,  "SINC4", "1200 SPS",   1200},
  
  // FIR - Low latency
  {ADS126X_FIR, ADS126X_RATE_2_5,     "FIR",   "2.5 SPS",    3},
  {ADS126X_FIR, ADS126X_RATE_10,      "FIR",   "10 SPS",     10},
  {ADS126X_FIR, ADS126X_RATE_20,      "FIR",   "20 SPS",     20},
};

// Calculate appropriate sample count based on data rate
// Target ~30 seconds max per config for fast rates, but at least 100 samples
size_t getSampleCount(uint16_t sps) {
  if (sps <= 10) return 100;         // 10-40 seconds for slow rates
  if (sps <= 100) return 500;        // 5 seconds
  if (sps <= 1200) return 1000;      // ~1 second
  return 1000;                        // Cap at 1000 for fast rates
}

const int numConfigs = sizeof(testConfigs) / sizeof(testConfigs[0]);
int currentConfigIndex = 0;
bool testComplete = false;
size_t targetSamples = 0;  // Dynamic sample count for current config

void configureADC(const TestConfig& config) {
  // Stop ADC
  if (USE_ADC1)
    ads126x.stopADC1();
  else
    ads126x.stopADC2();
  
  delay(50);  // Allow ADC to stop
  
  // Apply new configuration
  ads126x.setFilter(config.filter);
  ads126x.setRate(config.rate);
  
  delay(50);  // Allow filter/rate to settle
  
  // Start ADC
  if (USE_ADC1)
    ads126x.startADC1();
  else
    ads126x.startADC2();
    
  delay(100);  // Allow ADC to stabilize after start
}

void printResults(const TestConfig& config) {
  uint8_t adcResolution = USE_ADC1 ? 32 : 24;
  
  float rmsLsb = noiseAnalyzer.rmsNoiseLsb();
  float ppLsb = noiseAnalyzer.peakToPeakNoiseLsb();
  float nfb = noiseAnalyzer.noiseFreeBits(adcResolution);
  float enobValue = noiseAnalyzer.enob(adcResolution);
  double meanValue = noiseAnalyzer.mean();
  size_t samples = noiseAnalyzer.sampleCount();

  Serial.println("\n========================================");
  Serial.print("Filter: ");
  Serial.print(config.filterName);
  Serial.print(" | Rate: ");
  Serial.println(config.rateName);
  Serial.println("========================================");
  Serial.print("Samples:  ");
  Serial.println(samples);
  Serial.print("Mean:     ");
  Serial.print(meanValue, 1);
  Serial.println(" codes");
  Serial.print("RMS:      ");
  Serial.print(rmsLsb, 3);
  Serial.println(" LSB");
  Serial.print("P-P:      ");
  Serial.print(ppLsb, 1);
  Serial.println(" LSB");
  Serial.print("NFB:      ");
  Serial.print(nfb, 2);
  Serial.print(" / ");
  Serial.print(adcResolution);
  Serial.println(" bits");
  Serial.print("ENOB:     ");
  Serial.print(enobValue, 2);
  Serial.print(" / ");
  Serial.print(adcResolution);
  Serial.println(" bits");
  Serial.println("========================================\n");
}

void setup() {
  Serial.begin(115200);
  
  // Wait for serial connection (up to 5 seconds)
  unsigned long startWait = millis();
  while (!Serial && (millis() - startWait < 5000)) {
    delay(100);
  }
  
  Serial.println("\n\n===============================================");
  Serial.println("  ADS126X Filter/Rate Sweep Test");
  Serial.println("===============================================");
  Serial.print("ADC:     ");
  Serial.println(USE_ADC1 ? "ADC1 (32-bit)" : "ADC2 (24-bit)");
  Serial.print("Configs: ");
  Serial.print(numConfigs);
  Serial.println(" filter/rate combinations");
  Serial.println("Samples: 100-1000 per config (adaptive)");
  Serial.println("===============================================\n");

  SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);
  SPI.setFrequency(1'000'000);
  SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  ads126x.begin(Pins.ADC_CS_1);

  // Common configuration
  ads126x.setOutputmagnitudeTDACP(0b00000111);
  ads126x.setOutputmagnitudeTDACN(0b00000000);

  if (USE_ADC1)
    ads126x.setInputMux(ADS126X_TDAC, ADS126X_TDAC);
  else
    ads126x.setADC2Mux(ADS126X_TDAC, ADS126X_TDAC);

  ads126x.bypassPGA();

  if (USE_CHOP)
    ads126x.setChopMode(ADS126X_CHOP_1);

  // Start first configuration
  Serial.println(">>> Starting test sweep...\n");
  targetSamples = getSampleCount(testConfigs[currentConfigIndex].expectedSPS);
  configureADC(testConfigs[currentConfigIndex]);
  
  Serial.print("Config ");
  Serial.print(currentConfigIndex + 1);
  Serial.print("/");
  Serial.print(numConfigs);
  Serial.print(": ");
  Serial.print(testConfigs[currentConfigIndex].filterName);
  Serial.print(" @ ");
  Serial.print(testConfigs[currentConfigIndex].rateName);
  Serial.print(" (");
  Serial.print(targetSamples);
  Serial.println(" samples)");
}

void loop() {
  if (testComplete) {
    // All tests done, just idle
    delay(1000);
    return;
  }
  
  if (USE_ADC1) {
    while(digitalRead(Pins.ADC_DRDY_1) != LOW) {
      delayMicroseconds(10);
    }
  } else { 
    delayMicroseconds(100);
  }

  delayMicroseconds(25);

  const auto reading = USE_ADC1 ? ads126x.readADC1() : ads126x.readADC2();

  if (!reading.checksumValid) {
    return;  // Skip bad samples
  }

  // Collect samples
  size_t count = noiseAnalyzer.sampleCount();
  if (count < targetSamples) {
    noiseAnalyzer.addSample(reading.value);
    count = noiseAnalyzer.sampleCount();
    
    // Show progress
    size_t interval = targetSamples >= 500 ? 100 : 25;
    if (count % interval == 0 || count == 1) {
      Serial.print("  Collecting: ");
      Serial.print(count);
      Serial.print("/");
      Serial.println(targetSamples);
    }
    return;
  }
  
  // Collected enough samples - print results for this configuration
  printResults(testConfigs[currentConfigIndex]);
  
  // Move to next configuration
  currentConfigIndex++;
  if (currentConfigIndex >= numConfigs) {
    Serial.println("\n========================================");
    Serial.println("  ALL TESTS COMPLETE!");
    Serial.println("========================================\n");
    testComplete = true;
    return;
  }
  
  // Reset analyzer and configure next test
  noiseAnalyzer.reset();
  targetSamples = getSampleCount(testConfigs[currentConfigIndex].expectedSPS);
  configureADC(testConfigs[currentConfigIndex]);
  
  Serial.print("\nConfig ");
  Serial.print(currentConfigIndex + 1);
  Serial.print("/");
  Serial.print(numConfigs);
  Serial.print(": ");
  Serial.print(testConfigs[currentConfigIndex].filterName);
  Serial.print(" @ ");
  Serial.print(testConfigs[currentConfigIndex].rateName);
  Serial.print(" (");
  Serial.print(targetSamples);
  Serial.println(" samples)");
}
