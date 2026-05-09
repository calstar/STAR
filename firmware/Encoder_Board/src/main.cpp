#include <Arduino.h>
#include <Wire.h>

// Pin config
#define SDA_PIN 4
#define SCL_PIN 5

// AS5600 registers
#define AS5600_ADDR 0x36
#define REG_ZMCO 0x00
#define REG_CONF_HI 0x07
#define REG_CONF_LO 0x08
#define REG_STATUS 0x0B
#define REG_RAW_MSB 0x0C
#define REG_RAW_LSB 0x0D
#define REG_AGC 0x1A
#define REG_MAG_HI 0x1B
#define REG_MAG_LO 0x1C

#define STATUS_MH 0x08
#define STATUS_ML 0x10
#define STATUS_MD 0x20
#define READ_ERROR 0xFFFF

float startAngle = 0.0f;
float degAngle = 0.0f;
float correctedAngle = 0.0f;
bool sensorOk = false;

bool i2cReadBytes(uint8_t reg, uint8_t *buf, uint8_t len)
{
  Wire.beginTransmission((uint8_t)AS5600_ADDR);
  Wire.write(reg);
  uint8_t err = Wire.endTransmission(false);
  if (err != 0)
    return false;
  Wire.requestFrom((uint8_t)AS5600_ADDR, (uint8_t)len);
  if (Wire.available() < len)
    return false;
  for (uint8_t i = 0; i < len; i++)
    buf[i] = Wire.read();
  return true;
}

// Verify AS5600 ACKs on the bus
bool as5600Ping()
{
  Wire.beginTransmission((uint8_t)AS5600_ADDR);
  return Wire.endTransmission() == 0;
}

void dumpDiagnostics()
{
  Serial.println("[AS5600] --- Register dump ---");
  uint8_t val;

  // ZMCO (0x00): number of times zero-pos has been permanently burned (0-3)
  if (i2cReadBytes(REG_ZMCO, &val, 1))
    Serial.printf("  ZMCO   (0x00) = 0x%02X  (burn count: %d)\n", val, val & 0x03);
  else
    Serial.println("  ZMCO   read FAILED");

  // CONF (0x07-0x08): default is 0x0000 on a fresh part
  uint8_t conf[2];
  if (i2cReadBytes(REG_CONF_HI, conf, 2))
    Serial.printf("  CONF   (0x07) = 0x%02X%02X\n", conf[0], conf[1]);
  else
    Serial.println("  CONF   read FAILED");

  // STATUS (0x0B)
  if (i2cReadBytes(REG_STATUS, &val, 1))
  {
    Serial.printf("  STATUS (0x0B) = 0x%02X  [ ", val);
    if (val & STATUS_MD) Serial.print("MD ");
    if (val & STATUS_MH) Serial.print("MH ");
    if (val & STATUS_ML) Serial.print("ML ");
    if (!(val & 0x38))   Serial.print("NO_MAGNET ");
    Serial.println("]");
  }
  else
    Serial.println("  STATUS read FAILED");

  // RAW ANGLE (0x0C-0x0D)
  uint8_t raw[2];
  if (i2cReadBytes(REG_RAW_MSB, raw, 2))
    Serial.printf("  RAW    (0x0C) = 0x%02X%02X  (%d)\n", raw[0], raw[1],
                  ((raw[0] << 8) | raw[1]) & 0x0FFF);
  else
    Serial.println("  RAW    read FAILED");

  // AGC (0x1A): auto-gain control, 0 if no magnet / bus dead
  if (i2cReadBytes(REG_AGC, &val, 1))
    Serial.printf("  AGC    (0x1A) = %d  (ideal ~128, 0=no magnet/bad bus)\n", val);
  else
    Serial.println("  AGC    read FAILED");

  // MAGNITUDE (0x1B-0x1C): CORDIC magnitude
  uint8_t mag[2];
  if (i2cReadBytes(REG_MAG_HI, mag, 2))
    Serial.printf("  MAG    (0x1B) = %d\n", ((mag[0] << 8) | mag[1]) & 0x0FFF);
  else
    Serial.println("  MAG    read FAILED");

  Serial.println("[AS5600] -------------------------");
}

uint16_t readRawAngle()
{
  uint8_t buf[2];
  if (!i2cReadBytes(REG_RAW_MSB, buf, 2))
    return READ_ERROR;
  return ((uint16_t)(buf[0] << 8) | buf[1]) & 0x0FFF;
}

float rawToDegrees(uint16_t raw)
{
  return raw * 0.087890625f;
}

bool checkMagnetPresence()
{
  Serial.println("[AS5600] Waiting for magnet...");
  unsigned long start = millis();
  while (millis() - start < 3000)
  {
    uint8_t status;
    if (!i2cReadBytes(REG_STATUS, &status, 1))
    {
      Serial.println("[AS5600] ERROR: could not read STATUS");
      delay(500);
      continue;
    }
    status &= 0x38;
    if (status & STATUS_MD)
    {
      if (status & STATUS_MH)
      {
        Serial.println("[AS5600] WARNING: magnet too strong");
        return false;
      }
      if (status & STATUS_ML)
      {
        Serial.println("[AS5600] WARNING: magnet too weak");
        return false;
      }
      Serial.println("[AS5600] Magnet detected OK");
      return true;
    }
    delay(100);
  }
  Serial.println("[AS5600] ERROR: no magnet detected after 3 s");
  return false;
}

void correctAngle()
{
  correctedAngle = degAngle - startAngle;
  if (correctedAngle < 0)
    correctedAngle += 360.0f;
}

void setup()
{
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n=== AS5600 Ball Valve Encoder ===");

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  Serial.printf("I2C initialized  SDA=%d  SCL=%d  400 kHz\n", SDA_PIN, SCL_PIN);

  if (!as5600Ping())
  {
    Serial.println("[AS5600] No ACK at 0x36 — check wiring / pull-ups");
    Serial.println("=================================");
    return;
  }
  Serial.println("[AS5600] ACK OK at 0x36");

  dumpDiagnostics();

  sensorOk = checkMagnetPresence();

  uint16_t raw = readRawAngle();
  if (raw != READ_ERROR)
  {
    startAngle = rawToDegrees(raw);
    Serial.printf("Start angle tared at: %.1f deg\n", startAngle);
  }
  else
  {
    Serial.println("WARNING: could not tare start angle");
  }
  Serial.println("=================================");
}

void loop()
{
  if (!sensorOk)
  {
    delay(2000);
    Serial.println("[retry] Pinging AS5600...");
    if (as5600Ping())
    {
      dumpDiagnostics();
      sensorOk = checkMagnetPresence();
    }
    else
    {
      Serial.println("[retry] No ACK");
    }
    return;
  }

  uint16_t raw = readRawAngle();
  if (raw == READ_ERROR)
  {
    Serial.println("ERROR: I2C read failed");
  }
  else
  {
    degAngle = rawToDegrees(raw);
    correctAngle();
    Serial.printf("Raw: %4d  Abs: %6.1f deg  Corrected: %6.1f deg\n",
                  raw, degAngle, correctedAngle);
  }
  delay(100);
}
