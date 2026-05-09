#include <Arduino.h>
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include "STAR_ADS126X.h"
#include "main.h"
#include "adc_mappings.h"
#include "esp_mac.h" 



// Change the following line to automatically use the correct pins for the board being tested (PT_Board, LC_Board, RTD_Board, or TC_Board)
#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board

// These lines MUST be after the #define PINS_ACTIVE_LAYOUT or they will overwrite it with the default value!
#include "sense_board_pins.h"
#include "connector_adc_map.h"

// Connectors 1-10 on the sense board. Each chunk = one full scan (all connectors).
// Packet format expects num_sensors datapoints per chunk; max 9 chunks fits in 512 bytes.
#define TEST_PIN 1
#define NUM_CONNECTORS 10
#define MAX_CHUNKS_BEFORE_SEND 9

using namespace sense_board_pins;

// Ethernet configuration
byte mac[6];  // Will be populated with unique MAC from ESP32 eFuse
IPAddress staticIP(192, 168, 2, 101);
IPAddress gateway(0, 0, 0, 0);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
IPAddress receiverIP(192, 168, 2, 20);
const int receiverPort = 5006;
EthernetUDP udp;

static ADS126X ads126x;
SPIClass ADC_SPI(HSPI);

// Forward declarations
void flush_adc_cycles(int cycles);
void read_single_connector(uint8_t connector_id, int num_readings,
                          Diablo::SensorDataChunkCollection &chunk);
void collect_chunk();
void sendSensorDataPacket();

// One chunk = full scan (10 datapoints). Accumulate up to MAX_CHUNKS_BEFORE_SEND.
std::vector<Diablo::SensorDataChunkCollection> chunks;

float convert_code_to_voltage(int32_t code) {
  // Assumes the 2.5V internal reference is being used! 
  return ((float)code * 2.5f) / 2147483648.0f;
}

void setup() {
  Serial.begin(115200);
  // while (!Serial) {
  //   delay(10);  // Wait for native USB serial to connect
  // }

  Serial.println("Starting ADC with Ethernet...");
  
  // Print reference configuration
  #if USE_VDD_REFERENCE
    Serial.println("ADC Reference: VDD");
  #else
    Serial.println("ADC Reference: Internal 2.5V");
  #endif

  // Setup ADC SPI
  ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);

  // You can set the freq if you want, or just use the default
  // SPI.setFrequency(1'000'000);

  // Due to the ADC output having valid data on FALLING CLK edges
  ADC_SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  // Setup ADC
  ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);

  // Stop it while we config it, as suggested by datasheet
  ads126x.stopADC1();

  // Set initial input mux (will be updated per connector in each chunk)
  ads126x.setInputMux(getAdcChannel(1, TEST_PIN), ADS126X_AINCOM);

  // Set the reference voltage based on configuration in main.h
  #if USE_VDD_REFERENCE
    // Using VDD as reference (typically 3.3V or 5V depending on board)
    ads126x.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);
  #else
    // Using internal 2.5V reference (default if setReference is not called)
    // No call to setReference() - ADC defaults to internal reference
  #endif

  // Bypas the PGA, so it does not affect measurements 
  ads126x.bypassPGA();

  // Set the filter. You can change this to try different filters
  ads126x.setFilter(FILTER);

  // Set the datarate. You can change this, but the options depends on the filter
  // I do not know what happens if you program an invalid data rate for a given filter
  ads126x.setRate(DATA_RATE);

  // Start ADC now that configuration is done
  ads126x.startADC1();

  // Generate unique MAC address from ESP32 eFuse (derived for Ethernet)
  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));   // Derived from base eFuse MAC

  Serial.print("Generated unique MAC address: ");
  for (int i = 0; i < 6; i++) {
    if (i > 0) Serial.print(":");
    if (mac[i] < 0x10) Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();

  // Setup Ethernet SPI
  Serial.println("Initializing Ethernet...");
  SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI, Pins.ETH_CS);
  delay(1000);

  // Initialize Ethernet with CS pin
  Ethernet.init(Pins.ETH_CS);
  delay(1000);

  // Start Ethernet with static IP
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(1000);

  // Start UDP
  udp.begin(5005);

  // Print Ethernet status
  Serial.print("Ethernet initialized. IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Link Status: ");
  if (Ethernet.linkStatus() == LinkON) {
    Serial.println("Connected");
  } else if (Ethernet.linkStatus() == LinkOFF) {
    Serial.println("Disconnected");
  } else {
    Serial.println("Unknown");
  }

  Serial.println("Setup complete!");
}

void loop() {
  collect_chunk();

  if (chunks.size() >= MAX_CHUNKS_BEFORE_SEND) {
    sendSensorDataPacket();
    chunks.clear();
  }
}

void flush_adc_cycles(int cycles) {
  for (int i = 0; i < cycles; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW)
      delayMicroseconds(10);
    ads126x.readADC1();
  }
}

void read_single_connector(uint8_t connector_id, int num_readings,
                          Diablo::SensorDataChunkCollection &chunk) {
  uint32_t value = 0;
  for (int i = 0; i < num_readings; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW)
      delayMicroseconds(10);
    const auto reading = ads126x.readADC1();
    if (!reading.checksumValid) continue;
    value = static_cast<uint32_t>(reading.value);
  }
  chunk.add_datapoint(connector_id, value);
}

// One chunk = full scan of all 10 connectors (packet format expects num_sensors per chunk)
void collect_chunk() {
  Diablo::SensorDataChunkCollection chunk(millis(), NUM_CONNECTORS);
  for (uint8_t connector_id = 1; connector_id <= NUM_CONNECTORS; connector_id++) {
    ads126x.setInputMux(getAdcChannel(connector_id, TEST_PIN), ADS126X_AINCOM);
    flush_adc_cycles(settlePulses(FILTER, DATA_RATE));
    read_single_connector(connector_id, READINGS_PER_MUX, chunk);
  }
  if (chunk.size() == NUM_CONNECTORS)
    chunks.push_back(chunk);
}

void sendSensorDataPacket() {
  if (chunks.empty()) {
    return;
  }

  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t packetSize = Diablo::create_sensor_data_packet(
    chunks,
    NUM_CONNECTORS,
    millis(),
    packetBuffer,
    sizeof(packetBuffer)
  );

  if (packetSize == 0) {
    Serial.println("Error: Failed to create sensor data packet");
    return;
  }

  udp.beginPacket(receiverIP, receiverPort);
  udp.write(packetBuffer, packetSize);
  udp.endPacket();

  Serial.print("Sent sensor data packet: ");
  Serial.print(packetSize);
  Serial.print(" bytes, ");
  Serial.print(chunks.size());
  Serial.println(" chunks");
}