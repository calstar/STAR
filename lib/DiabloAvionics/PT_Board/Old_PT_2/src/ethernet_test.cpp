#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("==== PT TEST FIRMWARE LOADED ====");
}

void loop() {
  static uint32_t counter = 0;
  Serial.print("PT counter: ");
  Serial.println(counter++);
  delay(1000);
}
