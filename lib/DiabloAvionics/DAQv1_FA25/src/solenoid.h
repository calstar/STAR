// solenoid_controls.h
// Interface for controlling solenoid valves via MCP23S17 GPIO expanders.

#ifndef SOLENOID_CONTROLS_H_
#define SOLENOID_CONTROLS_H_

#include <Arduino.h>
#include <MCP23S17.h>
#include <SPI.h>
#include <stdint.h>
#include <stddef.h>

namespace solenoids {

// ===================== CONFIG =====================
constexpr bool SOLENOID_ACTIVE_HIGH = true;  // set to false if LOW = open
constexpr int PYRO_CS_1 = 48;

// ===================== PUBLIC ENUM =====================
enum SolenoidID {
  OVP = 0,
  FVP,
  OUP,
  FUP,
  ODP,
  FDP,
  PVF,
  PVO
};

// ===================== API =====================

// Initializes the MCP23S17 and configures all solenoid channels as outputs.
void init(SPIClass& spi,
          int sclk, int miso, int mosi,
          int cs_pin,
          uint8_t mcp_hw_addr = 0x00);

// Individual solenoid controls
void open(SolenoidID id);
void close(SolenoidID id);
bool isOpen(SolenoidID id);

// Safety and helper utilities
void safeAllOff();
void pulseBlocking(SolenoidID id, uint32_t ms);

// Higher-level operational macros
void openAll();
void closeAll();

void fillTanks();
void basePress();
void pressKero();
void pressLOX();
void pressKeroLOX();
void Pressurization();
void ventKeroLOX();
void openMains();
void ventTanks();
void ventAll();
void Abort();

}  // namespace solenoids

#endif  // SOLENOID_CONTROLS_H_
