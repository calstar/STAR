idf_component_register(SRCS "fpga_proto.c" "fpga_link.c" "fpga_link_esp.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_driver_spi esp_driver_gpio freertos)
