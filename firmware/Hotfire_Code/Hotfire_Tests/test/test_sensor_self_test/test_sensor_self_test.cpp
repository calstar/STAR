#include <unity.h>

#include "STAR_ADS126X.h"
#include "SensorSelfTest.h"

int32_t g_mock_adc_value = 0;
bool g_mock_adc_checksum = true;

ADS126X mock_adc;
uint8_t dummy_pin = 0;

static int g_check_ins = 0;
static void count_check_in() {
    g_check_ins++;
}

void setUp() {
    g_mock_adc_value = 0;
    g_mock_adc_checksum = true;
    stub_set_digital_read(LOW);
    SensorSelfTest::g_drdy_timeout_us = 0xFFFFFFFFu;
    SensorSelfTest::g_check_in = nullptr;
    g_check_ins = 0;
}

void tearDown() {
}

// ===========================================================================
// ADC Self-Test Logic Verification
// ===========================================================================

void test_adc_tdac_pass() {
    // Expected is 214748364 with tolerance 2147484.
    g_mock_adc_value = SensorSelfTest::ADC_TDAC_EXPECTED_CODE;
    g_mock_adc_checksum = true;

    auto result = SensorSelfTest::run_adc_self_test(mock_adc, dummy_pin, 0, 0);
    TEST_ASSERT_TRUE(result.passed);
    TEST_ASSERT_TRUE(result.checksum_valid);
    TEST_ASSERT_EQUAL(SensorSelfTest::ADC_TDAC_EXPECTED_CODE, result.code);
}

void test_adc_tdac_fail_out_of_tolerance() {
    g_mock_adc_value = SensorSelfTest::ADC_TDAC_EXPECTED_CODE +
                       SensorSelfTest::ADC_TDAC_TOLERANCE + 10;
    g_mock_adc_checksum = true;

    auto result = SensorSelfTest::run_adc_self_test(mock_adc, dummy_pin, 0, 0);
    TEST_ASSERT_FALSE(result.passed);
    TEST_ASSERT_TRUE(result.checksum_valid);
}

void test_adc_tdac_fail_checksum() {
    g_mock_adc_value = SensorSelfTest::ADC_TDAC_EXPECTED_CODE;
    g_mock_adc_checksum = false;

    auto result = SensorSelfTest::run_adc_self_test(mock_adc, dummy_pin, 0, 0);
    TEST_ASSERT_FALSE(result.passed);
    TEST_ASSERT_FALSE(result.checksum_valid);
}

// ===========================================================================
// Sensor Bias Continuity Logic Verification
// ===========================================================================

void test_sensor_bias_connected() {
    // Value must be < 40% FS (858993459)
    g_mock_adc_value = 500000000;
    g_mock_adc_checksum = true;

    auto result =
        SensorSelfTest::read_sensor_bias(mock_adc, dummy_pin, 0, 0, 1);
    TEST_ASSERT_EQUAL((int)SensorSelfTest::BiasResult::CONNECTED,
                      (int)result.result);
    TEST_ASSERT_TRUE(result.checksum_valid);
}

void test_sensor_bias_ambiguous() {
    // Value between 40% and 60% FS
    g_mock_adc_value = 1000000000;
    g_mock_adc_checksum = true;

    auto result =
        SensorSelfTest::read_sensor_bias(mock_adc, dummy_pin, 0, 0, 1);
    TEST_ASSERT_EQUAL((int)SensorSelfTest::BiasResult::AMBIGUOUS,
                      (int)result.result);
    TEST_ASSERT_TRUE(result.checksum_valid);
}

void test_sensor_bias_disconnected() {
    // Value >= 60% FS (1288490188)
    g_mock_adc_value = 1300000000;
    g_mock_adc_checksum = true;

    auto result =
        SensorSelfTest::read_sensor_bias(mock_adc, dummy_pin, 0, 0, 1);
    TEST_ASSERT_EQUAL((int)SensorSelfTest::BiasResult::DISCONNECTED,
                      (int)result.result);
    TEST_ASSERT_TRUE(result.checksum_valid);
}

void test_sensor_bias_checksum_fails() {
    g_mock_adc_value = 0;
    g_mock_adc_checksum = false;

    auto result =
        SensorSelfTest::read_sensor_bias(mock_adc, dummy_pin, 0, 0, 1);
    TEST_ASSERT_EQUAL((int)SensorSelfTest::BiasResult::AMBIGUOUS,
                      (int)result.result);
    TEST_ASSERT_FALSE(result.checksum_valid);
}

// ===========================================================================
// Dead ADC: data-ready never asserts
// ===========================================================================

void test_adc_tdac_times_out_when_adc_silent() {
    stub_set_digital_read(HIGH);
    SensorSelfTest::g_drdy_timeout_us = 1000;
    g_mock_adc_value = SensorSelfTest::ADC_TDAC_EXPECTED_CODE;

    auto result = SensorSelfTest::run_adc_self_test(mock_adc, dummy_pin, 0, 0);
    TEST_ASSERT_FALSE(result.passed);
    TEST_ASSERT_TRUE(result.timed_out);
}

void test_sensor_bias_times_out_as_ambiguous() {
    stub_set_digital_read(HIGH);
    SensorSelfTest::g_drdy_timeout_us = 1000;
    g_mock_adc_value = 500000000;  // would read CONNECTED if the ADC answered

    auto result =
        SensorSelfTest::read_sensor_bias(mock_adc, dummy_pin, 0, 0, 5);
    TEST_ASSERT_EQUAL((int)SensorSelfTest::BiasResult::AMBIGUOUS,
                      (int)result.result);
    TEST_ASSERT_FALSE(result.checksum_valid);
}

void test_self_test_steps_check_in() {
    SensorSelfTest::g_check_in = count_check_in;
    SensorSelfTest::run_adc_self_test(mock_adc, dummy_pin, 0, 0);
    SensorSelfTest::read_sensor_bias(mock_adc, dummy_pin, 0, 0, 1);
    TEST_ASSERT_EQUAL(2, g_check_ins);
}

int main(int argc, char** argv) {
    UNITY_BEGIN();

    RUN_TEST(test_adc_tdac_pass);
    RUN_TEST(test_adc_tdac_fail_out_of_tolerance);
    RUN_TEST(test_adc_tdac_fail_checksum);

    RUN_TEST(test_sensor_bias_connected);
    RUN_TEST(test_sensor_bias_ambiguous);
    RUN_TEST(test_sensor_bias_disconnected);
    RUN_TEST(test_sensor_bias_checksum_fails);

    RUN_TEST(test_adc_tdac_times_out_when_adc_silent);
    RUN_TEST(test_sensor_bias_times_out_as_ambiguous);
    RUN_TEST(test_self_test_steps_check_in);

    return UNITY_END();
}
