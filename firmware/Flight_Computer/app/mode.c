#include "mode.h"

#include "flight_state.h"
#include "idle_task.h"
#include "radio_task.h"

#define SNIFF_RX_MS    33u
#define SNIFF_SLEEP_MS 1000u

static flight_state_t s_state = FLIGHT_IDLE;

static void on_radio_command(radio_command_t cmd) {
    if (cmd == RADIO_CMD_ARM) {
        const flight_state_t next =
            flight_state_next(s_state, FLIGHT_EV_ARM);
        if (next == s_state) return;
        s_state = next;
        // ARMED and later: continuous RX so no preamble constraint exists.
        radio_task_start_continuous_rx();
    } else if (cmd == RADIO_CMD_DISARM) {
        const flight_state_t next =
            flight_state_next(s_state, FLIGHT_EV_UNARM);
        if (next == s_state) return;
        s_state = next;
        if (s_state == FLIGHT_IDLE) {
            radio_task_start_sniff(SNIFF_RX_MS, SNIFF_SLEEP_MS);
        }
    }
}

void mode_init(void) {
    radio_task_on_command(on_radio_command);
}

flight_state_t mode_state(void) {
    return s_state;
}
