#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <math.h>

#include <Adafruit_LIS3DH.h>
#include <Adafruit_Sensor.h>
#include <STAR_MCP3201.h>
#include <SPIMemory.h>
#include <SparkFun_LPS28DFW_Arduino_Library.h>
#include <STAR_ISM330DH.h>

#include "apogee.h"
#include "config.h"
#include "flight_log.h"
#include "flight_state.h"
#include "pins.h"

static SPIFlash g_flash(PIN_MX25_CS);
static STAR_MCP3201 g_adc(PIN_ADC_CS, &SPI);
static Adafruit_LIS3DH g_lis(PIN_ACCEL_CS, &SPI);
static ISM330DH_SPI g_imu;
static LPS28DFW g_baro;

static sfe_ism_data_t g_accel{};
static sfe_ism_data_t g_gyro{};

static volatile bool g_launchFlag = false;
static volatile bool g_imuWakeFlag = false;

void IRAM_ATTR onAccelInt() {
	g_launchFlag = true;
}

void IRAM_ATTR onImuInt() {
	g_imuWakeFlag = true;
}

static float pressureToAltitudeM(float pressureHpa, float seaLevelHpa) {
	if (pressureHpa <= 0.f || seaLevelHpa <= 0.f)
		return NAN;
	return 44330.0f * (1.0f - powf(pressureHpa / seaLevelHpa, 0.190284f));
}

static uint32_t s_lastLpsMs = 0;
static uint32_t s_lastMcpMs = 0;

void setup() {
	Serial.begin(115200);
	while (!Serial)
		delay(10);
	delay(50);

	pinMode(PIN_MX25_RESET, OUTPUT);
	digitalWrite(PIN_MX25_RESET, HIGH);

	SPI.begin(PIN_SCLK, PIN_MISO, PIN_MOSI, static_cast<int8_t>(-1));
	pinMode(PIN_ADC_CS, OUTPUT);
	digitalWrite(PIN_ADC_CS, HIGH);

	if (!g_flash.begin()) {
		Serial.println("ERROR: MX25 flash begin failed");
		while (true)
			delay(1000);
	}
	const uint32_t cap = g_flash.getCapacity();
	Serial.printf("Flash capacity: %lu bytes\r\n", static_cast<unsigned long>(cap));
	if (!flightLogInit(g_flash, cap))
		Serial.println("WARN: flightLogInit failed");

	flightStateInit();

	if (!g_lis.begin()) {
		Serial.println("ERROR: LIS3DH not found");
		while (true)
			delay(1000);
	}
	g_lis.setDataRate(ACCEL_ODR);
	g_lis.setRange(ACCEL_RANGE);
	g_lis.configureHighGInterrupt(INT1_THS_VALUE, INT1_DUR_VALUE);

	if (!g_imu.begin(SPI, SPISettings(4000000, MSBFIRST, SPI_MODE3), PIN_IMU_CS)) {
		Serial.println("ERROR: ISM330 SPI begin failed");
		while (true)
			delay(1000);
	}
	g_imu.deviceReset();
	while (!g_imu.getDeviceReset())
		delay(1);
	delay(100);
	g_imu.setDeviceConfig(true);
	g_imu.setBlockDataUpdate(true);
	g_imu.setAccelDataRate(ISM_XL_ODR_104Hz);
	g_imu.setAccelFullScale(ISM330_ACCEL_FS);
	g_imu.setGyroDataRate(ISM_GY_ODR_104Hz);
	g_imu.setGyroFullScale(ISM_500dps);
	g_imu.setAccelFilterLP2(true);
	g_imu.setAccelSlopeFilter(ISM_LP_ODR_DIV_100);
	g_imu.setGyroFilterLP1(true);
	g_imu.setGyroLP1Bandwidth(ISM_MEDIUM);
	if (!g_imu.configureWakeUpOnInt1(ISM330_WKUP_THS, ISM330_WAKEUP_DUR, ISM330_ROUTE_DRDY_TO_INT1)) {
		Serial.println("ERROR: ISM330 configureWakeUpOnInt1 failed");
		while (true)
			delay(1000);
	}
	g_imu.setPinMode(false);

	Wire.begin(PIN_SDA, PIN_SCL);
	while (g_baro.begin(LPS28DFW_I2C_ADDR, Wire) != LPS28DFW_OK) {
		Serial.println("ERROR: LPS28DFW not found");
		delay(1000);
	}
	lps28dfw_md_t modeConfig = {
		.fs = LPS28DFW_1260hPa,
		.odr = LPS28DFW_50Hz,
		.avg = LPS28DFW_4_AVG,
		.lpf = LPS28DFW_LPF_ODR_DIV_4,
	};
	if (g_baro.setModeConfig(&modeConfig) != LPS28DFW_OK) {
		Serial.println("ERROR: LPS28DFW setModeConfig failed");
		while (true)
			delay(1000);
	}

	pinMode(PIN_ACCEL_INT1, INPUT);
	attachInterrupt(digitalPinToInterrupt(PIN_ACCEL_INT1), onAccelInt, RISING);
	pinMode(PIN_IMU_INT1, INPUT);
	attachInterrupt(digitalPinToInterrupt(PIN_IMU_INT1), onImuInt, RISING);

	apogeeReset();

	Serial.println("DAN-E Avionics ready");
}

