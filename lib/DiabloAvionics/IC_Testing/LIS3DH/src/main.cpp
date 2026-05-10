#include <Arduino.h>
#include <SPI.h>
#include <Adafruit_LIS3DH.h>
#include <Adafruit_Sensor.h>

#include "main.h"

static SPIClass lis_spi(FSPI);
static Adafruit_LIS3DH lis(LIS3DH_CS_PIN, &lis_spi);
static volatile bool g_interrupt_flag = false;

void IRAM_ATTR onInterrupt() {
    g_interrupt_flag = true;
}

void setup() {
    Serial.begin(115200);
    while (!Serial) delay(10);

    Serial.println("LIS3DH firmware starting...");

    lis_spi.begin(LIS3DH_CLK_PIN, LIS3DH_MISO_PIN, LIS3DH_MOSI_PIN, LIS3DH_CS_PIN);

    if (!lis.begin()) {
        Serial.println("ERROR: LIS3DH not found. Check wiring!");
        while (1) delay(100);
    }

    lis.setDataRate(ACCEL_ODR);
    lis.setRange(ACCEL_RANGE);

    lis.configureHighGInterrupt(INT1_THS_VALUE, INT1_DUR_VALUE);

    pinMode(LIS3DH_INT1_PIN, INPUT);
    attachInterrupt(digitalPinToInterrupt(LIS3DH_INT1_PIN), onInterrupt, RISING);

    Serial.println("-----------------------------------");
    Serial.print("Range:         ±");
    switch (ACCEL_RANGE) {
        case LIS3DH_RANGE_2_G:  Serial.println("2g");  break;
        case LIS3DH_RANGE_4_G:  Serial.println("4g");  break;
        case LIS3DH_RANGE_8_G:  Serial.println("8g");  break;
        case LIS3DH_RANGE_16_G: Serial.println("16g"); break;
    }
    Serial.print("INT threshold: ");
    Serial.print(INTERRUPT_THRESHOLD_G);
    Serial.print("g  (INT1_THS = 0x");
    Serial.print(INT1_THS_VALUE, HEX);
    Serial.println(")");
    Serial.print("INT duration:  ");
    Serial.print(INTERRUPT_DURATION_COUNTS);
    Serial.print(" ODR cycles (INT1_DUR = 0x");
    Serial.print(INT1_DUR_VALUE, HEX);
    Serial.println(")");
    Serial.print("INT1 GPIO:     ");
    Serial.println(LIS3DH_INT1_PIN);
    Serial.println("-----------------------------------");
    Serial.println("X_g,Y_g,Z_g");
}

void loop() {
    if (g_interrupt_flag) {
        g_interrupt_flag = false;
        uint8_t src = lis.readAndClearInterrupt();
        if (src & 0x40) {  // IA bit — confirmed active interrupt
            Serial.print("[INTERRUPT] High-G event detected! INT1_SRC=0x");
            Serial.print(src, HEX);
            Serial.print("  axes:");
            if (src & 0x02) Serial.print(" XH");
            if (src & 0x08) Serial.print(" YH");
            if (src & 0x20) Serial.print(" ZH");
            Serial.println();
        }
    }

    lis.read();
    sensors_event_t event;
    lis.getEvent(&event);

    Serial.print(event.acceleration.x / 9.80665f, 3);
    Serial.print(",");
    Serial.print(event.acceleration.y / 9.80665f, 3);
    Serial.print(",");
    Serial.println(event.acceleration.z / 9.80665f, 3);

    delay(10);
}
