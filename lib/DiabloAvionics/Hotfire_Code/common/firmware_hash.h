#pragma once

/**
 * Firmware hash: computes SHA-256 of the running app partition at boot.
 *
 * Uses ESP-IDF's esp_partition_get_sha256(), which hashes the actual bytes
 * in flash. Any modification to the binary — even without a new git commit —
 * produces a different hash.
 *
 * SHA-256 is 32 bytes. The full 64-character hex string is printed for
 * unambiguous identification.
 */

#include <Arduino.h>
#include <esp_partition.h>
#include <esp_ota_ops.h>

namespace FirmwareHash {

// Computes SHA-256 of the running app partition once, then returns the cached
// result on every subsequent call. Safe to call from setup() and from loop().
inline const uint8_t* get() {
  static uint8_t cached[32] = {};
  static bool computed = false;
  if (!computed) {
    const esp_partition_t* part = esp_ota_get_running_partition();
    if (part && esp_partition_get_sha256(part, cached) == ESP_OK) {
      computed = true;
    }
  }
  return cached;
}

inline void print() {
  const uint8_t* sha256 = get();
  Serial.print("Firmware hash: ");
  for (int i = 0; i < 32; i++) {
    if (sha256[i] < 0x10) Serial.print("0");
    Serial.print(sha256[i], HEX);
  }
  Serial.println();
  Serial.flush();
}

} // namespace FirmwareHash
