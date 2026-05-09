#include <DAQv2-Comms.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <cstring>

#define ETH_CLK_PIN 39
#define ETH_MISO_PIN 41
#define ETH_MOSI_PIN 40
#define ETH_CS_PIN 38

IPAddress staticIP(192, 168, 2, 101);
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);

unsigned int localPort = 5006;         // Port to listen on
uint8_t packetBuffer[MAX_PACKET_SIZE]; // Buffer to hold incoming packets

EthernetUDP udp;

byte mac[] = {0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xEE};

// ============================================================================
// INITIALIZATION
// ============================================================================

void setup() {
  Serial.begin(115200);
  Serial.println("Ethernet Test Receive Packet Suite");
  Serial.println("===================================");

  // Start SPI with custom pins
  SPI.begin(ETH_CLK_PIN, ETH_MISO_PIN, ETH_MOSI_PIN, ETH_CS_PIN);
  delay(1000);

  // Initialize Ethernet with CS pin
  Ethernet.init(ETH_CS_PIN);
  delay(1000);

  // Start Ethernet with static IP
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(1000);

  // Start UDP
  udp.begin(localPort);

  // Print board information at initialization
  Serial.println("\nInitial Board Configuration:");
  printBoardInfo();
  Serial.println("\nListening for UDP packets...\n");
}

// ============================================================================
// BOARD INFORMATION
// ============================================================================

/**
 * @brief Prints all board networking information to Serial
 */
