#include "self_test.h"

#include <stddef.h>
#include <string.h>

static bool interval_valid(uint32_t interval) {
    return interval > 0U && interval <= INT32_MAX;
}

static bool elapsed(uint32_t now, uint32_t then, uint32_t interval) {
    return (uint32_t)(now - then) >= interval;
}

static self_test_reply_t checked_reply(self_test_reply_t reply) {
    if (reply.result < SELF_TEST_PENDING ||
        reply.result > SELF_TEST_NOT_IMPLEMENTED) {
        return (self_test_reply_t){SELF_TEST_FAIL, SELF_TEST_DIAG_BAD_REPLY};
    }
    return reply;
}

static bool config_valid(const self_test_config_t* c) {
    if (!c || c->device_count > SELF_TEST_MAX_DEVICES ||
        !interval_valid(c->probe_timeout_ms) ||
        !interval_valid(c->retry_interval_ms) ||
        !interval_valid(c->heartbeat_interval_ms) ||
        !interval_valid(c->battery_interval_ms) ||
        !interval_valid(c->battery_max_age_ms) ||
        !interval_valid(c->callback_budget_ms) ||
        !interval_valid(c->tick_budget_ms) ||
        c->callback_budget_ms > c->tick_budget_ms / 3U ||
        c->probe_max_attempts == 0U || c->publication_max_attempts == 0U ||
        c->session_timeout_ms > SELF_TEST_DEFAULT_SESSION_TIMEOUT_MS) {
        return false;
    }
    for (uint8_t i = 0; i < c->device_count; ++i) {
        for (uint8_t j = 0; j < i; ++j) {
            if (c->devices[i].device_id == c->devices[j].device_id) {
                return false;
            }
        }
    }
    return true;
}

static void aggregate(self_test_t* t) {
    t->status.probes_complete = true;
    for (uint8_t i = 0; i < t->config.device_count; ++i) {
        if (!t->status.devices[i].complete) {
            t->status.probes_complete = false;
        }
    }
    bool required = false;
    bool pending = false;
    t->status.probes_outcome = SELF_TEST_NOT_CONFIGURED;
    for (uint8_t i = 0; i < t->config.device_count; ++i) {
        const self_test_device_status_t* d = &t->status.devices[i];
        if (!d->required) {
            continue;
        }
        required = true;
        if (!d->complete) {
            pending = true;
        } else if (d->reply.result != SELF_TEST_PASS) {
            t->status.probes_outcome = SELF_TEST_FAIL;
            return;
        }
    }
    if (required) {
        t->status.probes_outcome = pending ? SELF_TEST_PENDING : SELF_TEST_PASS;
    }
}

bool self_test_reset(self_test_t* t, uint32_t now_ms) {
    if (!t || !t->initialized) {
        return false;
    }
    memset(&t->status, 0, sizeof(t->status));
    memset(t->probes, 0, sizeof(t->probes));
    t->status.now_ms = now_ms;
    t->status.device_count = t->config.device_count;
    for (uint8_t i = 0; i < t->config.device_count; ++i) {
        t->status.devices[i].device_id = t->config.devices[i].device_id;
        t->status.devices[i].required = t->config.devices[i].required;
    }
    t->session_started_ms = now_ms;
    t->next_probe = 0;
    t->last_heartbeat_ms = now_ms;
    t->last_battery_ms = now_ms;
    t->last_publication_ms = now_ms;
    t->heartbeat_started = false;
    t->battery_started = false;
    t->publication_retry = false;
    aggregate(t);
    return true;
}

bool self_test_init(self_test_t* t, const self_test_config_t* config,
                    const self_test_port_t* port, void* context,
                    uint32_t now_ms) {
    if (!t) {
        return false;
    }
    memset(t, 0, sizeof(*t));
    if (!port || !config_valid(config)) {
        return false;
    }
    t->config = *config;
    if (t->config.session_timeout_ms == 0U) {
        t->config.session_timeout_ms = SELF_TEST_DEFAULT_SESSION_TIMEOUT_MS;
    }
    t->port = *port;
    t->context = context;
    t->initialized = true;
    return self_test_reset(t, now_ms);
}

static void finish_probe(self_test_t* t, uint8_t index, uint32_t now_ms) {
    self_test_device_status_t* d = &t->status.devices[index];
    self_test_probe_state_t* p = &t->probes[index];
    if ((d->reply.result == SELF_TEST_FAIL ||
         d->reply.result == SELF_TEST_TIMEOUT) &&
        d->attempts < t->config.probe_max_attempts) {
        p->retry_wait = true;
        p->retry_at_ms = now_ms;
    } else {
        d->complete = true;
    }
}

