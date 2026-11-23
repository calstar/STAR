idf_component_register(SRCS "rec_ring.c" "recorder.c" INCLUDE_DIRS "include"
                       REQUIRES fatfs sdmmc esp_driver_sdmmc esp_timer freertos)
