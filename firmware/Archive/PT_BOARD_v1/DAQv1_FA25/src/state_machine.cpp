// #include <MCP23S17.h>
// #include <ADS126X.h>
// #include <SPI.h>
// #include <state_machine.h>
// #include <solenoid_control.h>
// #include <Arduino.h>
// #include <board_pins.h>

// #define SENSE_CS_1 40
// #define SENSE_DRDY_1 4 
// #define SENSE_CS_2 42
// #define SENSE_DRDY_2 35
// #define SOLENOID_ACTIVE_HIGH 1  // set to 0 if LOW = open on your hardware
// #define PYRO_CS_1 48
// #define PYRO_CS_2 48


// // // #define SOL_FUP 36 // Fuel upstream solenoid open
// // // #define SOL_FDP 35 // Fuel downstream solenoid open
// // // #define SOL_OUP 34 // LOX upstream solenoid open
// // // #define SOL_ODP 33 // LOX downstream solenoid open
// // // #define SOL_FVP 37 //SOL FVP
// // // #define SOL_OVP 38 //SOL OVP
// // #define PRESSURELINE 32

// // // #define SOL_PVF 39 //actuators
// // // #define SOL_PVO 40 //actuators

// // #define UP_PRESSURE 10


// // float calculatePressure(float raw_value, float PT_A, float PT_B, float PT_C, float PT_D) {
// //     return (PT_A * pow(raw_value, 3)) +
// //            (PT_B * pow(raw_value, 2)) +
// //            (PT_C * raw_value) + PT_D;
// // }

// // float readPT(int channel) {
// //   delay(10);
// //   SENSE_1.readADC1(channel, ADS126X_AINCOM);
// //   delay(10);
// //   long raw = SENSE_1.readADC1(channel, ADS126X_AINCOM);
// //   float voltage = (float)raw * 5.0 / 2147483648.0;
// //   return voltage;
// // }

// // void setup() {
// //   Serial.begin(115200);
// //   static SPIClass& bus = SPI;
// //   solenoidsInit(bus, /*SCLK=*/13, /*MISO=*/41, /*MOSI=*/5, /*CS=*/48, /*addr=*/0x00);
// //   SPI.begin(CLK, MISO, MOSI, -1);
  

// //   PYRO_1_MCP = new MCP23S17(PYRO_CS_1, 0x00, &SPI);
// //   PYRO_2_MCP = new MCP23S17(PYRO_CS_2, 0x00, &SPI);

// //   SENSE_1.begin(SENSE_CS_1);
// //   SENSE_1.startADC1();
// //   SENSE_1.setRate(ADS126X_RATE_1200);
// //   SENSE_1.setReference(ADS126X_REF_NEG_VSS, ADS126X_REF_POS_VDD);
// //   uint8_t power = SENSE_1.readRegister(ADS126X_POWER);
// //   power &= ~(1 << 2);
// //   SENSE_1.writeRegister(ADS126X_POWER);

// //   bool status = PYRO_1_MCP->begin();
// //   Serial.println(status ? "Started Pyro 1 GPIO EX" : "Failed to start Pyro 1 GPIO EX");
// //   delay(100);
// //   for (int pin = 0; pin < 7; pin++) {
// //     PYRO_1_MCP->pinMode8(pin, 0x00);
// //     PYRO_1_MCP->write1(pin, 0);
// //   }

// //   status = PYRO_2_MCP->begin();
// //   Serial.println(status ? "Started Pyro 2 GPIO EX" : "Failed to start Pyro 2 GPIO EX");
// //   delay(100);
// //   for (int pin = 0; pin < 7; pin++) {
// //     PYRO_2_MCP->pinMode8(pin, 0x00);
// //     PYRO_2_MCP->write1(pin, 0);
// //   }

// //   P_threshold_fuel_current = P_threshold_fuel_base;
// //   P_threshold_fuel_down = P_threshold_fuel_base;

// //   P_threshold_lox_current = P_threshold_lox_base;
// //   P_threshold_lox_down = P_threshold_lox_base;

// // }

// void loop() {
//   // No Serial parser. Call your control functions from here or other tasks.
//   // Example:
//   openSolenoid(OUP);
//   delay(1000);
//   closeSolenoid(OUP);
//   delay(1000);
  
// // }

