#include "idle_mlc.h"

#include "dev_ism330dhcx.h"

bool idle_mlc_wake_enabled(void) {
#if STAR_MLC_IDLE_WAKE
    return true;
#else
    return false;
#endif
}

bool idle_mlc_imu_power_down_allowed(void) {
    return !idle_mlc_wake_enabled();
}

int idle_mlc_maybe_power_down_imu(const dev_bus_t* bus) {
    if (!idle_mlc_imu_power_down_allowed()) {
        /* Keep CTRL1_XL / CTRL2_G / MLC running so INT2 can wake Stop. */
        return DEV_OK;
    }
    return ism330_power_down(bus);
}
