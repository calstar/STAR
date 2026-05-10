#pragma once

// =============================================================================
// USER CONFIG
// =============================================================================

#define MCP3201_CS_PIN    1
#define MCP3201_MISO_PIN  16
#define MCP3201_MOSI_PIN  3    // MOSI unused by MCP3201 (input-only ADC), but required by SPIClass
#define MCP3201_CLK_PIN   2

// Reference voltage (V) — used to convert raw counts to voltage
#define VREF              3.3f

// ADC full-scale counts (12-bit)
#define ADC_COUNTS        4095.0f
