#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "idle.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

/* Counts that convert to an exact-ish voltage: mv * 65535 / 10624. */
static uint32_t counts_for_mv(uint32_t mv) {
    return mv * 65535U / 10624U + 1U;
}

typedef struct {
    self_test_battery_t battery;
    bool usb;
    self_test_reply_t send_reply;
    idle_command_t commands[16];
    unsigned command_count;
    unsigned command_next;
    unsigned battery_calls;
    unsigned send_calls;
    unsigned poll_calls;
    idle_heartbeat_t sent;
    unsigned order[64]; /* 1 = battery, 2 = send, 3 = usb */
    unsigned order_count;
    uint32_t expected_budget;
} fake_t;

static void note(fake_t* f, unsigned what) {
    if (f->order_count < 64) { /* long runs only care about the first calls */
        f->order[f->order_count++] = what;
    }
}

static self_test_battery_t fake_battery(void* context, uint32_t now_ms,
                                        uint32_t budget_ms) {
    fake_t* f = context;
    CHECK(budget_ms == f->expected_budget);
    ++f->battery_calls;
    note(f, 1);
    self_test_battery_t b = f->battery;
    b.sampled_at_ms = now_ms;
    return b;
}

static bool fake_usb(void* context) {
    fake_t* f = context;
    note(f, 3);
    return f->usb;
}

static self_test_reply_t fake_send(void* context, const idle_heartbeat_t* hb,
                                   uint32_t budget_ms) {
    fake_t* f = context;
    CHECK(budget_ms == f->expected_budget);
    ++f->send_calls;
    note(f, 2);
    f->sent = *hb;
    return f->send_reply;
}

static idle_command_t fake_poll(void* context) {
    fake_t* f = context;
    ++f->poll_calls;
    if (f->command_next < f->command_count) {
        return f->commands[f->command_next++];
    }
    return IDLE_CMD_NONE;
}

static const idle_port_t port = {fake_battery, fake_usb, fake_send, fake_poll};

static idle_config_t config(void) {
    return (idle_config_t){.heartbeat_interval_ms = 10000,
                           .wake_tolerance_ms = 500,
                           .callback_budget_ms = 50,
                           .battery_warn_mv = 7000,
                           .battery_fail_mv = 6600,
                           .battery_hysteresis_mv = 100};
}

static void set_mv(fake_t* f, uint32_t mv) {
    f->battery = (self_test_battery_t){.reply = {SELF_TEST_PASS, 0},
                                       .valid = true,
                                       .raw_counts = counts_for_mv(mv)};
}

static void setup(idle_t* idle, fake_t* f, uint32_t now) {
    memset(f, 0, sizeof(*f));
    set_mv(f, 7800);
    f->send_reply.result = SELF_TEST_PASS;
    f->expected_budget = 50;
    idle_config_t c = config();
    CHECK(idle_init(idle, &c, &port, f));
    CHECK(idle_enter(idle, now));
}

static void push_command(fake_t* f, idle_command_t cmd) {
    CHECK(f->command_count < 16);
    f->commands[f->command_count++] = cmd;
}

/* ---------------------------------------------------------------- tests */

static void test_conversion(void) {
    CHECK(idle_counts_to_mv(0) == 0);
    CHECK(idle_counts_to_mv(65535) == 10624);
    CHECK(idle_counts_to_mv(65536) == 0); /* out of 16-bit range */
    /* From DEVICE_CHECKS: counts / 65535 * 3.32 / 0.3125. */
    CHECK(idle_counts_to_mv(40712) == 6600);
    CHECK(idle_counts_to_mv(43180) == 7000);
    /* Full 2S pack, 8.4 V, stays inside the ADC range. */
    CHECK(idle_counts_to_mv(51818) == 8400);
}

