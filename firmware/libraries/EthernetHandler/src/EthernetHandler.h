#pragma once

#include <Arduino.h>
#include <IPAddress.h>

struct EthernetPins {
  int clk;
  int miso;
  int mosi;
  int cs;
};

struct EthernetConfig {
  EthernetPins pins;
  IPAddress staticIP;
  IPAddress gateway;
  IPAddress subnet;
  IPAddress dns;
  IPAddress receiverIP;
  uint16_t receiverPort = 5006;
  uint16_t localPort = 5005;
  bool useNativeEth = false;
};

void EthernetInit(const EthernetConfig &config);
void sendPacket(const uint8_t *data, size_t len);
void sendPacket(const String &data);
IPAddress getLocalIP();
bool ethernetReady();
