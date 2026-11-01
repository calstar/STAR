idf_component_register(SRCS "si5351_plan.c" "si5351.c"
                       INCLUDE_DIRS "include"
                       REQUIRES esp_driver_i2c freertos)
