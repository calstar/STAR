#include "EthernetHandler.h"

#include <Arduino.h>
#include <ETH.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <WiFiUdp.h>
#include <esp_system.h>

namespace {
EthernetConfig currentConfig{};
EthernetUDP spiUdp;
WiFiUDP nativeUdp;
bool initialized = false;
bool usingNative = false;
} // namespace

void EthernetInit(const EthernetConfig &config) {
  currentConfig = config;
  usingNative = config.useNativeEth;

  if (usingNative) {
    if (!ETH.begin()) {
      initialized = false;
      return;
    }

    ETH.config(config.staticIP, config.gateway, config.subnet, config.dns);
    nativeUdp.begin(config.localPort);
    initialized = true;
    return;
  }

  uint64_t chipid = ESP.getEfuseMac();
  byte mac[6];
  mac[0] = 0x02;
  mac[1] = 0x00;
  mac[2] = (chipid >> 32) & 0xFF;
  mac[3] = (chipid >> 24) & 0xFF;
  mac[4] = (chipid >> 16) & 0xFF;
  mac[5] = (chipid >> 8) & 0xFF;

  SPI.begin(config.pins.clk, config.pins.miso, config.pins.mosi, config.pins.cs);
  Ethernet.init(config.pins.cs);
  Ethernet.begin(mac, config.staticIP, config.dns, config.gateway,
                 config.subnet);

  spiUdp.begin(config.localPort);
  initialized = true;
}

void sendPacket(const uint8_t *data, size_t len) {
  if (!initialized || data == nullptr || len == 0) {
    return;
  }

  if (usingNative) {
    nativeUdp.beginPacket(currentConfig.receiverIP, currentConfig.receiverPort);
    nativeUdp.write(data, len);
    nativeUdp.endPacket();
  } else {
    spiUdp.beginPacket(currentConfig.receiverIP, currentConfig.receiverPort);
    spiUdp.write(data, len);
    spiUdp.endPacket();
  }
}

void sendPacket(const String &data) {
  if (!initialized || data.isEmpty()) {
    return;
  }
  sendPacket(reinterpret_cast<const uint8_t *>(data.c_str()),
             static_cast<size_t>(data.length()));
}

IPAddress getLocalIP() {
  if (usingNative) {
    return ETH.localIP();
  }
  return Ethernet.localIP();
}

bool ethernetReady() { return initialized; }
