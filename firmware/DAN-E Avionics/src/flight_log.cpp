#include "flight_log.h"

#include <SPIMemory.h>
#include <string.h>

#include "config.h"
#include "flight_state.h"

namespace {

SPIFlash *s_flash = nullptr;
uint32_t s_logBase = 0;
uint32_t s_logEnd = 0;
uint32_t s_nextAddr = 0;

// Bitmap: sectors in log region (max 128 × 4 KiB = 512 KiB)
constexpr unsigned MAX_SECTORS = 128;
uint8_t s_sectorErased[MAX_SECTORS / 8];

bool sectorMarked(unsigned idx) {
	return (s_sectorErased[idx / 8] & (1U << (idx % 8))) != 0;
}

void sectorMark(unsigned idx) {
	s_sectorErased[idx / 8] |= static_cast<uint8_t>(1U << (idx % 8));
}

bool sectorEnsureErased(uint32_t absAddr) {
	if (absAddr < s_logBase || absAddr >= s_logEnd)
		return false;
	const uint32_t off = absAddr - s_logBase;
	const unsigned idx = static_cast<unsigned>(off / 4096U);
	if (idx >= MAX_SECTORS)
		return false;
	if (sectorMarked(idx))
		return true;
	const uint32_t secBase = s_logBase + static_cast<uint32_t>(idx) * 4096U;
	if (!s_flash->eraseSector(secBase))
		return false;
	sectorMark(idx);
	return true;
}

bool appendSpanning(const uint8_t *data, size_t len) {
	if (!s_flash || s_nextAddr + len > s_logEnd)
		return false;
	const uint32_t start = s_nextAddr;
	const uint32_t end = s_nextAddr + static_cast<uint32_t>(len) - 1U;
	const uint32_t firstSec = (start / 4096U) * 4096U;
	const uint32_t lastSec = (end / 4096U) * 4096U;
	for (uint32_t a = firstSec; a <= lastSec; a += 4096U) {
		if (!sectorEnsureErased(a))
			return false;
	}
	if (!s_flash->writeByteArray(s_nextAddr, const_cast<uint8_t *>(data), len))
		return false;
	s_nextAddr += static_cast<uint32_t>(len);
	return true;
}

// Record: [0xDA][0x4E][ver=1][flags=0] [tag u16 LE] [t_ms u32 LE] [payload_len u16 LE] [payload...]
constexpr uint8_t REC_VER = 1;
constexpr size_t REC_HEADER = 12;

bool appendRecord(uint16_t tag, uint32_t t_ms, const void *payload, uint16_t payload_len) {
	uint8_t buf[REC_HEADER + 256];
	if (REC_HEADER + payload_len > sizeof(buf))
		return false;
	buf[0] = 0xDA;
	buf[1] = 0x4E;
	buf[2] = REC_VER;
	buf[3] = 0;
	memcpy(buf + 4, &tag, 2);
	memcpy(buf + 6, &t_ms, 4);
	memcpy(buf + 10, &payload_len, 2);
	memcpy(buf + REC_HEADER, payload, payload_len);
	return appendSpanning(buf, REC_HEADER + payload_len);
}

} // namespace

bool flightLogInit(SPIFlash &flash, uint32_t capacityBytes) {
	s_flash = &flash;
	memset(s_sectorErased, 0, sizeof(s_sectorErased));
	if (capacityBytes <= FLIGHT_LOG_REGION_BYTES)
		return false;
	s_logBase = capacityBytes - FLIGHT_LOG_REGION_BYTES;
	s_logEnd = capacityBytes;
	s_nextAddr = s_logBase;
	return true;
}

bool sensorsShouldLog() {
#if !FLIGHT_LOG_ENABLE
	return false;
#else
	return flightStateGet() != FlightState::Idle;
#endif
}

void logFlightStateTransition(FlightState from, FlightState to, uint32_t t_ms, uint8_t reason) {
#if !FLIGHT_LOG_ENABLE
	(void)from;
	(void)to;
	(void)t_ms;
	(void)reason;
	return;
#endif
	if (!s_flash)
		return;
	uint8_t pl[3];
	pl[0] = static_cast<uint8_t>(from);
	pl[1] = static_cast<uint8_t>(to);
	pl[2] = reason;
	(void)appendRecord(5, t_ms, pl, sizeof(pl)); // tag 5 = FLIGHT_STATE
}

void logMcp3201(uint16_t raw, float psi, uint32_t t_ms) {
	if (!sensorsShouldLog() || !s_flash)
		return;
	uint8_t pl[6];
	memcpy(pl, &raw, 2);
	memcpy(pl + 2, &psi, 4);
	(void)appendRecord(1, t_ms, pl, sizeof(pl));
}

void logLis3dh(float ax_g, float ay_g, float az_g, uint32_t t_ms) {
	if (!sensorsShouldLog() || !s_flash)
		return;
	float pl[3] = {ax_g, ay_g, az_g};
	(void)appendRecord(2, t_ms, pl, sizeof(pl));
}

void logLps28dfw(float hpa, float temp_c, float alt_m, uint32_t t_ms) {
	if (!sensorsShouldLog() || !s_flash)
		return;
	float pl[3] = {hpa, temp_c, alt_m};
	(void)appendRecord(3, t_ms, pl, sizeof(pl));
}

void logIsm330(float ax, float ay, float az, float gx, float gy, float gz, uint32_t t_ms) {
	if (!sensorsShouldLog() || !s_flash)
		return;
	float pl[6] = {ax, ay, az, gx, gy, gz};
	(void)appendRecord(4, t_ms, pl, sizeof(pl));
}

void flightLogService() {
	// Reserved for future buffered flush / wear leveling
}
