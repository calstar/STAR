#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "flight_state.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

/* Every (state, event) pair against the drawio diagram. */
static void test_table(void) {
    enum { S = FLIGHT_STATE_COUNT, E = FLIGHT_EVENT_COUNT };
    flight_state_t want[S][E];
    for (int s = 0; s < S; ++s) {
        for (int e = 0; e < E; ++e) {
            want[s][e] = (flight_state_t)s;
        }
    }
    want[FLIGHT_SELF_TEST][FLIGHT_EV_SELF_TEST_DONE] = FLIGHT_IDLE;
    want[FLIGHT_IDLE][FLIGHT_EV_ARM] = FLIGHT_ARMED;
    want[FLIGHT_ARMED][FLIGHT_EV_UNARM] = FLIGHT_IDLE;
    want[FLIGHT_ARMED][FLIGHT_EV_LAUNCH_DETECTED] = FLIGHT_LAUNCHED;
    want[FLIGHT_LAUNCHED][FLIGHT_EV_APOGEE_DETECTED] = FLIGHT_RECOVERY;
    for (int s = 0; s < S; ++s) {
        for (int e = 0; e < E; ++e) {
            CHECK(flight_state_next((flight_state_t)s, (flight_event_t)e) ==
                  want[s][e]);
        }
    }
    CHECK(flight_state_next(FLIGHT_STATE_COUNT, FLIGHT_EV_ARM) ==
          FLIGHT_STATE_COUNT);
    CHECK(flight_state_next(FLIGHT_IDLE, FLIGHT_EVENT_COUNT) == FLIGHT_IDLE);
}

/* At this stage the log starts at ARMED (no launch detection yet). */
static void test_logging_states(void) {
    CHECK(!flight_state_logs_to_emmc(FLIGHT_SELF_TEST));
    CHECK(!flight_state_logs_to_emmc(FLIGHT_IDLE));
    CHECK(flight_state_logs_to_emmc(FLIGHT_ARMED));
    CHECK(flight_state_logs_to_emmc(FLIGHT_LAUNCHED));
    CHECK(flight_state_logs_to_emmc(FLIGHT_RECOVERY));
    CHECK(!flight_state_logs_to_emmc(FLIGHT_STATE_COUNT));
}

static void test_names(void) {
    CHECK(strcmp(flight_state_name(FLIGHT_ARMED), "ARMED") == 0);
    CHECK(strcmp(flight_state_name(FLIGHT_RECOVERY), "RECOVERY") == 0);
    CHECK(strcmp(flight_state_name(FLIGHT_STATE_COUNT), "?") == 0);
}

int main(void) {
    test_table();
    test_logging_states();
    test_names();
    puts("3 flight state test groups passed");
    return 0;
}
