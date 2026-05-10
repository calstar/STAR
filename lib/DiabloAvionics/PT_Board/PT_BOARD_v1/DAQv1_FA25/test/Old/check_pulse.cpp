// #include <ADS126X.h>
// #include <SPI.h>
// #include <Arduino.h>

// #define CS    37
// #define SCLK  13
// #define MISO  41
// #define MOSI  5

// ADS126X adc;

// void setPulseMode(void);

// // ADS1263 register addresses and commands
// static const uint8_t CMD_RREG  = 0x20;
// static const uint8_t REG_MODE0 = 0x03;

// static const uint8_t CMD_WREG  = 0x40;

// uint8_t readReg(uint8_t reg) {
//   SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE1));
//   digitalWrite(CS, LOW);
//   SPI.transfer(CMD_RREG | (reg & 0x1F));
//   SPI.transfer(0x00);                 // read 1 byte
//   uint8_t val = SPI.transfer(0x00);
//   digitalWrite(CS, HIGH);
//   SPI.endTransaction();
//   return val;
// }

// void setup() {
//   Serial.begin(115200);
//   SPI.begin(SCLK, MISO, MOSI, CS);
//   adc.begin(CS);

//   uint8_t mode0 = readReg(REG_MODE0);
//   bool isPulse  = (mode0 & 0x10) != 0;
//   sys_delay_ms(2000);
//   Serial.print("MODE0 = 0x");
//   Serial.println(mode0, HEX);
//   Serial.print("RUNMODE: ");
//   Serial.println(isPulse ? "Pulse (one-shot)" : "Continuous");

//   setPulseMode();
// }

// void loop() {
//   uint8_t mode0 = readReg(REG_MODE0);
//   bool isPulse  = (mode0 & 0x10) != 0;

//   Serial.print("MODE0 = 0x");
//   Serial.println(mode0, HEX);
//   Serial.print("RUNMODE: ");
//   Serial.println(isPulse ? "Pulse (one-shot)" : "Continuous");
// }



// void setPulseMode() {
//   // Read current MODE0
//   uint8_t mode0 = readReg(REG_MODE0);

//   // Set RUNMODE bit (bit 4) and clear CHOP bits (bits 1:0)
//   mode0 = (mode0 | 0x10) & ~0x03;

//   // Write back
//   SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE1));
//   digitalWrite(CS, LOW);
//   SPI.transfer(CMD_WREG | (REG_MODE0 & 0x1F));  // WREG + address
//   SPI.transfer(0x00);                           // writing 1 byte
//   SPI.transfer(mode0);
//   digitalWrite(CS, HIGH);
//   SPI.endTransaction();

//   // Confirm
//   uint8_t check = readReg(REG_MODE0);
//   Serial.print("MODE0 now = 0x");
//   Serial.println(check, HEX);
//   Serial.println((check & 0x10) ? "Pulse mode set" : "Still continuous");
// }