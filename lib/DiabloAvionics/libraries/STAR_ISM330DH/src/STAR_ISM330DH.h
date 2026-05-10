/**
 * STAR_ISM330DH — improved fork of SparkFun's SparkFun_6DoF_ISM330DHCX_Arduino_Library.
 * Adds STAR-specific API (wake-up on INT1, serviceWakeUpInterrupt, etc.) and public
 * types ISM330DH / ISM330DH_SPI. Original bus glue and STMicro driver retained; see README.
 */
#pragma once

#include "sfe_ism330dhcx.h"
#include "sfe_bus.h"
#include <SPI.h>
#include <Wire.h>

/** I2C driver for ISM330DHCX. Public include: STAR_ISM330DH.h */
class ISM330DH : public QwDevISM330DHCX {
public:
	ISM330DH() = default;

	bool begin(uint8_t deviceAddress = ISM330DHCX_ADDRESS_HIGH) {
		setCommunicationBus(_i2cBus, deviceAddress);
		_i2cBus.init();
		return QwDevISM330DHCX::init();
	}

	bool begin(TwoWire &wirePort, uint8_t deviceAddress = ISM330DHCX_ADDRESS_HIGH) {
		setCommunicationBus(_i2cBus, deviceAddress);
		_i2cBus.init(wirePort, true);
		return QwDevISM330DHCX::init();
	}

private:
	sfe_ISM330DHCX::QwI2C _i2cBus;
};

/** SPI driver for ISM330DHCX. */
class ISM330DH_SPI : public QwDevISM330DHCX {
public:
	ISM330DH_SPI() = default;

	bool begin(uint8_t cs) {
		setCommunicationBus(_spiBus);
		_spiBus.init(cs, true);
		return QwDevISM330DHCX::init();
	}

	bool begin(SPIClass &spiPort, SPISettings ismSettings, uint8_t cs) {
		setCommunicationBus(_spiBus);
		_spiBus.init(spiPort, ismSettings, cs, true);
		return QwDevISM330DHCX::init();
	}

private:
	sfe_ISM330DHCX::SfeSPI _spiBus;
};
