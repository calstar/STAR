/**
 * SensorDataChunkCollection unit tests
 *
 * Tests the data collection struct used by all sensor boards
 * before serializing into network packets.
 */
#include <unity.h>
#include <cstring>
#include <vector>

// DAQv2-Comms
#include "DiabloEnums.h"
#include "DiabloPackets.h"

// ===========================================================================
// Constructor and basic operations
// ===========================================================================

void test_chunk_constructor() {
    Diablo::SensorDataChunkCollection chunk(12345, 5);
    TEST_ASSERT_EQUAL(12345, chunk.timestamp);
    TEST_ASSERT_EQUAL(5, chunk.num_sensors);
    TEST_ASSERT_EQUAL(0, chunk.size());
    TEST_ASSERT_TRUE(chunk.empty());
    TEST_ASSERT_FALSE(chunk.full());
}

void test_chunk_add_datapoint() {
    Diablo::SensorDataChunkCollection chunk(100, 3);
    TEST_ASSERT_TRUE(chunk.add_datapoint(1, 0xDEAD));
    TEST_ASSERT_EQUAL(1, chunk.size());
    TEST_ASSERT_FALSE(chunk.empty());
    TEST_ASSERT_FALSE(chunk.full());

    TEST_ASSERT_TRUE(chunk.add_datapoint(2, 0xBEEF));
    TEST_ASSERT_TRUE(chunk.add_datapoint(3, 0xCAFE));
    TEST_ASSERT_EQUAL(3, chunk.size());
    TEST_ASSERT_TRUE(chunk.full());
}

void test_chunk_add_over_capacity() {
    Diablo::SensorDataChunkCollection chunk(100, 2);
    TEST_ASSERT_TRUE(chunk.add_datapoint(1, 100));
    TEST_ASSERT_TRUE(chunk.add_datapoint(2, 200));
    TEST_ASSERT_FALSE(chunk.add_datapoint(3, 300)); // over capacity
    TEST_ASSERT_EQUAL(2, chunk.size());
}

void test_chunk_clear() {
    Diablo::SensorDataChunkCollection chunk(100, 3);
    chunk.add_datapoint(1, 100);
    chunk.add_datapoint(2, 200);
    TEST_ASSERT_EQUAL(2, chunk.size());

    chunk.clear();
    TEST_ASSERT_EQUAL(0, chunk.size());
    TEST_ASSERT_TRUE(chunk.empty());
    TEST_ASSERT_FALSE(chunk.full());
}

void test_chunk_datapoint_values() {
    Diablo::SensorDataChunkCollection chunk(999, 2);
    chunk.add_datapoint(5, 0x12345678);
    chunk.add_datapoint(10, 0xABCDEF00);

    TEST_ASSERT_EQUAL(5, chunk.datapoints[0].sensor_id);
    TEST_ASSERT_EQUAL_HEX32(0x12345678, chunk.datapoints[0].data);
    TEST_ASSERT_EQUAL(10, chunk.datapoints[1].sensor_id);
    TEST_ASSERT_EQUAL_HEX32(0xABCDEF00, chunk.datapoints[1].data);
}

void test_chunk_zero_capacity() {
    Diablo::SensorDataChunkCollection chunk(100, 0);
    TEST_ASSERT_EQUAL(0, chunk.size());
    TEST_ASSERT_TRUE(chunk.empty());
    TEST_ASSERT_TRUE(chunk.full()); // 0 >= 0
    TEST_ASSERT_FALSE(chunk.add_datapoint(1, 100));
}

void test_chunk_single_sensor() {
    Diablo::SensorDataChunkCollection chunk(500, 1);
    TEST_ASSERT_TRUE(chunk.add_datapoint(1, 42));
    TEST_ASSERT_TRUE(chunk.full());
    TEST_ASSERT_FALSE(chunk.add_datapoint(2, 43));
}

// ===========================================================================
// Unity runner
// ===========================================================================

void setUp() {}
void tearDown() {}

int main(int argc, char **argv) {
    UNITY_BEGIN();

    RUN_TEST(test_chunk_constructor);
    RUN_TEST(test_chunk_add_datapoint);
    RUN_TEST(test_chunk_add_over_capacity);
    RUN_TEST(test_chunk_clear);
    RUN_TEST(test_chunk_datapoint_values);
    RUN_TEST(test_chunk_zero_capacity);
    RUN_TEST(test_chunk_single_sensor);

    return UNITY_END();

}
