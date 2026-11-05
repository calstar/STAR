// SX1262 start-up and transmit, against a pretend chip that keeps the
// registers, IRQ flags and device errors the way the datasheet describes.
#include <string.h>

#include "../../src/sx1262.cpp"
#include "../../src/sx1262_setup.cpp"
#include "unity.h"

using namespace radio_link;

namespace {

class TxChip : public SpiBus {
public:
    static constexpr uint8_t kStatus = 0x24;  // STBY_RC (2), no error
    static constexpr unsigned kMaxCmds = 64;

    void reset() {
        never_ready = false;
        status = kStatus;
        device_errors = 0;
        polls_until_done = 3;
        raise_timeout = false;
        irq = 0;
        tx_clamp = 0xC8;  // reset values, register table p.66
        tx_modulation = 0x01;
        sync[0] = sync[1] = 0;
        memset(buffer, 0, sizeof buffer);
        transmitting = false;
        n_cmds = 0;
    }
    // Test knobs.
    bool never_ready;
    uint8_t status;
    uint16_t device_errors;
    int polls_until_done;  // GetIrqStatus polls after SetTx; < 0: never
    bool raise_timeout;    // the chip's own TX timeout fires instead
    // What the chip saw.
    uint16_t irq;
    uint8_t tx_clamp, tx_modulation, sync[2];
    uint8_t buffer[256];
    bool transmitting;
    unsigned n_cmds;
    uint8_t cmds[kMaxCmds][12];  // first 12 bytes of each command
    uint16_t lens[kMaxCmds];

    int find(uint8_t opcode, int from = 0) const {
        for (unsigned i = static_cast<unsigned>(from); i < n_cmds; ++i) {
            if (cmds[i][0] == opcode)
                return static_cast<int>(i);
        }
        return -1;
    }

    bool wait_busy() override {
        return !never_ready;
    }
    void transfer(const uint8_t* tx, uint8_t* rx, uint16_t len) override {
        if (n_cmds < kMaxCmds) {
            memcpy(cmds[n_cmds], tx, len < 12 ? len : 12);
            lens[n_cmds++] = len;
        }
        memset(rx, 0xEE, len);
        rx[1] = status;
        const uint16_t addr =
            len >= 3 ? static_cast<uint16_t>(tx[1] << 8 | tx[2]) : 0;
        switch (tx[0]) {
            case 0x1D:  // ReadRegister
                rx[4] = addr == 0x08D8   ? tx_clamp
                        : addr == 0x0889 ? tx_modulation
                                         : 0;
                break;
            case 0x0D:  // WriteRegister
                if (addr == 0x08D8)
                    tx_clamp = tx[3];
                if (addr == 0x0889)
                    tx_modulation = tx[3];
                if (addr == 0x0740)
                    memcpy(sync, tx + 3, 2);
                break;
            case 0x17:  // GetDeviceErrors
                rx[2] = static_cast<uint8_t>(device_errors >> 8);
                rx[3] = static_cast<uint8_t>(device_errors);
                break;
            case 0x07:  // ClearDeviceErrors
                break;
            case 0x0E:  // WriteBuffer
                for (unsigned i = 2; i < len; ++i)
                    buffer[(tx[1] + i - 2) & 0xFF] = tx[i];
                break;
            case 0x83:  // SetTx
                transmitting = true;
                break;
            case 0x12:  // GetIrqStatus
                if (transmitting && raise_timeout) {
                    irq |= 1u << 9;
                    transmitting = false;
                } else if (transmitting && polls_until_done >= 0 &&
                           polls_until_done-- == 0) {
                    irq |= 1u << 0;
                    transmitting = false;
                }
                rx[2] = static_cast<uint8_t>(irq >> 8);
                rx[3] = static_cast<uint8_t>(irq);
                break;
            case 0x02:  // ClearIrqStatus
                irq = static_cast<uint16_t>(irq & ~(tx[1] << 8 | tx[2]));
                break;
            default:
                break;
        }
    }
};

class Control : public RadioControl {
public:
    bool rx_switch = false;
    bool rx_switch_during_tx = false;
    unsigned delays = 0;
    TxChip* chip = nullptr;
    void set_rx_switch(bool receive) override {
        rx_switch = receive;
    }
    void delay_ms(uint32_t ms) override {
        delays += ms;
        if (chip && chip->transmitting && rx_switch)
            rx_switch_during_tx = true;
    }
};

TxChip chip;
Control control;

}  // namespace

void setUp(void) {
    chip.reset();
    control = Control();
    control.chip = &chip;
}
void tearDown(void) {
}

