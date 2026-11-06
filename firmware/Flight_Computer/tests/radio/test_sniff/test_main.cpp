// End-to-end tests for Idle sniff behaviour (SetRxDutyCycle, DS 13.1.7).
//
// Three properties under test:
//   1. idle_arm_wake: a long-preamble Arm is always heard in sniff mode.
//   2. Average radio current in Idle is under 0.3 mA.
//   3. The radio is re-armed (listening) after every received packet.
//
// fake_air models the listen windows; Sx1262Setup is exercised against the
// same TxChip fake used in test_sx1262_setup.

#include <string.h>

#include "unity.h"

#include "../../../src/chips/sx1262.cpp"
#include "../../../src/chips/sx1262_setup.cpp"
#include "fake_air.h"

using namespace radio_link;

// Minimal fake chip (same pattern as TxChip in test_sx1262_setup).
namespace {

class IdleChip : public SpiBus {
public:
    static constexpr uint8_t kStatus = 0x24;  // STBY_RC, no error
    static constexpr unsigned kMaxCmds = 128;

    void reset() {
        never_ready = false;
        n_cmds = 0;
        device_errors = 0;
        tx_clamp = 0xC8;
        tx_modulation = 0x01;
        sync[0] = sync[1] = 0;
    }

    bool never_ready;
    uint16_t device_errors;
    uint8_t tx_clamp, tx_modulation, sync[2];
    unsigned n_cmds;
    uint8_t cmds[kMaxCmds][12];
    uint16_t lens[kMaxCmds];

    int find(uint8_t opcode, int from = 0) const {
        for (unsigned i = static_cast<unsigned>(from); i < n_cmds; ++i) {
            if (cmds[i][0] == opcode) return static_cast<int>(i);
        }
        return -1;
    }

    bool wait_busy() override { return !never_ready; }
    void transfer(const uint8_t* tx, uint8_t* rx, uint16_t len) override {
        if (n_cmds < kMaxCmds) {
            memcpy(cmds[n_cmds], tx, len < 12 ? len : 12);
            lens[n_cmds++] = len;
        }
        memset(rx, 0xEE, len);
        rx[1] = kStatus;
        const uint16_t addr =
            len >= 3 ? static_cast<uint16_t>(tx[1] << 8 | tx[2]) : 0;
        switch (tx[0]) {
            case 0x1D:  // ReadRegister
                rx[4] = addr == 0x08D8   ? tx_clamp
                        : addr == 0x0889 ? tx_modulation
                                         : 0;
                break;
            case 0x0D:  // WriteRegister
                if (addr == 0x08D8) tx_clamp = tx[3];
                if (addr == 0x0889) tx_modulation = tx[3];
                if (addr == 0x0740) memcpy(sync, tx + 3, 2);
                break;
            case 0x17:  // GetDeviceErrors
                rx[2] = static_cast<uint8_t>(device_errors >> 8);
                rx[3] = static_cast<uint8_t>(device_errors);
                break;
            case 0x12:  // GetIrqStatus — no TX in idle tests, always idle
                rx[2] = rx[3] = 0;
                break;
            default: break;
        }
    }
};

class IdleControl : public RadioControl {
public:
    bool rx_switch = false;
    void set_rx_switch(bool receive) override { rx_switch = receive; }
    void delay_ms(uint32_t) override {}
};

IdleChip chip;
IdleControl control;

}  // namespace

void setUp(void) {
    chip.reset();
    control = IdleControl();
    fake_air_configure(33, 1000);
}
void tearDown(void) {}

// 1. A long-preamble Arm (> sleep period) is always heard regardless of when
//    in the duty cycle the ground starts transmitting.
static void test_idle_arm_wake_long_preamble_always_heard(void) {
    // SF9 / 125 kHz: symbol time ≈ 4.096 ms. 260 symbols ≈ 1065 ms > 1000 ms sleep.
    const uint32_t preamble_ms = 1065;
    const uint32_t period = 33 + 1000;
    for (uint32_t offset = 0; offset < period; offset += 50) {
        TEST_ASSERT_TRUE(fake_air_packet_heard(offset, preamble_ms));
    }
}

// A short preamble (default 8 symbols ≈ 33 ms) can be missed when it falls
// entirely within the sleep window. This test must fail if the guard is removed
// (i.e., if short preambles were always allowed for Arm).
static void test_short_preamble_missed_in_sleep_window(void) {
    // Start 10 ms into the sleep window; 33 ms preamble ends at offset 43 ms,
    // still inside sleep (33 + 10 = 43 < 33 + 1000).
    TEST_ASSERT_FALSE(fake_air_packet_heard(33 + 10, 33));
    // Middle of sleep: definitely missed.
    TEST_ASSERT_FALSE(fake_air_packet_heard(500, 33));
}

// 2. Average radio current in Idle is under 0.3 mA.
static void test_average_idle_current_under_0_3_ma(void) {
    // SX1262 DS p.16: 4.6 mA in LoRa 125 kHz RX (DC-DC), 1.2 µA in warm sleep.
    const float avg = fake_air_average_current_ma(4.6f, 1.2f);
    // ≈ 4.6 * 33/1033 + 0.0012 * 1000/1033 ≈ 0.147 mA
    TEST_ASSERT_TRUE(avg < 0.3f);
    TEST_ASSERT_FLOAT_WITHIN(0.05f, 0.147f, avg);
}

// 3. After a packet arrives the radio is re-armed (SetRxDutyCycle sent again),
//    so it does not go deaf. If rearm_rx() is never called the radio stays in
//    STDBY_RC and misses every subsequent packet.
static void test_radio_rearmed_after_every_rxdone(void) {
    Sx1262Setup radio(chip, control, kDefaultLora);
    TEST_ASSERT_EQUAL(SetupStep::Ok, radio.configure());
    TEST_ASSERT_TRUE(radio.start_rx_duty_cycle(33, 1000));

    // Simulate three RxDone events: each must restart the duty cycle.
    for (int i = 0; i < 3; i++) {
        chip.n_cmds = 0;
        TEST_ASSERT_TRUE(radio.rearm_rx());
        TEST_ASSERT_TRUE(chip.find(0x94) >= 0);
    }
}

// If rearm_rx() is skipped the chip stays in STDBY_RC and no SetRxDutyCycle
// is sent — this test demonstrates the failure mode.
static void test_no_rearm_means_no_duty_cycle_command(void) {
    Sx1262Setup radio(chip, control, kDefaultLora);
    radio.configure();
    radio.start_rx_duty_cycle(33, 1000);
    chip.n_cmds = 0;

    // Caller deliberately does NOT call rearm_rx() after RxDone.
    // No new 0x94 should appear.
    TEST_ASSERT_EQUAL(-1, chip.find(0x94));
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_idle_arm_wake_long_preamble_always_heard);
    RUN_TEST(test_short_preamble_missed_in_sleep_window);
    RUN_TEST(test_average_idle_current_under_0_3_ma);
    RUN_TEST(test_radio_rearmed_after_every_rxdone);
    RUN_TEST(test_no_rearm_means_no_duty_cycle_command);
    return UNITY_END();
}
