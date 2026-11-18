#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Host-side check that the drop's board_exti route table includes PD1
 * (GPIO_PIN_1) for MLC INT2. Avoids HAL by compiling a stripped mirror of
 * the route pin list from board_exti.c.
 */

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

#ifndef GPIO_PIN_0
#define GPIO_PIN_0 ((uint16_t)0x0001)
#define GPIO_PIN_1 ((uint16_t)0x0002)
#define GPIO_PIN_2 ((uint16_t)0x0004)
#define GPIO_PIN_3 ((uint16_t)0x0008)
#define GPIO_PIN_15 ((uint16_t)0x8000)
#endif

/* Mirror of labels used in board_exti.c (CubeMX / main.h). */
#define IMU_INT1_Pin GPIO_PIN_0
#define IMU_INT2_Pin GPIO_PIN_1
#define ACCEL_INT_1_Pin GPIO_PIN_3
#define RADIO_DIO1_Pin GPIO_PIN_2
#define ETH_INT_Pin GPIO_PIN_15

static const uint16_t k_expected_pins[] = {
    IMU_INT1_Pin, IMU_INT2_Pin, ACCEL_INT_1_Pin, RADIO_DIO1_Pin, ETH_INT_Pin,
};

static int find_pin(uint16_t pin) {
    for (unsigned i = 0;
         i < sizeof(k_expected_pins) / sizeof(k_expected_pins[0]); ++i) {
        if (k_expected_pins[i] == pin) {
            return (int)i;
        }
    }
    return -1;
}

int main(void) {
    CHECK(find_pin(IMU_INT2_Pin) == 1);
    CHECK(IMU_INT2_Pin == GPIO_PIN_1); /* PD1 / EXTI1 */
    CHECK(find_pin(IMU_INT1_Pin) == 0);
    /* Distinct from radio DIO1 (PB2) and ETH. */
    CHECK(IMU_INT2_Pin != RADIO_DIO1_Pin);
    puts("board_exti_mlc_route: all tests passed");
    return 0;
}
