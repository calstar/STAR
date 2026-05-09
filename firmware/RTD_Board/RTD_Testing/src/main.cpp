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
#define PINS_ACTIVE_LAYOUT sense_board_pins::RTD_Board

// These lines MUST be after the #define PINS_ACTIVE_LAYOUT or they will overwrite it with the default value!
#include "sense_board_pins.h"
#include "connector_adc_map.h"

// RTD board: cycle connectors 1 and 2 only. Each connector is differential (pin 1 vs pin 2) with IDAC excitation.
#define NUM_CONNECTORS 2
#define MAX_CHUNKS_PER_PACKET 8 

using namespace sense_board_pins;

// Ethernet configuration
byte mac[6];
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
void set_connector_rtd(uint8_t connector_id);
void collect_chunk();
void sendSensorDataPacket();

std::vector<Diablo::SensorDataChunkCollection> chunks;

float convert_code_to_voltage(int32_t code) {
  return ((float)code * 2.5f) / 2147483648.0f;
}

void setup() {
  Serial.begin(115200);
  Serial.println("Starting RTD streaming (connectors 1 & 2)...");

  // Setup ADC SPI
  ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);
  ADC_SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);
  ads126x.stopADC1();

  // Initial mux/IDAC will be set per connector in collect_chunk
  ads126x.setInputMux(getAdcChannel(1, 1), getAdcChannel(1, 2));
  ads126x.bypassPGA();
  ads126x.setFilter(FILTER);
  ads126x.setRate(DATA_RATE);

  {
    const int idac1 = getIdacChannel(1, 1);
    const int idac2 = getIdacChannel(1, 2);
    if (idac1 >= 0) {
      ads126x.setIDAC1Pin(static_cast<uint8_t>(idac1));
      ads126x.setIDAC1Mag(ADS126X_IDAC_MAG_1000);
    }
    if (idac2 >= 0) {
      ads126x.setIDAC2Pin(static_cast<uint8_t>(idac2));
      ads126x.setIDAC2Mag(ADS126X_IDAC_MAG_1000);
    }
  }

  ads126x.startADC1();

  // MAC from ESP32 eFuse
  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  Serial.print("MAC: ");
  for (int i = 0; i < 6; i++) {
    if (i > 0) Serial.print(":");
    if (mac[i] < 0x10) Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();

  // Ethernet
  SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI, Pins.ETH_CS);
  delay(1000);
  Ethernet.init(Pins.ETH_CS);
  delay(1000);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(1000);
  udp.begin(5005);

  Serial.print("Ethernet OK, IP: ");
  Serial.println(Ethernet.localIP());
  Serial.println("Setup complete.");
}

void loop() {
  collect_chunk();

  if (chunks.size() >= MAX_CHUNKS_PER_PACKET) {
    sendSensorDataPacket();
    chunks.clear();
  }
}

void flush_adc_cycles(int cycles) {
  for (int i = 0; i < cycles; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW) {
      delayMicroseconds(10);
    }
  }
}

void set_connector_rtd(uint8_t connector_id) {
  ads126x.setInputMux(getAdcChannel(connector_id, 1), getAdcChannel(connector_id, 2));
  const int idac1 = getIdacChannel(connector_id, 1);
  const int idac2 = getIdacChannel(connector_id, 2);
  if (idac1 >= 0) {
    ads126x.setIDAC1Pin(static_cast<uint8_t>(idac1));
    ads126x.setIDAC1Mag(ADS126X_IDAC_MAG_1000);
  }
  if (idac2 >= 0) {
    ads126x.setIDAC2Pin(static_cast<uint8_t>(idac2));
    ads126x.setIDAC2Mag(ADS126X_IDAC_MAG_1000);
  }
}

void read_single_connector(uint8_t connector_id, int num_readings,
                          Diablo::SensorDataChunkCollection &chunk) {
  uint32_t value = 0;

  for (int i = 0; i < num_readings; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW) {
      delayMicroseconds(10);
    }
    const auto reading = ads126x.readADC1();
    if (!reading.checksumValid) {
      Serial.println("Warning: Bad checksum");
      continue;
    }
    value = static_cast<uint32_t>(reading.value);
  }

  chunk.add_datapoint(connector_id, value);
}

void collect_chunk() {
  Diablo::SensorDataChunkCollection chunk(millis(), NUM_CONNECTORS);

  for (uint8_t connector_id = 1; connector_id <= NUM_CONNECTORS; connector_id++) {
    set_connector_rtd(connector_id);
    flush_adc_cycles(settlePulses(FILTER, DATA_RATE));
    read_single_connector(connector_id, READINGS_PER_CONNECTOR, chunk);
  }

  if (!chunk.empty()) {
    chunks.push_back(chunk);
  }
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

  Serial.print("Sent RTD packet: ");
  Serial.print(packetSize);
  Serial.print(" bytes, ");
  Serial.print(chunks.size());
  Serial.println(" chunks");
}
