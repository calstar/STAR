#include <Arduino.h>
#include <SPI.h>
#include <STAR_MCP3201.h>

#include "main.h"

static SPIClass mcp_spi(FSPI);
static STAR_MCP3201 adc(MCP3201_CS_PIN, &mcp_spi);

void setup() {
    Serial.begin(115200);
    while (!Serial) delay(10);

    pinMode(MCP3201_CS_PIN, OUTPUT);
    digitalWrite(MCP3201_CS_PIN, HIGH);
    mcp_spi.begin(MCP3201_CLK_PIN, MCP3201_MISO_PIN, MCP3201_MOSI_PIN, MCP3201_CS_PIN);

    Serial.println("MCP3201T test starting...");
    Serial.println("raw,voltage");
}

void loop() {
    uint16_t raw = adc.read();
    float voltage = raw * (VREF / ADC_COUNTS);

    Serial.print(raw);
    Serial.print(",");
    Serial.println(voltage, 4);

    delay(10);
}
