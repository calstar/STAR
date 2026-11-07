/* mode_core: what is powered in each state, where commands go. */
#include <stdio.h>
#include <stdlib.h>

#include "mode_core.h"

#define CHECK(c)                                                    \
    do {                                                            \
        if (!(c)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #c); \
            exit(1);                                                \
        }                                                           \
    } while (0)

static void test_idle_keeps_only_the_radio(void) {
    mode_outputs_t o = mode_outputs(FLIGHT_IDLE);
    CHECK(!o.sensors && !o.gps && !o.ethernet);
    CHECK(o.idle_loop);
    CHECK(o.radio_sniff); /* Idle saves power: the radio duty-cycles */
}

static void test_armed_onwards_runs_everything(void) {
    const flight_state_t on[] = {FLIGHT_ARMED, FLIGHT_LAUNCHED,
                                 FLIGHT_RECOVERY};
    for (unsigned i = 0; i < 3; ++i) {
        mode_outputs_t o = mode_outputs(on[i]);
        CHECK(o.sensors && o.gps && o.ethernet && !o.idle_loop);
        CHECK(!o.radio_sniff); /* armed: listen all the time */
    }
    mode_outputs_t s = mode_outputs(FLIGHT_SELF_TEST);
    CHECK(!s.sensors && !s.idle_loop && !s.radio_sniff);
    mode_outputs_t bad = mode_outputs(FLIGHT_STATE_COUNT);
    CHECK(!bad.sensors && !bad.gps && !bad.idle_loop);
}

static void test_commands(void) {
    flight_state_t next = FLIGHT_STATE_COUNT;
    /* In Idle the Idle loop (PR #162) owns Arm. */
    CHECK(mode_route_command(FLIGHT_IDLE, MODE_CMD_ARM, &next) ==
          MODE_TO_IDLE_LOOP);
    /* Armed: Un-arm goes back to Idle; a second Arm is ignored. */
    CHECK(mode_route_command(FLIGHT_ARMED, MODE_CMD_DISARM, &next) ==
          MODE_TRANSITION);
    CHECK(next == FLIGHT_IDLE);
    CHECK(mode_route_command(FLIGHT_ARMED, MODE_CMD_ARM, &next) == MODE_IGNORE);
    /* After launch an Un-arm is ignored (flight_state table). */
    CHECK(mode_route_command(FLIGHT_LAUNCHED, MODE_CMD_DISARM, &next) ==
          MODE_IGNORE);
}

int main(void) {
    test_idle_keeps_only_the_radio();
    test_armed_onwards_runs_everything();
    test_commands();
    puts("mode_core: all tests passed");
    return 0;
}
