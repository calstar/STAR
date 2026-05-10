/**
 * Multi-Board Comms Testing - PRIMARY
 *
 * Sends SENSOR_DATA packets to the secondary board (192.168.2.101:5006),
 * receives reply SENSOR_DATA packets on port 5005, and prints both
 * sent and received packets to Serial.
 *
 * Uses: Arduino Ethernet, EthernetUDP, DAQv2-Comms (sensor packet format).
 */

#include <Arduino.h>
#include <SPI.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <vector>
#include <esp_mac.h>

#include "actuator_board_pins.h"

namespace pins = actuator_board_pins;

// ---------------------------------------------------------------------------
// Network: primary = 192.168.2.100, listen 5005; send to secondary 192.168.2.101:5006
// ---------------------------------------------------------------------------
byte mac[6];
IPAddress staticIP(192, 168, 2, 100);
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);

IPAddress secondaryIP(192, 168, 2, 101);
const int secondaryPort = 5006;
const int localPort = 5005;

EthernetUDP udp;
uint8_t packetBuffer[MAX_PACKET_SIZE];

// ---------------------------------------------------------------------------
// Sensor packet: 1 chunk, 2 synthetic sensors for testing
// ---------------------------------------------------------------------------
const uint8_t NUM_SENSORS = 2;
const unsigned long SEND_INTERVAL_MS = 1000;
unsigned long lastSendMs = 0;

// ---------------------------------------------------------------------------
// Helpers: packet type name, print header
// ---------------------------------------------------------------------------
static const char* packetTypeName(uint8_t t) {
  switch (t) {
    case (uint8_t)Diablo::PacketType::BOARD_HEARTBEAT: return "BOARD_HEARTBEAT";
    case (uint8_t)Diablo::PacketType::SERVER_HEARTBEAT: return "SERVER_HEARTBEAT";
    case (uint8_t)Diablo::PacketType::SENSOR_DATA: return "SENSOR_DATA";
    case (uint8_t)Diablo::PacketType::ACTUATOR_COMMAND: return "ACTUATOR_COMMAND";
    case (uint8_t)Diablo::PacketType::SENSOR_CONFIG: return "SENSOR_CONFIG";
    case (uint8_t)Diablo::PacketType::ACTUATOR_CONFIG: return "ACTUATOR_CONFIG";
    case (uint8_t)Diablo::PacketType::ABORT: return "ABORT";
    case (uint8_t)Diablo::PacketType::ABORT_DONE: return "ABORT_DONE";
    case (uint8_t)Diablo::PacketType::CLEAR_ABORT: return "CLEAR_ABORT";
    default: return "UNKNOWN";
  }
}

void printReceivedPacket(const uint8_t* buf, size_t len, IPAddress fromIP, uint16_t fromPort) {
  if (!buf || len < sizeof(Diablo::PacketHeader)) {
    Serial.print("RECV: (invalid, too short) ");
    Serial.print(len);
    Serial.print(" bytes from ");
    Serial.print(fromIP);
    Serial.print(":");
    Serial.println(fromPort);
    return;
  }
  Diablo::PacketHeader h;
  memcpy(&h, buf, sizeof(Diablo::PacketHeader));
  Serial.print("RECV: [");
  Serial.print(packetTypeName((uint8_t)h.packet_type));
  Serial.print("] ");
  Serial.print(len);
  Serial.print(" bytes from ");
  Serial.print(fromIP);
  Serial.print(":");
  Serial.print(fromPort);
  Serial.print(" | type=");
  Serial.print((int)h.packet_type);
  Serial.print(" version=");
  Serial.print((int)h.version);
  Serial.print(" ts=");
  Serial.println(h.timestamp);
}

// ---------------------------------------------------------------------------
// Send one SENSOR_DATA packet to secondary
// ---------------------------------------------------------------------------
void sendSensorPacket() {
  unsigned long ts = millis();
  Diablo::SensorDataChunkCollection chunk(ts, NUM_SENSORS);
  float v0 = (float)(ts % 10000) / 1000.0f;
  float v1 = (float)((ts / 17) % 1000) / 100.0f;
  uint32_t b0, b1;
  memcpy(&b0, &v0, sizeof(float));
  memcpy(&b1, &v1, sizeof(float));
  chunk.add_datapoint(0, b0);
  chunk.add_datapoint(1, b1);

  std::vector<Diablo::SensorDataChunkCollection> chunks;
  chunks.push_back(chunk);

  size_t n = Diablo::create_sensor_data_packet(chunks, NUM_SENSORS, millis(), packetBuffer, sizeof(packetBuffer));
  if (n == 0) {
    Serial.println("SENT: (create_sensor_data_packet failed)");
    return;
  }

  udp.beginPacket(secondaryIP, secondaryPort);
  udp.write(packetBuffer, n);
  udp.endPacket();

  Serial.print("SENT: [SENSOR_DATA] ");
  Serial.print(n);
  Serial.print(" bytes, 1 chunk, ");
  Serial.print(NUM_SENSORS);
  Serial.print(" sensors | ts=");
  Serial.println(ts);
}

// ---------------------------------------------------------------------------
// Setup & loop
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  while (!Serial)
    delay(10);

  Serial.println("Multi-Board Comms Testing – PRIMARY");
  Serial.println("  Sends SENSOR_DATA -> 192.168.2.101:5006");
  Serial.println("  Listens on :5005 for reply");
  Serial.println("----------------------------------------");

  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  Serial.print("MAC: ");
  for (int i = 0; i < 6; i++) {
    if (i) Serial.print(":");
    if (mac[i] < 0x10) Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();

  SPI.begin(pins::Actuator_Board.ETH_SCLK, pins::Actuator_Board.ETH_MISO, pins::Actuator_Board.ETH_MOSI, pins::Actuator_Board.ETH_CS);
  delay(500);
  Ethernet.init(pins::Actuator_Board.ETH_CS);
  delay(500);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(500);

  udp.begin(localPort);

  Serial.print("IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Link: ");
  Serial.println(Ethernet.linkStatus() == LinkON ? "ON" : "OFF");
  Serial.println();
}

void loop() {
  // 1) Check for incoming reply on 5005
  int n = udp.parsePacket();
  if (n > 0) {
    int len = udp.read(packetBuffer, sizeof(packetBuffer));
    if (len > 0)
      printReceivedPacket(packetBuffer, (size_t)len, udp.remoteIP(), udp.remotePort());
  }

  // 2) Periodically send SENSOR_DATA to secondary
  unsigned long now = millis();
  if (now - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = now;
    sendSensorPacket();
  }

  delay(10);
}
