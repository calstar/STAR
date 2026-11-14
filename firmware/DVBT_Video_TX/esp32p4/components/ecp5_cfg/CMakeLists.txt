idf_component_register(SRCS "ecp5_cfg_core.c" "ecp5_cfg_esp.c" INCLUDE_DIRS "include"
                       REQUIRES esp_driver_spi esp_driver_gpio esp_partition esp_rom)
