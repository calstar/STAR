/*
 * idle_e2e: the Idle state end to end, on a laptop.
 *
 *   PA0 counts + SW_ST -> REAL idle.c (PR #162) -> REAL heartbeat encoding
 *   (Ryan's frame.cpp) -> REAL Sx1262Setup::send -> fake SX1262 on the air
 *   -> captured packets decoded with Ryan's decode_frame
 *   ground Arm packets -> fake SX1262 RxDone/DIO1 -> REAL Sx1262::receive +
 *   Link + ArmGate -> REAL mode_core / flight_state -> ARMED, eMMC log
 *   (REAL emmc_log_on_state) recording
 *   RTC on an LSI that is not 32 kHz -> REAL sleep_math (WUT reload,
 *   elapsed time) -> the board's clock
 *
 * The harness plays the RTOS exactly as app/idle_task.c and the radio task
 * do: run the radio task on DIO1, call idle_on_wake(), sleep until the RTC
 * wakeup or an earlier DIO1. Only the radio chip, RTC, ADC and the ground
 * station are fake.
 *
 * Output, one line per check (parsed by ./flight_test):
 *   CHECK <id> PASS|FAIL <description> | <detail>
 * Usage: idle_e2e [--list] [--only=id,id]
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "emmc_log.h"
#include "fake_air.h"
#include "frame.h"
#include "idle.h"
#include "link.h"
#include "mode_core.h"
#include "sleep_math.h"
#include "sx1262.h"
#include "sx1262_setup.h"

using namespace radio_link;

namespace {

constexpr uint32_t kTrueLsiHz = 30500;   // this board's LSI, not 32 kHz
constexpr uint32_t kBootMs = 5000;       // self-test done, Idle starts
constexpr uint32_t kCounts7V92 = 48853;  // PA0 for a 7.92 V pack
constexpr uint8_t kTargetId = 0x01;      // radio_task.cpp

struct Control : RadioControl {
    uint32_t* now = nullptr;
    bool rx_switch = false;
    void set_rx_switch(bool receive) override {
        rx_switch = receive;
    }
    void delay_ms(uint32_t ms) override {
        *now += ms;
    }
};

struct World {
    uint32_t now = kBootMs;    // true time, ms
    uint32_t board = kBootMs;  // the board's RTOS clock
    FakeAir air{&now};
    Control control;
    Sx1262Setup setup{air, control, kDefaultLora};
    Sx1262 receiver{air};
    Link link{kTargetId};
    flight_state_t state = FLIGHT_IDLE;
    idle_t idle;
    uint8_t queue[8];
    unsigned queued = 0;
    bool on_usb = false;
    uint32_t battery_counts = kCounts7V92;
    // ground packets to deliver: time and bytes
    struct Ground {
        uint32_t t;
        uint8_t len;
        uint8_t data[32];
    } ground[4];
    unsigned n_ground = 0, next_ground = 0;
    // what the harness saw
    unsigned sleeps = 0, sleeps_deaf = 0, early_wakes = 0;
    uint32_t armed_at = 0;
    uint16_t tx_seq = 0;
    emmc_log_t log;
    emmc_log_chunk_t chunks[2];
    uint8_t scratch[EMMC_BLOCK_SIZE];
};

World* W = nullptr;  // the idle_port callbacks reach the world through this

// Ryan's seam, on the fake chip (radio_task.cpp does the same on SPI1).
}  // namespace

namespace radio_link {
RadioStatus radio_probe() {
    return RadioStatus::Ok;
}
RadioStatus radio_receive(uint8_t* buf, uint8_t max_len, uint8_t& len) {
    return W->receiver.receive(buf, max_len, len);
}
RadioStatus radio_send(const uint8_t* bytes, uint8_t len) {
    return W->setup.send(bytes, len);
}
}  // namespace radio_link

namespace {

// --- idle_port, as app/idle_task.c wires it ------------------------------
self_test_battery_t read_battery(void*, uint32_t now_ms, uint32_t) {
    self_test_battery_t b = {};
    b.reply.result = SELF_TEST_PASS;
    b.valid = true;
    b.raw_counts = W->battery_counts;
    b.sampled_at_ms = now_ms;
    return b;
}
bool on_usb(void*) {
    return W->on_usb;
}
self_test_reply_t send_heartbeat(void*, const idle_heartbeat_t* hb, uint32_t) {
    bool pack = hb->battery == IDLE_BATT_OK || hb->battery == IDLE_BATT_WARN ||
                hb->battery == IDLE_BATT_FAIL;
    uint16_t mv = pack ? hb->supply_mv : 0;
    uint32_t up = hb->uptime_ms / 1000u;
    const uint8_t p[7] = {FLIGHT_IDLE,
                          static_cast<uint8_t>(mv),
                          static_cast<uint8_t>(mv >> 8),
                          static_cast<uint8_t>(up),
                          static_cast<uint8_t>(up >> 8),
                          static_cast<uint8_t>(up >> 16),
                          static_cast<uint8_t>(up >> 24)};
    uint8_t frame[32];
    size_t n = 0;
    encode_frame(FrameType::Heartbeat, W->tx_seq++, p, 7, frame, sizeof frame,
                 n);
    uint32_t before = W->now;
    RadioStatus rs = radio_send(frame, static_cast<uint8_t>(n));
    W->board += W->now - before;  // awake: both clocks run together
    if (rs == RadioStatus::Ok)
        return {SELF_TEST_PASS, 0};
    if (rs == RadioStatus::ErrTimeout)
        return {SELF_TEST_TIMEOUT, 0};
    return {SELF_TEST_FAIL, 0};
}
idle_command_t poll_command(void*) {
    if (W->queued == 0)
        return IDLE_CMD_NONE;
    uint8_t c = W->queue[0];
    memmove(W->queue, W->queue + 1, --W->queued);
    return c == MODE_CMD_ARM ? IDLE_CMD_ARM : IDLE_CMD_DISARM;
}

// --- the radio task: DIO1 -> Link::poll -> ARM gate -> app_command -------
void radio_task() {
    while (W->air.dio1()) {
        ArmAction a = W->link.poll(W->board);
        flight_state_t next = W->state;
        if (a == ArmAction::Arm || a == ArmAction::Disarm) {
            mode_command_t c =
                a == ArmAction::Arm ? MODE_CMD_ARM : MODE_CMD_DISARM;
            switch (mode_route_command(W->state, c, &next)) {
                case MODE_TO_IDLE_LOOP:
                    if (W->queued < sizeof W->queue)
                        W->queue[W->queued++] = c;
                    break;
                case MODE_TRANSITION:
                    W->state = next;
                    break;
                default:
                    break;
            }
        }
        if (a == ArmAction::None && !W->air.dio1())
            break;
    }
}

void set_state(flight_state_t to) {
    emmc_log_on_state(&W->log, W->state, to, W->board);
    W->state = to;
}

// --- the ground station ---------------------------------------------------
void ground_arm(World& w, uint32_t t, uint16_t seq) {
    uint8_t p[9];
    put_u32(p, kArmKey);
    put_u32(p + 4, ~kArmKey);
    p[8] = kTargetId;
    size_t n = 0;
    World::Ground& g = w.ground[w.n_ground++];
    encode_frame(FrameType::Arm, seq, p, 9, g.data, sizeof g.data, n);
    g.t = t;
    g.len = static_cast<uint8_t>(n);
}

emmc_status_t no_card(void*, uint32_t* n) {
    *n = 1u << 20;
    return EMMC_OK;
}
emmc_status_t no_io(void*, uint32_t, void*, uint32_t, uint32_t) {
    return EMMC_OK;
}
emmc_status_t no_write(void*, uint32_t, const void*, uint32_t, uint32_t) {
    return EMMC_OK;
}

// --- the Idle loop, as app/idle_task.c runs it ----------------------------
void world_init(World& w) {
    W = &w;
    w.control.now = &w.now;
    static const emmc_port_t port = {no_card, no_io, no_write, nullptr,
                                     nullptr};
    emmc_log_config_t cfg = emmc_log_default_config();
    emmc_log_init(&w.log, &port, &w, &cfg, w.chunks, 2, w.scratch);
    static const idle_config_t icfg = {10000, 500, 500, 7000, 6600, 100};
    static const idle_port_t iport = {read_battery, on_usb, send_heartbeat,
                                      poll_command};
    idle_init(&w.idle, &icfg, &iport, nullptr);
}

void run(World& w, uint32_t until) {
    if (w.setup.configure() != SetupStep::Ok)
        return;
    idle_enter(&w.idle, w.board);
    // board_sleep_init: LSI measured against TIM2 (exact here)
    const uint32_t lsi = kTrueLsiHz;
    while (w.now < until && w.state == FLIGHT_IDLE) {
        radio_task();
        idle_result_t r = idle_on_wake(&w.idle, w.board);
        if (r.event == IDLE_EVENT_ARM_REQUESTED) {
            set_state(flight_state_next(FLIGHT_IDLE, FLIGHT_EV_ARM));
            w.armed_at = w.now;
            break;
        }
        if (w.state != FLIGHT_IDLE)
            break;  // DISARM etc. moved it
        uint32_t ms = r.event == IDLE_EVENT_SLEEP ? r.sleep_s * 1000u : 1000u;
        if (w.queued)
            continue;  // board_sleep's wake_now
        // Asleep: the chip must be listening with RF_SW on receive.
        w.sleeps++;
        if (!w.air.listening || !w.control.rx_switch)
            w.sleeps_deaf++;
        // The WUT fires after (reload + 1) x 16 true LSI cycles.
        uint32_t ticks = sleep_wut_reload(ms, lsi) + 1u;
        uint32_t wake =
            w.now + static_cast<uint32_t>(static_cast<uint64_t>(ticks) *
                                          16000u / kTrueLsiHz);
        if (w.next_ground < w.n_ground && w.ground[w.next_ground].t < wake) {
            wake = w.ground[w.next_ground].t;  // DIO1 wakes the MCU first
            w.early_wakes++;
        }
        // The RTC counts at the true LSI; the board converts with what it
        // measured (sleep_math), then FreeRTOS catches up.
        uint32_t steps = static_cast<uint32_t>(
            static_cast<uint64_t>(wake - w.now) * kTrueLsiHz / (128u * 1000u));
        w.board += sleep_elapsed_ms(0, steps, lsi);
        w.now = wake;
        while (w.next_ground < w.n_ground &&
               w.ground[w.next_ground].t <= w.now) {
            w.air.packet_arrives(w.ground[w.next_ground].data,
                                 w.ground[w.next_ground].len);
            w.next_ground++;
        }
    }
}

// --- checks ---------------------------------------------------------------
int failed;
char detail[256];

#define EXPECT(cond, ...)                                     \
    do {                                                      \
        if (!(cond)) {                                        \
            if (!failed)                                      \
                snprintf(detail, sizeof detail, __VA_ARGS__); \
            failed = 1;                                       \
        }                                                     \
    } while (0)

void note(const char* fmt, ...) {
    if (failed)
        return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(detail, sizeof detail, fmt, ap);
    va_end(ap);
}

struct Beat {
    uint32_t t, uptime_s;
    uint8_t state;
    uint16_t mv;
};
unsigned beats(const World& w, Beat* out, unsigned cap) {
    unsigned n = 0;
    for (unsigned i = 0; i < w.air.n_sent && n < cap; ++i) {
        Frame f;
        if (decode_frame(w.air.sent[i].data, w.air.sent[i].len, f) !=
                FrameStatus::Ok ||
            f.type != FrameType::Heartbeat || f.payload_len != kHeartbeatLen)
            continue;
        out[n].t = w.air.sent[i].t_ms;
        out[n].state = f.payload[0];
        out[n].mv = get_u16(f.payload + 1);
        out[n].uptime_s = get_u32(f.payload + 3);
        n++;
    }
    return n;
}

void check_idle_heartbeat() {
    static World w;
    world_init(w);
    run(w, kBootMs + 120000);
    static Beat b[32];
    unsigned n = beats(w, b, 32);
    EXPECT(w.air.n_sent == w.air.tx_attempts, "%u sends, %u decoded",
           w.air.tx_attempts, w.air.n_sent);
    EXPECT(n == w.air.n_sent, "%u of %u packets are not valid heartbeats",
           w.air.n_sent - n, w.air.n_sent);
    EXPECT(n >= 12 && n <= 13, "%u heartbeats in 120 s", n);
    uint32_t worst = 0;
    for (unsigned i = 1; i < n; ++i) {
        uint32_t gap = b[i].t - b[i - 1].t;
        uint32_t err = gap > 10000 ? gap - 10000 : 10000 - gap;
        if (err > worst)
            worst = err;
    }
    EXPECT(worst <= 500, "a heartbeat interval was off by %u ms", worst);
    for (unsigned i = 0; i < n; ++i) {
        EXPECT(b[i].state == FLIGHT_IDLE && b[i].mv == 7920,
               "heartbeat %u: state %u, %u mV", i, b[i].state, b[i].mv);
        uint32_t true_s = b[i].t / 1000u;
        EXPECT(b[i].uptime_s + 1 >= true_s && b[i].uptime_s <= true_s + 1,
               "heartbeat %u uptime %u s at %u s", i, b[i].uptime_s, true_s);
    }
    note(
        "%u heartbeats, every 10 s +/- %u ms, decoded by Ryan's decode_frame,"
        " 7.92 V, uptime counts sleep",
        n, worst);
}

void check_idle_rx_while_asleep() {
    static World w;
    world_init(w);
    run(w, kBootMs + 60000);
    EXPECT(w.sleeps >= 5, "only %u sleeps", w.sleeps);
    EXPECT(w.sleeps_deaf == 0, "%u of %u sleeps with the radio not listening",
           w.sleeps_deaf, w.sleeps);
    note("%u sleeps, radio in continuous RX with RF_SW on receive in all",
         w.sleeps);
}

void check_idle_arm_wake() {
    static World w;
    world_init(w);
    // ArmGate needs a second ARM within its confirm window (arm_gate.h).
    ground_arm(w, kBootMs + 23400, 100);
    ground_arm(w, kBootMs + 23900, 101);
    run(w, kBootMs + 60000);
    EXPECT(w.state == FLIGHT_ARMED, "state %d, not ARMED", w.state);
    EXPECT(w.armed_at >= kBootMs + 23900 && w.armed_at <= kBootMs + 24000,
           "armed at %u ms, confirm sent at %u", w.armed_at, kBootMs + 23900);
    EXPECT(w.early_wakes == 2, "%u DIO1 wakes, expected 2", w.early_wakes);
    mode_outputs_t o = mode_outputs(w.state);
    EXPECT(o.sensors && o.gps && !o.idle_loop, "ARMED does not start sensors");
    EXPECT(w.log.recording, "the eMMC log is not recording in ARMED");
    static Beat b[32];
    unsigned n = beats(w, b, 32);
    EXPECT(n == 3, "%u heartbeats before the Arm (expected 0, 10, 20 s)", n);
    note(
        "Arm confirmed at 28.9 s: woke on DIO1 twice, ARMED %u ms later, "
        "sensors + eMMC on, heartbeats stop",
        w.armed_at - (kBootMs + 23900));
}

void check_idle_usb() {
    static World w;
    world_init(w);
    w.on_usb = true;
    w.battery_counts = 30840;  // USB_5V on PA0
    run(w, kBootMs + 30000);
    static Beat b[8];
    unsigned n = beats(w, b, 8);
    EXPECT(n >= 3, "%u heartbeats", n);
    for (unsigned i = 0; i < n; ++i) {
        EXPECT(b[i].mv == 0, "heartbeat %u reports %u mV on USB", i, b[i].mv);
    }
    EXPECT(idle_last_heartbeat(&w.idle)->battery == IDLE_BATT_USB,
           "Idle judged USB as a battery");
    note("on USB: %u heartbeats with battery_mV 0, Idle state USB", n);
}

void check_idle_tx_fail() {
    static World w;
    world_init(w);
    run(w, kBootMs + 15000);  // 2 good heartbeats
    w.air.tx_never_done = true;
    run(w, kBootMs + 35000);  // 2 that never finish
    unsigned failures = idle_last_heartbeat(&w.idle)->consecutive_send_failures;
    w.air.tx_never_done = false;
    unsigned attempts_before = w.air.tx_attempts;
    run(w, kBootMs + 46000);
    EXPECT(failures == 2, "%u consecutive failures counted, expected 2",
           failures);
    EXPECT(w.setup.tx_timeouts() == 2, "%u TX timeouts", w.setup.tx_timeouts());
    EXPECT(w.air.tx_attempts == attempts_before + 1,
           "%u sends after recovery: a retry storm",
           w.air.tx_attempts - attempts_before);
    EXPECT(idle_last_heartbeat(&w.idle)->consecutive_send_failures == 0,
           "failure count did not reset after a good send");
    EXPECT(w.sleeps_deaf == 0, "radio left deaf after a failed send");
    note(
        "2 TxDone timeouts counted, no retries, back in RX each time, "
        "recovered on the next heartbeat");
}

void check_idle_clock() {
    static World w;
    world_init(w);
    run(w, kBootMs + 120000);
    int32_t err = static_cast<int32_t>(w.board - w.now);
    // Had the board assumed 32 kHz, 115 s of sleep would be off by ~4.7 %.
    uint32_t naive =
        static_cast<uint32_t>(115000ull * 32000u / kTrueLsiHz) - 115000u;
    EXPECT(err >= -50 && err <= 50, "board clock off by %d ms after %u s", err,
           (w.now - kBootMs) / 1000u);
    note(
        "LSI %u Hz: board clock within %d ms of true time over %u s "
        "(assuming 32 kHz would be ~%u ms off)",
        kTrueLsiHz, err, (w.now - kBootMs) / 1000u, naive);
}

struct Check {
    const char* id;
    const char* what;
    void (*run)();
};

const Check checks[] = {
    {"idle_heartbeat",
     "Idle: a LoRa heartbeat every 10 s, 7.92 V, decoded by Ryan's frames",
     check_idle_heartbeat},
    {"idle_rx_asleep",
     "Idle: radio listening (continuous RX, RF_SW) through every sleep",
     check_idle_rx_while_asleep},
    {"idle_arm_wake",
     "Idle: ground Arm wakes on DIO1 -> ARMED, sensors + eMMC start",
     check_idle_arm_wake},
    {"idle_usb", "Idle on USB: heartbeats never report USB's 5 V as the pack",
     check_idle_usb},
    {"idle_tx_fail",
     "Idle: TxDone timeouts counted, no retry storm, radio back in RX",
     check_idle_tx_fail},
    {"idle_clock", "Idle: RTC on a 30.5 kHz LSI, board clock still true time",
     check_idle_clock},
};

}  // namespace

int main(int argc, char** argv) {
    const char* only = nullptr;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--list") == 0) {
            for (const Check& c : checks)
                printf("%s\t%s\n", c.id, c.what);
            return 0;
        }
        if (strncmp(argv[i], "--only=", 7) == 0)
            only = argv[i] + 7;
    }
    int bad = 0;
    for (const Check& c : checks) {
        if (only) {
            char list[256];
            snprintf(list, sizeof list, ",%s,", only);
            char key[64];
            snprintf(key, sizeof key, ",%s,", c.id);
            if (!strstr(list, key))
                continue;
        }
        failed = 0;
        detail[0] = 0;
        c.run();
        printf("CHECK %s %s %s | %s\n", c.id, failed ? "FAIL" : "PASS", c.what,
               detail);
        bad |= failed;
    }
    return bad;
}
