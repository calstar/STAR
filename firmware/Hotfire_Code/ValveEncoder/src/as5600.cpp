#include "as5600.h"

namespace {
constexpr uint8_t REG_ZMCO = 0x00;
constexpr uint8_t REG_CONF_HI = 0x07;
constexpr uint8_t REG_STATUS = 0x0B;
constexpr uint8_t REG_RAW_MSB = 0x0C;
constexpr uint8_t REG_AGC = 0x1A;
constexpr uint8_t REG_MAG_HI = 0x1B;

constexpr uint8_t STATUS_MH = 0x08;  // too strong
constexpr uint8_t STATUS_ML = 0x10;  // too weak
constexpr uint8_t STATUS_MD = 0x20;  // detected
}  // namespace

bool As5600Reading::magnetDetected() const {
    return status & STATUS_MD;
}
bool As5600Reading::magnetTooWeak() const {
    return status & STATUS_ML;
}
bool As5600Reading::magnetTooStrong() const {
    return status & STATUS_MH;
}
bool As5600Reading::usable() const {
    return i2c_ok && magnetDetected() && !magnetTooWeak() && !magnetTooStrong();
}

bool As5600::begin(int sda, int scl, uint32_t clock_hz) {
    bus_.begin(sda, scl, clock_hz);
    bus_.setTimeOut(20);  // ms, so a stuck bus can't hang the loop
    return ping();
}

bool As5600::ping() {
    bus_.beginTransmission(ADDR);
    return bus_.endTransmission() == 0;
}

bool As5600::readBytes(uint8_t reg, uint8_t* buf, uint8_t len) {
    bus_.beginTransmission(ADDR);
    bus_.write(reg);
    if (bus_.endTransmission(false) != 0)
        return false;
    if (bus_.requestFrom(ADDR, len) != len)
        return false;
    for (uint8_t i = 0; i < len; i++)
        buf[i] = bus_.read();
    return true;
}

As5600Reading As5600::read() {
    As5600Reading r;
    uint8_t buf[3];  // STATUS, RAW_MSB, RAW_LSB are consecutive
    if (!readBytes(REG_STATUS, buf, 3))
        return r;
    r.i2c_ok = true;
    r.status = buf[0] & (STATUS_MD | STATUS_ML | STATUS_MH);
    r.raw_angle = ((static_cast<uint16_t>(buf[1]) << 8) | buf[2]) & 0x0FFF;
    return r;
}

void As5600::dumpDiagnostics(Print& out) {
    out.println("[AS5600] --- register dump ---");
    uint8_t v;
    if (readBytes(REG_ZMCO, &v, 1))
        out.printf("  ZMCO   = %u  (burn count, max 3)\n", v & 0x03);
    uint8_t two[2];
    if (readBytes(REG_CONF_HI, two, 2))
        out.printf("  CONF   = 0x%02X%02X\n", two[0], two[1]);
    if (readBytes(REG_STATUS, &v, 1))
        out.printf("  STATUS = 0x%02X  MD=%d ML=%d MH=%d\n", v,
                   (v & STATUS_MD) != 0, (v & STATUS_ML) != 0,
                   (v & STATUS_MH) != 0);
    if (readBytes(REG_RAW_MSB, two, 2))
        out.printf("  RAW    = %u counts\n", ((two[0] << 8) | two[1]) & 0x0FFF);
    if (readBytes(REG_AGC, &v, 1))
        out.printf("  AGC    = %u  (pinned at either end = wrong magnet gap)\n",
                   v);
    if (readBytes(REG_MAG_HI, two, 2))
        out.printf("  MAG    = %u\n", ((two[0] << 8) | two[1]) & 0x0FFF);
    out.println("[AS5600] ---------------------");
}