static void test_init_rejects_bad_input(void) {
    idle_t idle;
    fake_t f;
    idle_config_t c = config();
    idle_port_t p = port;

    CHECK(!idle_init(NULL, &c, &port, &f));
    CHECK(!idle_init(&idle, NULL, &port, &f));
    CHECK(!idle_init(&idle, &c, NULL, &f));

    p.on_usb_power = NULL; /* USB detection is mandatory, never assumed */
    CHECK(!idle_init(&idle, &c, &p, &f));
    CHECK(idle_on_wake(&idle, 0).event == IDLE_EVENT_ERROR);
    CHECK(idle_last_heartbeat(&idle) == NULL);

    c = config();
    c.battery_fail_mv = 7000; /* fail must be below warn */
    CHECK(!idle_init(&idle, &c, &port, &f));
    c = config();
    c.wake_tolerance_ms = 10000; /* tolerance must be below interval */
    CHECK(!idle_init(&idle, &c, &port, &f));
    c = config();
    c.heartbeat_interval_ms = 999;
    CHECK(!idle_init(&idle, &c, &port, &f));
    c = config();
    c.callback_budget_ms = 0;
    CHECK(!idle_init(&idle, &c, &port, &f));
}

static void test_wake_before_enter_is_error(void) {
    idle_t idle;
    fake_t f;
    memset(&f, 0, sizeof(f));
    f.expected_budget = 50;
    f.send_reply.result = SELF_TEST_PASS;
    idle_config_t c = config();
    CHECK(idle_init(&idle, &c, &port, &f));
    /* Uptime past 2^31 ms: an unset schedule must not mean "sleep for weeks".
     */
    idle_result_t r = idle_on_wake(&idle, 3000000000U);
    CHECK(r.event == IDLE_EVENT_ERROR);
    CHECK(f.send_calls == 0 && f.poll_calls == 0);
    CHECK(idle_enter(&idle, 3000000000U));
    CHECK(idle_on_wake(&idle, 3000000000U).heartbeat_sent);
}

static void test_first_wake_sends_heartbeat(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 5000);
    idle_result_t r = idle_on_wake(&idle, 5000);
    CHECK(r.event == IDLE_EVENT_SLEEP);
    CHECK(r.heartbeat_sent);
    CHECK(r.sleep_s == 10);
    CHECK(f.send_calls == 1);
    CHECK(f.sent.sequence == 1);
    CHECK(f.sent.uptime_ms == 5000);
    CHECK(f.sent.battery == IDLE_BATT_OK);
    CHECK(f.sent.previous_send == SELF_TEST_PENDING);
}

static void test_sixty_seconds_gives_six_heartbeats(void) {
    idle_t idle;
    fake_t f;
    uint32_t now = 0;
    setup(&idle, &f, now);
    for (int i = 0; i < 6; ++i) {
        idle_result_t r = idle_on_wake(&idle, now);
        CHECK(r.event == IDLE_EVENT_SLEEP);
        CHECK(r.heartbeat_sent);
        CHECK(r.sleep_s == 10);
        now += r.sleep_s * 1000U; /* the RTC fires when Idle asked */
    }
    CHECK(now == 60000);
    CHECK(f.send_calls == 6);
    CHECK(f.battery_calls == 6);
    CHECK(f.sent.sequence == 6);
}

static void test_battery_read_before_transmit(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    idle_on_wake(&idle, 0);
    /* battery, then USB check, then send: never sample during TX. */
    CHECK(f.order_count == 3);
    CHECK(f.order[0] == 1);
    CHECK(f.order[1] == 3);
    CHECK(f.order[2] == 2);
}

static void test_thresholds(void) {
    idle_t idle;
    fake_t f;
    uint32_t now = 0;

    setup(&idle, &f, now);
    set_mv(&f, 7200);
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_OK);

    setup(&idle, &f, now);
    set_mv(&f, 6800);
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_WARN);
    CHECK(f.sent.supply_mv >= 6799 && f.sent.supply_mv <= 6801);

    setup(&idle, &f, now);
    set_mv(&f, 6500);
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_FAIL);

    /* Exactly at the warn level is OK; one step under is WARN. */
    setup(&idle, &f, now);
    f.battery.raw_counts = 43180; /* 7000 mV */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_OK);
}

