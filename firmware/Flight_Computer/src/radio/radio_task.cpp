#include "radio_task.h"

#include <string.h>

#include "board.h"
#include "board_config.h"
#include "board_exti.h"
#include "board_spi.h"
#include "cmsis_os2.h"
#include "frame.h"
#include "link.h"
#include "main.h"
#include "sx1262.h"
#include "sx1262_setup.h"

namespace {

using namespace radio_link;

constexpr uint32_t kEvDio1 = 1u << 0;
constexpr uint32_t kEvConfig = 1u << 1;
constexpr uint32_t kBusyTimeoutMs = 20;  // > calibrate 3.5 ms + TCXO 5 ms
constexpr uint32_t kFrameTimeoutMs = 10;
constexpr uint32_t kSetupRetryMs = 5000;
// Proposal pending review, like the key and window in arm_gate.h.
constexpr uint8_t kTargetId = 0x01;

// Ryan's SpiBus over board_spi (SPI1, CS PC4, BUSY PC5).
class BoardBus : public SpiBus {
public:
    bool wait_busy() override {
        board_spi_wake(BOARD_SPI_RADIO);  // asleep between Idle sniffs
        const uint32_t deadline = board_now_ms() + kBusyTimeoutMs;
        while (HAL_GPIO_ReadPin(RADIO_BUSY_GPIO_Port, RADIO_BUSY_Pin) ==
               GPIO_PIN_SET) {
            if (board_deadline_passed(deadline)) {
                return false;
            }
        }
        return true;
    }
    void transfer(const uint8_t* tx, uint8_t* rx, uint16_t len) override {
        if (board_spi_transfer(BOARD_SPI_RADIO, tx, rx, len,
                               board_now_ms() + kFrameTimeoutMs) !=
            BOARD_SPI_OK) {
            // All zeros decode as "no chip" in sx1262_status_ok(), so a
            // failed transfer is reported, never mistaken for data.
            memset(rx, 0, len);
        }
    }
};

// RF_SW (PB1) and waiting, for Sx1262Setup.
class BoardControl : public RadioControl {
public:
    void set_rx_switch(bool receive) override {
        HAL_GPIO_WritePin(RADIO_RF_SW_GPIO_Port, RADIO_RF_SW_Pin,
                          receive ? GPIO_PIN_SET : GPIO_PIN_RESET);
    }
    void delay_ms(uint32_t ms) override {
        osDelay(ms);
    }
};

BoardBus bus;
BoardControl control;
// The flight settings, except a bench build may lower the transmit power
// (STAR_RADIO_POWER_DBM, -9..+22 on the high-power PA, datasheet p.84).
#ifdef STAR_RADIO_POWER_DBM
constexpr LoraConfig kLora = {kDefaultLora.freq_hz,  kDefaultLora.sf,
                              kDefaultLora.bw,       kDefaultLora.cr,
                              kDefaultLora.preamble, STAR_RADIO_POWER_DBM,
                              kDefaultLora.sync_word};
static_assert(STAR_RADIO_POWER_DBM >= -9 && STAR_RADIO_POWER_DBM <= 22,
              "SX1262 high-power PA range is -9..+22 dBm");
#else
constexpr LoraConfig kLora = kDefaultLora;
#endif
Sx1262Setup setup(bus, control, kLora);
Sx1262 receiver(bus);
Link link(kTargetId);

osMutexId_t mutex;
osThreadId_t thread;
bool configured;
LoraConfig pending;
volatile bool reconfigure;
uint16_t tx_seq;
radio_status_t status;
radio_rx_t last_rx;
// The RX mode last asked for (mode.c), kept so it survives a late start-up.
bool want_sniff;
uint32_t want_rx_ms, want_sleep_ms;
void (*on_command)(radio_command_t);
uint8_t frame_buf[kFrameMaxLen];

void take() {
    (void)osMutexAcquire(mutex, osWaitForever);
}
void give() {
    (void)osMutexRelease(mutex);
}

void try_setup();

// configure() is written for a chip just out of reset. A running chip may be
// asleep between sniffs (BUSY high until woken), and then the first command
// times out. So a re-run starts as power-on does (board_bringup.c): NRESET
// low >= 100 us, release, BUSY falls in STDBY_RC (SX1262 DS 8.1, 8.2.2).
void reset_chip() {
    HAL_GPIO_WritePin(RADIO_NRST_GPIO_Port, RADIO_NRST_Pin, GPIO_PIN_RESET);
    osDelay(1);
    HAL_GPIO_WritePin(RADIO_NRST_GPIO_Port, RADIO_NRST_Pin, GPIO_PIN_SET);
    for (int i = 0; i < 50 && HAL_GPIO_ReadPin(RADIO_BUSY_GPIO_Port,
                                               RADIO_BUSY_Pin) == GPIO_PIN_SET;
         ++i) {
        osDelay(1);
    }
}

// Again from reset: new settings, or a start-up that failed.
void restart(const LoraConfig* cfg) {
    take();
    if (cfg) {
        setup.set_config(*cfg);
    }
    configured = false;  // nothing transmits through a chip in reset
    reset_chip();
    give();
    try_setup();
}

void try_setup() {
    take();
    status.setup_attempts++;
    const SetupStep step = setup.configure();
    status.setup_step = static_cast<uint8_t>(step);
    status.device_errors = setup.device_errors();
    configured = step == SetupStep::Ok;
    // A mode asked for before start-up finished (Idle can begin first).
    if (configured && want_sniff) {
        (void)setup.start_rx_duty_cycle(want_rx_ms, want_sleep_ms);
    }
    give();
}

// The link settings in fc_config, in the chip's codes. A bench build keeps
// its lowered power (STAR_RADIO_POWER_DBM).
LoraConfig lora_from(const fc_config_t& c) {
    LoraConfig l = kLora;
    l.freq_hz = c.radio_freq_hz;
    l.sf = c.radio_sf;
    l.bw = c.radio_bw_hz == 500000u   ? 0x06
           : c.radio_bw_hz == 250000u ? 0x05
                                      : 0x04;      // Table 13-48
    l.cr = static_cast<uint8_t>(c.radio_cr - 4u);  // 5..8 -> 1..4
    l.preamble = c.radio_preamble;
    l.sync_word = c.radio_sync_word;
#ifndef STAR_RADIO_POWER_DBM
    l.power_dbm = c.radio_tx_dbm;
#endif
    return l;
}

void radio_task(void*) {
    board_exti_route(RADIO_DIO1_Pin, osThreadGetId(), kEvDio1);
    const fc_config_t saved = board_config_get();
    setup.set_config(lora_from(saved));
    try_setup();
    uint32_t last_setup = board_now_ms();
    for (;;) {
        const uint32_t flags =
            osThreadFlagsWait(kEvDio1 | kEvConfig, osFlagsWaitAny, 1000);
        if (reconfigure) {  // new settings: the full start-up again
            take();
            const LoraConfig cfg = pending;
            reconfigure = false;
            give();
            restart(&cfg);
            last_setup = board_now_ms();
            continue;
        }
        if (!configured) {
            if (board_now_ms() - last_setup >= kSetupRetryMs) {
                restart(nullptr);
                last_setup = board_now_ms();
            }
            continue;
        }
        take();
        const uint32_t ok_before = link.frames_ok();
        const ArmAction action = link.poll(board_now_ms());
        if (link.frames_ok() != ok_before) {
            // Read the signal quality now, before the next packet lands.
            PacketStatus ps = {0, 0, 0};
            const Frame& f = link.last_frame();
            last_rx.quality_ok = receiver.packet_status(ps);
            last_rx.rssi_x2 = ps.rssi_x2;
            last_rx.snr_x4 = ps.snr_x4;
            last_rx.signal_rssi_x2 = ps.signal_rssi_x2;
            last_rx.type = static_cast<uint8_t>(f.type);
            last_rx.seq = f.seq;
            last_rx.payload_len = f.payload_len;
            memcpy(last_rx.payload, f.payload,
                   f.payload_len < sizeof last_rx.payload
                       ? f.payload_len
                       : sizeof last_rx.payload);
            last_rx.at_ms = board_now_ms();
            last_rx.count++;
        }
        // In sniff mode the chip returns to STDBY_RC after any DIO1 event
        // (RxDone, HeaderErr, CrcErr, p.71); restart the duty cycle so the
        // radio does not go deaf. Skip the 1-second fallback poll: the chip
        // is still cycling on its own and must not be interrupted.
        if (flags == kEvDio1) {
            setup.rearm_rx();
        }
        status.frames_ok = link.frames_ok();
        status.frames_dropped = link.frames_dropped();
        status.radio_errors = link.radio_errors();
        status.crc_errors = receiver.crc_errors();
        give();
        if (action == ArmAction::Arm) {
            status.arms++;
            if (on_command)
                on_command(RADIO_CMD_ARM);
        } else if (action == ArmAction::Disarm) {
            status.disarms++;
            if (on_command)
                on_command(RADIO_CMD_DISARM);
        }
    }
}

}  // namespace

