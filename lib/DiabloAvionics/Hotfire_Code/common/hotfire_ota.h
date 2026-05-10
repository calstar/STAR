#pragma once

/**
 * Ethernet OTA support for all hotfire boards.
 *
 * Usage:
 *   1. Declare:  OTAEthernetServer otaServer(HOTFIRE_OTA_PORT);
 *   2. Setup:    otaServer.begin();
 *   3. Loop:     EthernetClient c = otaServer.available();
 *                if (c) hotfire_handleOTA(c);   // blocks until done or timeout
 *
 * Wire protocol (matches ota_upload.py):
 *   Client sends: [4-byte big-endian size][firmware binary]
 *   Board replies: "OK\r\n" then restarts.
 */

#include <Arduino.h>
#include <Ethernet.h>
#include <Update.h>

#ifndef HOTFIRE_OTA_CHUNK_SIZE
#define HOTFIRE_OTA_CHUNK_SIZE  4096
#endif
#ifndef HOTFIRE_OTA_TIMEOUT_MS
#define HOTFIRE_OTA_TIMEOUT_MS  10000
#endif

// Some Arduino-ESP32 cores make Server use pure virtual begin(uint16_t); others
// use begin(). Official Ethernet 2.x EthernetServer only implements void begin(),
// so EthernetServer can be abstract on CI. Implement begin(uint16_t) without
// 'override' so it matches newer Server.h on CI; omitting 'override' avoids an
// error on older cores whose Server has no begin(uint16_t).
class OTAEthernetServer : public EthernetServer {
public:
  explicit OTAEthernetServer(uint16_t port) : EthernetServer(port) {}
  void begin(uint16_t port = 0) {
    (void)port;
    EthernetServer::begin();
  }
  using EthernetServer::begin;
};

// Blocking OTA handler. Call only after otaServer.available() returns a client.
// On success: sends "OK", closes the client, and reboots.
// On failure: prints error, closes the client, and returns (board keeps running).
inline void hotfire_handleOTA(EthernetClient& client) {
  Serial.println("[OTA] Client connected — starting firmware transfer.");

  // Step 1: 4-byte big-endian firmware size
  Serial.println("[OTA] Waiting for 4-byte size header...");
  unsigned long startWait = millis();
  while (client.available() < 4) {
    if (millis() - startWait > HOTFIRE_OTA_TIMEOUT_MS) {
      Serial.println("[OTA] ERROR: Timed out waiting for size header.");
      client.stop();
      return;
    }
    delay(1);
  }

  uint32_t firmwareSize = 0;
  firmwareSize |= ((uint32_t)client.read()) << 24;
  firmwareSize |= ((uint32_t)client.read()) << 16;
  firmwareSize |= ((uint32_t)client.read()) << 8;
  firmwareSize |= ((uint32_t)client.read());

  Serial.printf("[OTA] Firmware size: %u bytes\n", firmwareSize);

  if (firmwareSize == 0 || firmwareSize > 0x200000) {
    Serial.println("[OTA] ERROR: Invalid firmware size. Aborting.");
    client.stop();
    return;
  }

  // Step 2: Begin flash update
  if (!Update.begin(firmwareSize)) {
    Serial.print("[OTA] ERROR: Update.begin() failed: ");
    Update.printError(Serial);
    client.stop();
    return;
  }
  Serial.println("[OTA] Update.begin() OK. Receiving firmware...");

  // Step 3: Stream data into flash
  uint8_t buf[HOTFIRE_OTA_CHUNK_SIZE];
  uint32_t totalReceived = 0;
  int lastPercent = -1;
  unsigned long lastDataTime = millis();

  while (totalReceived < firmwareSize) {
    int available = client.available();
    if (available > 0) {
      int toRead = min((int)sizeof(buf), available);
      toRead = min(toRead, (int)(firmwareSize - totalReceived));
      int bytesRead = client.read(buf, toRead);
      if (bytesRead > 0) {
        size_t written = Update.write(buf, bytesRead);
        if (written != (size_t)bytesRead) {
          Serial.println("[OTA] ERROR: Update.write() size mismatch.");
          Update.printError(Serial);
          Update.abort();
          client.stop();
          return;
        }
        totalReceived += bytesRead;
        lastDataTime = millis();

        int percent = (int)((totalReceived * 100UL) / firmwareSize);
        if (percent / 5 != lastPercent / 5) {
          lastPercent = percent;
          Serial.printf("[OTA] Progress: %d%% (%u / %u bytes)\n",
                        percent, totalReceived, firmwareSize);
        }
      }
    } else {
      if (millis() - lastDataTime > HOTFIRE_OTA_TIMEOUT_MS) {
        Serial.println("[OTA] ERROR: Timed out waiting for firmware data.");
        Update.abort();
        client.stop();
        return;
      }
      delay(1);
    }
  }

  // Step 4: Finalize
  Serial.println("[OTA] All bytes received. Finalizing...");
  if (!Update.end(true)) {
    Serial.print("[OTA] ERROR: Update.end() failed: ");
    Update.printError(Serial);
    client.stop();
    return;
  }

  Serial.println("[OTA] Update successful — rebooting.");
  Serial.flush();
  client.println("OK");
  client.flush();
  client.stop();
  delay(500);
  ESP.restart();
}
