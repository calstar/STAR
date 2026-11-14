#include "status_led.h"

#include "board.h"
#include "daq_link.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "readings.h"

#define CYCLE_MS  2500
#define BLINK_MS  120

static void led(bool on) { gpio_set_level(PIN_STATUS_LED, on); }

static void led_task(void *arg)
{
    readings_t r;
    for (;;) {
        readings_get(&r);
        if (!r.sensor_ok) {
            led(1); vTaskDelay(pdMS_TO_TICKS(62));
            led(0); vTaskDelay(pdMS_TO_TICKS(62));
            continue;
        }
        int n = (int)daq_link_state();
        int used = 0;
        for (int i = 0; i < n; i++) {
            led(1); vTaskDelay(pdMS_TO_TICKS(BLINK_MS));
            led(0); vTaskDelay(pdMS_TO_TICKS(BLINK_MS));
            used += 2 * BLINK_MS;
        }
        vTaskDelay(pdMS_TO_TICKS(used < CYCLE_MS ? CYCLE_MS - used : 0));
    }
}

void status_led_start(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << PIN_STATUS_LED,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&io);
    led(0);
    xTaskCreate(led_task, "led", 2048, NULL, 2, NULL);
}