static void test_frequency_word_and_time_on_air(void) {
    // Independent Python: 915e6 << 25 / 32e6; p.41 formula.
    TEST_ASSERT_EQUAL_HEX32(0x39300000, sx1262_frequency_word(915000000));
    TEST_ASSERT_EQUAL_UINT32(164864, lora_time_on_air_us(kDefaultLora, 14));
    TEST_ASSERT_EQUAL_UINT32(103424, lora_time_on_air_us(kDefaultLora, 1));
    LoraConfig sf7 = kDefaultLora;
    sf7.sf = 7;
    TEST_ASSERT_EQUAL_UINT32(399616, lora_time_on_air_us(sf7, 255));
    LoraConfig sf12 = kDefaultLora;
    sf12.sf = 12;  // 32.8 ms symbols: LDRO on
    TEST_ASSERT_EQUAL_UINT32(991232, lora_time_on_air_us(sf12, 10));
}

static void test_configure_follows_the_datasheet_order(void) {
    Sx1262Setup radio(chip, control, kDefaultLora);
    TEST_ASSERT_EQUAL(SetupStep::Ok, radio.configure());
    // 14.2/14.4 (p.99-100): standby, regulator, TCXO, calibrate, then packet
    // type before modulation before packet params; ends listening.
    const uint8_t order[] = {0x80, 0x96, 0x97, 0x89, 0x07, 0x9D, 0x8A,
                             0x86, 0x98, 0x95, 0x8E, 0x8F, 0x8B, 0x8C,
                             0x08, 0x1D, 0x0D, 0x0D, 0x17, 0x8C, 0x82};
    TEST_ASSERT_EQUAL_UINT(sizeof order, chip.n_cmds);
    for (unsigned i = 0; i < sizeof order; ++i) {
        TEST_ASSERT_EQUAL_HEX8(order[i], chip.cmds[i][0]);
    }
    const uint8_t tcxo[] = {0x97, 0x02, 0x00, 0x01, 0x40};  // 1.8 V, 5 ms
    TEST_ASSERT_EQUAL_HEX8_ARRAY(tcxo, chip.cmds[2], sizeof tcxo);
    TEST_ASSERT_EQUAL_HEX8(0x7F, chip.cmds[3][1]);  // calibrate all blocks
    TEST_ASSERT_EQUAL_HEX8(0x01, chip.cmds[5][1]);  // DIO2 drives RF switch
    const uint8_t freq[] = {0x86, 0x39, 0x30, 0x00, 0x00};
    TEST_ASSERT_EQUAL_HEX8_ARRAY(freq, chip.cmds[7], sizeof freq);
    const uint8_t image[] = {0x98, 0xE1, 0xE9};
    TEST_ASSERT_EQUAL_HEX8_ARRAY(image, chip.cmds[8], sizeof image);
    const uint8_t pa[] = {0x95, 0x04, 0x07, 0x00, 0x01};  // +22 dBm, p.77
    TEST_ASSERT_EQUAL_HEX8_ARRAY(pa, chip.cmds[9], sizeof pa);
    const uint8_t power[] = {0x8E, 0x16, 0x04};  // +22 dBm, 200 us ramp
    TEST_ASSERT_EQUAL_HEX8_ARRAY(power, chip.cmds[10], sizeof power);
    const uint8_t mod[] = {0x8B, 0x09, 0x04, 0x01, 0x00};  // SF9 125k 4/5
    TEST_ASSERT_EQUAL_HEX8_ARRAY(mod, chip.cmds[12], sizeof mod);
    const uint8_t pkt[] = {0x8C, 0x00, 0x08, 0x00, 0xFF, 0x01, 0x00};
    TEST_ASSERT_EQUAL_HEX8_ARRAY(pkt, chip.cmds[13], sizeof pkt);  // CRC on
    const uint8_t irq[] = {0x08, 0x02, 0x63, 0x02, 0x63, 0, 0, 0, 0};
    TEST_ASSERT_EQUAL_HEX8_ARRAY(irq, chip.cmds[14], sizeof irq);
    TEST_ASSERT_EQUAL_HEX8(0xDE, chip.tx_clamp);  // 0xC8 | 0x1E, errata 15.2
    TEST_ASSERT_EQUAL_HEX8(0x14, chip.sync[0]);
    TEST_ASSERT_EQUAL_HEX8(0x24, chip.sync[1]);
    const uint8_t rx[] = {0x82, 0xFF, 0xFF, 0xFF};  // continuous RX
    TEST_ASSERT_EQUAL_HEX8_ARRAY(rx, chip.cmds[chip.n_cmds - 1], sizeof rx);
    TEST_ASSERT_TRUE(control.rx_switch);
}

static void test_configure_names_the_failing_step(void) {
    chip.never_ready = true;
    Sx1262Setup a(chip, control, kDefaultLora);
    TEST_ASSERT_EQUAL(SetupStep::Standby, a.configure());

    setUp();
    chip.device_errors = 1u << 6;  // PLL_LOCK_ERR
    Sx1262Setup b(chip, control, kDefaultLora);
    TEST_ASSERT_EQUAL(SetupStep::DeviceErrors, b.configure());
    TEST_ASSERT_EQUAL_HEX16(0x0040, b.device_errors());
    TEST_ASSERT_EQUAL(-1, chip.find(0x82));  // not left listening as if ok

    setUp();
    chip.status = 0x00;  // no chip: MISO low
    Sx1262Setup c(chip, control, kDefaultLora);
    TEST_ASSERT_EQUAL(SetupStep::TxClamp, c.configure());  // first read
}

