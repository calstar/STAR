idf_component_register(SRCS "main.c" INCLUDE_DIRS "."
                       REQUIRES fpga_link si5351 ad9116 esp_driver_i2c esp_driver_spi freertos)