void loop() {
	const uint32_t now = millis();

	if (g_launchFlag) {
		g_launchFlag = false;
		(void)g_lis.readAndClearInterrupt();
		flightStateOnLaunchDetect();
	}
	if (g_imuWakeFlag) {
		g_imuWakeFlag = false;
		sfe_ism330_wake_event_t wu{};
		(void)g_imu.serviceWakeUpInterrupt(&wu);
	}

	if (now - s_lastLpsMs >= 20U) {
		s_lastLpsMs = now;
		if (g_baro.getSensorData() == LPS28DFW_OK) {
			const float hpa = g_baro.data.pressure.hpa;
			const float tempC = g_baro.data.heat.deg_c;
			const float altM = pressureToAltitudeM(hpa, LPS28DFW_SEA_LEVEL_HPA);

			if (flightStateGet() == FlightState::Launch) {
				apogeePushAltitude(altM);
				if (apogeeShouldConfirm())
					flightStateOnApogee();
			}

			if (sensorsShouldLog())
				logLps28dfw(hpa, tempC, altM, now);
		}
	}

	if (now - s_lastMcpMs >= 10U) {
		s_lastMcpMs = now;
		const uint16_t raw = g_adc.read();
		const float psi = (static_cast<float>(raw) / ADC_COUNTS) * PT_FULL_SCALE_PSI;
		if (sensorsShouldLog())
			logMcp3201(raw, psi, now);
	}

	g_lis.read();
	sensors_event_t ev{};
	g_lis.getEvent(&ev);
	if (sensorsShouldLog()) {
		const float ax = ev.acceleration.x / 9.80665f;
		const float ay = ev.acceleration.y / 9.80665f;
		const float az = ev.acceleration.z / 9.80665f;
		logLis3dh(ax, ay, az, now);
	}

	if (g_imu.checkStatus()) {
		if (g_imu.getAccel(&g_accel) && g_imu.getGyro(&g_gyro)) {
			if (sensorsShouldLog()) {
				logIsm330(g_accel.xData / 1000.0f, g_accel.yData / 1000.0f, g_accel.zData / 1000.0f,
				           g_gyro.xData / 1000.0f, g_gyro.yData / 1000.0f, g_gyro.zData / 1000.0f, now);
			}
		}
	}

	flightStateTick();
	applyActuatorOutputs();

#if DEBUG_TELEMETRY
	static uint32_t s_dbgMs = 0;
	if (now - s_dbgMs >= 200U) {
		s_dbgMs = now;
		Serial.printf("state=%u  baro_ok\r\n", static_cast<unsigned>(static_cast<uint8_t>(flightStateGet())));
	}
#endif

	delay(1);
}
