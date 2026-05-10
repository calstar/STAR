#include <MCP23S17.h>
#include <SPI.h>



#define PYRO_CS_1 48
// #define PYRO_CS_2 4
#define MOSI 5
#define MISO 41
#define CLK 13


// #define VALVE_FUP 36    // Fuel upstream solenoid open
// #define VALVE_FDP 35  // Fuel downstream solenoid open
// #define VALVE_OUP 34    // LOX upstream solenoid open
// #define VALVE_ODP 33  // LOX downstream solenoid open
// #define FUELVENT 37 
// #define LOXVENT 38
// #define PRESSURELINE 41

// #define FUELMAIN 39 //actuators
// #define LOXMAIN 40 //actuators

// #define UP_PRESSURE 10

#define OV 1    // Fuel upstream solenoid open
#define FV 1  // Fuel downstream solenoid open
#define OUP 1    // LOX upstream solenoid open
#define FUP 1  // LOX downstream solenoid open
#define ODP 1 
#define FDP 1

#define PVF 1 //actuators
#define PVO 1 //actuators


MCP23S17* PYRO_1_MCP;

void setup() {
  Serial.begin(115200);
  SPI.begin(CLK, MISO, MOSI, -1);


  PYRO_1_MCP = new MCP23S17(PYRO_CS_1, 0x00, &SPI);

  // Init MCP23S17 and set banks to outputs
  bool status = PYRO_1_MCP->begin();
  Serial.println(status ? "Started Pyro 1 GPIO EX" : "Failed to start Pyro 1 GPIO EX");
  delay(100);
  for (int pin = 0; pin < 7; pin++) {
    PYRO_1_MCP->pinMode8(pin, 0x00);
    PYRO_1_MCP->write1(pin, 0);
  }




  // Ensure all actuators start OFF
  PYRO_1_MCP->write1(VALVE_FUP, 0);
  PYRO_1_MCP->write1(VALVE_FDP, 0);
  PYRO_1_MCP->write1(VALVE_OUP, 0);
  PYRO_1_MCP->write1(VALVE_ODP, 0);
  PYRO_1_MCP->write1(FUELVENT, 0);
  PYRO_1_MCP->write1(LOXVENT, 0);
  PYRO_1_MCP->write1(FUELMAIN, 0);
  PYRO_1_MCP->write1(LOXMAIN, 0);
}


void loop() {
  // Example: 1s ON, 1s OFF for all actuators.
  // Replace with your desired sequencing.

      PYRO_1_MCP->write1(12, 1);
      delay(2000);


      PYRO_1_MCP->write1(12, 0);
      delay(2000);



  // Serial.println("off");
  // PYRO_1_MCP->write1(VALVE_FUP, 0);
  // delay(2000);

}
