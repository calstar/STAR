extern "C" {
#include "health.h"
#include "health_core.h"
}
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "frame.h"
#include "selftest_radio.h"
#define CHECK(x)                                            \
    do {                                                    \
        if (!(x)) {                                         \
            std::fprintf(stderr, "%d: %s\n", __LINE__, #x); \
            std::abort();                                   \
        }                                                   \
    } while (0)
static void beat_all(health_t& h, uint32_t now) {
    for (unsigned i = 0; i < HEALTH_COUNT; ++i)
        health_beat(&h, static_cast<health_id_t>(i), now);
}
static void test_health() {
    health_t h;
    health_init(&h, 0);
    CHECK(health_check(&h, 4999));
    health_beat(&h, HEALTH_SENSORS, 4999);
    health_beat(&h, HEALTH_GNSS, 4999);
    CHECK(!health_check(&h, 5000));
    CHECK(h.faults == (1U << HEALTH_LOG));
    beat_all(h, 5001);
    CHECK(!health_check(&h, 5001));  // late recovery cannot mask a stall
    CHECK(!health_prepare_sleep(&h, 5001, 10000));
    health_init(&h, 0);
    beat_all(h, 6000);
    CHECK(!health_check(&h, 6000));  // late beats before monitor ran
    health_init(&h, 0);
    CHECK(!health_prepare_sleep(&h, 0, 0));
    CHECK(!health_prepare_sleep(&h, 0, 10001));
    CHECK(health_prepare_sleep(&h, 4000, 10000));
    CHECK(!health_prepare_sleep(&h, 4000, 1000));
    CHECK(
        !health_check(&h, 9000));  // never feed from the polling task in sleep
    health_beat(&h, HEALTH_LOG, 9000);  // sleeping beats cannot hide stale work
    CHECK(health_resume(&h, 14000));
    CHECK(h.last[HEALTH_LOG] == 10000);
    CHECK(health_check(&h, 14999));
    CHECK(!health_check(&h, 15000));  // preserve pre-sleep age
    CHECK(!health_resume(&h, 15000));
    health_init(&h, 0);
    CHECK(health_prepare_sleep(&h, 0, 10000));
    CHECK(health_resume(&h, 200));  // early DIO1 wake
    beat_all(h, 200);
    CHECK(health_prepare_sleep(&h, 200, 10000));
    CHECK(!health_resume(&h, 11201));  // missed wake deadline
    CHECK(h.faults == HEALTH_ALL);
    health_init(&h, UINT32_MAX - 100);
    CHECK(health_prepare_sleep(&h, UINT32_MAX - 50, 10000));
    CHECK(health_resume(&h, 9949));  // tick wrap during sleep
    CHECK(health_check(&h, 14898));
    CHECK(!health_check(&h, 14899));
}
static void test_active() {
    health_t h;
    health_init(&h, 0);
    // Idle: sensors and GNSS are parked, only the log writer runs.
    health_set_active(&h, HEALTH_SENSORS, false, 0);
    health_set_active(&h, HEALTH_GNSS, false, 0);
    health_beat(&h, HEALTH_LOG, 4000);
    CHECK(health_check(&h, 8000));
    CHECK(h.faults == 0);
    // ARMED 20 s later: the parked time is not stale.
    health_beat(&h, HEALTH_LOG, 8000);
    health_set_active(&h, HEALTH_SENSORS, true, 20000);
    health_beat(&h, HEALTH_LOG, 12000);
    health_beat(&h, HEALTH_LOG, 16000);
    health_beat(&h, HEALTH_LOG, 20000);
    CHECK(health_check(&h, 24999));
    // A running worker that stops checking in still faults.
    health_beat(&h, HEALTH_LOG, 24000);
    CHECK(!health_check(&h, 25000));
    CHECK(h.faults == (1U << HEALTH_SENSORS));
    // Turning on an already-active worker keeps its age.
    health_init(&h, 0);
    health_set_active(&h, HEALTH_GNSS, true, 4999);
    beat_all(h, 0);
    health_beat(&h, HEALTH_SENSORS, 4999);
    health_beat(&h, HEALTH_LOG, 4999);
    CHECK(!health_check(&h, 5000));
    CHECK(h.faults == (1U << HEALTH_GNSS));
    health_set_active(&h, HEALTH_COUNT, false, 0);  // ignored
    CHECK(h.active == (unsigned)HEALTH_ALL);
}

struct Sink {
    unsigned calls;
    uint8_t type, len;
    rec_health_t rec;
};
static void sink(void* ctx, uint8_t type, const void* data, uint8_t len) {
    Sink& s = *static_cast<Sink*>(ctx);
    ++s.calls;
    s.type = type;
    s.len = len;
    std::memcpy(&s.rec, data, sizeof s.rec);
}
static void test_core() {
    Sink s = {};
    health_core_t c;
    health_core_init(&c, record_sink_t{sink, &s});
    CHECK(health_core_due(&c, 123, HEALTH_CORE_ARMED_MS));  // first sample
    health_inputs_t in = {};
    for (unsigned i = 0; i < REC_HEALTH_INPUTS; ++i) {
        in.valid[i] = true;
        in.counts[i] = static_cast<uint16_t>(1000 + i);
    }
    in.counts[0] = 49343;  // 7999 mV on PA0
    in.counts[6] = 19740;  // 1000 mV on PC1 = 1000 mA at 1 V/A
    in.valid[5] = false;   // ALT_CURR conversion failed
    health_core_sample(&c, &in, 1U << HEALTH_GNSS, 123, 777);
    CHECK(s.calls == 1 && s.type == REC_HEALTH && s.len == 25);
    CHECK(s.rec.t_us == 777);
    CHECK(s.rec.battery_mv == 7999 && s.rec.battery == BATTERY_OK);
    CHECK(s.rec.current_ma == 1000);
    CHECK(s.rec.valid == 0x5F && s.rec.counts[5] == 0);
    CHECK(s.rec.counts[2] == 1002);  // pyro 1 continuity, raw
    CHECK(s.rec.task_faults == (1U << HEALTH_GNSS));
    CHECK(std::memcmp(&c.latest, &s.rec, sizeof s.rec) == 0);
    CHECK(!health_core_due(&c, 222, HEALTH_CORE_ARMED_MS));
    CHECK(health_core_due(&c, 223, HEALTH_CORE_ARMED_MS));
    CHECK(!health_core_due(&c, 5122, HEALTH_CORE_IDLE_MS));
    // On USB the PA0 reading is the USB supply, flagged so.
    in.on_usb = true;
    in.valid[6] = false;
    health_core_sample(&c, &in, 0, UINT32_MAX, 0);
    CHECK(s.rec.battery == BATTERY_USB && s.rec.current_ma == 0);
    CHECK(health_core_due(&c, 99, 100));  // wraps
    CHECK(health_current_ma(0) == 0 && health_current_ma(65535) == 3320);
}

struct Fake {
    unsigned calls;
    selftest_tx_result_t result;
    uint8_t payload[4];
};
static selftest_tx_result_t send(void* ctx, uint8_t type,
                                 const uint8_t* payload, uint8_t len) {
    Fake& f = *static_cast<Fake*>(ctx);
    CHECK(type == SELFTEST_RADIO_TYPE && len == SELFTEST_RADIO_PAYLOAD);
    if (f.calls)
        CHECK(std::memcmp(f.payload, payload, len) == 0);  // same report
    std::memcpy(f.payload, payload, len);
    ++f.calls;
    return f.result;
}
static void test_report() {
    CHECK(SELFTEST_RADIO_TYPE ==
          static_cast<uint8_t>(radio_link::FrameType::SelfTest));
    CHECK(SELFTEST_RADIO_PAYLOAD == radio_link::kSelfTestLen);
    selftest_radio_t tx;
    selftest_radio_init(&tx, 0x81, 7920, 0);
    // What radio_task_send_frame() does with it, decoded by Ryan's codec.
    uint8_t wire[radio_link::kFrameMaxLen];
    size_t n = 0;
    CHECK(radio_link::encode_frame(radio_link::FrameType::SelfTest, 7,
                                   tx.payload, SELFTEST_RADIO_PAYLOAD, wire,
                                   sizeof wire,
                                   n) == radio_link::FrameStatus::Ok);
    radio_link::Frame frame;
    CHECK(radio_link::decode_frame(wire, n, frame) ==
          radio_link::FrameStatus::Ok);
    CHECK(frame.type == radio_link::FrameType::SelfTest && frame.seq == 7);
    CHECK(radio_link::get_u16(frame.payload) == 0x81);
    CHECK(radio_link::get_u16(frame.payload + 2) == 7920);

    // battery_mV: the pack's reading only; USB and an unread ADC send 0.
    CHECK(selftest_radio_mv(battery_assess(true, 49343, false)) == 7999);
    CHECK(selftest_radio_mv(battery_assess(true, 40000, false)) != 0);  // FAIL
    CHECK(selftest_radio_mv(battery_assess(true, 31000, true)) == 0);   // USB
    CHECK(selftest_radio_mv(battery_assess(false, 0, false)) == 0);
    CHECK(selftest_radio_mv(battery_t{BATTERY_UNKNOWN, 5000, 1}) == 0);

    Fake f = {0, SELFTEST_TX_TIMEOUT, {0}};
    selftest_radio_step(&tx, 0, send, &f);
    CHECK(f.calls == 1 && !tx.finished);
    selftest_radio_step(&tx, 499, send, &f);
    CHECK(f.calls == 1);
    f.result = SELFTEST_TX_PENDING;  // queued is not delivered
    selftest_radio_step(&tx, 500, send, &f);
    CHECK(f.calls == 2 && !tx.finished);
    f.result = SELFTEST_TX_DONE;
    selftest_radio_step(&tx, 1000, send, &f);
    CHECK(tx.finished && tx.result == SELFTEST_TX_DONE && tx.attempts == 3);
    selftest_radio_step(&tx, 6000, send, &f);
    CHECK(f.calls == 3);
    // A timeout is retried, then reported, never retried forever.
    selftest_radio_init(&tx, 0, 0, UINT32_MAX - 100);
    f = Fake{0, SELFTEST_TX_TIMEOUT, {0}};
    for (uint32_t t = UINT32_MAX - 100, i = 0; i < 100; ++i, t += 250)
        selftest_radio_step(&tx, t, send, &f);
    CHECK(tx.finished && f.calls == SELFTEST_RADIO_MAX_ATTEMPTS &&
          tx.result == SELFTEST_TX_TIMEOUT);
    selftest_radio_init(&tx, 0, 0, 0);
    selftest_radio_step(&tx, 0, nullptr, nullptr);
    CHECK(tx.result == SELFTEST_TX_UNAVAILABLE && !tx.finished);
}
int main() {
    test_health();
    test_active();
    test_core();
    test_report();
    std::puts("health/radio tests passed");
}
