#include "ina260.h"

namespace {
constexpr uint8_t REG_CONFIG = 0x00;
constexpr uint8_t REG_CURRENT = 0x01;
constexpr uint8_t REG_BUS_V = 0x02;
constexpr uint8_t REG_MASK_EN = 0x06;
constexpr uint8_t REG_MFR_ID = 0xFE;
constexpr uint8_t REG_DIE_ID = 0xFF;

constexpr uint16_t MFR_ID_TI = 0x5449;
constexpr uint16_t DIE_ID_MASK = 0xFFF0;
constexpr uint16_t DIE_ID_INA260 = 0x2270;

// AVG = 16, VBUSCT = ISHCT = 1.1 ms -> ~35 ms per triggered pair.
constexpr uint16_t CFG_AVG16 = 0b010 << 9;
constexpr uint16_t CFG_VBUSCT_1100US = 0b100 << 6;
constexpr uint16_t CFG_ISHCT_1100US = 0b100 << 3;
constexpr uint16_t MODE_SHUTDOWN = 0b000;
constexpr uint16_t MODE_TRIG_BOTH = 0b011;
constexpr uint16_t CFG_BASE = CFG_AVG16 | CFG_VBUSCT_1100US | CFG_ISHCT_1100US;

constexpr uint16_t MASK_CVRF = 1 << 3;  // conversion ready
constexpr uint32_t CONVERSION_TIMEOUT_MS = 100;
}  // namespace

bool INA260::begin(TwoWire &wire, uint8_t addr) {
    wire_ = &wire;
    addr_ = addr;
    uint16_t mfr = 0, die = 0;
    if (!read16(REG_MFR_ID, mfr) || !read16(REG_DIE_ID, die)) return false;
    if (mfr != MFR_ID_TI || (die & DIE_ID_MASK) != DIE_ID_INA260) return false;
    shutdown();
    return true;
}

bool INA260::read(Reading &out) {
    if (!write16(REG_CONFIG, CFG_BASE | MODE_TRIG_BOTH)) return false;

    // Reading Mask/Enable clears CVRF, so poll it until the pair completes.
    uint32_t start = millis();
    uint16_t mask = 0;
    do {
        delay(5);
        if (!read16(REG_MASK_EN, mask)) return false;
    } while (!(mask & MASK_CVRF) && millis() - start < CONVERSION_TIMEOUT_MS);
    if (!(mask & MASK_CVRF)) return false;

    uint16_t raw_i = 0, raw_v = 0;
    if (!read16(REG_CURRENT, raw_i) || !read16(REG_BUS_V, raw_v)) return false;

    // 1.25 mA/LSB signed, 1.25 mV/LSB
    out.current_mA = (static_cast<int16_t>(raw_i) * 5) / 4;
    out.bus_mV = static_cast<uint16_t>((static_cast<uint32_t>(raw_v) * 5) / 4);
    int32_t mag = out.current_mA < 0 ? -out.current_mA : out.current_mA;
    out.power_mW = (static_cast<uint32_t>(mag) * out.bus_mV) / 1000;
    return true;
}

void INA260::shutdown() { write16(REG_CONFIG, CFG_BASE | MODE_SHUTDOWN); }

bool INA260::write16(uint8_t reg, uint16_t val) {
    wire_->beginTransmission(addr_);
    wire_->write(reg);
    wire_->write(static_cast<uint8_t>(val >> 8));
    wire_->write(static_cast<uint8_t>(val & 0xFF));
    return wire_->endTransmission() == 0;
}

bool INA260::read16(uint8_t reg, uint16_t &val) {
    wire_->beginTransmission(addr_);
    wire_->write(reg);
    if (wire_->endTransmission(false) != 0) return false;
    if (wire_->requestFrom(addr_, static_cast<uint8_t>(2)) != 2) return false;
    val = static_cast<uint16_t>(wire_->read()) << 8;
    val |= static_cast<uint16_t>(wire_->read());
    return true;
}
