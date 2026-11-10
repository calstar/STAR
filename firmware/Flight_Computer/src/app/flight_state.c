#include "flight_state.h"

flight_state_t flight_state_next(flight_state_t state, flight_event_t event) {
    switch (state) {
        case FLIGHT_SELF_TEST:
            return event == FLIGHT_EV_SELF_TEST_DONE ? FLIGHT_IDLE : state;
        case FLIGHT_IDLE:
            return event == FLIGHT_EV_ARM ? FLIGHT_ARMED : state;
        case FLIGHT_ARMED:
            if (event == FLIGHT_EV_UNARM) {
                return FLIGHT_IDLE;
            }
            return event == FLIGHT_EV_LAUNCH_DETECTED ? FLIGHT_LAUNCHED : state;
        case FLIGHT_LAUNCHED:
            return event == FLIGHT_EV_APOGEE_DETECTED ? FLIGHT_RECOVERY : state;
        case FLIGHT_RECOVERY:
        default:
            return state;
    }
}

bool flight_state_logs_to_emmc(flight_state_t state) {
    return state == FLIGHT_ARMED || state == FLIGHT_LAUNCHED ||
           state == FLIGHT_RECOVERY;
}

const char* flight_state_name(flight_state_t state) {
    switch (state) {
        case FLIGHT_SELF_TEST:
            return "SELF_TEST";
        case FLIGHT_IDLE:
            return "IDLE";
        case FLIGHT_ARMED:
            return "ARMED";
        case FLIGHT_LAUNCHED:
            return "LAUNCHED";
        case FLIGHT_RECOVERY:
            return "RECOVERY";
        default:
            return "?";
    }
}
