set(video "")
if(EXISTS ${CMAKE_CURRENT_LIST_DIR}/../third_party/esp-video-components)
    set(video video_src)
endif()
idf_component_register(SRCS "main.c" INCLUDE_DIRS "."
                       REQUIRES fpga_link ecp5_cfg ts_mux esp_hw_support heap spi_bus_esp si5351 ad9116 adrf6755 esp_timer esp_driver_i2c esp_driver_spi freertos ${video})
if(video)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DVBT_HAVE_VIDEO=1)
endif()
