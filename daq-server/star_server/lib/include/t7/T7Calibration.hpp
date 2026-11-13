#pragma once

// How calibration_service sees a LabJack T7 channel: as one more PT / LC / TC, with the same uid,
// store, models, captures and tares as an ESP32 sensor. Only where its data comes from differs.
//
//   t7_bridge  ── raw volts {0x26, (slot-1)*0x20 + ain} ──►  calibration_service
//              ── cold junction °C {0x26, (slot-1)*0x20 + 0x0F} (TC boards) ──►
//   calibration_service ── calibrated {0x26, (slot-1)*0x20 + 0x10 + ain} ──► GUI
//
// The "ADC code" a T7 channel feeds the shared calibration machinery is its reading in
// MICROVOLTS (t7_counts): an int32 like the ESP32 boards' codes, so captured points, cubic fits,
// the robust learner and tares all work on it unchanged. 1 µV is 0.005 % of a 20 mV load-cell
// span, 0.02 ‰ of a 5 V PT span and about 0.025 °C of a type K, so the rounding is not what
// limits any of them. The cubic store tags these channels "uV"
// (CubicCalibrationStore kRawUnitMicrovolts) so a fit never crosses between the two units.

#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "config/Config.hpp"

namespace fsw {
namespace t7 {

/** Raw-table offset (within a slot's 32-entry block) of the cold-junction table: AIN15 does not
 *  exist on a T7, so the slot is free. Entity T7<slot>.CJC, field temperature_c. */
constexpr uint8_t kCjcTableOffset = 0x0F;

/** First logical calibration channel for T7 inputs. ESP32 boards use (slot-1)*10 + connector,
 *  at most 80; T7 inputs use 128 + (slot-1)*16 + ain (128..255), so the two cannot collide in
 *  PTCalibrationManager / SensorCalibrationManager. */
constexpr uint8_t kT7LogicalBase = 128;

/** Logical calibration channel for a T7 input. */
uint8_t t7_logical_channel(uint8_t slot, uint8_t ain);

/** uid of a T7 input: board_id * 100 + ain, the ESP32 scheme with the AIN as connector. */
uint16_t t7_uid(int board_id, int ain);

/** The calibration "ADC code" for a T7 reading: microvolts, rounded and clamped to int32. */
int32_t t7_counts(double volts);

/** Volts from a calibration code. */
double t7_volts(double counts);

/** Cold-junction table id for a slot. */
std::array<uint8_t, 2> cjc_table_id(uint8_t slot);

/** One T7 input as calibration sees it. */
struct T7CalChannel {
    std::string board_key;  ///< "labjack_1" — the <board> in [calibration_model_<board>] etc.
    int board_id = 0;
    uint8_t slot = 0;
    config::T7Channel channel;
    uint16_t uid = 0;
    uint8_t logical_ch = 0;
};

/**
 * Every PT / LC / TC input on every enabled T7, from config. VOLTAGE inputs are left out (they
 * have nothing to calibrate). Built only from a config t7_bridge would accept: when
 * Config::t7_errors is non-empty the map is empty, because the bridge is not streaming either.
 */
class T7CalibrationMap {
public:
    T7CalibrationMap() = default;
    explicit T7CalibrationMap(const config::Config& cfg);

    const T7CalChannel* by_uid(uint16_t uid) const;
    /** The input behind raw table {0x26, (slot-1)*0x20 + ain}, or nullptr. */
    const T7CalChannel* by_table(uint8_t slot, uint8_t ain) const;
    const std::vector<T7CalChannel>& all() const {
        return channels_;
    }
    /** Slots with at least one TC (they publish a cold-junction table). */
    std::vector<uint8_t> tc_slots() const;
    /** Raw tables calibration_service subscribes to: every input above, plus each TC slot's CJC. */
    std::vector<std::pair<uint8_t, uint8_t>> raw_tables() const;
    bool empty() const {
        return channels_.empty();
    }

private:
    std::vector<T7CalChannel> channels_;
    std::map<uint16_t, size_t> by_uid_;
    std::map<std::pair<uint8_t, uint8_t>, size_t> by_table_;
};

}  // namespace t7
}  // namespace fsw