static void test_hysteresis(void) {
    idle_t idle;
    fake_t f;
    uint32_t now = 0;
    setup(&idle, &f, now);

    set_mv(&f, 6950); /* drops below warn: immediate */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_WARN);

    now += 10000;
    set_mv(&f, 7050); /* above warn but inside the band: stays WARN */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_WARN);

    now += 10000;
    set_mv(&f, 6990); /* wobble back down: still WARN, no flip */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_WARN);

    now += 10000;
    set_mv(&f, 7100); /* clears warn + 100 mV: recovers */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_OK);

    now += 10000;
    set_mv(&f, 6500); /* straight to FAIL */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_FAIL);

    now += 10000;
    set_mv(&f, 6650); /* above fail but inside its band: stays FAIL */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_FAIL);

    now += 10000;
    set_mv(&f, 6750); /* clears fail + 100 mV: WARN */
    idle_on_wake(&idle, now);
    CHECK(f.sent.battery == IDLE_BATT_WARN);
}

static void test_usb_is_never_battery_health(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    f.usb = true;
    set_mv(&f, 5000); /* USB-level voltage would read as FAIL if trusted */
    idle_on_wake(&idle, 0);
    CHECK(f.sent.battery == IDLE_BATT_USB);
    CHECK(f.sent.supply_mv >= 4999 && f.sent.supply_mv <= 5001);

    f.usb = true;
    set_mv(&f, 8000); /* and a healthy-looking value is not OK either */
    idle_on_wake(&idle, 10000);
    CHECK(f.sent.battery == IDLE_BATT_USB);
}

static void test_invalid_battery_still_sends(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);

    f.battery.valid = false;
    idle_result_t r = idle_on_wake(&idle, 0);
    CHECK(r.heartbeat_sent);
    CHECK(f.sent.battery == IDLE_BATT_INVALID);
    CHECK(f.sent.supply_mv == 0);

    set_mv(&f, 7500);
    f.battery.reply.result = SELF_TEST_TIMEOUT;
    idle_on_wake(&idle, 10000);
    CHECK(f.sent.battery == IDLE_BATT_INVALID);

    set_mv(&f, 7500);
    f.battery.raw_counts = 70000; /* impossible for a 16-bit ADC */
    idle_on_wake(&idle, 20000);
    CHECK(f.sent.battery == IDLE_BATT_INVALID);
}

static void test_send_failure_counted_and_sleep_continues(void) {
    idle_t idle;
    fake_t f;
    uint32_t now = 0;
    setup(&idle, &f, now);

    f.send_reply.result = SELF_TEST_TIMEOUT; /* no TxDone */
    idle_result_t r = idle_on_wake(&idle, now);
    CHECK(r.event == IDLE_EVENT_SLEEP); /* never stuck awake retrying */
    CHECK(r.sleep_s == 10);
    CHECK(f.send_calls == 1); /* no retry burst */

    now += 10000;
    f.send_reply.result = SELF_TEST_FAIL;
    idle_on_wake(&idle, now);
    CHECK(f.sent.previous_send == SELF_TEST_TIMEOUT);
    CHECK(f.sent.consecutive_send_failures == 1);

    now += 10000;
    f.send_reply.result = SELF_TEST_PASS;
    idle_on_wake(&idle, now);
    CHECK(f.sent.previous_send == SELF_TEST_FAIL);
    CHECK(f.sent.consecutive_send_failures == 2);

    now += 10000;
    idle_on_wake(&idle, now);
    CHECK(f.sent.previous_send == SELF_TEST_PASS);
    CHECK(f.sent.consecutive_send_failures == 0);
}

static void test_arm_requested_without_heartbeat(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    push_command(&f, IDLE_CMD_ARM);
    idle_result_t r = idle_on_wake(&idle, 0); /* heartbeat is also due */
    CHECK(r.event == IDLE_EVENT_ARM_REQUESTED);
    CHECK(!r.heartbeat_sent);
    CHECK(f.send_calls == 0);
    CHECK(f.battery_calls == 0);
}

static void test_disarm_stays_idle(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    idle_on_wake(&idle, 0);
    push_command(&f, IDLE_CMD_DISARM);
    idle_result_t r = idle_on_wake(&idle, 3000); /* radio wake */
    CHECK(r.event == IDLE_EVENT_SLEEP);
    CHECK(!r.heartbeat_sent);
}

