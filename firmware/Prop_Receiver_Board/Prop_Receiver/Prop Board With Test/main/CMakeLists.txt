idf_component_register(
    SRCS "main.c" "prop_core.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES driver esp_adc esp_eth esp_netif esp_event esp_timer nvs_flash lwip
)