static void test_send_waits_for_tx_done_and_returns_to_rx(void) {
    Sx1262Setup radio(chip, control, kDefaultLora);
    TEST_ASSERT_EQUAL(SetupStep::Ok, radio.configure());
    chip.n_cmds = 0;
    const uint8_t frame[14] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14};
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.send(frame, sizeof frame));
    TEST_ASSERT_EQUAL_HEX8_ARRAY(frame, chip.buffer, sizeof frame);
    TEST_ASSERT_EQUAL_HEX8(0x05, chip.tx_modulation);  // errata 15.1 bit 2
    int pp = chip.find(0x8C);
    TEST_ASSERT_TRUE(pp >= 0);
    TEST_ASSERT_EQUAL_HEX8(14, chip.cmds[pp][4]);  // payload length for TX
    int tx = chip.find(0x83);
    TEST_ASSERT_TRUE(tx > pp);
    // Timeout = 2 x 164864 us in 15.625 us steps = 21103 (0x00526F).
    TEST_ASSERT_EQUAL_HEX8(0x00, chip.cmds[tx][1]);
    TEST_ASSERT_EQUAL_HEX8(0x52, chip.cmds[tx][2]);
    TEST_ASSERT_EQUAL_HEX8(0x6F, chip.cmds[tx][3]);
    TEST_ASSERT_EQUAL_UINT(3, control.delays);  // polled until TxDone
    TEST_ASSERT_FALSE(control.rx_switch_during_tx);
    // Back to listening for any length.
    int rx = chip.find(0x82, tx);
    TEST_ASSERT_TRUE(rx > tx);
    TEST_ASSERT_EQUAL_HEX8(0xFF, chip.cmds[chip.find(0x8C, tx)][4]);
    TEST_ASSERT_TRUE(control.rx_switch);
    TEST_ASSERT_EQUAL_UINT32(1, radio.tx_ok());
}

static void test_send_keeps_a_packet_that_just_arrived(void) {
    Sx1262Setup radio(chip, control, kDefaultLora);
    radio.configure();
    chip.irq = kIrqRxDone;  // an Arm frame landed, not read yet
    const uint8_t frame[3] = {1, 2, 3};
    TEST_ASSERT_EQUAL(RadioStatus::Ok, radio.send(frame, sizeof frame));
    TEST_ASSERT_TRUE(chip.irq & kIrqRxDone);
}

static void test_send_times_out(void) {
    Sx1262Setup radio(chip, control, kDefaultLora);
    radio.configure();
    chip.polls_until_done = -1;  // TxDone never comes
    const uint8_t frame[14] = {0};
    TEST_ASSERT_EQUAL(RadioStatus::ErrTimeout, radio.send(frame, sizeof frame));
    // Host limit: 2 x ToA + 50 ms = 379 ms of 1 ms polls, then give up.
    TEST_ASSERT_EQUAL_UINT(379, control.delays);
    TEST_ASSERT_EQUAL_UINT32(1, radio.tx_timeouts());
    TEST_ASSERT_TRUE(control.rx_switch);  // still returned to RX

    setUp();
    Sx1262Setup b(chip, control, kDefaultLora);
    b.configure();
    chip.raise_timeout = true;  // the chip's own timeout
    TEST_ASSERT_EQUAL(RadioStatus::ErrTimeout, b.send(frame, sizeof frame));
    TEST_ASSERT_EQUAL_UINT(0, control.delays);
}

static void test_send_refuses_bad_input_and_dead_chip(void) {
    Sx1262Setup radio(chip, control, kDefaultLora);
    radio.configure();
    const uint8_t frame[1] = {1};
    TEST_ASSERT_EQUAL(RadioStatus::ErrTooLong, radio.send(frame, 0));
    TEST_ASSERT_EQUAL(RadioStatus::ErrTooLong, radio.send(nullptr, 1));
    chip.status = 0xFF;  // chip gone
    TEST_ASSERT_EQUAL(RadioStatus::ErrNotFound, radio.send(frame, 1));
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_frequency_word_and_time_on_air);
    RUN_TEST(test_configure_follows_the_datasheet_order);
    RUN_TEST(test_configure_names_the_failing_step);
    RUN_TEST(test_send_waits_for_tx_done_and_returns_to_rx);
    RUN_TEST(test_send_keeps_a_packet_that_just_arrived);
    RUN_TEST(test_send_times_out);
    RUN_TEST(test_send_refuses_bad_input_and_dead_chip);
    return UNITY_END();
}