static void probe_one(self_test_t* t, uint32_t now_ms) {
    for (uint8_t n = 0; n < t->config.device_count; ++n) {
        uint8_t i = t->next_probe;
        t->next_probe = (uint8_t)((i + 1U) % t->config.device_count);
        self_test_device_status_t* d = &t->status.devices[i];
        self_test_probe_state_t* p = &t->probes[i];
        if (d->complete) {
            continue;
        }
        if (p->retry_wait) {
            if (!elapsed(now_ms, p->retry_at_ms, t->config.retry_interval_ms)) {
                continue;
            }
            p->retry_wait = false;
            p->started = false;
        }
        if (!p->started) {
            p->started = true;
            p->started_at_ms = now_ms;
            ++d->attempts;
        } else if (elapsed(now_ms, p->started_at_ms,
                           t->config.probe_timeout_ms)) {
            d->reply.result = SELF_TEST_TIMEOUT;
            finish_probe(t, i, now_ms);
            return;
        }
        if (t->port.probe) {
            uint32_t remaining = t->config.probe_timeout_ms -
                                 (uint32_t)(now_ms - p->started_at_ms);
            uint32_t session_remaining =
                t->config.session_timeout_ms -
                (uint32_t)(now_ms - t->session_started_ms);
            if (session_remaining < remaining) {
                remaining = session_remaining;
            }
            uint32_t budget = t->config.callback_budget_ms;
            if (remaining < budget) {
                budget = remaining;
            }
            d->reply = checked_reply(t->port.probe(
                t->context, d->device_id, d->attempts, now_ms, budget));
        } else {
            d->reply = (self_test_reply_t){SELF_TEST_NOT_IMPLEMENTED, 0};
        }
        if (d->reply.result != SELF_TEST_PENDING) {
            finish_probe(t, i, now_ms);
        }
        return;
    }
}

static void sample_battery(self_test_t* t, uint32_t now_ms) {
    if (!t->battery_started ||
        elapsed(now_ms, t->last_battery_ms, t->config.battery_interval_ms)) {
        t->battery_started = true;
        t->last_battery_ms = now_ms;
        if (t->port.read_battery) {
            t->status.battery = t->port.read_battery(
                t->context, now_ms, t->config.callback_budget_ms);
            t->status.battery.reply = checked_reply(t->status.battery.reply);
            if (t->status.battery.reply.result == SELF_TEST_PASS &&
                !t->status.battery.valid) {
                t->status.battery.reply = (self_test_reply_t){
                    SELF_TEST_FAIL, SELF_TEST_DIAG_BAD_REPLY};
            }
        } else {
            t->status.battery =
                (self_test_battery_t){.reply = {SELF_TEST_NOT_IMPLEMENTED, 0}};
        }
        t->status.battery.valid =
            t->status.battery.valid &&
            t->status.battery.reply.result == SELF_TEST_PASS;
    }
    if (t->status.battery.valid &&
        elapsed(now_ms, t->status.battery.sampled_at_ms,
                t->config.battery_max_age_ms)) {
        t->status.battery.valid = false;
        t->status.battery.reply = (self_test_reply_t){
            SELF_TEST_TIMEOUT, SELF_TEST_DIAG_STALE_BATTERY};
    }
    if (!t->status.battery.valid) {
        t->status.battery.raw_counts = 0;
    }
}

static void publish(self_test_t* t, uint32_t now_ms) {
    if (!t->heartbeat_started || elapsed(now_ms, t->last_heartbeat_ms,
                                         t->config.heartbeat_interval_ms)) {
        t->heartbeat_started = true;
        t->last_heartbeat_ms = now_ms;
        t->status.publication_attempts = 0;
        t->publication_retry = true;
    } else if (!t->publication_retry || !elapsed(now_ms, t->last_publication_ms,
                                                 t->config.retry_interval_ms)) {
        return;
    }
    t->last_publication_ms = now_ms;
    ++t->status.publication_attempts;
    t->status.publication =
        t->port.publish_status
            ? checked_reply(t->port.publish_status(
                  t->context, &t->status, t->config.callback_budget_ms))
            : (self_test_reply_t){SELF_TEST_NOT_IMPLEMENTED, 0};
    self_test_result_t result = t->status.publication.result;
    t->publication_retry =
        (result == SELF_TEST_PENDING || result == SELF_TEST_FAIL ||
         result == SELF_TEST_TIMEOUT) &&
        t->status.publication_attempts < t->config.publication_max_attempts;
    if (result == SELF_TEST_PENDING && !t->publication_retry) {
        t->status.publication.result = SELF_TEST_TIMEOUT;
    }
}

void self_test_tick(self_test_t* t, uint32_t now_ms) {
    if (!t || !t->initialized) {
        return;
    }
    t->status.now_ms = now_ms;
    if (!t->status.probes_complete) {
        if (elapsed(now_ms, t->session_started_ms,
                    t->config.session_timeout_ms)) {
            t->status.deadline_expired = true;
            for (uint8_t i = 0; i < t->config.device_count; ++i) {
                self_test_device_status_t* d = &t->status.devices[i];
                if (!d->complete) {
                    d->reply = (self_test_reply_t){
                        SELF_TEST_TIMEOUT, SELF_TEST_DIAG_SESSION_TIMEOUT};
                    d->complete = true;
                }
            }
        } else {
            probe_one(t, now_ms);
        }
    }
    aggregate(t);
    sample_battery(t, now_ms);
    publish(t, now_ms);
}

const self_test_status_t* self_test_status(const self_test_t* t) {
    return t && t->initialized ? &t->status : NULL;
}
