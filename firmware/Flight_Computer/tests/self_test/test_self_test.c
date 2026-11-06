#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "self_test.h"

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #condition); \
            exit(1);                                                        \
        }                                                                   \
    } while (0)

typedef struct {
    self_test_reply_t replies[SELF_TEST_MAX_DEVICES];
    unsigned calls[SELF_TEST_MAX_DEVICES];
    uint8_t attempts[SELF_TEST_MAX_DEVICES];
    uint16_t call_order[64];
    unsigned total_probes;
    unsigned battery_calls;
    unsigned publication_calls;
    self_test_battery_t battery;
    self_test_reply_t publication;
    self_test_status_t sent;
    bool fresh_battery;
    uint32_t expected_budget;
    uint32_t last_probe_budget;
} fake_t;

static self_test_reply_t probe(void* context, uint16_t id, uint8_t attempt,
                               uint32_t now_ms, uint32_t budget_ms) {
    fake_t* f = context;
    (void)now_ms;
    CHECK(id >= 10 && id < 10 + SELF_TEST_MAX_DEVICES);
    CHECK(budget_ms > 0 && budget_ms <= f->expected_budget);
    f->last_probe_budget = budget_ms;
    CHECK(f->total_probes < 64);
    f->call_order[f->total_probes++] = id;
    ++f->calls[id - 10];
    f->attempts[id - 10] = attempt;
    return f->replies[id - 10];
}

static self_test_battery_t battery(void* context, uint32_t now_ms,
                                   uint32_t budget_ms) {
    fake_t* f = context;
    CHECK(budget_ms == f->expected_budget);
    ++f->battery_calls;
    self_test_battery_t result = f->battery;
    if (f->fresh_battery) {
        result.sampled_at_ms = now_ms;
    }
    return result;
}

static self_test_reply_t publish_status(void* context,
                                        const self_test_status_t* status,
                                        uint32_t budget_ms) {
    fake_t* f = context;
    CHECK(budget_ms == f->expected_budget);
    ++f->publication_calls;
    f->sent = *status;
    return f->publication;
}

static const self_test_port_t port = {probe, battery, publish_status};

static self_test_config_t config(void) {
    return (self_test_config_t){.device_count = 2,
                                .devices = {{10, true}, {11, true}},
                                .probe_timeout_ms = 100,
                                .retry_interval_ms = 20,
                                .heartbeat_interval_ms = 1000,
                                .battery_interval_ms = 200,
                                .battery_max_age_ms = 300,
                                .callback_budget_ms = 1,
                                .tick_budget_ms = 3,
                                .probe_max_attempts = 2,
                                .publication_max_attempts = 2};
}

static void setup(self_test_t* t, fake_t* f, const self_test_config_t* c,
                  uint32_t now) {
    memset(f, 0, sizeof(*f));
    for (unsigned i = 0; i < SELF_TEST_MAX_DEVICES; ++i) {
        f->replies[i].result = SELF_TEST_PASS;
    }
    f->battery = (self_test_battery_t){
        .reply = {SELF_TEST_PASS, 0}, .valid = true, .raw_counts = 32768};
    f->fresh_battery = true;
    f->publication.result = SELF_TEST_PASS;
    f->expected_budget = c->callback_budget_ms;
    CHECK(self_test_init(t, c, &port, f, now));
}

static void test_pass_and_inventory(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    setup(&t, &f, &c, 0);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PENDING);
    CHECK(!self_test_status(&t)->battery.valid);
    self_test_tick(&t, 0);
    CHECK(f.total_probes == 1 && f.call_order[0] == 10);
    CHECK(f.sent.probes_outcome == SELF_TEST_PENDING);
    self_test_tick(&t, 1);
    CHECK(f.total_probes == 2 && f.call_order[1] == 11);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PASS);
    CHECK(f.calls[2] == 0 && f.attempts[0] == 1);
    self_test_tick(&t, 1000);
    CHECK(f.total_probes == 2);
    CHECK(f.sent.probes_outcome == SELF_TEST_PASS);
    CHECK(f.sent.devices[0].device_id == 10 && f.sent.devices[0].complete);
    CHECK(f.sent.battery.valid && f.sent.battery.raw_counts == 32768);
}

