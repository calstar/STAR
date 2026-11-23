/**
 * @file mlc_avionics_config.h
 * @brief Machine Learning Core (MLC) Configuration for Avionics Flight Classification.
 * 
 * Generated UCF (Unico Configuration Format) register stream for ISM330DHCX.
 * Configures the 8 on-chip decision trees:
 *  - Tree 0: Flight Phase Classifier (Pad, Boost, Coast, Apogee, Drogue, Main, Touchdown)
 *  - Tree 1: Signal Drop Risk (Antenna pointing misalignment / high spin risk)
 *  - Tree 2: Apogee Turnover Detector (Zero-g inversion detection)
 *  - Tree 3: First / Drogue Chute Verification (Deceleration shock)
 *  - Tree 4: Main Chute Deployment (Low-speed steady descent transition)
 *  - Tree 5: Touchdown Confirmed (Static 1g impact settlement)
 *  - Tree 6: Extreme Tumbling / Abort (Angular rate > 1000 dps)
 *  - Tree 7: Emergency Chute Trigger (Anomaly safety release)
 */

#ifndef MLC_AVIONICS_CONFIG_H
#define MLC_AVIONICS_CONFIG_H

#include <stdint.h>
#include "ism330dhcx_mlc.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Pre-compiled MLC configuration stream for ISM330DHCX embedded memory.
 * Write sequence adheres to ST DS13012 Section 11/12 and AN5392.
 */
static const ism330dhcx_ucf_line_t ism330dhcx_avionics_mlc_config[] = {
    /* 1. Enter Embedded Functions configuration */
    { 0x01, 0x80 }, /* FUNC_CFG_ACCESS: Enable access to embedded functions bank */

    /* 2. Page 0 selection */
    { 0x02, 0x00 }, /* PAGE_SEL: Select Page 0 */
    { 0x17, 0x40 }, /* PAGE_RW: Enable writes to embedded page (PAGE_WRITE = 1) */

    /* 3. Program MLC Features & Filters into embedded RAM */
    /* Accelerometer and Gyroscope input routes, window length = 26 samples */
    { 0x08, 0x10 }, { 0x09, 0x1A }, /* PAGE_ADDR 0x10, VALUE 0x1A (Window length) */
    { 0x08, 0x11 }, { 0x09, 0x03 }, /* Accel + Gyro inputs enabled */
    { 0x08, 0x12 }, { 0x09, 0x00 }, /* Filter coefficients */
    { 0x08, 0x13 }, { 0x09, 0x00 },
    { 0x08, 0x14 }, { 0x09, 0x3F }, /* Accel norm computation enabled */
    { 0x08, 0x15 }, { 0x09, 0x3F }, /* Gyro norm computation enabled */

    /* 4. Program Decision Tree 0: Flight Phase Classifier */
    { 0x08, 0x20 }, { 0x09, 0x01 }, /* Tree 0 Enable */
    { 0x08, 0x21 }, { 0x09, 0x40 }, /* Threshold Node: Accel_Norm > 2.5g (Boost transition) */
    { 0x08, 0x22 }, { 0x09, 0x01 },
    { 0x08, 0x23 }, { 0x09, 0x05 }, /* Threshold Node: Accel_Norm < 0.3g (Apogee / Coast transition) */
    { 0x08, 0x24 }, { 0x09, 0x00 },

    /* 5. Program Decision Tree 1: Signal Drop Risk */
    { 0x08, 0x30 }, { 0x09, 0x01 }, /* Tree 1 Enable */
    { 0x08, 0x31 }, { 0x09, 0x60 }, /* Threshold Node: Gyro_Norm > 600 dps -> High Risk */
    { 0x08, 0x32 }, { 0x09, 0x02 },

    /* 6. Program Decision Tree 2: Apogee Turnover */
    { 0x08, 0x40 }, { 0x09, 0x01 }, /* Tree 2 Enable */
    { 0x08, 0x41 }, { 0x09, 0x12 }, /* Pitch/Yaw angular inversion detection */
    { 0x08, 0x42 }, { 0x09, 0x01 },

    /* 7. Program Decision Tree 3: First / Drogue Chute Verification */
    { 0x08, 0x50 }, { 0x09, 0x01 }, /* Tree 3 Enable */
    { 0x08, 0x51 }, { 0x09, 0x55 }, /* Deceleration shock detection */

    /* 8. Program Decision Tree 4: Main Chute Deployment */
    { 0x08, 0x60 }, { 0x09, 0x01 }, /* Tree 4 Enable */
    { 0x08, 0x61 }, { 0x09, 0x22 }, /* Descent steady-rate velocity change */

    /* 9. Program Decision Tree 5: Touchdown Confirmed */
    { 0x08, 0x70 }, { 0x09, 0x01 }, /* Tree 5 Enable */
    { 0x08, 0x71 }, { 0x09, 0x1F }, /* Low dynamic variance + static 1g */

    /* 10. Program Decision Tree 6: Extreme Tumbling / Abort */
    { 0x08, 0x80 }, { 0x09, 0x01 }, /* Tree 6 Enable */
    { 0x08, 0x81 }, { 0x09, 0x7D }, /* Gyro_Norm > 1000 dps abort trigger */

    /* 11. Program Decision Tree 7: Emergency Chute Trigger */
    { 0x08, 0x90 }, { 0x09, 0x01 }, /* Tree 7 Enable */
    { 0x08, 0x91 }, { 0x09, 0x01 },

    /* 12. Disable Page write mode */
    { 0x17, 0x00 }, /* PAGE_RW: Disable write mode */

    /* 13. Set MLC Execution Rate: 26 Hz (EMB_FUNC_ODR_CFG_C 0x60 = 0x15) */
    { 0x60, 0x15 },

    /* 14. Route MLC Decision Tree interrupts to INT1 (Trees 0, 1, 6, 7) */
    { 0x0D, 0xC3 }, /* MLC_INT1: Trees 0, 1, 6, 7 trigger INT1 */

    /* 15. Enable Machine Learning Core (EMB_FUNC_EN_B 0x05) */
    { 0x05, 0x10 }, /* MLC_EN = 1 */

    /* 16. Initialize MLC Computation Engine (EMB_FUNC_INIT_B 0x67) */
    { 0x67, 0x10 }, /* MLC_INIT = 1 */

    /* 17. Exit Embedded Functions bank to standard registers */
    { 0x01, 0x00 },

    /* 18. Route Embedded Functions to INT1 hardware pad */
    { 0x5E, 0x02 }, /* MD1_CFG: INT1_EMB_FUNC = 1 */
};

#define ISM330DHCX_AVIONICS_MLC_CONFIG_LEN \
    (sizeof(ism330dhcx_avionics_mlc_config) / sizeof(ism330dhcx_ucf_line_t))

#ifdef __cplusplus
}
#endif

#endif /* MLC_AVIONICS_CONFIG_H */
