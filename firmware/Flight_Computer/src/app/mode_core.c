#include "mode_core.h"

mode_outputs_t mode_outputs(flight_state_t state) {
    mode_outputs_t o = {false, false, false, false, false};
    switch (state) {
        case FLIGHT_IDLE:
            o.idle_loop = true;
            o.radio_sniff = true; /* ~0.15 mA instead of ~4.6 mA listening */
            break;
        case FLIGHT_ARMED:
        case FLIGHT_LAUNCHED:
        case FLIGHT_RECOVERY:
            o.sensors = true;
            o.gps = true;
            o.ethernet = true;
            break;
        default: /* SELF_TEST, out of range: nothing new started */
            break;
    }
    return o;
}

mode_route_t mode_route_command(flight_state_t state, mode_command_t command,
                                flight_state_t* next) {
    if (state == FLIGHT_IDLE) {
        return MODE_TO_IDLE_LOOP;
    }
    flight_event_t ev =
        command == MODE_CMD_ARM ? FLIGHT_EV_ARM : FLIGHT_EV_UNARM;
    flight_state_t to = flight_state_next(state, ev);
    if (to == state) {
        return MODE_IGNORE;
    }
    if (next) {
        *next = to;
    }
    return MODE_TRANSITION;
}
