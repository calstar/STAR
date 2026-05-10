#include <Arduino.h>
#include <SPI.h>

#include <STAR_ISM330DH.h>

#include "main.h"

static ISM330DH_SPI imu;
static SPISettings ismSpiSettings(ISM330_SPI_HZ, MSBFIRST, SPI_MODE3);
static sfe_ism_data_t accelData{};
static sfe_ism_data_t gyroData{};

static volatile bool g_intFlag = false;

void IRAM_ATTR onInt1Isr() {
	g_intFlag = true;
}

void setup() {
	Serial.begin(115200);
	while (!Serial)
		delay(10);
	delay(50);

	// Idle every CS on the shared SPI bus HIGH so only the IMU answers.
	const uint8_t otherCs[] = {0 /*MX25_CS*/, 1 /*ADC_CS*/, 17 /*ACCEL_CS*/};
	for (uint8_t pin : otherCs) {
		pinMode(pin, OUTPUT);
		digitalWrite(pin, HIGH);
	}

	pinMode(ISM330_CS_PIN, OUTPUT);
	digitalWrite(ISM330_CS_PIN, HIGH);

	// --- GPIO sanity test (run BEFORE SPI.begin) ---
	// Burst 50 square-wave pulses on each of SCLK / MOSI / CS so a logic
	// analyzer can confirm the pins physically toggle.
	Serial.println("GPIO toggle test starting...");
	const uint8_t testPins[] = {ISM330_SCLK_PIN, ISM330_MOSI_PIN, ISM330_CS_PIN};
	for (uint8_t pin : testPins) {
		pinMode(pin, OUTPUT);
		Serial.printf("  toggling GPIO%u\r\n", pin);
		for (int i = 0; i < 50; i++) {
			digitalWrite(pin, HIGH);
			delayMicroseconds(100);
			digitalWrite(pin, LOW);
			delayMicroseconds(100);
		}
		digitalWrite(pin, HIGH); // leave idle high (safe for CS / SCK mode 3)
	}
	Serial.println("GPIO toggle test done.");

	SPI.begin(ISM330_SCLK_PIN, ISM330_MISO_PIN, ISM330_MOSI_PIN, ISM330_CS_PIN);

	// Raw WHO_AM_I probe — 0x6B means the chip is talking to us correctly.
	// 0x00/0xFF means MISO is dead / wrong CS / wrong mode / no power.
	SPI.beginTransaction(ismSpiSettings);
	digitalWrite(ISM330_CS_PIN, LOW);
	SPI.transfer(0x0F | 0x80);
	uint8_t whoami = SPI.transfer(0x00);
	digitalWrite(ISM330_CS_PIN, HIGH);
	SPI.endTransaction();
	Serial.printf("WHO_AM_I = 0x%02X (expect 0x6B)\r\n", whoami);

	if (!imu.begin(SPI, ismSpiSettings, ISM330_CS_PIN)) {
		Serial.println("ERROR: ISM330DHCX not found. Check SPI wiring / CS / power.");
		while (true)
			delay(1000);
	}

	imu.deviceReset();
	while (!imu.getDeviceReset())
		delay(1);
	delay(100);

	imu.setDeviceConfig(true);
	imu.setBlockDataUpdate(true);

	imu.setAccelDataRate(ISM_XL_ODR_104Hz);
	imu.setAccelFullScale(ISM330_ACCEL_FS);
	imu.setGyroDataRate(ISM_GY_ODR_104Hz);
	imu.setGyroFullScale(ISM_500dps);

	imu.setAccelFilterLP2(true);
	imu.setAccelSlopeFilter(ISM_LP_ODR_DIV_100);
	imu.setGyroFilterLP1(true);
	imu.setGyroLP1Bandwidth(ISM_MEDIUM);

	if (!imu.configureWakeUpOnInt1(ISM330_WKUP_THS, ISM330_WAKEUP_DUR, ISM330_ROUTE_DRDY_TO_INT1)) {
		Serial.println("ERROR: configureWakeUpOnInt1 failed.");
		while (true)
			delay(1000);
	}

	// Active high on INT1 (use RISING on the MCU)
	imu.setPinMode(false);

	pinMode(ISM330_INT1_PIN, INPUT);
	attachInterrupt(digitalPinToInterrupt(ISM330_INT1_PIN), onInt1Isr, RISING);

	Serial.println();
	Serial.println("ISM330DHCX test (ISM330DH)");
	Serial.printf("Accel FS: %.0f g  wake-up threshold: %.2f g  WK_THS LSBs: %u  wake_dur: %u\r\n",
	              ISM330_ACCEL_FS_G, ISM330_WAKEUP_THRESHOLD_G,
	              static_cast<unsigned>(ISM330_WKUP_THS),
	              static_cast<unsigned>(ISM330_WAKEUP_DUR));
	Serial.printf("INT1 GPIO: %d\r\n", ISM330_INT1_PIN);
	Serial.println("ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps");
}

void loop() {
	if (g_intFlag) {
		g_intFlag = false;
		sfe_ism330_wake_event_t wu{};
		if (imu.serviceWakeUpInterrupt(&wu)) {
			Serial.print("[INT] Wake-up  axes:");
			if (wu.axisX)
				Serial.print(" X");
			if (wu.axisY)
				Serial.print(" Y");
			if (wu.axisZ)
				Serial.print(" Z");
			Serial.println();
		}
	}

	if (imu.checkStatus()) {
		if (imu.getAccel(&accelData) && imu.getGyro(&gyroData)) {
			Serial.print(accelData.xData / 1000.0f, 4);
			Serial.print(",");
			Serial.print(accelData.yData / 1000.0f, 4);
			Serial.print(",");
			Serial.print(accelData.zData / 1000.0f, 4);
			Serial.print(",");
			Serial.print(gyroData.xData / 1000.0f, 4);
			Serial.print(",");
			Serial.print(gyroData.yData / 1000.0f, 4);
			Serial.print(",");
			Serial.println(gyroData.zData / 1000.0f, 4);
		}
	}

	delay(10);
}