static void test_terminal_results(void) {
    const self_test_result_t results[] = {SELF_TEST_FAIL, SELF_TEST_TIMEOUT,
                                          SELF_TEST_NOT_CONFIGURED,
                                          SELF_TEST_NOT_IMPLEMENTED};
    for (unsigned i = 0; i < sizeof(results) / sizeof(results[0]); ++i) {
        self_test_t t = {0};
        fake_t f;
        self_test_config_t c = config();
        c.probe_max_attempts = 1;
        setup(&t, &f, &c, 0);
        f.replies[0] = (self_test_reply_t){results[i], 42};
        self_test_tick(&t, 0);
        self_test_tick(&t, 1);
        self_test_tick(&t, 1000);
        CHECK(f.sent.probes_outcome == SELF_TEST_FAIL);
        CHECK(f.sent.devices[0].reply.result == results[i]);
        CHECK(f.sent.devices[0].reply.diagnostic == 42);
        CHECK(f.sent.devices[1].reply.result == SELF_TEST_PASS);
        CHECK(f.calls[0] == 1 && f.calls[1] == 1);
        CHECK(f.publication_calls == 2);
    }
}

static void test_pending_timeout_and_fairness(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.heartbeat_interval_ms = 50;
    c.probe_max_attempts = 1;
    setup(&t, &f, &c, 0);
    f.replies[0] = (self_test_reply_t){SELF_TEST_PENDING, 77};
    self_test_tick(&t, 0);
    self_test_tick(&t, 1);
    CHECK(f.calls[1] == 1);
    self_test_tick(&t, 50);
    CHECK(f.publication_calls == 2);
    self_test_tick(&t, 99);
    CHECK(self_test_status(&t)->devices[0].reply.result == SELF_TEST_PENDING);
    unsigned calls = f.calls[0];
    self_test_tick(&t, 100);
    CHECK(f.calls[0] == calls);
    CHECK(self_test_status(&t)->devices[0].reply.result == SELF_TEST_TIMEOUT);
    CHECK(self_test_status(&t)->devices[0].reply.diagnostic == 77);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_FAIL);
    CHECK(f.publication_calls == 3);
}

static void test_probe_retry_bounds_and_recovery(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.device_count = 1;
    setup(&t, &f, &c, 0);
    f.replies[0].result = SELF_TEST_FAIL;
    self_test_tick(&t, 0);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PENDING);
    self_test_tick(&t, 19);
    CHECK(f.calls[0] == 1);
    self_test_tick(&t, 20);
    CHECK(f.calls[0] == 2 && f.attempts[0] == 2);
    self_test_tick(&t, 1000);
    CHECK(f.calls[0] == 2);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_FAIL);
    CHECK(self_test_reset(&t, 1001));
    self_test_tick(&t, 1001);
    f.replies[0].result = SELF_TEST_PASS;
    self_test_tick(&t, 1021);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PASS);
    CHECK(f.attempts[0] == 2);
}

static void test_timeout_retry(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.device_count = 1;
    setup(&t, &f, &c, 0);
    f.replies[0].result = SELF_TEST_PENDING;
    self_test_tick(&t, 0);
    self_test_tick(&t, 100);
    self_test_tick(&t, 119);
    CHECK(f.calls[0] == 1);
    self_test_tick(&t, 120);
    CHECK(f.attempts[0] == 2);
    self_test_tick(&t, 220);
    CHECK(self_test_status(&t)->devices[0].complete);
    CHECK(self_test_status(&t)->devices[0].reply.result == SELF_TEST_TIMEOUT);
    self_test_tick(&t, 1000);
    CHECK(f.calls[0] == 2);
}

