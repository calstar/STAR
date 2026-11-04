#pragma once

// LabJack T7 boards in config.toml.
//
// A T7 is declared like any other board, as a [boards.<name>] section with type = "T7", and
// carries a table of the analog inputs it streams:
//
//   [boards.labjack_1]
//   type = "T7"
//   ip = "192.168.2.81"
//   mac = ""                  # DHCP reservation, same as the ESP32 boards (deploy/dhcp)
//   board_id = 81
//   enabled = true
//   scan_rate_hz = 100        # scans per second; every channel is sampled once per scan
//
//   [[boards.labjack_1.channels]]
//   ain = 1                   # AIN number as printed on the T7 (0-13)
//   kind = "PT"
//   role = "LOX Tank"
//   range = 10.0              # +/- volts: 10, 1, 0.1 or 0.01
//
// Only t7_bridge reads these. daq_bridge, config_broadcast and active_boards() see type "T7" as
// an unknown board type and skip it, so a T7 entry never receives ESP32 packets.
//
// Parsing is strict on purpose. A T7 config that is wrong (a duplicate AIN, a range the device
// does not have, a thermocouple with no type) is reported in Config::t7_errors and t7_bridge
// refuses to start, rather than streaming something other than what the config says.

#include <cstdint>
#include <string>
#include <vector>

namespace fsw {
namespace config {

/** One streamed analog input. */
struct T7Channel {
    int ain = -1;               ///< AIN number on the device, 0-13.
    std::string kind;           ///< "PT" | "TC" | "LC" | "RTD" | "VOLTAGE" — what is wired to it.
    std::string role;           ///< Sensor name, e.g. "LOX Tank" — what the GUI calls it.
    double range_v = 10;        ///< +/- input range in volts: 10, 1, 0.1 or 0.01.
    bool differential = false;  ///< true: AIN(ain) - AIN(ain+1); ain must be even.
    std::string tc_type;        ///< Thermocouple type letter (kind == "TC" only): "K".

    // Volts -> engineering units (t7_bridge publishes both). Every number describing the sensor
    // is stated in the channel; there are no defaults for them, so a missing one is a config
    // error rather than a plausible-looking wrong reading.
    double full_scale = 0;            ///< PT: psi at full output. LC: kg at rated output.
    std::string signal;               ///< PT output: "0-5V" "0.5-4.5V" "1-5V" "0-10V" "4-20mA".
    double shunt_ohms = 0;            ///< PT "4-20mA": the resistor the loop current crosses.
    double sensitivity_mv_per_v = 0;  ///< LC: rated output, mV per V of excitation.
    double excitation_v = 0;          ///< LC: bridge excitation voltage.
    // RTD through a LabJack LJTick-Resistance: a divider from the tick's 2.5 V reference through
    // the RTD and a fixed precision resistor, read across the fixed one,
    //   Vout = Vref * R_fixed / (R_fixed + R_rtd)   (LabJack, LJTick-Resistance datasheet).
    double r0_ohms = 0;    ///< RTD: resistance at 0 C, 100 (Pt100) or 1000 (Pt1000).
    double ljtr_ohms = 0;  ///< RTD: the tick's fixed resistor, 1k/10k/100k/1M by model.
    /** RTD: the tick's reference. 2.5 V +/-0.04 % per its datasheet; set a measured value here. */
    double vref_v = 2.5;

    /** AIN#_NEGATIVE_CH value: 199 = single-ended, else the paired odd input. */
    int negative_ch() const {
        return differential ? ain + 1 : 199;
    }
};

/** One [boards.*] section with type = "T7". */
struct T7Board {
    std::string section;  ///< "boards.labjack_1"
    std::string ip;
    std::string mac;
    int64_t serial = 0;  ///< Optional; when non-zero t7_bridge checks the unit that answered.
    int board_id = -1;
    bool enabled = true;
    double scan_rate_hz = 100.0;
    int resolution_index = 0;  ///< STREAM_RESOLUTION_INDEX; 0 = device default.
    double settling_us = 0.0;  ///< STREAM_SETTLING_US; 0 = automatic.
    int scans_per_read = 0;    ///< Scans per LJM_eStreamRead; 0 = scan_rate/20 (a 50 ms block).
    /** Thermocouple cold junction = T7 internal sensor + this (K). The default is LabJack's
     *  TEMPERATURE_AIR_K estimate for a T7 with Ethernet on (device - 4.3 - 0.6); measure it on
     *  the stand (a TC beside a reference thermometer) and set it. */
    double cjc_offset_k = -4.9;
    std::vector<T7Channel> channels;

    /** Elodin slot, same rule as BoardConfig::slot(): board_id % 10, 0 -> 10. */
    uint8_t slot() const {
        int m = board_id % 10;
        return static_cast<uint8_t>(m == 0 ? 10 : m);
    }

    /** scans_per_read with the default applied; always >= 1. */
    int effective_scans_per_read() const;
};

/** Highest AIN number on a T7 without an expansion mux (AIN0-AIN13). */
constexpr int kT7MaxAin = 13;

// Parsed by config::load() into Config::t7_boards / Config::t7_errors (see Config.cpp).

}  // namespace config
}  // namespace fsw
