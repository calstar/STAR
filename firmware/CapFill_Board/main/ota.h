#pragma once

#include "esp_err.h"

// Firmware update over Ethernet, same wire protocol as the club's hotfire_ota.h / ota_upload.py:
//   client connects to TCP DAQ_OTA_PORT (3232), sends [4-byte big-endian size][firmware .bin],
//   board writes it to the other OTA slot, replies "OK\r\n" and reboots.
esp_err_t ota_server_start(void);