static void test_heartbeat_boundaries_and_gap(void) {
    const uint32_t intervals[] = {500, 1000};
    for (unsigned i = 0; i < 2; ++i) {
        self_test_t t = {0};
        fake_t f;
        self_test_config_t c = config();
        c.heartbeat_interval_ms = intervals[i];
        setup(&t, &f, &c, 5);
        CHECK(f.publication_calls == 0);
        self_test_tick(&t, 10);
        CHECK(f.publication_calls == 1);
        self_test_tick(&t, 10 + intervals[i] - 1);
        CHECK(f.publication_calls == 1);
        self_test_tick(&t, 10 + intervals[i]);
        CHECK(f.publication_calls == 2);
        self_test_tick(&t, 11 + intervals[i]);
        CHECK(f.publication_calls == 2);
        self_test_tick(&t, 100000);
        CHECK(f.publication_calls == 3);
        self_test_tick(&t, 100000);
        CHECK(f.publication_calls == 3);
        self_test_tick(&t, 100000 + intervals[i]);
        CHECK(f.publication_calls == 4);
    }
}

static void test_wraparound(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.device_count = 1;
    c.battery_interval_ms = 2000;
    uint32_t start = UINT32_MAX - 50U;
    setup(&t, &f, &c, start);
    f.replies[0].result = SELF_TEST_PENDING;
    self_test_tick(&t, start);
    self_test_tick(&t, start + 99U);
    CHECK(self_test_status(&t)->devices[0].reply.result == SELF_TEST_PENDING);
    self_test_tick(&t, start + 100U);
    CHECK(self_test_status(&t)->devices[0].reply.result == SELF_TEST_TIMEOUT);
    f.replies[0].result = SELF_TEST_PASS;
    self_test_tick(&t, start + 120U);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PASS);
    self_test_tick(&t, start + 299U);
    CHECK(self_test_status(&t)->battery.valid);
    self_test_tick(&t, start + 300U);
    CHECK(!self_test_status(&t)->battery.valid);
    self_test_tick(&t, start + 999U);
    CHECK(f.publication_calls == 1);
    self_test_tick(&t, start + 1000U);
    CHECK(f.publication_calls == 2);
}

static void test_battery_validity(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.battery_interval_ms = 1000;
    setup(&t, &f, &c, 0);
    f.battery.raw_counts = 0;
    self_test_tick(&t, 0);
    CHECK(self_test_status(&t)->battery.valid);
    self_test_tick(&t, 299);
    CHECK(self_test_status(&t)->battery.valid);
    self_test_tick(&t, 300);
    CHECK(!self_test_status(&t)->battery.valid);
    CHECK(self_test_status(&t)->battery.reply.diagnostic ==
          SELF_TEST_DIAG_STALE_BATTERY);
    f.battery.raw_counts = 65535;
    self_test_tick(&t, 1000);
    CHECK(f.sent.battery.valid && f.sent.battery.raw_counts == 65535);
    f.battery.reply = (self_test_reply_t){SELF_TEST_FAIL, 45};
    self_test_tick(&t, 2000);
    CHECK(!f.sent.battery.valid && f.sent.battery.raw_counts == 0);
    CHECK(f.sent.battery.reply.diagnostic == 45);
    f.battery.reply.result = SELF_TEST_PASS;
    f.fresh_battery = false;
    f.battery.sampled_at_ms = 2999;
    self_test_tick(&t, 4000);
    CHECK(!f.sent.battery.valid);
    f.battery.sampled_at_ms = 5001;
    self_test_tick(&t, 5000);
    CHECK(!f.sent.battery.valid);
    f.fresh_battery = true;
    f.battery.valid = false;
    self_test_tick(&t, 6000);
    CHECK(f.sent.battery.reply.diagnostic == SELF_TEST_DIAG_BAD_REPLY);
    f.battery.valid = true;
    self_test_tick(&t, 7000);
    CHECK(f.sent.battery.valid);
}

