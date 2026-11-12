#pragma once

#include <Arduino.h>

#include "status.h"

// BLE peripheral: one Switch service with an Output characteristic
// (read/write/notify) and a Status characteristic (read/notify). Open: no
// pairing or encryption, any central in range can connect. Up to
// CONFIG_BT_NIMBLE_MAX_CONNECTIONS centrals at once; notifications go to all.
namespace ble_link {

using OutputRequestFn = void (*)(bool on);

void begin(const char *name, OutputRequestFn on_output_request);
bool connected();
uint32_t connectCount();  // connections accepted since boot
void publishFirmwareHash(const uint8_t *sha256);  // 32 bytes, read-only characteristic
void publishOutput(bool on);
void publishStatus(const StatusPacket &pkt);

}  // namespace ble_link
