/**
 * Stacklight Driver — receives STACKLIGHT_COMMAND over Ethernet/UDP, drives
 * stack segments (active-low). Board heartbeats + firmware hash match hotfire
 * boards; Ethernet OTA on HOTFIRE_OTA_PORT.
 */

#include <Arduino.h>
#include <SPI.h>

#include <Ethernet.h>
#include <EthernetUdp.h>
#include <DAQv2-Comms.h>
#include <cstring>
#include <esp_mac.h>

#include "stacklight_pins.h"
#include "firmware_hash.h"
#include "hotfire_config.h"
#include "hotfire_ota.h"

using namespace stacklight_pins;

#ifndef MAX_PACKET_SIZE
#define MAX_PACKET_SIZE 512
#endif

#ifndef SENSOR_UDP_LISTEN_PORT
#define SENSOR_UDP_LISTEN_PORT 5005
#endif

static uint8_t board_id = BOARD_ID;
static byte mac[6];
static IPAddress staticIP(192, 168, 2, BOARD_ID);
static IPAddress gateway(0, 0, 0, 0);
static IPAddress subnet(255, 255, 255, 0);
static IPAddress dns(192, 168, 2, 1);
static IPAddress serverIP(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
static EthernetUDP udp;
static OTAEthernetServer otaServer(HOTFIRE_OTA_PORT);
static unsigned long lastHeartbeatMillis = 0;
static unsigned long last_server_heartbeat_ms = 0;
static Diablo::EngineState last_engine_state = Diablo::EngineState::SAFE;

static void applyStacklightOutputs(uint8_t red, uint8_t yellow, uint8_t green,
                                   uint8_t buzzer) {
  digitalWrite(PIN_RED, red ? LOW : HIGH);
  digitalWrite(PIN_YELLOW, yellow ? LOW : HIGH);
  digitalWrite(PIN_GREEN, green ? LOW : HIGH);
  digitalWrite(PIN_BUZZ, buzzer ? LOW : HIGH);
}

static void initOutputs() {
  pinMode(PIN_RED, OUTPUT);
  pinMode(PIN_YELLOW, OUTPUT);
  pinMode(PIN_GREEN, OUTPUT);
  pinMode(PIN_BUZZ, OUTPUT);
  pinMode(PIN_EX1, OUTPUT);
  pinMode(PIN_EX2, OUTPUT);
  pinMode(PIN_EX3, OUTPUT);
  digitalWrite(PIN_RED, HIGH);
  digitalWrite(PIN_YELLOW, HIGH);
  digitalWrite(PIN_GREEN, HIGH);
  digitalWrite(PIN_BUZZ, HIGH);
  digitalWrite(PIN_EX1, HIGH);
  digitalWrite(PIN_EX2, HIGH);
  digitalWrite(PIN_EX3, HIGH);
}

static void sendBoardHeartbeat() {
  Diablo::BoardHeartbeatPacket hb;
  memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
  hb.board_id = board_id;
  hb.engine_state = last_engine_state;
  hb.board_state = Diablo::BoardState::ACTIVE;

  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t len = Diablo::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                    sizeof(packetBuffer));
  if (len == 0) return;

  udp.beginPacket(serverIP, HOTFIRE_SERVER_PORT);
  udp.write(packetBuffer, len);
  udp.endPacket();
}

void setup() {
  Serial.begin(115200);
  FirmwareHash::print();
  Serial.println("Stacklight Driver starting...");

  board_id = static_cast<uint8_t>(BOARD_ID);
  staticIP = IPAddress(192, 168, 2, board_id);
  Serial.print("Board ID / IP: ");
  Serial.print(static_cast<unsigned>(board_id));
  Serial.print(" / 192.168.2.");
  Serial.println(static_cast<unsigned>(board_id));

  initOutputs();

  ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
  SPI.begin(ETH_SCLK, ETH_MISO, ETH_MOSI, ETH_CS);
  delay(ETHERNET_SPI_DELAY_MS);
  Ethernet.init(ETH_CS);
  delay(ETHERNET_INIT_DELAY_MS);
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(ETHERNET_BEGIN_DELAY_MS);
  udp.begin(SENSOR_UDP_LISTEN_PORT);
  Serial.print("UDP listen port ");
  Serial.println(SENSOR_UDP_LISTEN_PORT);
  otaServer.begin();
  Serial.print("OTA TCP port ");
  Serial.println(HOTFIRE_OTA_PORT);
  Serial.print("Ethernet IP: ");
  Serial.println(Ethernet.localIP());
  Serial.flush();
}

void loop() {
  EthernetClient ota_client = otaServer.available();
  if (ota_client) hotfire_handleOTA(ota_client);

  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    uint8_t packetBuffer[MAX_PACKET_SIZE];
    int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
    if (bytesRead > 0 && bytesRead >= static_cast<int>(sizeof(Diablo::PacketHeader))) {
      Diablo::PacketHeader hdr;
      memcpy(&hdr, packetBuffer, sizeof(hdr));
      switch (hdr.packet_type) {
        case Diablo::PacketType::SERVER_HEARTBEAT: {
          Diablo::PacketHeader dummy;
          Diablo::ServerHeartbeatPacket sh;
          if (Diablo::parse_server_heartbeat_packet(packetBuffer,
                                                    static_cast<size_t>(bytesRead),
                                                    dummy, sh)) {
            last_server_heartbeat_ms = millis();
            last_engine_state = sh.engine_state;
          }
          break;
        }
        case Diablo::PacketType::STACKLIGHT_COMMAND: {
          Diablo::PacketHeader dummy;
          Diablo::StacklightCommandPacket cmd;
          if (Diablo::parse_stacklight_command_packet(packetBuffer,
                                                      static_cast<size_t>(bytesRead),
                                                      dummy, cmd)) {
            applyStacklightOutputs(cmd.red, cmd.yellow, cmd.green, cmd.buzzer);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  unsigned long now = millis();
  if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatMillis = now;
    sendBoardHeartbeat();
  }

  delay(LOOP_DELAY_MS);
}
