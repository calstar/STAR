idf_component_register(
    SRCS "main.c" "fdc1004.c" "eth.c" "http_api.c" "readings.c" "status_led.c"
         "diablo_proto.c" "daq_link.c" "ota.c"
    INCLUDE_DIRS "."
    REQUIRES esp_driver_i2c esp_driver_gpio esp_driver_spi esp_eth esp_netif esp_event
             esp_http_server esp_timer nvs_flash app_update esp_partition lwip)

