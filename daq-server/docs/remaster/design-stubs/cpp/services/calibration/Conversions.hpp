// DESIGN STUB (DESIGN-WP9 §2, move-only step 1) — not compiled. Becomes
// diablo_server/services/calibration/Conversions.hpp, header-only, compiled into
// calibration_service only (STYLE-S2). Bodies: calibration_main.cpp 263-278, 331-457, 464-477,
// 479-530, moved verbatim with `static` → `inline`; the stray comment 464-466 moves with mono_ns
// (STYLE-S38).
//
// Owns:       nothing (pure functions) — except convert_hp_pt_to_pressure, which mutates the
//             caller's hysteresis latch array and reads getenv("CAL_HP_MA_HYST") on every call.
// Threads:    calibration_service has one thread; nothing here locks.
// Errors:     none signalled; out-of-range inputs produce whatever today's arithmetic produces.
//             resolve_*_sensor_uid return 100 + ch for ch outside 1-10, as today.
// D22:        header-inline on purpose: these are inlined at today's call sites. None of the
//             expressions here is FMA-contractible (DESIGN-WP9 §6.3 table); the contractible ones
//             (Blend, PtSmoother::step) live in SensorModels.hpp / the lib and stay inline too.
// Must not know: Elodin, files, the stores, the sensor-model globals (SensorModels.hpp), main's
//             locals. resolve_pt_sensor_uid / resolve_lc_sensor_uid stay two functions (identical
//             bodies; the duplication is documented at 505-509; DESIGN-WP9 open question 2).
// Contract:   published values — calibration/golden/stack.txt (float32 at 4 ULP, D22).
#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "config/LoadActiveBoards.hpp"  // fsw::config::PtBoardConfig
#include "elodin/DatabaseConfig.hpp"    // fsw::elodin::BoardChannels

namespace fsw::calibration_service {

inline double convert_ratiometric_pt_to_pressure(int32_t adc_raw, double full_scale_psi);
inline double convert_hp_pt_to_pressure(uint8_t local_ch, uint32_t adc_raw,
                                        const fsw::config::PtBoardConfig& board,
                                        double full_scale_psi, double sense_resistor_ohms,
                                        std::array<uint8_t, 11>& live_state);
inline double convert_tc_adc_to_temp_c(int32_t adc_raw, double adc_ref_voltage);
inline double clamp_tc_rtd_temp_publish_c(double t_c);
inline double convert_rtd_adc_to_temp_c(int32_t adc_raw, double adc_ref_voltage,
                                        double excitation_ua, double r0_ohm);
inline double convert_act_adc_to_current(uint32_t adc_raw);
inline double convert_lc_adc_to_force(int32_t adc_raw, double sensitivity_mv_per_v, double pga_gain,
                                      double full_scale_value);
inline double unix_now();
inline uint64_t mono_ns();
inline uint16_t resolve_pt_sensor_uid(uint8_t type_lo, uint8_t ch,
                                      const std::vector<fsw::elodin::BoardChannels>& pt_boards);
inline uint16_t resolve_lc_sensor_uid(uint8_t type_lo, uint8_t ch,
                                      const std::vector<fsw::elodin::BoardChannels>& lc_boards);

}  // namespace fsw::calibration_service
