#include <MCP23S17.h>
#include <SPI.h>

// ===================== CONFIG =====================
#define SOLENOID_ACTIVE_HIGH 1  // set to 0 if LOW = open on your hardware
#define PYRO_CS_1 48
#define MOSI 5
#define MISO 41
#define CLK 13
// If your MCP23S17 library names these differently (e.g., pinMode / digitalWrite),
// change the calls near the bottom accordingly.


// begin(chs, )


// ===================== GLOBALS =====================
static MCP23S17* PYRO_1_MCP;
static MCP23S17* PYRO_2_MCP;

// Logical channel -> MCP pin map (GPIO 0..15)
struct Channel {
  const char* name;
  uint8_t pin;
};
static Channel channels[] = {
  {"OVP",  15},
  {"FVP",  14},
  {"OUP", 13},
  {"FUP", 12},
  {"ODP", 11},
  {"FDP", 10},
  {"PVF",  9},
  {"PVO",  8},
};
static const size_t NUM_CHANNELS = sizeof(channels) / sizeof(channels[0]);

// Keep software truth regardless of library readback support
static uint8_t g_shadow[sizeof(channels) / sizeof(channels[0])] = {0};

// Public enum API (order must match channels[] above)
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

// ===================== INTERNAL CORE =====================
static inline void setSolenoidIdx_(size_t idx, bool open) {
  const uint8_t level = (SOLENOID_ACTIVE_HIGH ? (open ? 1 : 0)
                                              : (open ? 0 : 1));
  PYRO_1_MCP->write1(channels[idx].pin, level);
  g_shadow[idx] = open ? 1 : 0;
}

// ===================== PUBLIC API =====================
// Call this ONCE from your setup code. No Serial required.
void solenoidsInit(SPIClass& spi,
                   int sclk, int miso, int mosi,
                   int cs_pin,
                   uint8_t mcp_hw_addr = 0x00) {
  spi.begin(sclk, miso, mosi, -1);           // CS handled by driver
  PYRO_1_MCP = new MCP23S17(cs_pin, mcp_hw_addr, &spi);

  // Bring up the expander
  (void)PYRO_1_MCP->begin();

  // Configure used pins as outputs and default CLOSED
  for (size_t i = 0; i < NUM_CHANNELS; i++) {
    PYRO_1_MCP->pinMode1(channels[i].pin, OUTPUT);
    setSolenoidIdx_(i, /*open=*/false);
  }
}

void openSolenoid(SolenoidID id)  { setSolenoidIdx_((size_t)id, true);  }
void closeSolenoid(SolenoidID id) { setSolenoidIdx_((size_t)id, false); }

bool isSolenoidOpen(SolenoidID id) {
  return g_shadow[(size_t)id] != 0;
}

void safeAllOff() {
  for (size_t i = 0; i < NUM_CHANNELS; i++) setSolenoidIdx_(i, false);
}

// Optional blocking pulse helper
void pulseSolenoidBlocking(SolenoidID id, uint32_t ms) {
  openSolenoid(id);
  delay(ms);
  closeSolenoid(id);
}

void openAllvalves() {
    openSolenoid(OVP);
    openSolenoid(FVP);
    openSolenoid(OUP);
    openSolenoid(FUP);
    openSolenoid(ODP);
    openSolenoid(FDP);
    openSolenoid(PVF);
    openSolenoid(PVO);
}

void closeAllvalves() {
    closeSolenoid(OVP);
    closeSolenoid(FVP);
    closeSolenoid(OUP);
    closeSolenoid(FUP);
    closeSolenoid(ODP);
    closeSolenoid(FDP);
    closeSolenoid(PVF);
    closeSolenoid(PVO);
}

void fillTanks() {
    closeAllvalves();
    openSolenoid(OVP);
    openSolenoid(FVP);
}

void basePress() {
    //Open Ground Station SOL, Pressurize Pressurant until tank is at 4.5k PSI, Close all Valves()
}

void pressKero() {
    closeAllvalves();
    openSolenoid(FUP);
    //read pressure until tank is at 1000 PSI
    closeSolenoid(FUP);
    //if pressure > 1.1k PSI
    closeSolenoid(FUP);
    openSolenoid(FVP); 
    //if pressure <= 1k PSI
    closeSolenoid(FVP);
}

void pressLOX() {
    closeAllvalves();
    openSolenoid(OUP);
    //read pressure until tank is at 1000 PSI
    closeSolenoid(OUP);
    //if pressure > 1.1k PSI
    closeSolenoid(OUP);
    openSolenoid(OVP); 
    //if pressure <= 1k PSI
    closeSolenoid(OVP);
}

void pressKeroLOX() {
    closeAllvalves();
    openSolenoid(FUP);
    openSolenoid(OUP);
    //read pressure until tank is at 1000 PSI
    closeSolenoid(FUP);
    closeSolenoid(OUP);
    //if pressure > 1.1k PSI
    closeSolenoid(FUP);
    closeSolenoid(OUP);
    openSolenoid(FVP);
    openSolenoid(OVP); 
    //if pressure <= 1k PSI
    closeAllvalves();
}

void Pressurization() {
    basePress();
    pressKeroLOX();
    basePress();
}

void ventKeroLOX() {
    closeAllvalves();
    openSolenoid(FVP);
    openSolenoid(OVP);
    //once pressure in both tanks = 0 psi
}

void openMains() {
    closeAllvalves();
    openSolenoid(PVF);
    openSolenoid(PVO);
}

void ventTanks() {
    //while KeroLox pressure > 0
      ventKeroLOX();
      delay(25);
    //
    closeAllvalves();
}

void ventAll() {
    ventKeroLOX();
  //while Pressurant pressure > 0
    pressKeroLOX();
      // while KeroLox pressure > 0
         ventKeroLOX();
         delay(25);
      //
      closeAllvalves();
    closeAllvalves();
}

void Abort() {
    ventKeroLOX();
    //while Pressurant pressure > 0
    pressKeroLOX();
      // while KeroLox pressure > 0
        //if Pressurant pressure == 0, kerolox pressure < 100,
        //openMains();
         ventKeroLOX();
         delay(25);
      //
      closeAllvalves();
    closeAllvalves();
}



// ===================== Arduino hooks =====================
// If you truly don’t want Arduino’s setup/loop, you can remove these and
// call solenoidsInit(...) from your own init code elsewhere.