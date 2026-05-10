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

// ============================================================================
// INITIALIZATION
// ============================================================================

void setup() {
  Serial.begin(115200);
  Serial.println("Ethernet Test Send Packet Suite");
  Serial.println("================================");

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
  udp.begin(5005);

  // Print board information at initialization
  Serial.println("\nInitial Board Configuration:");
  printBoardInfo();
  Serial.println("\nEntering CLI mode...\n");
  printMenu();
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
    if (i > 0) Serial.print(":");
    if (mac[i] < 0x10) Serial.print("0");
    Serial.print(mac[i], HEX);
  }
  Serial.println();
  
  // UDP Configuration
  Serial.print("UDP Local Port: ");
  Serial.println(5005);
  Serial.print("UDP Receiver IP: ");
  Serial.print(receiverIP);
  Serial.print(":");
  Serial.println(receiverPort);
  
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
// PACKET SENDING FUNCTIONS
// ============================================================================

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
 * @return true if packet was sent successfully, false otherwise
 */
bool sendHeartbeatPacket() {
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
    return false;
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
  
  return true;
}

/**
 * @brief Continuously sends heartbeat packets until user cancels
 * Checks for Serial input to allow cancellation
 */
void startHeartbeatLoop() {
  Serial.println("\nStarting heartbeat packet loop...");
  Serial.println("Send 'q' or 'quit' to stop sending heartbeats\n");
  
  unsigned long lastSendTime = 0;
  const unsigned long heartbeatInterval = 1000; // 1 second between heartbeats
  
  while (true) {
    // Check for user input to quit
    if (Serial.available() > 0) {
      String input = Serial.readStringUntil('\n');
      input.trim();
      input.toLowerCase();
      
      if (input == "q" || input == "quit") {
        Serial.println("\nStopping heartbeat loop. Returning to CLI...\n");
        return;
      }
    }
    
    // Send heartbeat at specified interval
    unsigned long currentTime = millis();
    if (currentTime - lastSendTime >= heartbeatInterval) {
      sendHeartbeatPacket();
      lastSendTime = currentTime;
    }
    
    delay(10); // Small delay to prevent overwhelming the serial buffer
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

/**
 * @brief Prints the CLI menu options
 */
void printMenu() {
  Serial.println("=== Ethernet Test Suite CLI ===");
  Serial.println("Commands:");
  Serial.println("  'i' or 'info'  - Print board information");
  Serial.println("  'h' or 'heartbeat' - Start sending heartbeat packets");
  Serial.println("  'm' or 'menu'  - Show this menu");
  Serial.println("================================\n");
}

/**
 * @brief Processes CLI commands from Serial input
 */
void processCLI() {
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();
    input.toLowerCase();
    
    if (input.length() == 0) {
      return; // Empty input, ignore
    }
    
    if (input == "i" || input == "info") {
      Serial.println();
      printBoardInfo();
      Serial.println();
    }
    else if (input == "h" || input == "heartbeat") {
      startHeartbeatLoop();
      printMenu();
    }
    else if (input == "m" || input == "menu") {
      printMenu();
    }
    else {
      Serial.print("Unknown command: '");
      Serial.print(input);
      Serial.println("'. Type 'm' or 'menu' for available commands.");
    }
  }
}

void loop() {
  // Process CLI commands
  processCLI();
  
  // Small delay to prevent overwhelming the system
  delay(50);
}