static void test_publication_retry_and_recovery(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    setup(&t, &f, &c, 0);
    f.publication = (self_test_reply_t){SELF_TEST_FAIL, 81};
    self_test_tick(&t, 0);
    self_test_tick(&t, 19);
    CHECK(f.publication_calls == 1);
    CHECK(self_test_status(&t)->publication.diagnostic == 81);
    self_test_tick(&t, 20);
    CHECK(f.publication_calls == 2);
    CHECK(f.sent.publication.result == SELF_TEST_FAIL);
    CHECK(f.sent.probes_outcome == SELF_TEST_PASS);
    self_test_tick(&t, 999);
    CHECK(f.publication_calls == 2);
    f.publication.result = SELF_TEST_PASS;
    self_test_tick(&t, 1000);
    CHECK(f.publication_calls == 3);
    CHECK(self_test_status(&t)->publication.result == SELF_TEST_PASS);
    CHECK(self_test_status(&t)->publication_attempts == 1);
    f.publication.result = SELF_TEST_PENDING;
    self_test_tick(&t, 2000);
    CHECK(self_test_status(&t)->publication.result == SELF_TEST_PENDING);
    self_test_tick(&t, 2020);
    CHECK(self_test_status(&t)->publication.result == SELF_TEST_TIMEOUT);
    self_test_tick(&t, 2040);
    CHECK(f.publication_calls == 5);
}

static void test_missing_and_optional(void) {
    self_test_t t = {0};
    self_test_config_t c = config();
    self_test_port_t empty = {0};
    CHECK(self_test_init(&t, &c, &empty, NULL, 0));
    self_test_tick(&t, 0);
    CHECK(self_test_status(&t)->devices[0].reply.result ==
          SELF_TEST_NOT_IMPLEMENTED);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_FAIL);
    CHECK(!self_test_status(&t)->battery.valid);
    CHECK(self_test_status(&t)->publication.result ==
          SELF_TEST_NOT_IMPLEMENTED);
    c.device_count = 0;
    CHECK(self_test_init(&t, &c, &empty, NULL, 0));
    self_test_tick(&t, 0);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_NOT_CONFIGURED);
    fake_t f;
    c = config();
    c.devices[0].required = false;
    setup(&t, &f, &c, 0);
    f.replies[0].result = SELF_TEST_NOT_CONFIGURED;
    self_test_tick(&t, 0);
    self_test_tick(&t, 1);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PASS);
    CHECK(self_test_status(&t)->devices[0].reply.result ==
          SELF_TEST_NOT_CONFIGURED);
    c.devices[1].required = false;
    setup(&t, &f, &c, 0);
    self_test_tick(&t, 0);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_NOT_CONFIGURED);
}

static void test_reset_and_copied_dependencies(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    setup(&t, &f, &c, 0);
    self_test_tick(&t, 0);
    self_test_tick(&t, 1);
    c.device_count = 0;
    CHECK(self_test_reset(&t, 10));
    CHECK(self_test_status(&t)->device_count == 2);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PENDING);
    CHECK(!self_test_status(&t)->battery.valid);
    CHECK(self_test_status(&t)->publication_attempts == 0);
    self_test_tick(&t, 10);
    CHECK(f.calls[0] == 2 && f.attempts[0] == 1);
    CHECK(f.publication_calls == 2 && f.battery_calls == 2);
    self_test_port_t copy = port;
    c = config();
    CHECK(self_test_init(&t, &c, &copy, &f, 20));
    copy.probe = NULL;
    self_test_tick(&t, 20);
    CHECK(f.calls[0] == 3);
}