// Ryan's seam (src/radio/radio.h), on the real chip. Callers hold the mutex:
// link.poll() inside the task, radio_send() inside radio_task_send_frame().
namespace radio_link {
RadioStatus radio_probe() {
    return configured ? RadioStatus::Ok : RadioStatus::ErrNotFound;
}
RadioStatus radio_receive(uint8_t* buf, uint8_t max_len, uint8_t& len) {
    return receiver.receive(buf, max_len, len);
}
RadioStatus radio_send(const uint8_t* bytes, uint8_t len) {
    return setup.send(bytes, len);
}
}  // namespace radio_link

extern "C" {

void radio_task_on_command(void (*callback)(radio_command_t)) {
    on_command = callback;
}

bool radio_task_start(void) {
    static const osMutexAttr_t mutex_attr = {"radio", osMutexPrioInherit,
                                             nullptr, 0};
    mutex = osMutexNew(&mutex_attr);
    static const osThreadAttr_t attr = {
        .name = "radio",
        .attr_bits = 0,
        .cb_mem = nullptr,
        .cb_size = 0,
        .stack_mem = nullptr,
        .stack_size = 1024,
        .priority = osPriorityAboveNormal, /* an Arm should not wait */
        .tz_module = 0,
        .reserved = 0,
    };
    thread = mutex ? osThreadNew(radio_task, nullptr, &attr) : nullptr;
    return thread != nullptr;
}

radio_send_result_t radio_task_send_frame(uint8_t type, const uint8_t* payload,
                                          uint8_t len) {
    if (!mutex) {
        return RADIO_SEND_NO_RADIO;
    }
    take();
    if (!configured) {
        give();
        return RADIO_SEND_NO_RADIO;
    }
    size_t n = 0;
    if (encode_frame(static_cast<FrameType>(type), tx_seq, payload, len,
                     frame_buf, sizeof frame_buf, n) != FrameStatus::Ok) {
        give();
        return RADIO_SEND_BAD_FRAME;
    }
    tx_seq++;
    const RadioStatus rs = radio_send(frame_buf, static_cast<uint8_t>(n));
    status.tx_ok = setup.tx_ok();
    status.tx_timeouts = setup.tx_timeouts();
    give();
    if (rs == RadioStatus::Ok)
        return RADIO_SEND_OK;
    if (rs == RadioStatus::ErrTimeout)
        return RADIO_SEND_TIMEOUT;
    return RADIO_SEND_NO_RADIO;
}

void radio_task_status(radio_status_t* out) {
    *out = status;
}

void radio_task_set_config(const fc_config_t* c) {
    if (!mutex || !thread) {
        return;  // not started: it reads the settings when it starts
    }
    take();
    pending = lora_from(*c);
    reconfigure = true;
    give();
    (void)osThreadFlagsSet(thread, kEvConfig);
}

void radio_task_start_sniff(uint32_t rx_ms, uint32_t sleep_ms) {
    if (!mutex)
        return;
    take();
    want_sniff = true;
    want_rx_ms = rx_ms;
    want_sleep_ms = sleep_ms;
    if (configured)
        setup.start_rx_duty_cycle(rx_ms, sleep_ms);
    give();
}

void radio_task_start_continuous_rx(void) {
    if (!mutex)
        return;
    take();
    want_sniff = false;
    if (configured)
        setup.start_rx_continuous();
    give();
}

void radio_task_last_rx(radio_rx_t* out) {
    if (!mutex) {
        *out = last_rx;
        return;
    }
    take();
    *out = last_rx;
    give();
}

}  // extern "C"
