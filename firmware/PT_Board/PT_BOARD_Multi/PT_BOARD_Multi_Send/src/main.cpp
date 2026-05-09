/**
 * PT_BOARD_Multi_Send
 *
 * Cycles through each PT (connectors 1–10), takes one measurement per PT,
 * and sends DAQv2-Comms SENSOR_DATA packets over Ethernet to a Python GUI.
 *
 * Loosely based on mini_daq/Simple_Test_Adnan (ADC, mux cycling, settle).
 * Uses DAQv2-Comms for packet format and Ethernet/UDP for transport.
 */

#include <Arduino.h>
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <vector>
#include <esp_mac.h>

#include "STAR_ADS126X.h"
#include "sense_board_pins.h"
#include "connector_adc_map.h"
#include "adc_mappings.h"

#define PINS_ACTIVE_LAYOUT sense_board_pins::PT_Board

using namespace sense_board_pins;

// ---------------------------------------------------------------------------
// ADC config (from Simple_Test_Adnan style)
// ---------------------------------------------------------------------------
#define FILTER       ADS126X_SINC4
#define DATA_RATE    ADS126X_RATE_7200
#define TEST_PIN     1
#define NUM_PTS      10   // Connectors 1–10 on PT board

static ADS126X ads126x;
SPIClass ADC_SPI(HSPI);   // ADC on HSPI, Ethernet on default SPI (VSPI)

// ---------------------------------------------------------------------------
// Ethernet
// ---------------------------------------------------------------------------
byte mac[6];
IPAddress staticIP(192, 168, 2, 101);   // 101 so PT board doesn't conflict with Actuator_Testing (100)
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
IPAddress receiverIP(192, 168, 2, 20);   // Same PC as actuator; different port (5007) for PT data
const int receiverPort = 5007;           // 5007 so PT and Actuator (5006) can run together
EthernetUDP udp;
uint8_t packetBuffer[MAX_PACKET_SIZE];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
float convert_code_to_voltage(int32_t code) {
  return ((float)code * 2.5f) / 2147483648.0f;
}

void flush_cycles(int n) {
  for (int i = 0; i < n; i++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW)
      delayMicroseconds(1);
    ads126x.readADC1();
  }
}

// Take one valid reading from current mux. Returns true on success.
bool read_one(int32_t& out_raw, float& out_volts) {
  for (int retries = 0; retries < 50; retries++) {
    while (digitalRead(Pins.ADC_DRDY_1) != LOW)
      delayMicroseconds(1);
    const auto r = ads126x.readADC1();
    if (r.checksumValid) {
      out_raw = r.value;
      out_volts = convert_code_to_voltage(r.value);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  while (!Serial)
    delay(10);
  delay(500);

  Serial.println("PT_BOARD_Multi_Send – cycle PTs, send DAQv2-Comms over UDP");

  // ADC SPI (HSPI)
  ADC_SPI.begin(Pins.ADC_SCLK, Pins.ADC_MISO, Pins.ADC_MOSI);
  ADC_SPI.setDataMode(SPI_MODE1);
  pinMode(Pins.ADC_DRDY_1, INPUT);

  ads126x.begin(Pins.ADC_CS_1, &ADC_SPI);
  ads126x.stopADC1();

  ads126x.bypassPGA();
  ads126x.setFilter(FILTER);
  ads126x.setRate(DATA_RATE);
  ads126x.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);

  ads126x.startADC1();

  // Ethernet (default SPI / VSPI)
  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI);
  delay(300);
  Ethernet.init(Pins.ETH_CS);
  delay(300);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(300);
  udp.begin(5007);   // Local port; actuator board uses 5005

  Serial.print("IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Link: ");
  Serial.println(Ethernet.linkStatus() == LinkON ? "ON" : "OFF");
  Serial.print("Send to: ");
  Serial.print(receiverIP);
  Serial.print(":");
  Serial.println(receiverPort);
  Serial.println();
}

// ---------------------------------------------------------------------------
// Loop: cycle connectors 1..10, one measurement each, one SENSOR_DATA packet
// ---------------------------------------------------------------------------
void loop() {
  Diablo::SensorDataChunkCollection chunk(millis(), NUM_PTS);
  float voltages[NUM_PTS];

  for (int conn = 1; conn <= NUM_PTS; conn++) {
    int ch = getAdcChannel(conn, TEST_PIN);
    float v = 0.0f;
    if (ch >= 0) {
      ads126x.setInputMux(static_cast<uint8_t>(ch), ADS126X_AINCOM);
      flush_cycles(settlePulses(FILTER, DATA_RATE));
      int32_t raw;
      if (read_one(raw, v))
        { /* use v */ }
      else
        v = 0.0f;  // placeholder on read failure
    }
    voltages[conn - 1] = v;
    uint32_t vbits;
    memcpy(&vbits, &v, sizeof(float));
    chunk.add_datapoint(static_cast<uint8_t>(conn - 1), vbits);
  }

  std::vector<Diablo::SensorDataChunkCollection> chunks;
  chunks.push_back(chunk);

  size_t n = Diablo::create_sensor_data_packet(chunks, NUM_PTS, millis(), packetBuffer, sizeof(packetBuffer));
  if (n == 0)
    return;

  udp.beginPacket(receiverIP, receiverPort);
  udp.write(packetBuffer, n);
  udp.endPacket();

  // Print voltages in pt_reading.ino format: pt1 \npt2 pt3 ... pt10 
  for (int i = 0; i < NUM_PTS; i++) {
    Serial.print(voltages[i]);
    Serial.print(" ");
    if (i == 0) {
      Serial.println();
    }
  }

  delay(50);
}