static void test_invalid_inputs(void) {
    self_test_t t = {0};
    self_test_config_t c = config();
    self_test_tick(NULL, 0);
    self_test_tick(&t, 0);
    CHECK(!self_test_status(&t) && !self_test_status(NULL));
    CHECK(!self_test_reset(&t, 0) && !self_test_reset(NULL, 0));
    CHECK(!self_test_init(NULL, &c, &port, NULL, 0));
    CHECK(!self_test_init(&t, NULL, &port, NULL, 0));
    CHECK(!self_test_init(&t, &c, NULL, NULL, 0));
    for (unsigned i = 0; i < 13; ++i) {
        c = config();
        switch (i) {
            case 0:
                c.device_count = SELF_TEST_MAX_DEVICES + 1;
                break;
            case 1:
                c.devices[1].device_id = c.devices[0].device_id;
                break;
            case 2:
                c.probe_timeout_ms = 0;
                break;
            case 3:
                c.retry_interval_ms = 0;
                break;
            case 4:
                c.heartbeat_interval_ms = UINT32_MAX;
                break;
            case 5:
                c.battery_interval_ms = 0;
                break;
            case 6:
                c.battery_max_age_ms = 0;
                break;
            case 7:
                c.callback_budget_ms = 0;
                break;
            case 8:
                c.tick_budget_ms = 2;
                break;
            case 9:
                c.probe_max_attempts = 0;
                break;
            case 10:
                c.publication_max_attempts = 0;
                break;
            case 12:
                c.session_timeout_ms = 30000;
                break;
            case 11:
                c.callback_budget_ms = UINT32_MAX;
                break;
        }
        CHECK(!self_test_init(&t, &c, &port, NULL, 0));
        self_test_tick(&t, 0);
        CHECK(!self_test_status(&t));
    }
}

static void test_malformed_driver_results(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.probe_max_attempts = 1;
    setup(&t, &f, &c, 0);
    f.replies[0].result = (self_test_result_t)99;
    f.battery.reply.result = (self_test_result_t)99;
    f.publication.result = (self_test_result_t)99;
    self_test_tick(&t, 0);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_FAIL);
    CHECK(self_test_status(&t)->devices[0].reply.diagnostic ==
          SELF_TEST_DIAG_BAD_REPLY);
    CHECK(!self_test_status(&t)->battery.valid);
    CHECK(self_test_status(&t)->publication.result == SELF_TEST_FAIL);
    CHECK(self_test_status(&t)->publication.diagnostic ==
          SELF_TEST_DIAG_BAD_REPLY);
}

static void test_full_inventory_budget(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.device_count = SELF_TEST_MAX_DEVICES;
    for (uint8_t i = 0; i < c.device_count; ++i) {
        c.devices[i] = (self_test_device_t){(uint16_t)(10 + i), true};
    }
    setup(&t, &f, &c, 0);
    for (uint8_t i = 0; i < c.device_count; ++i) {
        unsigned before =
            f.total_probes + f.battery_calls + f.publication_calls;
        self_test_tick(&t, i);
        CHECK(f.total_probes + f.battery_calls + f.publication_calls - before <=
              3);
        CHECK(f.call_order[i] == 10 + i);
    }
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PASS);
}

