idf_component_register(SRCS "tx_app.c" INCLUDE_DIRS "include"
                       REQUIRES spi_bus_if fpga_link ecp5_cfg si5351 ad9116 adrf6755 ts_mux fc_link)
