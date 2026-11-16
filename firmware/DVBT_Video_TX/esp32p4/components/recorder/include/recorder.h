// Records the transmitted transport stream to the board's SD NAND
// (ZDSD01GLGEAG, 1 GB, soldered: no card detect; SDMMC slot 1 through the
// GPIO matrix, 1- or 4-bit, FAT): /sdcard/TXnnnn.TS, a new file each boot. The same stream
// that goes on air, so a lost link still leaves the flight's video; any
// player (VLC, ffmpeg) opens it. The TS loop calls recorder_push for
// every packet it sends; a task writes in 32 KB blocks and syncs each
// second, so a power cut loses at most about a second.
#pragma once
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct {
    int pin_clk, pin_cmd, pin_d0, pin_d1, pin_d2, pin_d3;   // d1-d3: 4-bit only
    int width;                  // 1 or 4
    bool format;                // make a FAT if the mount finds none (new board only)
    size_t ring_bytes;          // PSRAM ring (e.g. 1 MB: 2 s of slack for a slow write)
} recorder_config_t;

esp_err_t recorder_start(const recorder_config_t *cfg);
void recorder_push(const uint8_t *pkts, size_t n_pkts);     // no-op if not started
uint32_t recorder_dropped(void);
