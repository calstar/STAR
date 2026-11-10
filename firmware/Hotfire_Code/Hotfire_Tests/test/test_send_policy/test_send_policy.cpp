/**
 * sensorBatchReady: when a sensor board ships its queued chunks.
 *
 * The bug it guards: an LC board at SINC4 / 20 SPS takes ~0.8 s per chunk, and
 * waiting for a full packet of 9 held every reading back 7-12 s.
 */
#include <unity.h>

#include "send_policy.h"

static const size_t kMax = 9;
static const uint32_t kAge = 250;

void test_empty_queue_never_sends() {
    TEST_ASSERT_FALSE(sensorBatchReady(0, kMax, 0, 100000, kAge));
}

void test_full_packet_sends_regardless_of_age() {
    TEST_ASSERT_TRUE(sensorBatchReady(kMax, kMax, 1000, 1000, kAge));
}

void test_fast_board_still_batches() {
    // A 75 Hz PT board: 3 chunks in 40 ms is young, keep filling.
    TEST_ASSERT_FALSE(sensorBatchReady(3, kMax, 1000, 1040, kAge));
}

void test_slow_board_sends_single_old_chunk() {
    // An LC chunk started 800 ms ago: ship it now, not 8 chunks from now.
    TEST_ASSERT_TRUE(sensorBatchReady(1, kMax, 1000, 1800, kAge));
}

void test_age_boundary() {
    TEST_ASSERT_FALSE(sensorBatchReady(1, kMax, 1000, 1000 + kAge - 1, kAge));
    TEST_ASSERT_TRUE(sensorBatchReady(1, kMax, 1000, 1000 + kAge, kAge));
}

void test_age_survives_millis_wrap() {
    // Oldest chunk 100 ms before the uint32 wrap, now 200 ms after it.
    TEST_ASSERT_TRUE(sensorBatchReady(1, kMax, 0xFFFFFFFFu - 99u, 200u, kAge));
    TEST_ASSERT_FALSE(sensorBatchReady(1, kMax, 0xFFFFFFFFu - 99u, 50u, kAge));
}

void setUp() {
}
void tearDown() {
}

int main(int argc, char** argv) {
    UNITY_BEGIN();
    RUN_TEST(test_empty_queue_never_sends);
    RUN_TEST(test_full_packet_sends_regardless_of_age);
    RUN_TEST(test_fast_board_still_batches);
    RUN_TEST(test_slow_board_sends_single_old_chunk);
    RUN_TEST(test_age_boundary);
    RUN_TEST(test_age_survives_millis_wrap);
    return UNITY_END();
}
