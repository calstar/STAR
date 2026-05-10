#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BME280.h>

#include "main.h"

static Adafruit_BME280 bme;

void setup() {
    Serial.begin(115200);
    while (!Serial) delay(10);

    Wire.begin(BME280_SDA_PIN, BME280_SCL_PIN);

    if (!bme.begin(BME280_I2C_ADDR, &Wire)) {
        Serial.println("ERROR: BME280 not found. Check wiring and I2C address!");
        while (1) delay(100);
    }

    Serial.println("BME280 test starting...");
    Serial.println("temp_C,pressure_Pa,humidity_%");
}

void loop() {
    Serial.print(bme.readTemperature(), 2);
    Serial.print(",");
    Serial.print(bme.readPressure(), 2);
    Serial.print(",");
    Serial.println(bme.readHumidity(), 2);

    delay(10);
}