static void test_disarm_then_arm_in_one_wake(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    push_command(&f, IDLE_CMD_DISARM);
    push_command(&f, IDLE_CMD_ARM);
    CHECK(idle_on_wake(&idle, 0).event == IDLE_EVENT_ARM_REQUESTED);
}

static void test_command_drain_is_bounded(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    idle_on_wake(&idle, 0);
    for (int i = 0; i < 10; ++i) {
        push_command(&f, IDLE_CMD_DISARM);
    }
    f.poll_calls = 0;
    idle_result_t r = idle_on_wake(&idle, 2000);
    CHECK(r.event == IDLE_EVENT_SLEEP);
    CHECK(f.poll_calls == IDLE_MAX_COMMANDS_PER_WAKE);
}

static void test_radio_wake_does_not_delay_heartbeat(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    idle_on_wake(&idle, 0); /* heartbeat 1, next due at 10000 */

    idle_result_t r = idle_on_wake(&idle, 7300); /* radio wake, no command */
    CHECK(!r.heartbeat_sent);
    CHECK(f.battery_calls == 1); /* no extra battery read */
    CHECK(r.sleep_s == 3);       /* ceil(2700 ms): back on the 10 s grid */

    r = idle_on_wake(&idle, 10000);
    CHECK(r.heartbeat_sent);
    CHECK(f.send_calls == 2);
}

static void test_early_lsi_wake_within_tolerance(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    idle_on_wake(&idle, 0);

    idle_result_t r = idle_on_wake(&idle, 9600); /* LSI ran 4% fast */
    CHECK(r.heartbeat_sent);
    CHECK(r.sleep_s == 10);

    r = idle_on_wake(&idle, 9600 + 9000); /* 1 s early: outside tolerance */
    CHECK(!r.heartbeat_sent);
    CHECK(r.sleep_s == 1);
}

static void test_long_gap_sends_one_heartbeat(void) {
    idle_t idle;
    fake_t f;
    setup(&idle, &f, 0);
    idle_on_wake(&idle, 0);
    idle_result_t r = idle_on_wake(&idle, 95000); /* missed 8 intervals */
    CHECK(r.heartbeat_sent);
    CHECK(f.send_calls == 2); /* no catch-up burst */
    CHECK(r.sleep_s == 10);
}

static void test_clock_and_sequence_wraparound(void) {
    idle_t idle;
    fake_t f;
    uint32_t now = UINT32_MAX - 15000U; /* clock wraps mid-run */
    setup(&idle, &f, now);
    for (int i = 0; i < 4; ++i) {
        idle_result_t r = idle_on_wake(&idle, now);
        CHECK(r.heartbeat_sent);
        CHECK(r.sleep_s == 10);
        now += r.sleep_s * 1000U;
    }
    CHECK(f.send_calls == 4);

    /* Sequence number wraps modulo 2^32. */
    idle.last.sequence = UINT32_MAX;
    idle_on_wake(&idle, now);
    CHECK(f.sent.sequence == 0);
}

static void test_failure_count_saturates(void) {
    idle_t idle;
    fake_t f;
    uint32_t now = 0;
    setup(&idle, &f, now);
    f.send_reply.result = SELF_TEST_FAIL;
    for (int i = 0; i < 300; ++i) {
        idle_on_wake(&idle, now);
        now += 10000;
    }
    CHECK(idle_last_heartbeat(&idle)->consecutive_send_failures == 255);
}

int main(void) {
    test_conversion();
    test_init_rejects_bad_input();
    test_wake_before_enter_is_error();
    test_first_wake_sends_heartbeat();
    test_sixty_seconds_gives_six_heartbeats();
    test_battery_read_before_transmit();
    test_thresholds();
    test_hysteresis();
    test_usb_is_never_battery_health();
    test_invalid_battery_still_sends();
    test_send_failure_counted_and_sleep_continues();
    test_arm_requested_without_heartbeat();
    test_disarm_stays_idle();
    test_disarm_then_arm_in_one_wake();
    test_command_drain_is_bounded();
    test_radio_wake_does_not_delay_heartbeat();
    test_early_lsi_wake_within_tolerance();
    test_long_gap_sends_one_heartbeat();
    test_clock_and_sequence_wraparound();
    test_failure_count_saturates();
    puts("idle tests passed");
    return 0;
}
