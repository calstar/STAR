/* Sanity checks on pins.h for an ESP32-S3-WROOM-1-N16R2. Catches pin-map mistakes before flashing. */
#include <stdio.h>
#include <string.h>
#include "pins.h"

typedef struct { const char *name; int gpio; int needs_adc1; } pin_t;
#define P(n) { #n, n, 0 }
#define PA(n) { #n, n, 1 }
static const pin_t pins[] = {
    P(PIN_SPI_SCLK), P(PIN_SPI_MOSI), P(PIN_SPI_MISO), P(PIN_ETH_CS), P(PIN_ETH_INT), P(PIN_ETH_RST), P(PIN_DAC_CS),
    P(PIN_RS485_TX), P(PIN_RS485_RX), P(PIN_RS485_DE), P(PIN_RS485_RE_N),
    P(PIN_OD_CRTL_1), P(PIN_OD_CRTL_2), P(PIN_OD_CRTL_3), P(PIN_OD_CRTL_4), P(PIN_OD_CRTL_5),
    PA(PIN_MOTOR_ADC_1), PA(PIN_MOTOR_ADC_2), PA(PIN_MOTOR_ADC_3), PA(PIN_MOTOR_ADC_4), PA(PIN_MOTOR_ADC_5),
};
#define N ((int)(sizeof pins / sizeof pins[0]))

static int fails = 0, warns = 0;
#define FAIL(...) do { fails++; printf("  FAIL: "); printf(__VA_ARGS__); printf("\n"); } while (0)
#define WARN(...) do { warns++; printf("  warn: "); printf(__VA_ARGS__); printf("\n"); } while (0)

static int exists_on_module(int g) { return (g >= 0 && g <= 21) || (g >= 35 && g <= 48); }

int main(void)
{
    for (int i = 0; i < N; i++) {
        int g = pins[i].gpio;
        if (!exists_on_module(g)) FAIL("%s = IO%d is not brought out on ESP32-S3-WROOM-1 (IO22-34 are unavailable)", pins[i].name, g);
        if (g == 0) FAIL("%s = IO0 is the BOOT button", pins[i].name);
        if (g == 19 || g == 20) FAIL("%s = IO%d is the native USB D-/D+ pin", pins[i].name, g);
        if (g == 3 || g == 45 || g == 46) WARN("%s = IO%d is a strapping pin (read at reset); make sure the circuit is safe then", pins[i].name, g);
        if (g == 43 || g == 44) WARN("%s = IO%d is UART0; fine only because the console runs on USB Serial/JTAG", pins[i].name, g);
        if (pins[i].needs_adc1 && !(g >= 1 && g <= 10)) FAIL("%s = IO%d is not on ADC1 (IO1-IO10); ADC2 conflicts with Wi-Fi", pins[i].name, g);
        for (int j = i + 1; j < N; j++)
            if (pins[j].gpio == g) FAIL("%s and %s both use IO%d", pins[i].name, pins[j].name, g);
    }

    /* electrical constants */
    float fs_ma = DAC_FULL_SCALE_V * XTR111_GAIN / LOOP_RS_OHMS * 1000.0f;
    if (fs_ma + 0.05f < LOOP_MA_MAX) FAIL("LOOP_MA_MAX %.2f mA exceeds what the DAC/R_S can produce (%.2f mA)", LOOP_MA_MAX, fs_ma);
    if (fs_ma > LOOP_MA_MAX + 1.0f) WARN("DAC full scale (%.2f mA) is well above LOOP_MA_MAX (%.2f mA); fine, but you are not using the top of the range", fs_ma, LOOP_MA_MAX);
    float fb_full_v = (LOOP_MA_MAX - FB_OFFSET_MA) / FB_MA_PER_V;
    if (fb_full_v > 3.1f) FAIL("Feedback at LOOP_MA_MAX would be %.2f V: above the ~3.1 V usable ADC range (12 dB attenuation)", fb_full_v);
    if (fb_full_v < 0.5f) WARN("Feedback at LOOP_MA_MAX is only %.2f V: poor ADC resolution", fb_full_v);
    if (OD_CRTL_ENABLE_LEVEL != 0 && OD_CRTL_ENABLE_LEVEL != 1) FAIL("OD_CRTL_ENABLE_LEVEL must be 0 or 1");

    /* DAC80508 datasheet (SLASEL1D) rules */
    if (DAC_REF_DIV != 1 && DAC_REF_DIV != 2) FAIL("DAC_REF_DIV must be 1 or 2");
    if (DAC_BUFF_GAIN != 1 && DAC_BUFF_GAIN != 2) FAIL("DAC_BUFF_GAIN must be 1 or 2");
    if (DAC_REF_DIV == 1 && DAC_BUFF_GAIN == 1) FAIL("DAC DIV 1 / GAIN 1 is 'not recommended' (datasheet Table 1)");
    float vref_max = DAC_REF_DIV == 2 ? DAC_VDD_MIN_V : DAC_VDD_MIN_V / 2.0f;   /* Recommended Operating Conditions */
    if (DAC_VREF_V > vref_max + 1e-6f)
        FAIL("DAC VREF %.2f V exceeds %.2f V allowed at VDD %.2f V with REF-DIV %d: reference alarm forces all outputs to 0 V",
             DAC_VREF_V, vref_max, DAC_VDD_MIN_V, DAC_REF_DIV);
    float v_at_max = LOOP_MA_MAX * 1e-3f * LOOP_RS_OHMS / XTR111_GAIN;
    if (v_at_max > DAC_VDD_MIN_V - 0.004f) FAIL("DAC must output %.2f V for LOOP_MA_MAX but VDD is only %.2f V", v_at_max, DAC_VDD_MIN_V);
    if (PIN_DAC_CS == PIN_ETH_CS) FAIL("DAC and W5500 share a chip select");

    printf("pins.h: %d pins checked, %d failures, %d warnings\n", N, fails, warns);
    return fails ? 1 : 0;
}
