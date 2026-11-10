#pragma once

/**
 * Firmware hash: the identity of the image this board is running.
 *
 * esp_partition_get_sha256() returns the SHA-256 that ESP-IDF *appended* to the
 * app image at build time, after recomputing it once to check the image is
 * intact. It is therefore NOT sha256(firmware.bin): hashing the whole file folds
 * the appended digest into its own input and can never match this value. To
 * compare a board against a build, use firmware/tools/firmware_digest.py, and to
 * turn a digest into a commit use firmware/tools/which_firmware.py.
 * See FIRMWARE_HASH_VERIFICATION.md.
 *
 * Any change to the image changes this, with or without a new commit. The build
 * is kept free of absolute paths so the same source hashes the same on every
 * machine -- see firmware/tools/reproducible_build.py.
 *
 * SHA-256 is 32 bytes. The full 64-character hex string is printed for
 * unambiguous identification. Note print() emits uppercase hex; the registry
 * stores lowercase, and which_firmware.py accepts either.
 */

#include <Arduino.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>

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
        if (sha256[i] < 0x10)
            Serial.print("0");
        Serial.print(sha256[i], HEX);
    }
    Serial.println();
    Serial.flush();
}

}  // namespace FirmwareHash
