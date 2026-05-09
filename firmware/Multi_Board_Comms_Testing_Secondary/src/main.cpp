/**
 * Multi-Board Comms Testing - SECONDARY
 *
 * Listens on port 5006 for SENSOR_DATA (or any) packets from the primary.
 * On receive: sends a reply SENSOR_DATA packet back to the primary at
 * remoteIP():5005.
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

#include "sense_board_pins.h"

// ---------------------------------------------------------------------------
// Network: secondary = 192.168.2.101, listen 5006; reply to primary at primaryIP:5005
// ---------------------------------------------------------------------------
byte mac[6];
IPAddress staticIP(192, 168, 2, 101);
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);

const int localPort = 5006;
const int primaryListenPort = 5005;

EthernetUDP udp;
uint8_t packetBuffer[MAX_PACKET_SIZE];
uint8_t replyBuffer[MAX_PACKET_SIZE];

// ---------------------------------------------------------------------------
// Build and send reply SENSOR_DATA to primary (remoteIP:5005)
// ---------------------------------------------------------------------------
void sendReplyTo(IPAddress primaryIP) {
  unsigned long ts = millis();
  const uint8_t numSensors = 1;
  Diablo::SensorDataChunkCollection chunk(ts, numSensors);
  float ack = 42.0f;  // simple "ACK" value
  uint32_t ackBits;
  memcpy(&ackBits, &ack, sizeof(float));
  chunk.add_datapoint(0, ackBits);

  std::vector<Diablo::SensorDataChunkCollection> chunks;
  chunks.push_back(chunk);

  size_t n = Diablo::create_sensor_data_packet(chunks, numSensors, millis(), replyBuffer, sizeof(replyBuffer));
  if (n == 0)
    return;

  udp.beginPacket(primaryIP, primaryListenPort);
  udp.write(replyBuffer, n);
  udp.endPacket();

  Serial.print("REPLY: [SENSOR_DATA] ");
  Serial.print(n);
  Serial.print(" bytes -> ");
  Serial.print(primaryIP);
  Serial.print(":");
  Serial.println(primaryListenPort);
}

// ---------------------------------------------------------------------------
// Setup & loop
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  while (!Serial)
    delay(10);

  Serial.println("Multi-Board Comms Testing – SECONDARY");
  Serial.println("  Listens on :5006 for packets from primary");
  Serial.println("  Replies with SENSOR_DATA -> <primaryIP>:5005");
  Serial.println("----------------------------------------");

  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  Serial.print("MAC: ");
  for (int i = 0; i < 6; i++) {
    if (i) Serial.print(":");
    if (mac[i] < 0x10) Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();

  SPI.begin(sense_board_pins::PT_Board.ETH_SCLK, sense_board_pins::PT_Board.ETH_MISO, sense_board_pins::PT_Board.ETH_MOSI, sense_board_pins::PT_Board.ETH_CS);
  delay(500);
  Ethernet.init(sense_board_pins::PT_Board.ETH_CS);
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
  int n = udp.parsePacket();
  if (n > 0) {
    int len = udp.read(packetBuffer, sizeof(packetBuffer));
    if (len > 0) {
      IPAddress from = udp.remoteIP();
      Serial.print("RECV: ");
      Serial.print(len);
      Serial.print(" bytes from ");
      Serial.print(from);
      Serial.print(":");
      Serial.println(udp.remotePort());

      sendReplyTo(from);
    }
  }

  delay(10);
}
