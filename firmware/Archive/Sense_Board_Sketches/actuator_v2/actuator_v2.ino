#include <MCP23S17.h>
#include <SPI.h>

// ===== SPI / MCP23S17 wiring =====
#define PYRO_CS_1 48
#define MOSI 5
#define MISO 41
#define CLK 13

MCP23S17* PYRO_1_MCP;

// ===== Logical channel -> MCP pin map =====
// Change the pin numbers on the right to match your hardware.
// Pins are MCP23S17 GPIO numbers 0..15.
struct Channel {
  const char* name;  // command name typed over Serial
  uint8_t pin;       // MCP23S17 pin number
};
Channel channels[] = {
  {"OV",  15},
  {"FV",  14},
  {"OUP", 13},
  {"FUP", 12},
  {"ODP", 11},
  {"FDP", 10},
  {"PVF", 9},
  {"PVO", 8},
};
const size_t NUM_CHANNELS = sizeof(channels) / sizeof(channels[0]);

// ===== Helpers =====
int findChannel(const String& key) {
  for (size_t i = 0; i < NUM_CHANNELS; i++) {
    if (key.equalsIgnoreCase(channels[i].name)) return (int)i;
  }
  return -1;
}

void setChannel(size_t idx, uint8_t level) {
  PYRO_1_MCP->write1(channels[idx].pin, level);
}

uint8_t getChannel(size_t idx) {
  // Some MCP23S17 libs have read1, others use readGPIO. Use write1 + cached if needed.
  // If your lib lacks read1, track state in an array instead.
  return PYRO_1_MCP->read1(channels[idx].pin);
}

void printStatus() {
  Serial.println("STATUS:");
  for (size_t i = 0; i < NUM_CHANNELS; i++) {
    uint8_t v = getChannel(i);
    Serial.print("  ");
    Serial.print(channels[i].name);
    Serial.print(": ");
    Serial.println(v ? "OPEN" : "CLOSE");
  }
}

void allOff() {
  for (size_t i = 0; i < NUM_CHANNELS; i++) {
    setChannel(i, 0);
  }
}

// ===== Setup =====
void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }

  SPI.begin(CLK, MISO, MOSI, -1);
  PYRO_1_MCP = new MCP23S17(PYRO_CS_1, 0x00, &SPI);

  bool ok = PYRO_1_MCP->begin();
  Serial.println(ok ? "MCP23S17 ready" : "MCP23S17 init FAILED");

  // Set all pins used here as outputs and default LOW
  for (size_t i = 0; i < NUM_CHANNELS; i++) {
    // If your library uses pinMode8, replace with it. Most support pinMode(pin, mode).
    PYRO_1_MCP->pinMode1(channels[i].pin, OUTPUT);
    PYRO_1_MCP->write1(channels[i].pin, 0);
  }

  Serial.println("Type commands like:");
  Serial.println("  OPEN OV");
  Serial.println("  CLOSE FV");
  Serial.println("Extra:");
  Serial.println("  STATUS      (prints current states)");
  Serial.println("  ALL OFF     (sets all to LOW)");
  Serial.println("  HELP");
}

// ===== Main loop: parse simple Serial commands =====
void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) return;

    // Normalize spaces
    line.replace('\r', ' ');
    while (line.indexOf("  ") >= 0) line.replace("  ", " ");

    // Uppercase copy for parsing action
    String uline = line;
    uline.toUpperCase();

    if (uline == "HELP") {
      Serial.println("Commands:");
      Serial.println("  OPEN <NAME>    e.g. OPEN OV");
      Serial.println("  CLOSE <NAME>   e.g. CLOSE FV");
      Serial.println("  STATUS         show states");
      Serial.println("  ALL OFF        set all LOW");
      Serial.print("Names: ");
      for (size_t i = 0; i < NUM_CHANNELS; i++) {
        Serial.print(channels[i].name);
        if (i + 1 < NUM_CHANNELS) Serial.print(", ");
      }
      Serial.println();
      return;
    }

    if (uline == "STATUS") {
      printStatus();
      return;
    }

    if (uline == "ALL OFF") {
      allOff();
      Serial.println("All channels set to CLOSE");
      return;
    }

    // Expect "OPEN <NAME>" or "CLOSE <NAME>"
    int spaceIdx = uline.indexOf(' ');
    if (spaceIdx < 0) {
      Serial.println("Bad command. Type HELP");
      return;
    }
    String action = uline.substring(0, spaceIdx);
    String target = uline.substring(spaceIdx + 1);
    target.trim();

    int idx = findChannel(target);
    if (idx < 0) {
      Serial.print("Unknown name: ");
      Serial.println(target);
      Serial.println("Type HELP for list");
      return;
    }

    uint8_t level;
    if (action == "OPEN") {
      level = 1;
    } else if (action == "CLOSE") {
      level = 0;
    } else {
      Serial.print("Unknown action: ");
      Serial.println(action);
      Serial.println("Use OPEN or CLOSE");
      return;
    }

    setChannel((size_t)idx, level);
    Serial.print(channels[idx].name);
    Serial.print(" -> ");
    Serial.println(level ? "OPEN" : "CLOSE");
  }
}