static void test_session_deadline(void) {
    const uint32_t starts[] = {0, UINT32_MAX - 20U};
    for (unsigned n = 0; n < 2; ++n) {
        self_test_t t = {0};
        fake_t f;
        self_test_config_t c = config();
        c.session_timeout_ms = 50;
        c.callback_budget_ms = 7;
        c.tick_budget_ms = 21;
        c.devices[1].required = false;
        uint32_t start = starts[n];
        setup(&t, &f, &c, start);
        f.replies[1].result = SELF_TEST_PENDING;
        self_test_tick(&t, start);
        CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_PASS);
        CHECK(!self_test_status(&t)->probes_complete);
        self_test_tick(&t, start + 49U);
        CHECK(f.last_probe_budget == 1);
        CHECK(!self_test_status(&t)->deadline_expired);
        unsigned calls = f.total_probes;
        self_test_tick(&t, start + 50U);
        const self_test_status_t* status = self_test_status(&t);
        CHECK(status->probes_complete && status->deadline_expired);
        CHECK(status->devices[0].reply.result == SELF_TEST_PASS);
        CHECK(status->devices[1].reply.result == SELF_TEST_TIMEOUT);
        CHECK(status->devices[1].reply.diagnostic ==
              SELF_TEST_DIAG_SESSION_TIMEOUT);
        CHECK(status->devices[1].attempts == 1);
        CHECK(status->probes_outcome == SELF_TEST_PASS);
        self_test_tick(&t, start + 1000U);
        CHECK(f.total_probes == calls);
        CHECK(f.sent.probes_complete && f.sent.deadline_expired);
        CHECK(self_test_reset(&t, start + 1001U));
        CHECK(!self_test_status(&t)->probes_complete);
        CHECK(!self_test_status(&t)->deadline_expired);
        f.replies[1].result = SELF_TEST_PASS;
        self_test_tick(&t, start + 1001U);
        self_test_tick(&t, start + 1002U);
        CHECK(self_test_status(&t)->probes_complete);
        self_test_tick(&t, start + 2000U);
        CHECK(!self_test_status(&t)->deadline_expired);
    }
}

static void test_deadline_retry_and_unstarted(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.session_timeout_ms = 20;
    c.probe_max_attempts = 3;
    setup(&t, &f, &c, 0);
    f.replies[0].result = SELF_TEST_FAIL;
    self_test_tick(&t, 0);
    CHECK(!self_test_status(&t)->probes_complete);
    self_test_tick(&t, 20);
    CHECK(f.total_probes == 1);
    CHECK(self_test_status(&t)->probes_complete);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_FAIL);
    CHECK(self_test_status(&t)->devices[0].reply.result == SELF_TEST_TIMEOUT);
    CHECK(self_test_status(&t)->devices[1].reply.result == SELF_TEST_TIMEOUT);
    CHECK(self_test_status(&t)->devices[1].attempts == 0);
    c.session_timeout_ms = 0;
    setup(&t, &f, &c, 0);
    self_test_tick(&t, 29000);
    CHECK(f.total_probes == 0);
    CHECK(self_test_status(&t)->probes_complete);
    CHECK(self_test_status(&t)->deadline_expired);
    c.device_count = 0;
    setup(&t, &f, &c, 0);
    CHECK(self_test_status(&t)->probes_complete);
    self_test_tick(&t, 29000);
    CHECK(!self_test_status(&t)->deadline_expired);
}

static void test_failure_completes_after_three_attempts(void) {
    self_test_t t = {0};
    fake_t f;
    self_test_config_t c = config();
    c.device_count = 1;
    c.probe_max_attempts = 3;
    setup(&t, &f, &c, 0);
    f.replies[0].result = SELF_TEST_FAIL;
    self_test_tick(&t, 0);
    self_test_tick(&t, 20);
    CHECK(!self_test_status(&t)->probes_complete);
    self_test_tick(&t, 40);
    CHECK(self_test_status(&t)->probes_complete);
    CHECK(self_test_status(&t)->probes_outcome == SELF_TEST_FAIL);
    CHECK(!self_test_status(&t)->deadline_expired);
    CHECK(f.attempts[0] == 3);
}

int main(void) {
    test_pass_and_inventory();
    test_terminal_results();
    test_pending_timeout_and_fairness();
    test_probe_retry_bounds_and_recovery();
    test_timeout_retry();
    test_heartbeat_boundaries_and_gap();
    test_wraparound();
    test_battery_validity();
    test_publication_retry_and_recovery();
    test_missing_and_optional();
    test_reset_and_copied_dependencies();
    test_invalid_inputs();
    test_malformed_driver_results();
    test_full_inventory_budget();
    test_session_deadline();
    test_deadline_retry_and_unstarted();
    test_failure_completes_after_three_attempts();
    puts("17 self-test test groups passed");
    return 0;
}
