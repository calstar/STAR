#include <Arduino.h>
#include <SPIMemory.h>

#include "main.h"

namespace {

SPIFlash flash(MX25_PIN_CS);

void printDivider() {
	Serial.println();
	for (uint8_t i = 0; i < 80; i++)
		Serial.print('-');
	Serial.println();
}

bool fillTestPattern(uint8_t *buf, size_t len) {
	for (size_t i = 0; i < len; i++)
		buf[i] = static_cast<uint8_t>(0xA5U ^ (i * 131U));
	return true;
}

bool verifyPattern(const uint8_t *buf, size_t len) {
	for (size_t i = 0; i < len; i++) {
		if (buf[i] != static_cast<uint8_t>(0xA5U ^ (i * 131U)))
			return false;
	}
	return true;
}

} // namespace

void setup() {
	Serial.begin(115200);
	while (!Serial)
		delay(10);
	delay(50);

	printDivider();
	Serial.println("MX25L25645 — write / readback test (SPIMemory)");
	printDivider();

	SPI.begin(MX25_PIN_SCK, MX25_PIN_MISO, MX25_PIN_MOSI, MX25_PIN_CS);

	if (!flash.begin()) {
		Serial.println("FAIL: flash.begin() — check wiring, CS, and power.");
		if (flash.error())
			Serial.println(flash.error(VERBOSE));
		while (true)
			delay(1000);
	}

	const uint32_t jedec = flash.getJEDECID();
	Serial.printf("JEDEC ID: 0x%06lX\r\n", static_cast<unsigned long>(jedec));
	if (jedec != MX25_EXPECTED_JEDEC)
		Serial.printf("WARN: expected 0x%06lX for MX25L25645G; continuing anyway.\r\n",
		              static_cast<unsigned long>(MX25_EXPECTED_JEDEC));

	const uint32_t cap = flash.getCapacity();
	Serial.printf("Reported capacity: %lu bytes (%.2f MiB)\r\n",
	              static_cast<unsigned long>(cap),
	              static_cast<double>(cap) / (1024.0 * 1024.0));

	if (cap < 4096U || MX25_TEST_BYTES > 4096U) {
		Serial.println("FAIL: capacity or test size invalid.");
		while (true)
			delay(1000);
	}

	// Use last 4 KiB sector so we stay away from low addresses other tooling might use.
	const uint32_t sectorBase = cap - 4096U;
	Serial.printf("Test sector base: 0x%08lX\r\n", static_cast<unsigned long>(sectorBase));

	if (!flash.eraseSector(sectorBase)) {
		Serial.println("FAIL: eraseSector");
		if (flash.error())
			Serial.println(flash.error(VERBOSE));
		while (true)
			delay(1000);
	}
	Serial.println("Sector erase OK.");

	uint8_t writeBuf[MX25_TEST_BYTES];
	uint8_t readBuf[MX25_TEST_BYTES];
	fillTestPattern(writeBuf, MX25_TEST_BYTES);

	if (!flash.writeByteArray(sectorBase, writeBuf, MX25_TEST_BYTES)) {
		Serial.println("FAIL: writeByteArray");
		if (flash.error())
			Serial.println(flash.error(VERBOSE));
		while (true)
			delay(1000);
	}
	Serial.printf("Wrote %u bytes at 0x%08lX\r\n",
	              static_cast<unsigned>(MX25_TEST_BYTES),
	              static_cast<unsigned long>(sectorBase));

	memset(readBuf, 0, sizeof(readBuf));
	if (!flash.readByteArray(sectorBase, readBuf, MX25_TEST_BYTES)) {
		Serial.println("FAIL: readByteArray");
		if (flash.error())
			Serial.println(flash.error(VERBOSE));
		while (true)
			delay(1000);
	}

	const bool ok = verifyPattern(readBuf, MX25_TEST_BYTES);
	if (ok) {
		Serial.println("PASS: readback matches written pattern.");
	} else {
		Serial.println("FAIL: readback mismatch.");
		for (unsigned i = 0; i < MX25_TEST_BYTES; i++) {
			if (readBuf[i] != writeBuf[i]) {
				Serial.printf("  first diff @ %u: wrote 0x%02X read 0x%02X\r\n",
				              i, writeBuf[i], readBuf[i]);
				break;
			}
		}
	}

	// Second check: Arduino String round-trip (same idea as storage-test Flash_Storage.ino)
	const char *msg = "MX25 OK";
	String sIn = msg;
	const uint16_t strBytes = static_cast<uint16_t>(sizeof(char) * (sIn.length() + 1U));
	const uint32_t strAddr = flash.getAddress(strBytes);
	if (strAddr == 0 && strBytes > 0) {
		Serial.println("WARN: getAddress failed for string test; skipping.");
	} else {
		if (!flash.eraseSector(strAddr)) {
			Serial.println("FAIL: eraseSector (string test)");
		} else if (!flash.writeStr(strAddr, sIn, strBytes)) {
			Serial.println("FAIL: writeStr");
		} else {
			String sOut;
			sOut.reserve(sIn.length() + 1U);
			if (!flash.readStr(strAddr, sOut, strBytes))
				Serial.println("FAIL: readStr");
			else if (sOut == sIn)
				Serial.println("PASS: String readback OK.");
			else
				Serial.println("FAIL: String readback mismatch.");
		}
	}

	printDivider();
	Serial.println("Done.");
	printDivider();
}

void loop() {
	delay(1000);
}
