#include <Arduino.h>
#include <ETH.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <WiFi.h>

#define ETH_CLK_PIN 7
#define ETH_MISO_PIN 41
#define ETH_MOSI_PIN 13
#define ETH_CS_PIN 6
#define ETH_PHY_ADDR 0

IPAddress staticIP(192, 168, 2, 100);
IPAddress gateway(192, 168, 2, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 2, 1);
IPAddress receiverIP(192, 168, 2, 1);
const int receiverPort = 5006;
EthernetUDP udp;

byte mac[] = {0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED};

void setup() {
  Serial.begin(115200);
  Serial.println("Minimal UDP Sender");
  SPI.begin(ETH_CLK_PIN, ETH_MISO_PIN, ETH_MOSI_PIN, ETH_CS_PIN);
  delay(1000);
  // Ethernet.config(staticIP, gateway, subnet, dns);
  Ethernet.init(ETH_CS_PIN);
  delay(1000);

  Ethernet.begin(mac, staticIP, dns, gateway, subnet);
  delay(1000);

  Serial.println("ESP32 IP: ");
  Serial.println(Ethernet.localIP());
  udp.begin(5005); // Local port for sending
}

void loop() {
  String sensorValue = "Example data: " + String(random(0, 100));
  unsigned long timestamp = millis();
  String dataToSend = sensorValue + ", Timestamp: " + String(timestamp) + "\n";
  int dataLength = dataToSend.length();
  char dataBuffer[dataLength + 1];
  dataToSend.toCharArray(dataBuffer, dataLength + 1);

  udp.beginPacket(receiverIP, receiverPort);
  udp.write(dataBuffer, dataLength);
  udp.endPacket();

  Serial.print("Sent (UDP): ");
  Serial.print(dataToSend);
  delay(1000); // Adjust streaming rate
}