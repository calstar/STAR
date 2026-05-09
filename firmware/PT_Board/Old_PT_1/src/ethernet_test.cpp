#include <DAQv2-Comms.h>
#include <cstring>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>

#define ETH_CLK_PIN 39
#define ETH_MISO_PIN 41
#define ETH_MOSI_PIN 40
#define ETH_CS_PIN 38

IPAddress staticIP(192, 168, 2, 100);
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
IPAddress receiverIP(192, 168, 2, 20);
const int receiverPort = 5006;
EthernetUDP udp;

byte mac[] = {0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED};

void setup() {
  Serial.begin(115200);
  Serial.println("Minimal UDP Sender");

  // Start SPI with custom pins
  SPI.begin(ETH_CLK_PIN, ETH_MISO_PIN, ETH_MOSI_PIN, ETH_CS_PIN);
  delay(1000);

  // Initialize Ethernet with CS pin
  Ethernet.init(ETH_CS_PIN);
  delay(1000);

  // Start Ethernet with static IP
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(1000);

  Serial.println("ESP32 IP: ");
  Serial.println(Ethernet.localIP());

  // Start UDP
  udp.begin(5005);
}

/**
 * @brief Sends an example message in the old format (string-based)
 * This is the original implementation for testing basic UDP communication
 */
void sendExampleMessage() {
  String sensorValue = "Example data: " + String(random(0, 100));
  unsigned long timestamp = millis();
  String dataToSend = sensorValue + ", Timestamp: " + String(timestamp) + "\n";

  // Convert to C-string
  int dataLength = dataToSend.length();
  char dataBuffer[dataLength + 1];
  dataToSend.toCharArray(dataBuffer, dataLength + 1);

  // Send UDP packet
  udp.beginPacket(receiverIP, receiverPort);
  udp.write(dataBuffer, dataLength);
  udp.endPacket();

  Serial.print("Sent (UDP) with length " + String(dataLength) + ": ");
  Serial.print(dataToSend);
}

/**
 * @brief Creates and sends a Board Heartbeat packet using DiabloComms library
 * This uses the proper packet encoding format defined in the DAQv2-Comms
 * library
 */
void sendHeartbeatPacket() {
  // Prepare heartbeat packet data
  Diablo::BoardHeartbeatPacket heartbeatData;
  memset(heartbeatData.firmware_hash, 0, sizeof(heartbeatData.firmware_hash));
  heartbeatData.board_id = 1;                             // Change as needed
  heartbeatData.engine_state = Diablo::EngineState::SAFE; // Change as needed
  heartbeatData.board_state = Diablo::BoardState::ACTIVE; // Change as needed

  // Create the encoded packet
  uint8_t packetBuffer[MAX_PACKET_SIZE];
  size_t packetSize = Diablo::create_board_heartbeat_packet(
      heartbeatData, millis(), packetBuffer, sizeof(packetBuffer));

  if (packetSize == 0) {
    Serial.println("Error: Failed to create heartbeat packet");
    return;
  }

  // Send UDP packet
  udp.beginPacket(receiverIP, receiverPort);
  udp.write(packetBuffer, packetSize);
  udp.endPacket();

  Serial.print("Sent heartbeat packet (UDP) with length ");
  Serial.print(packetSize);
  Serial.print(" bytes - Board ID: ");
  Serial.print(heartbeatData.board_id);
  Serial.print(", Engine State: ");
  Serial.print(static_cast<int>(heartbeatData.engine_state));
  Serial.print(", Board State: ");
  Serial.println(static_cast<int>(heartbeatData.board_state));
}

void loop() {
  // ============================================================================
  // PACKET SELECTION - Comment/uncomment the packet type you want to send
  // ============================================================================

  // Example message (original string-based format)
  // sendExampleMessage();

  // Board Heartbeat packet (DiabloComms library)
  sendHeartbeatPacket();

  // TODO: Add more packet types here for test suite:
  // sendSensorDataPacket();
  // sendActuatorCommandPacket();
  // etc.

  delay(1000);
}
