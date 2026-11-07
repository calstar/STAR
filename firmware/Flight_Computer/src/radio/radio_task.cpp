#include "radio_task.h"

#include <string.h>

#include "board.h"
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
constexpr uint32_t kBusyTimeoutMs = 20;  // > calibrate 3.5 ms + TCXO 5 ms
constexpr uint32_t kFrameTimeoutMs = 10;
constexpr uint32_t kSetupRetryMs = 5000;
// Proposal pending review, like the key and window in arm_gate.h.
constexpr uint8_t kTargetId = 0x01;

// Ryan's SpiBus over board_spi (SPI1, CS PC4, BUSY PC5).
class BoardBus : public SpiBus {
public:
    bool wait_busy() override {
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
Sx1262Setup setup(bus, control, kDefaultLora);
Sx1262 receiver(bus);
Link link(kTargetId);

osMutexId_t mutex;
bool configured;
uint16_t tx_seq;
radio_status_t status;
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

void radio_task(void*) {
    board_exti_route(RADIO_DIO1_Pin, osThreadGetId(), kEvDio1);
    try_setup();
    uint32_t last_setup = board_now_ms();
    for (;;) {
        const uint32_t flags = osThreadFlagsWait(kEvDio1, osFlagsWaitAny, 1000);
        if (!configured) {
            if (board_now_ms() - last_setup >= kSetupRetryMs) {
                try_setup();
                last_setup = board_now_ms();
            }
            continue;
        }
        take();
        const ArmAction action = link.poll(board_now_ms());
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
    return mutex && osThreadNew(radio_task, nullptr, &attr) != nullptr;
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

}  // extern "C"
