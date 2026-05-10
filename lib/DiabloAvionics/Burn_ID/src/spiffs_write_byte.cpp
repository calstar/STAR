/**
 * ESP32 S3: write a single 8-bit integer to SPIFFS (root).
 * Standalone .cpp — no PlatformIO project; add to your build as needed.
 */

#include <Arduino.h>
#include <SPIFFS.h>

static const char* FILE_PATH = "/value.bin";
static const uint8_t VALUE_TO_WRITE = 31;  // change as needed
bool success;

void setup() {
  Serial.begin(115200);
  delay(500);
  // Wait for serial (USB CDC) so output and user are ready before burning
  while (!Serial) {
    delay(10);
  }
  delay(500);

  if (!SPIFFS.begin(true)) {
    Serial.println("SPIFFS mount failed");
    return;
  }

  File f = SPIFFS.open(FILE_PATH, "w");
  if (!f) {
    Serial.println("Failed to open file for writing");
    SPIFFS.end();
    return;
  }

  size_t written = f.write(&VALUE_TO_WRITE, 1);
  f.close();

  if (written != 1) {
    Serial.println("Write failed");
    SPIFFS.end();
    return;
  }
  Serial.printf("Wrote byte %u to %s\n", (unsigned)VALUE_TO_WRITE, FILE_PATH);

  // Read back to verify
  File fr = SPIFFS.open(FILE_PATH, "r");
  if (!fr || fr.size() < 1) {
    Serial.println("Read-back failed: could not open or empty file");
    SPIFFS.end();
    return;
  }
  uint8_t readBack = 0;
  size_t n = fr.read(&readBack, 1);
  fr.close();
  SPIFFS.end();

  if (n == 1 && readBack == VALUE_TO_WRITE) {
    Serial.printf("Read-back OK: %s contains %u\n", FILE_PATH, (unsigned)readBack);
    success = true;
  } else {
    Serial.printf("Read-back FAIL: got %u (expected %u)\n", (unsigned)readBack, (unsigned)VALUE_TO_WRITE);
    success = false;
  }
}

void loop() {
  if (success)  {
    Serial.printf("Burn in succeeded: ID %u\n", (unsigned)VALUE_TO_WRITE);
  }
  else {
    Serial.println("Burn in failed");
  }
  delay(500);
}
