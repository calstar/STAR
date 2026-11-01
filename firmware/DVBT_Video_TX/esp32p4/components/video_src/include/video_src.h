// Camera -> ISP -> hardware H.264 on the ESP32-P4 (Espressif esp_video,
// V4L2 API): MIPI-CSI capture in YUV420, encoded by the H.264 M2M device,
// each access unit handed to a callback with its capture time.
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

typedef void (*video_src_cb_t)(const uint8_t *au, size_t n, bool key, int64_t capture_us, void *arg);

typedef struct {
    int sccb_port, sccb_scl, sccb_sda;   // camera I2C (SCCB)
    int reset_pin, pwdn_pin;             // -1 if not wired
    int width, height;                   // must match the sensor format chosen in menuconfig
    int bitrate;                         // bit/s, below the channel rate
    int gop;                             // frames per IDR
    int min_qp, max_qp;
    video_src_cb_t cb;
    void *arg;
} video_src_config_t;

// Starts a task; returns once the camera and encoder are streaming.
esp_err_t video_src_start(const video_src_config_t *cfg);
