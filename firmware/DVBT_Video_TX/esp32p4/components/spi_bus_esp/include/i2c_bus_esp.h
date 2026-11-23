// i2c_bus_if on the ESP-IDF I2C master driver: one bus, devices added on
// first use per address (up to 4), 400 kHz.
#pragma once
#include "esp_err.h"
#include "i2c_bus_if.h"

esp_err_t i2c_bus_esp_init(int pin_sda, int pin_scl, i2c_bus_if_t *bus);
