/**
 * stream_one_adc: Read ADC1 only, single fixed channel (no mux cycling).
 * Streams readings over Ethernet UDP using DAQv2-Comms packet format.
 */
#include <Arduino.h>
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include "STAR_ADS126X.h"
#include "main.h"
#include "esp_mac.h"

// Board pin layout: define before any header that uses it (PT_Board, LC_Board, RTD_Board, TC_Board)
#define PINS_ACTIVE_LAYOUT PT_Board
#include "sense_board_pins.h"
#include "connector_adc_map.h"

// Fixed input: connector 1, pin 1 (single-ended vs AINCOM). Change if needed.
#define FIXED_CONNECTOR 1
#define FIXED_PIN 1

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

void read_data(int count);
void sendSensorDataPacket();

#define NUM_SENSORS 1
#define MAX_CHUNKS 10
std::vector<Diablo::SensorDataChunkCollection> dataChunks;
static const uint8_t kSensorId = 1;  // Single channel, fixed ID

float convert_code_to_voltage(int32_t code) {
  return ((float)code * 2.5f) / 2147483648.0f;
}

void setup() {
  Serial.begin(115200);
  Serial.println("stream_one_adc: ADC1 only, no muxing");

#if USE_VDD_REFERENCE
  Serial.println("ADC Reference: VDD");
#else
  Serial.println("ADC Reference: Internal 2.5V");
#endif

  ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI, Pins.ADC_CS_1);
  ADC_SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);
  ads126x.stopADC1();

  // Single fixed channel: set mux once, never change
  const int posChannel = getAdcChannel(FIXED_CONNECTOR, FIXED_PIN);
  ads126x.setInputMux(static_cast<uint8_t>(posChannel), ADS126X_AINCOM);

#if USE_VDD_REFERENCE
  ads126x.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);
#endif

  ads126x.bypassPGA();
  ads126x.setFilter(FILTER);
  ads126x.setRate(DATA_RATE);
  ads126x.startADC1();

  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  Serial.print("MAC: ");
  for (int i = 0; i < 6; i++) {
    if (i > 0) Serial.print(":");
    if (mac[i] < 0x10) Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();

  Serial.println("Initializing Ethernet...");
  SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI, Pins.ETH_CS);
  delay(1000);
  Ethernet.init(Pins.ETH_CS);
  delay(1000);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(1000);
  udp.begin(5005);

  Serial.print("Ethernet OK. IP: ");
  Serial.println(Ethernet.localIP());
  Serial.println("Setup complete.");
}

void loop() {
  read_data(READINGS_PER_CHUNK);

  if (dataChunks.size() >= MAX_CHUNKS) {
    sendSensorDataPacket();
    dataChunks.clear();
  }
}

void read_data(int count) {
  Diablo::SensorDataChunkCollection chunk(millis(), NUM_SENSORS);

  for (int i = 0; i < count; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW) {
      delayMicroseconds(10);
    }
    const auto reading = ads126x.readADC1();
    if (!reading.checksumValid) {
      Serial.println("Warning: Bad checksum");
      continue;
    }
    chunk.add_datapoint(kSensorId, static_cast<uint32_t>(reading.value));
  }

  if (!chunk.empty()) {
    dataChunks.push_back(chunk);
  }
}



void sendSensorDataPacket() {
  if (dataChunks.empty()) return;

  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t packetSize = Diablo::create_sensor_data_packet(
    dataChunks,
    NUM_SENSORS,
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

  Serial.print("Sent ");
  Serial.print(packetSize);
  Serial.print(" bytes, ");
  Serial.print(dataChunks.size());
  Serial.println(" chunks");
}
