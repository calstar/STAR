#pragma once
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"
typedef struct test_i2c_dev *i2c_master_dev_handle_t;
typedef struct test_i2c_bus *i2c_master_bus_handle_t;
typedef enum { I2C_ADDR_BIT_LEN_7 } i2c_addr_bit_len_t;
typedef struct { i2c_addr_bit_len_t dev_addr_length; uint16_t device_address; uint32_t scl_speed_hz; } i2c_device_config_t;
esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t, const i2c_device_config_t *, i2c_master_dev_handle_t *);
esp_err_t i2c_master_transmit(i2c_master_dev_handle_t, const uint8_t *, size_t, int);
esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t, const uint8_t *, size_t, uint8_t *, size_t, int);
