extern "C" {
#include "health.h"
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
struct Fake {
    unsigned calls;
    selftest_tx_result_t result;
    uint8_t frame[11];
};
static selftest_tx_result_t send(void* ctx, const uint8_t* bytes, uint8_t len,
                                 uint32_t budget) {
    Fake& f = *static_cast<Fake*>(ctx);
    CHECK(len == 11 && budget == 1000);
    if (f.calls)
        CHECK(std::memcmp(f.frame, bytes, len) == 0);
    std::memcpy(f.frame, bytes, len);
    ++f.calls;
    return f.result;
}
static void test_report() {
    selftest_radio_t tx;
    CHECK(!selftest_radio_init(nullptr, 0, 0, 0, 0));
    CHECK(selftest_radio_init(&tx, 0x81, 7920, 65535, 0));
    const uint8_t prefix[] = {1, 2, 255, 255, 4, 0x81, 0, 0xF0, 0x1E};
    CHECK(std::memcmp(tx.bytes, prefix, sizeof(prefix)) == 0);
    radio_link::Frame frame;
    CHECK(radio_link::decode_frame(tx.bytes, 11, frame) ==
          radio_link::FrameStatus::Ok);
    CHECK(frame.type == radio_link::FrameType::SelfTest && frame.seq == 65535);
    CHECK(radio_link::get_u16(frame.payload) == 0x81);
    CHECK(radio_link::get_u16(frame.payload + 2) == 7920);
    uint8_t corrupt[11];
    std::memcpy(corrupt, tx.bytes, 11);
    corrupt[5] ^= 1;
    CHECK(radio_link::decode_frame(corrupt, 11, frame) ==
          radio_link::FrameStatus::ErrCrc);
    Fake f = {0, SELFTEST_TX_TIMEOUT, {0}};
    selftest_radio_step(&tx, 0, send, &f);
    CHECK(f.calls == 1 && !tx.finished);
    selftest_radio_step(&tx, 1499, send, &f);
    CHECK(f.calls == 1);
    f.result = SELFTEST_TX_PENDING;  // queued is not delivered
    selftest_radio_step(&tx, 1500, send, &f);
    CHECK(f.calls == 2 && !tx.finished);
    f.result = SELFTEST_TX_DONE;
    selftest_radio_step(&tx, 3000, send, &f);
    CHECK(tx.finished && tx.result == SELFTEST_TX_DONE);
    selftest_radio_step(&tx, 6000, send, &f);
    CHECK(f.calls == 3);
    CHECK(selftest_radio_init(&tx, 0, 0, 0, UINT32_MAX - 100));
    selftest_radio_step(&tx, UINT32_MAX - 100, nullptr, nullptr);
    selftest_radio_step(&tx, 1398, nullptr, nullptr);
    CHECK(tx.attempts == 1);
    selftest_radio_step(&tx, 1399, nullptr, nullptr);
    CHECK(tx.attempts == 2);
    selftest_radio_step(&tx, 2899, nullptr, nullptr);
    CHECK(tx.finished && tx.attempts == 3 &&
          tx.result == SELFTEST_TX_UNAVAILABLE);
}
int main() {
    test_health();
    test_report();
    std::puts("health/radio tests passed");
}
