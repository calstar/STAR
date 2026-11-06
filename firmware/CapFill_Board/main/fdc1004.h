// Minimal TI FDC1004 driver: 4 single-ended channels, repeat mode, auto CAPDAC.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "driver/i2c_master.h"

#define FDC1004_NUM_CH 4

typedef enum {
    FDC1004_RATE_100 = 1,   // 100 S/s, best noise
    FDC1004_RATE_200 = 2,
    FDC1004_RATE_400 = 3,
} fdc1004_rate_t;

typedef struct {
    i2c_master_dev_handle_t dev;
    fdc1004_rate_t rate;
    uint8_t capdac[FDC1004_NUM_CH];   // 0..31, 3.125 pF per step
    uint8_t settle[FDC1004_NUM_CH];   // samples to discard after a CAPDAC change
} fdc1004_t;

typedef struct {
    bool  fresh;       // a new sample arrived on this read
    bool  saturated;   // ADC hit full scale (reading clipped)
    float pf;          // total capacitance = measured + CAPDAC offset
    int32_t counts;    // same value in raw FDC1004 units (2^19 counts per pF), CAPDAC offset included
    uint8_t capdac;
} fdc1004_sample_t;

// Adds the device to the bus, checks IDs, resets, and starts continuous measurement on CIN1..CIN4.
esp_err_t fdc1004_init(fdc1004_t *fdc, i2c_master_bus_handle_t bus, uint8_t addr, fdc1004_rate_t rate);

// Reads whichever channels have finished since the last call. Call every ~10-20 ms.
esp_err_t fdc1004_poll(fdc1004_t *fdc, fdc1004_sample_t out[FDC1004_NUM_CH]);
