// solenoid_controls.cpp
// Implementation of solenoid control functions using MCP23S17

#include "solenoid.h"

namespace solenoids {

// ===================== INTERNALS =====================
static MCP23S17* PYRO_1_MCP = nullptr;

struct Channel {
  const char* name;
  uint8_t pin;
};
static Channel channels[] = {
  {"OVP", 15}, {"FVP", 14}, {"OUP", 13}, {"FUP", 12},
  {"ODP", 11}, {"FDP", 10}, {"PVF", 9},  {"PVO", 8},
};
static constexpr size_t NUM_CHANNELS = sizeof(channels) / sizeof(channels[0]);
static uint8_t g_shadow[NUM_CHANNELS] = {0};

// Helper
static inline void setIdx(size_t idx, bool open) {
  const uint8_t level = (SOLENOID_ACTIVE_HIGH ? (open ? 1 : 0)
                                              : (open ? 0 : 1));
  PYRO_1_MCP->write1(channels[idx].pin, level);
  g_shadow[idx] = open ? 1 : 0;
}

// ===================== CORE FUNCTIONS =====================
void init(SPIClass& spi,
          int sclk, int miso, int mosi,
          int cs_pin,
          uint8_t mcp_hw_addr) {
  spi.begin(sclk, miso, mosi, -1);
  PYRO_1_MCP = new MCP23S17(cs_pin, mcp_hw_addr, &spi);
  PYRO_1_MCP->begin();

  for (size_t i = 0; i < NUM_CHANNELS; i++) {
    PYRO_1_MCP->pinMode1(channels[i].pin, OUTPUT);
    setIdx(i, false);
  }
}

void open(SolenoidID id)  { setIdx((size_t)id, true);  }
void close(SolenoidID id) { setIdx((size_t)id, false); }
bool isOpen(SolenoidID id) { return g_shadow[(size_t)id] != 0; }

void safeAllOff() {
  for (size_t i = 0; i < NUM_CHANNELS; i++) setIdx(i, false);
}

void pulseBlocking(SolenoidID id, uint32_t ms) {
  open(id);
  delay(ms);
  close(id);
}

// ===================== HIGH-LEVEL OPERATIONS =====================
void openAll() {
  for (size_t i = 0; i < NUM_CHANNELS; i++) setIdx(i, true);
}

void closeAll() {
  for (size_t i = 0; i < NUM_CHANNELS; i++) setIdx(i, false);
}

void fillTanks() {
  closeAll();
  open(OVP);
  open(FVP);
}

void basePress() {
  // Placeholder for future pressure feedback logic
}

void pressKero() {
  closeAll();
  open(FUP);
  // TODO: wait for pressure sensor read
  close(FUP);
  open(FVP);
  // TODO: feedback loop
  close(FVP);
}

void pressLOX() {
  closeAll();
  open(OUP);
  // TODO: pressure read until 1000 PSI
  close(OUP);
  open(OVP);
  // TODO: pressure read until 1000 PSI
  close(OVP);
}

void pressKeroLOX() {
  closeAll();
  open(FUP);
  open(OUP);
  // TODO: wait until both tanks reach 1000 PSI
  close(FUP);
  close(OUP);
  open(FVP);
  open(OVP);
  closeAll();
}

void Pressurization() {
  basePress();
  pressKeroLOX();
  basePress();
}

void ventKeroLOX() {
  closeAll();
  open(FVP);
  open(OVP);
  // TODO: wait until both tanks = 0 PSI
}

void openMains() {
  closeAll();
  open(PVF);
  open(PVO);
}

void ventTanks() {
  ventKeroLOX();
  delay(25);
  closeAll();
}

void ventAll() {
  ventKeroLOX();
  pressKeroLOX();
  ventKeroLOX();
  delay(25);
  closeAll();
}

void Abort() {
  ventKeroLOX();
  pressKeroLOX();
  ventKeroLOX();
  delay(25);
  closeAll();
}

}  // namespace solenoids
