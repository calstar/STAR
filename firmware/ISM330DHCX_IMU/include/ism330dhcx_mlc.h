/**
 * @file ism330dhcx_mlc.h
 * @brief STMicroelectronics ISM330DHCX Machine Learning Core (MLC) Interface.
 * 
 * Supports on-chip Decision Tree execution across up to 8 parallel flows (MLC0 to MLC7).
 */

#ifndef ISM330DHCX_MLC_H
#define ISM330DHCX_MLC_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Single UCF (Unico Configuration Format) register transaction.
 * Compatible with ST Unico-GUI and ST MEMS C-array exports.
 */
typedef struct {
    uint8_t address;
    uint8_t data;
} ism330dhcx_ucf_line_t;

/**
 * @brief Machine Learning Core status flags.
 */
typedef struct {
    bool mlc1_event;
    bool mlc2_event;
    bool mlc3_event;
    bool mlc4_event;
    bool mlc5_event;
    bool mlc6_event;
    bool mlc7_event;
    bool mlc8_event;
} ism330dhcx_mlc_status_t;

/**
 * @brief Real-time outputs from the 8 on-chip decision tree flows (MLC0_SRC to MLC7_SRC).
 */
typedef struct {
    uint8_t tree0_out;  /**< e.g., Flight Phase Classifier (Pad, Boost, Coast, Apogee, etc.) */
    uint8_t tree1_out;  /**< e.g., Signal Drop Risk (0 = Normal, 1 = High Risk) */
    uint8_t tree2_out;  /**< e.g., Apogee Turnover (0 = False, 1 = Detected) */
    uint8_t tree3_out;  /**< e.g., First / Drogue Chute Verification */
    uint8_t tree4_out;  /**< e.g., Main Chute Deployment */
    uint8_t tree5_out;  /**< e.g., Touchdown Confirmed */
    uint8_t tree6_out;  /**< e.g., Extreme Tumbling / Flight Abort Condition */
    uint8_t tree7_out;  /**< e.g., Emergency Chute Trigger */
} ism330dhcx_mlc_results_t;

/**
 * @brief Avionics Flight Phase enumeration for Tree 0
 */
typedef enum {
    AVIONICS_PHASE_PAD       = 0x00,
    AVIONICS_PHASE_BOOST     = 0x01,
    AVIONICS_PHASE_COAST     = 0x02,
    AVIONICS_PHASE_APOGEE    = 0x03,
    AVIONICS_PHASE_DROGUE    = 0x04,
    AVIONICS_PHASE_MAIN      = 0x05,
    AVIONICS_PHASE_TOUCHDOWN = 0x06
} avionics_flight_phase_t;

/**
 * @brief Helper string converter for avionics phase output
 */
static inline const char* avionics_phase_str(uint8_t phase) {
    switch (phase) {
        case AVIONICS_PHASE_PAD:       return "PAD (PRE-LAUNCH)";
        case AVIONICS_PHASE_BOOST:     return "BOOST (THRUSTING)";
        case AVIONICS_PHASE_COAST:     return "COAST (BALLISTIC)";
        case AVIONICS_PHASE_APOGEE:    return "APOGEE (TURNOVER)";
        case AVIONICS_PHASE_DROGUE:    return "DROGUE / FIRST CHUTE";
        case AVIONICS_PHASE_MAIN:      return "MAIN CHUTE DESCENT";
        case AVIONICS_PHASE_TOUCHDOWN: return "TOUCHDOWN (LANDED)";
        default:                       return "UNKNOWN";
    }
}

#ifdef __cplusplus
}
#endif

#endif /* ISM330DHCX_MLC_H */
