idf_component_register(SRCS "fpga_update.c" "fpga_update_usb.c" INCLUDE_DIRS "include"
                       REQUIRES ecp5_cfg esp_driver_usb_serial_jtag esp_partition freertos)
