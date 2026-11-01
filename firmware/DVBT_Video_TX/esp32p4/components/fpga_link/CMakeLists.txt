idf_component_register(SRCS "fpga_proto.c" "fpga_link.c"
                       INCLUDE_DIRS "include"
                       REQUIRES spi_bus_if esp_driver_spi esp_driver_gpio freertos)
