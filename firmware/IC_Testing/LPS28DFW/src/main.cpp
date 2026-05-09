#include <Arduino.h>
#include <Wire.h>
#include <math.h>

#include "SparkFun_LPS28DFW_Arduino_Library.h"

#include "main.h"

static LPS28DFW pressureSensor;

/** Barometric altitude (m) from static pressure using a simple ISA troposphere fit. */
static float pressureToAltitudeM(float pressureHpa, float seaLevelHpa) {
	if (pressureHpa <= 0.f || seaLevelHpa <= 0.f)
		return NAN;
	// h = 44330 * (1 - (P/P0)^(1/5.255)); exponent ≈ 0.190284
	return 44330.0f * (1.0f - powf(pressureHpa / seaLevelHpa, 0.190284f));
}

void setup() {
	Serial.begin(115200);
	while (!Serial)
		delay(10);

	Wire.begin(LPS28DFW_SDA_PIN, LPS28DFW_SCL_PIN);

	while (pressureSensor.begin(LPS28DFW_I2C_ADDR, Wire) != LPS28DFW_OK) {
		Serial.println("ERROR: LPS28DFW not found. Check wiring and I2C address (0x5C / 0x5D).");
		delay(1000);
	}

	lps28dfw_md_t modeConfig = {
		.fs = LPS28DFW_1260hPa,
		.odr = LPS28DFW_10Hz,
		.avg = LPS28DFW_32_AVG,
		.lpf = LPS28DFW_LPF_DISABLE,
	};
	if (pressureSensor.setModeConfig(&modeConfig) != LPS28DFW_OK) {
		Serial.println("ERROR: setModeConfig failed.");
		while (1)
			delay(1000);
	}

	Serial.println();
	Serial.println("LPS28DFW test (SparkFun library)");
	Serial.printf("Altitude uses ISA P0 = %.2f hPa (change LPS28DFW_SEA_LEVEL_HPA to match local pressure)\r\n",
	              LPS28DFW_SEA_LEVEL_HPA);
	Serial.println();
}

void loop() {
	if (pressureSensor.getSensorData() != LPS28DFW_OK) {
		Serial.println("ERROR: getSensorData failed");
		delay(500);
		return;
	}

	const float tempC = pressureSensor.data.heat.deg_c;
	const float pressHpa = pressureSensor.data.pressure.hpa;
	const float altM = pressureToAltitudeM(pressHpa, LPS28DFW_SEA_LEVEL_HPA);

	Serial.printf("Temperature: %.3f C\r\n", tempC);
	Serial.printf("Pressure:    %.3f hPa\r\n", pressHpa);
	Serial.printf("Altitude:    %.1f m (barometric, ISA)\r\n", altM);
	Serial.println();

	delay(1000);
}
