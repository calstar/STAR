idf_component_register(SRCS "spi_bus_pack.c" "spi_bus_esp.c" "i2c_bus_esp.c" INCLUDE_DIRS "include"
                       REQUIRES spi_bus_if esp_driver_spi esp_driver_gpio esp_driver_i2c esp_rom)