void printBoardInfo() {
  Serial.println("--- Board Network Information ---");

  // IP Configuration
  Serial.print("Static IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Gateway: ");
  Serial.println(gateway);
  Serial.print("Subnet Mask: ");
  Serial.println(subnet);
  Serial.print("DNS Server: ");
  Serial.println(dns);

  // MAC Address
  Serial.print("MAC Address: ");
  for (int i = 0; i < 6; i++) {
    if (i > 0)
      Serial.print(":");
    if (mac[i] < 0x10)
      Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();

  // UDP Configuration
  Serial.print("UDP Local Port: ");
  Serial.println(localPort);

  // Ethernet Link Status
  Serial.print("Ethernet Link Status: ");
  if (Ethernet.linkStatus() == LinkON) {
    Serial.println("Connected");
  } else if (Ethernet.linkStatus() == LinkOFF) {
    Serial.println("Disconnected");
  } else {
    Serial.println("Unknown");
  }

  Serial.println("--------------------------------");
}

// ============================================================================
// PACKET DECODING AND PRINTING
// ============================================================================

/**
 * @brief Prints raw packet data in hex format for debugging
 */
void printRawPacketData(const uint8_t *buffer, size_t size) {
  Serial.println("Raw packet data (hex):");
  for (size_t i = 0; i < size; i++) {
    if (buffer[i] < 0x10)
      Serial.print("0");
    Serial.print(buffer[i], HEX);
    Serial.print(" ");
    if ((i + 1) % 16 == 0)
      Serial.println();
  }
  if (size % 16 != 0)
    Serial.println();
}

/**
 * @brief Prints packet header information
 */
void printPacketHeader(const Diablo::PacketHeader &header) {
  Serial.println("--- Packet Header ---");
  Serial.print("Packet Type: ");
  Serial.print(static_cast<int>(header.packet_type));
  Serial.print(" (");

  // Print type name
  switch (header.packet_type) {
  case Diablo::PacketType::BOARD_HEARTBEAT:
    Serial.print("BOARD_HEARTBEAT");
    break;
  case Diablo::PacketType::SERVER_HEARTBEAT:
    Serial.print("SERVER_HEARTBEAT");
    break;
  case Diablo::PacketType::SENSOR_DATA:
    Serial.print("SENSOR_DATA");
    break;
  case Diablo::PacketType::ACTUATOR_COMMAND:
    Serial.print("ACTUATOR_COMMAND");
    break;
  case Diablo::PacketType::SENSOR_CONFIG:
    Serial.print("SENSOR_CONFIG");
    break;
  case Diablo::PacketType::ACTUATOR_CONFIG:
    Serial.print("ACTUATOR_CONFIG");
    break;
  case Diablo::PacketType::ABORT:
    Serial.print("ABORT");
    break;
  case Diablo::PacketType::ABORT_DONE:
    Serial.print("ABORT_DONE");
    break;
  case Diablo::PacketType::CLEAR_ABORT:
    Serial.print("CLEAR_ABORT");
    break;
  default:
    Serial.print("UNKNOWN");
    break;
  }
  Serial.println(")");
  Serial.print("Version: ");
  Serial.println(header.version);
  Serial.print("Timestamp: ");
  Serial.println(header.timestamp);
  Serial.println("---------------------");
}

/**
 * @brief Prints Board Heartbeat packet information
 */
void printBoardHeartbeat(const Diablo::PacketHeader &header,
                         const Diablo::BoardHeartbeatPacket &data) {
  Serial.println("=== Board Heartbeat Packet ===");
  printPacketHeader(header);

  Serial.println("--- Packet Data ---");
  Serial.println("(Board role is implied by board_id / deployment; no board_type field.)");
  Serial.print("Board ID: ");
  Serial.println(data.board_id);

  Serial.print("Engine State: ");
  Serial.print(static_cast<int>(data.engine_state));
  Serial.print(" (");
  switch (data.engine_state) {
  case Diablo::EngineState::SAFE:
    Serial.print("SAFE");
    break;
  case Diablo::EngineState::PRESSURIZING:
    Serial.print("PRESSURIZING");
    break;
  case Diablo::EngineState::LOX_FILL:
    Serial.print("LOX_FILL");
    break;
  case Diablo::EngineState::FIRING:
    Serial.print("FIRING");
    break;
  case Diablo::EngineState::POST_FIRE:
    Serial.print("POST_FIRE");
    break;
  default:
    Serial.print("UNKNOWN");
    break;
  }
  Serial.println(")");

  Serial.print("Board State: ");
  Serial.print(static_cast<int>(data.board_state));
  Serial.print(" (");
  switch (data.board_state) {
  case Diablo::BoardState::SETUP:
    Serial.print("SETUP");
    break;
  case Diablo::BoardState::ACTIVE:
    Serial.print("ACTIVE");
    break;
  case Diablo::BoardState::CONNECTION_LOSS_DETECTED:
    Serial.print("CONNECTION_LOSS_DETECTED");
    break;
  case Diablo::BoardState::NO_CONNECTION_ABORT:
    Serial.print("NO_CONNECTION_ABORT");
    break;
  case Diablo::BoardState::NO_CONN_ABORT_FOLLOWER:
    Serial.print("NO_CONN_ABORT_FOLLOWER");
    break;
  case Diablo::BoardState::PT_ABORT:
    Serial.print("PT_ABORT");
    break;
  case Diablo::BoardState::NO_PT_ABORT:
    Serial.print("NO_PT_ABORT");
    break;
  case Diablo::BoardState::ABORT_FINISHED:
    Serial.print("ABORT_FINISHED");
    break;
  case Diablo::BoardState::STANDALONE_ABORT:
    Serial.print("STANDALONE_ABORT");
    break;
  case Diablo::BoardState::SELF_TEST:
    Serial.print("SELF_TEST");
    break;
  default:
    Serial.print("UNKNOWN");
    break;
  }
  Serial.println(")");
  Serial.println("==============================");
}

/**
 * @brief Prints Server Heartbeat packet information
 */
void printServerHeartbeat(const Diablo::PacketHeader &header,
                          const Diablo::ServerHeartbeatPacket &data) {
  Serial.println("=== Server Heartbeat Packet ===");
  printPacketHeader(header);

  Serial.println("--- Packet Data ---");
  Serial.print("Engine State: ");
  Serial.print(static_cast<int>(data.engine_state));
  Serial.print(" (");
  switch (data.engine_state) {
  case Diablo::EngineState::SAFE:
    Serial.print("SAFE");
    break;
  case Diablo::EngineState::PRESSURIZING:
    Serial.print("PRESSURIZING");
    break;
  case Diablo::EngineState::LOX_FILL:
    Serial.print("LOX_FILL");
    break;
  case Diablo::EngineState::FIRING:
    Serial.print("FIRING");
    break;
  case Diablo::EngineState::POST_FIRE:
    Serial.print("POST_FIRE");
    break;
  default:
    Serial.print("UNKNOWN");
    break;
  }
  Serial.println(")");
  Serial.println("===============================");
}

/**
 * @brief Attempts to decode and print packet information
 * @param buffer The packet buffer
 * @param size The size of the packet
 */
void decodeAndPrintPacket(const uint8_t *buffer, size_t size) {
  if (!buffer || size == 0) {
    Serial.println("Error: Invalid buffer or size");
    return;
  }

  // Check minimum size for header
  const size_t min_header_size = sizeof(Diablo::PacketHeader);
  if (size < min_header_size) {
    Serial.println("Error: Packet too small to contain header");
    Serial.print("Received size: ");
    Serial.print(size);
    Serial.print(" bytes, minimum required: ");
    Serial.print(min_header_size);
    Serial.println(" bytes");
    printRawPacketData(buffer, size);
    return;
  }

  // Try to read the header first
  Diablo::PacketHeader header;
  memcpy(&header, buffer, min_header_size);

  // Validate header
  Serial.println("\n--- Attempting to decode packet ---");
  printPacketHeader(header);

  // Try to decode based on packet type
  bool decoded = false;

  switch (header.packet_type) {
  case Diablo::PacketType::BOARD_HEARTBEAT: {
    Diablo::BoardHeartbeatPacket heartbeatData;
    if (Diablo::parse_board_heartbeat_packet(buffer, size, header,
                                             heartbeatData)) {
      printBoardHeartbeat(header, heartbeatData);
      decoded = true;
    } else {
      Serial.println("Error: Failed to parse Board Heartbeat packet");
      Serial.print("Expected size: ");
      Serial.print(sizeof(Diablo::PacketHeader) +
                   sizeof(Diablo::BoardHeartbeatPacket));
      Serial.print(" bytes, received: ");
      Serial.print(size);
      Serial.println(" bytes");
    }
    break;
  }

  case Diablo::PacketType::SERVER_HEARTBEAT: {
    Diablo::ServerHeartbeatPacket heartbeatData;
    if (Diablo::parse_server_heartbeat_packet(buffer, size, header,
                                              heartbeatData)) {
      printServerHeartbeat(header, heartbeatData);
      decoded = true;
    } else {
      Serial.println("Error: Failed to parse Server Heartbeat packet");
      Serial.print("Expected size: ");
      Serial.print(sizeof(Diablo::PacketHeader) +
                   sizeof(Diablo::ServerHeartbeatPacket));
      Serial.print(" bytes, received: ");
      Serial.print(size);
      Serial.println(" bytes");
    }
    break;
  }

  case Diablo::PacketType::SENSOR_DATA:
    Serial.println(
        "Packet type: SENSOR_DATA (not yet implemented for full decoding)");
    Serial.print("Packet size: ");
    Serial.print(size);
    Serial.println(" bytes");
    // TODO: Add full sensor data parsing when needed
    decoded = true; // At least we identified the type
    break;

  case Diablo::PacketType::ACTUATOR_COMMAND:
    Serial.println("Packet type: ACTUATOR_COMMAND (not yet implemented for "
                   "full decoding)");
    Serial.print("Packet size: ");
    Serial.print(size);
    Serial.println(" bytes");
    // TODO: Add full actuator command parsing when needed
    decoded = true; // At least we identified the type
    break;

  case Diablo::PacketType::SENSOR_CONFIG:
    Serial.println(
        "Packet type: SENSOR_CONFIG (not yet implemented for full decoding)");
    Serial.print("Packet size: ");
    Serial.print(size);
    Serial.println(" bytes");
    // TODO: Add full sensor config parsing when needed
    decoded = true; // At least we identified the type
    break;

  case Diablo::PacketType::ACTUATOR_CONFIG:
    Serial.println(
        "Packet type: ACTUATOR_CONFIG (not yet implemented for full decoding)");
    Serial.print("Packet size: ");
    Serial.print(size);
    Serial.println(" bytes");
    // TODO: Add full actuator config parsing when needed
    decoded = true; // At least we identified the type
    break;

  case Diablo::PacketType::ABORT:
    Serial.println(
        "Packet type: ABORT (not yet implemented for full decoding)");
    Serial.print("Packet size: ");
    Serial.print(size);
    Serial.println(" bytes");
    // TODO: Add full abort parsing when needed
    decoded = true; // At least we identified the type
    break;

  case Diablo::PacketType::ABORT_DONE:
    Serial.println(
        "Packet type: ABORT_DONE (not yet implemented for full decoding)");
    Serial.print("Packet size: ");
    Serial.print(size);
    Serial.println(" bytes");
    // TODO: Add full abort done parsing when needed
    decoded = true; // At least we identified the type
    break;

  case Diablo::PacketType::CLEAR_ABORT:
    Serial.println(
        "Packet type: CLEAR_ABORT (not yet implemented for full decoding)");
    Serial.print("Packet size: ");
    Serial.print(size);
    Serial.println(" bytes");
    // TODO: Add full clear abort parsing when needed
    decoded = true; // At least we identified the type
    break;

  default:
    Serial.print("Error: Unknown packet type: ");
    Serial.println(static_cast<int>(header.packet_type));
    decoded = false;
    break;
  }

  if (!decoded) {
    Serial.println("\n--- Decoding failed, showing raw data ---");
    printRawPacketData(buffer, size);
  }

  Serial.println("----------------------------------------\n");
}

// ============================================================================
// MAIN LOOP
// ============================================================================

void loop() {
  // Check for incoming UDP packets
  int packetSize = udp.parsePacket();
  if (packetSize) {
    Serial.print("Received packet of size ");
    Serial.print(packetSize);
    Serial.print(" bytes from ");
    IPAddress remoteIp = udp.remoteIP();
    Serial.print(remoteIp);
    Serial.print(":");
    Serial.println(udp.remotePort());

    // Read the packet into the buffer
    int len = udp.read(packetBuffer, MAX_PACKET_SIZE);
    if (len > 0) {
      // Decode and print packet information
      decodeAndPrintPacket(packetBuffer, len);
    } else {
      Serial.println("Error: Failed to read packet data");
    }
  }

  // Small delay to prevent overwhelming the system
  delay(10);
}
