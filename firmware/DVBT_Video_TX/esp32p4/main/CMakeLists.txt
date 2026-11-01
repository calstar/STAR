idf_component_register(SRCS "main.c" INCLUDE_DIRS "."
                       REQUIRES fpga_link ecp5_cfg ts_mux esp_hw_support heap spi_bus_esp si5351 ad9116 adrf6755 esp_timer esp_driver_i2c esp_driver_spi freertos)
