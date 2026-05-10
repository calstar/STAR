#include <Arduino.h>

#include <Arduino.h>
#include <SPI.h>
#include <EthernetUdp.h>
#include <Ethernet.h>

// Network configuration for the RECEIVER PCB
byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xEE }; // Unique MAC address
IPAddress staticIP(192, 168, 2, 101); // Unique IP for the receiver
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);

unsigned int localPort = 5006; // Port to listen on (must match sender's receiverPort)
char packetBuffer[UDP_TX_PACKET_MAX_SIZE]; // Buffer to hold incoming packets

EthernetUDP udp;

// Define the Chip Select (CS) pin as a constant variable
const int ETH_CS_PIN = 6; 

void setup() {
  Serial.begin(115200);
  while (!Serial); // Wait for Serial Monitor to open

  Serial.println("Minimal UDP Receiver");

  // Initialize Ethernet using the variable
  Ethernet.init(ETH_CS_PIN);
  delay(1000);
  
  // Start the Ethernet connection and the UDP library
  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  udp.begin(localPort);

  Serial.print("Receiver IP: ");
  Serial.println(Ethernet.localIP());
  Serial.print("Listening on port ");
  Serial.println(localPort);
}

void loop() {
  // Check for incoming UDP packets
  int packetSize = udp.parsePacket();
  if (packetSize) {
    Serial.print("Received packet of size ");
    Serial.println(packetSize);
    Serial.print("From ");
    IPAddress remoteIp = udp.remoteIP();
    Serial.print(remoteIp);
    Serial.print(", port ");
    Serial.println(udp.remotePort());

    // Read the packet into the buffer
    int len = udp.read(packetBuffer, UDP_TX_PACKET_MAX_SIZE);
    if (len > 0) {
      packetBuffer[len] = '\0'; // Null-terminate the string
    }
    
    Serial.println("Contents:");
    Serial.println(packetBuffer);
  }
}
