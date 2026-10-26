/**
 * Shared sensor hotfire state machine core — PT / TC / LC / RTD boards
 *
 * Single implementation of: UDP rx, packet processing, the state machine,
 * state LED, board heartbeat, Ethernet init, chunk batching and sending.
 * Board-specific: ADC init, reading one chunk, reference voltage, self-test,
 * via callbacks.
 *
 * Two FreeRTOS tasks share the work, so a slow round of ADC readings never
 * holds up the network:
 *
 *   ADC task (core 1)      owns the ADC's SPI bus. Samples while told to,
 *                          pushes each chunk onto a queue (dropping the
 *                          oldest when full), runs self-test on request.
 *   network task (core 0)  owns Ethernet and all board state: reads every
 *                          waiting packet each 1 ms pass, runs the state
 *                          machine, sends heartbeats, batches chunks into
 *                          packets, flushes logs, serves OTA.
 *
 * The network task drives the ADC task with commands over a queue; nothing
 * else is shared between them except the log buffer (locked, hotfire_log.h)
 * and a drop counter.
 *
 * Include after: Arduino.h, Ethernet, DAQv2-Comms, main.h, sense_board_pins.h
 * Define before include (or use defaults):
 *   SENSOR_HOTFIRE_MAX_PACKET_SIZE (default 512)
 *   SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE (default 11)
 */

#pragma once

#include <Arduino.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <STAR_EthernetOTA.h>
#include <daq-protocol.h>
#include <esp_idf_version.h>
#include <esp_mac.h>
#include <esp_task_wdt.h>

#include <atomic>
#include <cstring>

#include "SensorCoreLogic.h"
#include "SensorSelfTest.h"
#include "board_net.h"
#include "firmware_hash.h"

#ifndef SENSOR_HOTFIRE_MAX_PACKET_SIZE
#define SENSOR_HOTFIRE_MAX_PACKET_SIZE 512
#endif
#ifndef SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE
#define SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE 11
#endif
#ifndef SENSOR_UDP_LISTEN_PORT
#define SENSOR_UDP_LISTEN_PORT 5005
#endif

// Two-tier serial logging (HF_LOG* = always, HF_VERBOSE* = verbose-only, gated
// by g_verbose). Each board defines `bool g_verbose = true;` once in its main
// .cpp.
#include "hotfire_log.h"

namespace SensorHotfire {

inline StarOTA::Server g_ota_server{HOTFIRE_OTA_PORT};

/**
 * What a board provides. Every callback except init_adc runs on the ADC
 * task, and none of them may touch Ethernet.
 */
struct Config {
    const char* board_name;
    const sense_board_pins::Layout* pins;
    /** The ADS126X_RATE_* the ADC runs at. Decides how waitDrdy() waits. */
    uint8_t adc_rate_code;
    /** Conversions the filter needs to settle after a channel switch
     * (settlePulses(FILTER, DATA_RATE)). Sets the data-ready timeout. */
    uint8_t adc_settle_conversions;
    /** Called once from setup(), before the tasks start, and again on the
     * ADC task if the ADC stops answering (see ADC_REINIT_AFTER_TIMEOUTS). */
    void (*init_adc)(void* user_data);
    /**
     * Read every channel in `config` once. The core has already filled in
     * `out`'s timestamp and sensor IDs (in config order); the board writes
     * `out.values[i]` for each. Return false to discard the chunk.
     *
     * Wait for data with waitDrdy(), and write 0 for a channel when it
     * returns false (the ADC did not answer in time).
     */
    bool (*read_chunk)(void* user_data, const StoredSensorConfig& config,
                       Chunk& out);
    /** Called when the configured reference_voltage byte changes
     * (0=2.5V internal, 1=VDD, 2=ignore). */
    void (*on_reference_voltage_config)(void* user_data,
                                        uint8_t reference_voltage);
    /**
     * Called once when entering SelfTest state.
     * Performs ADC self-test and connector continuity check, fills
     * `results_out`. After return, core sends the SELF_TEST packet and goes to
     * Active.
     */
    void (*run_self_test)(void* user_data, const StoredSensorConfig& config,
                          std::vector<daq::SelfTestResult>& results_out);
    void* user_data;
};

/** Network task -> ADC task. */
struct AdcCommand {
    enum class Type : uint8_t { ApplyConfig, SetSampling, RunSelfTest };
    Type type;
    bool sampling;        // SetSampling
    uint32_t config_seq;  // ApplyConfig
    StoredSensorConfig config;  // ApplyConfig
};

/** ADC task -> network task: the outcome of a self-test. */
struct AdcSelfTestResult {
    uint8_t adc_good;
    uint8_t num_results;
    daq::SelfTestResult results[MAX_SENSORS_PER_BOARD];
};

constexpr UBaseType_t CHUNK_QUEUE_DEPTH = 2 * HOTFIRE_CHUNKS_PER_PACKET;
constexpr UBaseType_t ADC_COMMAND_QUEUE_DEPTH = 8;
// Priority does not rank these against each other: each task has a core to
// itself. 5 keeps them above Arduino's loopTask (1) and the idle tasks (0),
// and well below ESP-IDF's system tasks (esp_timer 22, ipc 24).
constexpr UBaseType_t SENSOR_TASK_PRIORITY = 5;
constexpr uint32_t ADC_TASK_STACK_BYTES = 6 * 1024;
constexpr uint32_t NET_TASK_STACK_BYTES = 8 * 1024;
constexpr TickType_t NET_TASK_PERIOD_TICKS = pdMS_TO_TICKS(1);
/** Chunks in a row with a data-ready timeout before the ADC is re-set up. */
constexpr uint8_t ADC_REINIT_AFTER_TIMEOUTS = 5;
/** Task watchdog period: a task that stops checking in reboots the board. */
constexpr uint32_t TASK_WATCHDOG_TIMEOUT_S = 5;

struct CoreState {
    uint8_t board_id;
    byte mac[6];
    IPAddress staticIP;
    IPAddress gateway;
    IPAddress subnet;
    IPAddress dns;
    IPAddress serverIP;
    int serverPort;
    const int udpListenPort = 5005;
    const int serverPortDefault = 5006;
    // Address (assigned by the ground station) and server-discovery state.
    // Always present so this struct has one shape.
    BoardNet::State net;
    EthernetUDP udp;
    State state;
    StoredSensorConfig stored_config;  // latest config from the server
    unsigned long lastHeartbeatMillis;
    unsigned long last_led_cycle_millis;
    unsigned long last_led_edge_millis;
    int led_blink_index;
    bool led_on;

    // --- task plumbing ---
    QueueHandle_t chunk_queue;   // ADC -> network, Chunk
    QueueHandle_t adc_commands;  // network -> ADC, AdcCommand
    QueueHandle_t adc_results;   // ADC -> network, AdcSelfTestResult
    std::atomic<uint32_t> chunks_dropped;  // written by the ADC task only

    // --- network-task-only state ---
    StoredSensorConfig adc_config;  // last config handed to the ADC task
    bool adc_config_sent;
    uint32_t config_seq;
    bool sampling_sent;
    ChunkBatch batch;
    uint32_t chunks_dropped_logged;
};

/**
 * Freeze the board's address before a single byte reaches flash. Our address
 * comes from a DHCP lease, and a renewal that landed mid-flash would move us
 * and drop the transfer, so this suspends renewals for the duration.
 */
inline void otaFreezeAddress(void* user_data, uint32_t image_bytes) {
    (void)image_bytes;
    if (user_data)
        BoardNet::beginOtaHold(static_cast<CoreState*>(user_data)->net);
}

inline IncomingPacketKind processIncomingPacket(CoreState& s, const Config& cfg,
                                                const uint8_t* buffer,
                                                size_t len, IPAddress remote_ip,
                                                int remote_port) {
    (void)remote_port;
    uint8_t log_mode = 1;
    const IncomingPacketKind kind =
        parseIncoming(buffer, len, s.stored_config, log_mode);

    if (kind == IncomingPacketKind::ServerHeartbeat) {
#ifdef SENSOR_ETH_USE_DHCP
        BoardNet::onServerPacket(s.net, remote_ip, s.serverIP);
#else
        // Server IP/port are hardcoded; do not update from packet
#endif
        return kind;
    }

    if (kind == IncomingPacketKind::None && len >= sizeof(daq::PacketHeader) &&
        buffer[0] == static_cast<uint8_t>(daq::PacketType::SENSOR_CONFIG)) {
        Serial.println("SENSOR_CONFIG parse failed (DAQv2-Comms)");
        Serial.flush();
        return kind;
    }

    if (kind != IncomingPacketKind::SensorConfig)
        return kind;
    (void)cfg;

    // enable_serial_printing is the mode byte (0..3): bit0 = USB verbose,
    // upper part = server log stream level. See hotfire_log.h.
    g_verbose = (log_mode & 1);
    g_log_stream_level = (log_mode >= 2) ? (log_mode - 1) : 0;

    HF_LOGLN("SENSOR_CONFIG received:");
    // Field-by-field breakdown is verbose-only; the header above is Tier 1.
    HF_VERBOSE("  num_sensors=");
    HF_VERBOSELN(static_cast<unsigned>(s.stored_config.num_sensors));
    HF_VERBOSE("  sensor_ids=");
    if (s.stored_config.num_sensors > 0) {
        for (uint8_t i = 0; i < s.stored_config.num_sensors; ++i) {
            if (i)
                HF_VERBOSE(",");
            HF_VERBOSE(static_cast<unsigned>(s.stored_config.sensor_ids[i]));
        }
        HF_VERBOSELN_();
    } else {
        HF_VERBOSELN("(none)");
    }
    HF_VERBOSE("  reference_voltage=");
    HF_VERBOSELN(static_cast<unsigned>(s.stored_config.reference_voltage));
    HF_VERBOSE("  necessary_for_abort=");
    HF_VERBOSELN(s.stored_config.necessary_for_abort ? 1 : 0);
    HF_VERBOSE("  actuator_controller_ip=");
    if (s.stored_config.actuator_controller_ip != 0) {
        const uint8_t* ip_bytes = reinterpret_cast<const uint8_t*>(
            &s.stored_config.actuator_controller_ip);
        IPAddress actuatorIP(ip_bytes[0], ip_bytes[1], ip_bytes[2],
                             ip_bytes[3]);
        HF_VERBOSELN(actuatorIP);
    } else {
        HF_VERBOSELN("0.0.0.0");
    }
    HF_VERBOSE("  enable_serial_printing=");
    HF_VERBOSELN(g_verbose ? 1 : 0);
    Serial.flush();
#ifdef SENSOR_ETH_USE_DHCP
    BoardNet::onServerPacket(s.net, remote_ip, s.serverIP);
#endif
    return kind;
}

inline void applyPacketTransition(CoreState& s, const Config& cfg,
                                  IncomingPacketKind kind) {
    const State next =
        nextState(s.state, kind, s.stored_config.necessary_for_abort,
                  cfg.run_self_test != nullptr);
    if (next == s.state)
        return;
    s.state = next;
    Serial.print("State -> ");
    Serial.println(stateName(next));
    Serial.flush();
}

inline void sendBoardHeartbeat(CoreState& s, const Config& cfg,
                               daq::BoardState board_state, IPAddress dest_ip,
                               int dest_port) {
    daq::BoardHeartbeatPacket hb;
    memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
    hb.board_id = s.board_id;
    hb.engine_state = daq::EngineState::SAFE;
    hb.board_state = board_state;

    uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
    size_t n = daq::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                  sizeof(packetBuffer));
    if (n == 0)
        return;
    HF_VERBOSE("Sent: heartbeat to ");
    HF_VERBOSE(dest_ip);
    HF_VERBOSE(":");
    HF_VERBOSELN(dest_port);
    s.udp.beginPacket(dest_ip, dest_port);
    s.udp.write(packetBuffer, n);
    s.udp.endPacket();
}

inline void updateStateLed(CoreState& s, const Config& cfg, int state_num) {
    if (state_num < 1)
        state_num = 1;
    if (state_num > 10)
        state_num = 10;
    const int led_pin = cfg.pins->LED;
    unsigned long now = millis();
    const unsigned long STATE_LED_CYCLE_MS = 2500;
    const unsigned long BLINK_ON_MS = 120;
    const unsigned long BLINK_OFF_MS = 120;

    if (now - s.last_led_cycle_millis >= STATE_LED_CYCLE_MS) {
        s.last_led_cycle_millis = now;
        s.last_led_edge_millis = now;
        s.led_blink_index = 0;
        s.led_on = true;
        digitalWrite(led_pin, HIGH);
        return;
    }
    if (s.led_blink_index >= state_num)
        return;
    if (s.led_on) {
        if (now - s.last_led_edge_millis >= BLINK_ON_MS) {
            digitalWrite(led_pin, LOW);
            s.led_on = false;
            s.led_blink_index++;
            s.last_led_edge_millis = now;
        }
    } else {
        if (now - s.last_led_edge_millis >= BLINK_OFF_MS) {
            digitalWrite(led_pin, HIGH);
            s.led_on = true;
            s.last_led_edge_millis = now;
        }
    }
}

// Flush the accumulated log buffer to the server as one LOGS packet (type 15).
// The board is identified server-side by UDP source IP, so no board_id is sent.
inline void flushLogs(CoreState& s) {
    static uint8_t pkt[sizeof(daq::PacketHeader) + 3 + LOG_BUF_SIZE];
    size_t n = 0;
    {
        // Copy out under the lock, send after: the ADC task may be logging.
        HfLogLock lock;
        if (g_logbuf.empty())
            return;
        n = daq::create_log_packet(g_logbuf.flags(), g_logbuf.data(),
                                   g_logbuf.length(), millis(), pkt,
                                   sizeof(pkt));
        g_logbuf.clear();
    }
    if (n > 0) {
        s.udp.beginPacket(s.serverIP, s.serverPort);
        s.udp.write(pkt, n);
        s.udp.endPacket();
    }
}

inline void startTasks(CoreState& s, const Config& cfg);

inline void setup(CoreState& s, const Config& cfg) {
    Serial.begin(115200);
    delay(SERIAL_MONITOR_READY_DELAY_MS);
    FirmwareHash::print();
    HF_LOG(cfg.board_name);
    HF_LOGLN(" Hotfire state machine starting...");

    s.board_id = (uint8_t)BOARD_ID;
    s.staticIP = IPAddress(192, 168, 2, (uint8_t)BOARD_ID);
    HF_LOG("Board ID and IP: ");
    HF_LOG(static_cast<unsigned>(s.board_id));
    HF_LOG(" / 192.168.2.");
    HF_LOGLN(static_cast<unsigned>(s.board_id));

    const sense_board_pins::Layout& Pins = *cfg.pins;
    pinMode(Pins.LED, OUTPUT);
    digitalWrite(Pins.LED, LOW);

    if (cfg.init_adc)
        cfg.init_adc(cfg.user_data);

    ESP_ERROR_CHECK(esp_read_mac(s.mac, ESP_MAC_ETH));
    BoardNet::configure(s.net, s.mac, s.staticIP, s.subnet);
    BoardNet::printMac(s.net);
    SPI.begin(Pins.ETH_SCLK, Pins.ETH_MISO, Pins.ETH_MOSI, Pins.ETH_CS);
    delay(ETHERNET_SPI_DELAY_MS);
    Ethernet.init(Pins.ETH_CS);
    delay(ETHERNET_INIT_DELAY_MS);
#ifdef SENSOR_ETH_USE_DHCP
    // The ground station decides our address; we only ask for one. See
    // board_net.h for what happens when nothing answers.
    BoardNet::begin(s.net, s.dns, s.gateway);
#else
    // Boards that have not opted in keep their compiled-in static address.
    Ethernet.begin(s.mac, s.staticIP, s.dns, s.gateway, s.subnet);
#endif
    delay(ETHERNET_BEGIN_DELAY_MS);

    // W5500 / Ethernet status (same pattern as Stream_ADC_Data and other DAQ
    // sketches)
    HF_LOGLN("[ETH] Ethernet initialized (SPI WIZnet)");
    HF_LOG("Address source: ");
    HF_LOGLN(BoardNet::sourceName(s.net.source));
    HF_LOG("Stack IP (Ethernet.localIP): ");
    HF_LOGLN(Ethernet.localIP());
    HF_LOG("Hardware: ");
    switch (Ethernet.hardwareStatus()) {
        case EthernetNoHardware:
            HF_LOGLN("no chip detected — check CS / SPI wiring");
            break;
        case EthernetW5100:
            HF_LOGLN("W5100");
            break;
        case EthernetW5200:
            HF_LOGLN("W5200");
            break;
        case EthernetW5500:
            HF_LOGLN("W5500");
            break;
        default:
            HF_LOGLN("unknown");
            break;
    }
    HF_LOG("Link status: ");
    if (Ethernet.linkStatus() == LinkON) {
        HF_LOGLN("Connected");
    } else if (Ethernet.linkStatus() == LinkOFF) {
        HF_LOGLN("Disconnected");
    } else {
        HF_LOGLN("Unknown");
    }
    if (Ethernet.localIP() == IPAddress(0, 0, 0, 0)) {
        HF_LOGLN("[ETH] WARNING: stack IP is 0.0.0.0 — check cable / W5500");
    }
    Serial.flush();

    s.udp.begin(SENSOR_UDP_LISTEN_PORT);
    Serial.print("UDP listening on port ");
    Serial.println(SENSOR_UDP_LISTEN_PORT);
    Serial.println(
        "(Expect SENSOR_CONFIG packet type 5 to transition to Active)");
    g_ota_server.onStart(otaFreezeAddress, &s);
    g_ota_server.begin();

    s.state = State::WaitingForServer;
    s.serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
    s.serverPort = HOTFIRE_SERVER_PORT;
    s.lastHeartbeatMillis = 0;
#ifdef SENSOR_ETH_USE_DHCP
    HF_LOGLN(
        "[NET] address assigned by the server; broadcasting until one is "
        "heard");
#endif
    Serial.println("State -> WaitingForServer");
    Serial.flush();
    Serial.print("Config target: send SENSOR_CONFIG to 192.168.2.");
    Serial.print(static_cast<unsigned>(s.board_id));
    Serial.println(":5005");
    Serial.flush();
    HF_LOGLN("Setup complete. State: WaitingForServer");

    // Ethernet is up now, so this is the first log the server can actually
    // receive (boot logs before Ethernet are unsendable). Announce identity +
    // IP and flush immediately so the server sees the board come online.
    HF_LOG("ONLINE board=");
    HF_LOG(static_cast<unsigned>(s.board_id));
    HF_LOG(" ip=");
    HF_LOG(Ethernet.localIP());
    HF_LOGLN_();
    flushLogs(s);

    startTasks(s, cfg);
}

//-----------------------------------------------------------------------------
// ADC task
//-----------------------------------------------------------------------------

// Set in startTasks() from the board's Config; read by waitDrdy().
inline bool g_drdy_sleeps = false;
inline uint32_t g_drdy_timeout_us = UINT32_MAX;
// Set by the first timeout in a chunk; cleared by the ADC task per chunk.
inline bool g_chunk_timed_out = false;

/**
 * Wait for the ADC's data-ready line to go low. At fast data rates this spins
 * (a conversion is tens of microseconds); when a conversion takes 2 ms or
 * more it sleeps 1 ms between checks, so the ADC task gives up its core
 * while it waits.
 *
 * Returns false if the ADC does not answer within 3x the conversions it
 * needs (drdyTimeoutUs). After the first timeout in a chunk every further
 * wait in that chunk fails at once, so a dead ADC costs one timeout per
 * chunk rather than one per channel.
 *
 * ADC task only.
 */
inline bool waitDrdy(int drdy_pin) {
    if (g_chunk_timed_out)
        return false;
    const uint32_t start = micros();
    while (digitalRead(drdy_pin) != LOW) {
        if (micros() - start >= g_drdy_timeout_us) {
            g_chunk_timed_out = true;
            return false;
        }
        if (g_drdy_sleeps)
            vTaskDelay(1);
        else
            delayMicroseconds(10);
    }
    return true;
}

/**
 * Subscribe the calling task to the task watchdog. If either sensor task
 * stops calling watchdogCheckIn() for TASK_WATCHDOG_TIMEOUT_S, the board
 * reboots and comes back in WaitingForServer.
 */
inline void watchdogSubscribe(const char* task_name) {
    esp_err_t err = esp_task_wdt_add(nullptr);
    if (err == ESP_ERR_INVALID_STATE) {
        // This core's sdkconfig did not start the watchdog; start it.
#if ESP_IDF_VERSION_MAJOR >= 5
        esp_task_wdt_config_t wdt = {};
        wdt.timeout_ms = TASK_WATCHDOG_TIMEOUT_S * 1000;
        wdt.trigger_panic = true;
        esp_task_wdt_init(&wdt);
#else
        esp_task_wdt_init(TASK_WATCHDOG_TIMEOUT_S, true);
#endif
        err = esp_task_wdt_add(nullptr);
    }
    if (err != ESP_OK) {
        HF_LOG("[TASK] WARNING: ");
        HF_LOG(task_name);
        HF_LOGLN(" could not join the task watchdog");
    }
}

inline void watchdogCheckIn() {
    esp_task_wdt_reset();
}

/** Print how much of the calling task's stack has never been touched. */
inline void logStackHeadroom(const char* task_name) {
    HF_LOG("[TASK] ");
    HF_LOG(task_name);
    HF_LOG(" stack headroom: ");
    HF_LOG(static_cast<unsigned>(uxTaskGetStackHighWaterMark(nullptr)));
    HF_LOGLN(" bytes");
}

/** Periodic headroom report: once 5 s after start, then every 30 s when
 *  verbose. */
inline void maybeLogStackHeadroom(const char* task_name,
                                  unsigned long& next_ms, bool& first_done) {
    const unsigned long now = millis();
    if (static_cast<long>(now - next_ms) < 0)
        return;
    if (!first_done || g_verbose)
        logStackHeadroom(task_name);
    first_done = true;
    next_ms = now + 30000;
}

struct FreeRtosChunkQueue {
    QueueHandle_t q;
    bool trySend(const Chunk& c) {
        return xQueueSend(q, &c, 0) == pdTRUE;
    }
    bool tryReceive(Chunk& c) {
        return xQueueReceive(q, &c, 0) == pdTRUE;
    }
};

struct TaskArgs {
    CoreState* s;
    const Config* cfg;
};

inline void runSelfTestOnAdc(CoreState& s, const Config& cfg,
                             const StoredSensorConfig& config) {
    std::vector<daq::SelfTestResult> results;
    cfg.run_self_test(cfg.user_data, config, results);

    AdcSelfTestResult out{};
    if (!results.empty() && results[0].sensor_id == 0) {
        out.adc_good = results[0].result;
        results.erase(results.begin());
    }
    out.num_results = static_cast<uint8_t>(
        results.size() <= MAX_SENSORS_PER_BOARD ? results.size()
                                                : MAX_SENSORS_PER_BOARD);
    for (uint8_t i = 0; i < out.num_results; ++i)
        out.results[i] = results[i];
    xQueueSend(s.adc_results, &out, portMAX_DELAY);
}

inline void adcTask(void* arg) {
    CoreState& s = *static_cast<TaskArgs*>(arg)->s;
    const Config& cfg = *static_cast<TaskArgs*>(arg)->cfg;
    FreeRtosChunkQueue chunks{s.chunk_queue};

    StoredSensorConfig config{};
    uint32_t config_seq = 0;
    bool have_reference = false;
    uint8_t reference = 0;
    bool sampling = false;
    unsigned long next_stack_log_ms = millis() + 5000;
    bool stack_logged = false;
    uint8_t timeouts_in_a_row = 0;
    uint32_t timeouts_total = 0;
    uint32_t timeouts_logged = 0;
    unsigned long last_timeout_log_ms = 0;

    watchdogSubscribe("adc");
    SensorSelfTest::g_check_in = watchdogCheckIn;
    SensorSelfTest::g_drdy_timeout_us = g_drdy_timeout_us;

    for (;;) {
        watchdogCheckIn();
        // Idle: sleep until told to do something. Sampling: just check.
        const bool will_sample =
            sampling && config.num_sensors > 0 && cfg.read_chunk;
        TickType_t wait = will_sample ? 0 : pdMS_TO_TICKS(100);
        AdcCommand cmd;
        while (xQueueReceive(s.adc_commands, &cmd, wait) == pdTRUE) {
            wait = 0;
            switch (cmd.type) {
                case AdcCommand::Type::ApplyConfig:
                    config = cmd.config;
                    config_seq = cmd.config_seq;
                    if (cfg.on_reference_voltage_config &&
                        (!have_reference ||
                         reference != config.reference_voltage)) {
                        cfg.on_reference_voltage_config(
                            cfg.user_data, config.reference_voltage);
                        reference = config.reference_voltage;
                        have_reference = true;
                    }
                    break;
                case AdcCommand::Type::SetSampling:
                    sampling = cmd.sampling;
                    break;
                case AdcCommand::Type::RunSelfTest:
                    if (cfg.run_self_test)
                        runSelfTestOnAdc(s, cfg, config);
                    break;
            }
        }

        maybeLogStackHeadroom("adc", next_stack_log_ms, stack_logged);

        if (!sampling || config.num_sensors == 0 || !cfg.read_chunk)
            continue;  // the command wait above was the sleep

        Chunk chunk{};
        chunk.timestamp_ms = millis();
        chunk.config_seq = config_seq;
        chunk.num_sensors = config.num_sensors;
        memcpy(chunk.sensor_ids, config.sensor_ids, config.num_sensors);
        g_chunk_timed_out = false;
        const bool keep = cfg.read_chunk(cfg.user_data, config, chunk);
        if (g_chunk_timed_out) {
            // The board wrote 0 for every channel from the timeout on.
            timeouts_total++;
            timeouts_in_a_row++;
        } else {
            timeouts_in_a_row = 0;
        }
        if (keep && pushDropOldest(chunks, chunk))
            s.chunks_dropped.fetch_add(1, std::memory_order_relaxed);

        if (timeouts_total != timeouts_logged &&
            millis() - last_timeout_log_ms >= 1000) {
            last_timeout_log_ms = millis();
            timeouts_logged = timeouts_total;
            HF_LOG("[ADC] WARNING: data-ready timeout (");
            HF_LOG(static_cast<unsigned>(timeouts_in_a_row));
            HF_LOG(" chunk(s) in a row, ");
            HF_LOG(timeouts_total);
            HF_LOGLN(" total); sending 0 for missed channels");
        }
        if (timeouts_in_a_row >= ADC_REINIT_AFTER_TIMEOUTS) {
            HF_LOG("[ADC] ");
            HF_LOG(static_cast<unsigned>(ADC_REINIT_AFTER_TIMEOUTS));
            HF_LOGLN(" timeouts in a row -- re-initialising the ADC");
            if (cfg.init_adc)
                cfg.init_adc(cfg.user_data);
            if (cfg.on_reference_voltage_config && have_reference)
                cfg.on_reference_voltage_config(cfg.user_data, reference);
            timeouts_in_a_row = 0;
        }
        // Same cadence as the old single loop: one chunk, then a short rest.
        vTaskDelay(pdMS_TO_TICKS(LOOP_DELAY_MS));
    }
}

//-----------------------------------------------------------------------------
// Network task
//-----------------------------------------------------------------------------

inline void sendAdcCommand(CoreState& s, const AdcCommand& cmd) {
    if (xQueueSend(s.adc_commands, &cmd, pdMS_TO_TICKS(100)) != pdTRUE)
        HF_LOGLN("[ADC] WARNING: command queue full, command dropped");
}

/** Hand the ADC task the server's config, but only when it changed. */
inline void syncAdcConfig(CoreState& s) {
    const StoredSensorConfig& now = s.stored_config;
    const bool layout_changed =
        !s.adc_config_sent || !sameSensorList(now, s.adc_config);
    if (!layout_changed &&
        now.reference_voltage == s.adc_config.reference_voltage)
        return;
    if (layout_changed)
        s.config_seq++;
    AdcCommand cmd{};
    cmd.type = AdcCommand::Type::ApplyConfig;
    cmd.config_seq = s.config_seq;
    cmd.config = now;
    sendAdcCommand(s, cmd);
    s.adc_config = now;
    s.adc_config_sent = true;
}

inline bool shouldSample(State st) {
    return st == State::Active || st == State::StandaloneAbort;
}

inline void syncSampling(CoreState& s) {
    const bool want = shouldSample(s.state);
    if (want == s.sampling_sent)
        return;
    AdcCommand cmd{};
    cmd.type = AdcCommand::Type::SetSampling;
    cmd.sampling = want;
    sendAdcCommand(s, cmd);
    s.sampling_sent = want;
}

inline IPAddress actuatorControllerIP(const CoreState& s) {
    const uint8_t* ip_bytes =
        reinterpret_cast<const uint8_t*>(&s.stored_config.actuator_controller_ip);
    return IPAddress(ip_bytes[0], ip_bytes[1], ip_bytes[2], ip_bytes[3]);
}

/** Send the batch as one SENSOR_DATA packet (short is fine), then clear it. */
inline void sendBatch(CoreState& s) {
    if (s.batch.empty())
        return;
    if (!shouldSample(s.state)) {
        s.batch.clear();
        return;
    }
    uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
    size_t packetSize =
        s.batch.buildPacket(millis(), packetBuffer, sizeof(packetBuffer));
    if (packetSize == 0) {
        HF_VERBOSE("Send FAIL: create_sensor_data_packet returned 0 (n=");
        HF_VERBOSE(s.batch.size());
        HF_VERBOSE(", buf=");
        HF_VERBOSE(SENSOR_HOTFIRE_MAX_PACKET_SIZE);
        HF_VERBOSELN(")");
        s.batch.clear();
        return;
    }
    s.udp.beginPacket(s.serverIP, s.serverPort);
    s.udp.write(packetBuffer, packetSize);
    s.udp.endPacket();
    HF_VERBOSE("Sent: sensor_data to ");
    HF_VERBOSE(s.serverIP);
    HF_VERBOSE(":");
    HF_VERBOSELN(s.serverPort);

    static unsigned long s_last_dump_ms = 0;
    unsigned long now = millis();
    if (now - s_last_dump_ms >= 1000) {
        s_last_dump_ms = now;
        HF_VERBOSELN("SENSOR_DATA contents:");
        for (uint8_t i = 0; i < s.batch.size(); ++i) {
            const Chunk& chunk = s.batch.at(i);
            HF_VERBOSE("  chunk ");
            HF_VERBOSE(i);
            HF_VERBOSE(" ts=");
            HF_VERBOSE(chunk.timestamp_ms);
            HF_VERBOSE(" :");
            for (uint8_t j = 0; j < chunk.num_sensors; ++j) {
                HF_VERBOSE(" (id=");
                HF_VERBOSE(static_cast<unsigned>(chunk.sensor_ids[j]));
                HF_VERBOSE(", data=");
                HF_VERBOSE(chunk.values[j]);
                HF_VERBOSE(")");
            }
            HF_VERBOSELN_();
        }
    }

    if (s.state == State::StandaloneAbort && s.stored_config.valid &&
        s.stored_config.actuator_controller_ip != 0) {
        const IPAddress actuatorIP = actuatorControllerIP(s);
        s.udp.beginPacket(actuatorIP, s.serverPortDefault);
        s.udp.write(packetBuffer, packetSize);
        s.udp.endPacket();
        HF_VERBOSE("Sent: sensor_data to ");
        HF_VERBOSE(actuatorIP);
        HF_VERBOSE(":");
        HF_VERBOSELN(s.serverPortDefault);
    }
    s.batch.clear();
}

/** Move every chunk the ADC task has queued into packets. */
inline void drainChunks(CoreState& s) {
    Chunk chunk;
    while (xQueueReceive(s.chunk_queue, &chunk, 0) == pdTRUE) {
        if (s.batch.mustSendBefore(chunk))
            sendBatch(s);
        s.batch.add(chunk);
        if (s.batch.full())
            sendBatch(s);
    }

    const uint32_t dropped = s.chunks_dropped.load(std::memory_order_relaxed);
    static unsigned long s_last_drop_log_ms = 0;
    if (dropped != s.chunks_dropped_logged &&
        millis() - s_last_drop_log_ms >= 1000) {
        s_last_drop_log_ms = millis();
        HF_LOG("[ADC] WARNING: chunk queue full, dropped ");
        HF_LOG(dropped - s.chunks_dropped_logged);
        HF_LOG(" oldest chunk(s) (");
        HF_LOG(dropped);
        HF_LOGLN(" total)");
        s.chunks_dropped_logged = dropped;
    }
}

/** A self-test finished on the ADC task: report it and go Active. */
inline void handleSelfTestResult(CoreState& s) {
    AdcSelfTestResult r;
    if (xQueueReceive(s.adc_results, &r, 0) != pdTRUE)
        return;
    if (s.state != State::SelfTest)
        return;
    std::vector<daq::SelfTestResult> results(r.results,
                                             r.results + r.num_results);
    uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
    size_t packetSize = daq::create_self_test_packet(
        r.adc_good, results, millis(), packetBuffer, sizeof(packetBuffer));
    if (packetSize > 0) {
        s.udp.beginPacket(s.serverIP, s.serverPort);
        s.udp.write(packetBuffer, packetSize);
        s.udp.endPacket();
        HF_VERBOSE("Sent: SELF_TEST to ");
        HF_VERBOSE(s.serverIP);
        HF_VERBOSE(":");
        HF_VERBOSELN(s.serverPort);
    }
    s.state = State::Active;
    Serial.println("State -> Active");
    Serial.flush();
}

/** Read and act on one waiting packet. Returns false when none is waiting. */
inline bool receiveOnePacket(CoreState& s, const Config& cfg) {
    int packetSize = s.udp.parsePacket();
    if (packetSize <= 0)
        return false;

    IPAddress remoteIP = s.udp.remoteIP();
    int remotePort = s.udp.remotePort();
    uint8_t packetBuffer[SENSOR_HOTFIRE_MAX_PACKET_SIZE];
    int bytesRead = s.udp.read(packetBuffer, sizeof(packetBuffer));
    if (bytesRead <= 0) {
        HF_LOG("WARNING: parsePacket returned ");
        HF_LOG(packetSize);
        HF_LOGLN(" but read() returned 0");
        return true;
    }
    HF_VERBOSE("Received packet from ");
    HF_VERBOSE(remoteIP);
    HF_VERBOSE(":");
    HF_VERBOSE(remotePort);
    HF_VERBOSE(" type ");
    HF_VERBOSE(static_cast<unsigned>(packetBuffer[0]));
    HF_VERBOSE(" (");
    HF_VERBOSE(packetTypeName(packetBuffer[0]));
    HF_VERBOSE(") len=");
    HF_VERBOSE(bytesRead);
    HF_VERBOSE(" hex:");
    for (int i = 0; i < bytesRead && i < 12; i++) {
        HF_VERBOSE(" ");
        if (packetBuffer[i] < 16)
            HF_VERBOSE("0");
        HF_VERBOSE(packetBuffer[i], HEX);
    }
    HF_VERBOSELN_();

    IncomingPacketKind kind = processIncomingPacket(
        s, cfg, packetBuffer, bytesRead, remoteIP, remotePort);
    if (kind == IncomingPacketKind::SensorConfig) {
        HF_VERBOSELN("SENSOR_CONFIG parsed");
        syncAdcConfig(s);
    } else if (static_cast<uint8_t>(packetBuffer[0]) == 6) {
        Serial.println(
            "(Packet type 6 = ACTUATOR_CONFIG; sensor boards expect "
            "SENSOR_CONFIG type 5)");
        Serial.flush();
    } else if (static_cast<uint8_t>(packetBuffer[0]) == 5) {
        Serial.println(
            "(Type 5 received but parse failed - check header/length)");
        Serial.flush();
    }

    const State before = s.state;
    applyPacketTransition(s, cfg, kind);
    if (before != State::SelfTest && s.state == State::SelfTest) {
        AdcCommand cmd{};
        cmd.type = AdcCommand::Type::RunSelfTest;
        sendAdcCommand(s, cmd);
    }
    return true;
}

/** One pass of the network task. */
inline void networkStep(CoreState& s, const Config& cfg) {
#ifdef SENSOR_ETH_USE_DHCP
    // Renew the lease as it expires; no-op while an OTA is in flight.
    BoardNet::maintainLease(s.net);
#endif
    // One step of any OTA transfer; never blocks for more than a chunk, so the
    // watchdog and heartbeats keep running during an upload. Reboots into the
    // new image on success.
    //
    // Updates are only allowed in WaitingForServer: never flash a board that
    // is streaming for a test. Sampling is already off in that state, and a
    // transfer under way is aborted if the board moves on.
    const bool ota_allowed = s.state == State::WaitingForServer;
    if (g_ota_server.service(ota_allowed) == StarOTA::Result::Refused) {
        HF_LOG("[OTA] update refused: board is in ");
        HF_LOG(stateName(s.state));
        HF_LOGLN("; updates are only accepted in WaitingForServer");
    }
    // Bench marker: prints only on builds made with -DSTAR_OTA_TEST_MESSAGE,
    // so consecutive OTA uploads are visibly different on the serial monitor.
    StarOTA::printTestMessage();

    static uint32_t s_udp_check_count = 0;
    static unsigned long s_last_debug_ms = 0;
    s_udp_check_count++;

    // Read everything that is waiting, not one packet per pass: the server
    // broadcasts a heartbeat every 200 ms, and anything less falls behind.
    while (receiveOnePacket(s, cfg)) {
    }

#ifdef SENSOR_ETH_USE_DHCP
    // Server gone quiet: forget it and resume discovery broadcasts so a new
    // (or restarted) server can find us. Our address is unaffected -- it is
    // the server's to change, not ours.
    if (BoardNet::serverWentSilent(s.net)) {
        s.net.serverLearned = false;
        s.serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
        Serial.println("[NET] server silent -- resuming discovery");
        Serial.flush();
    }
#endif

    handleSelfTestResult(s);
    syncSampling(s);
    drainChunks(s);

    updateStateLed(s, cfg, static_cast<int>(s.state));

    unsigned long now = millis();
    if (s.state == State::WaitingForServer && (now - s_last_debug_ms >= 2000)) {
        s_last_debug_ms = now;
        HF_VERBOSE(cfg.board_name);
        HF_VERBOSE(" debug: state=WaitingForServer IP=");
        HF_VERBOSE(Ethernet.localIP());
        HF_VERBOSE(" network_passes=");
        HF_VERBOSELN(s_udp_check_count);
    }
    if (now - s.lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
        s.lastHeartbeatMillis = now;
        if (s.state == State::WaitingForServer)
            HF_VERBOSELN("Setup state: sending heartbeat");
        sendBoardHeartbeat(s, cfg, boardStateFor(s.state), s.serverIP,
                           s.serverPort);
        if (s.state == State::StandaloneAbort && s.stored_config.valid &&
            s.stored_config.actuator_controller_ip != 0)
            sendBoardHeartbeat(s, cfg, daq::BoardState::STANDALONE_ABORT,
                               actuatorControllerIP(s), s.serverPortDefault);
#ifdef SENSOR_ETH_USE_DHCP
        // Discovery: announce to everyone on the wire until a server is
        // learned. Reuses the normal heartbeat packet on the same 1 s tick.
        if (!s.net.serverLearned)
            sendBoardHeartbeat(s, cfg, boardStateFor(s.state),
                               IPAddress(255, 255, 255, 255),
                               HOTFIRE_SERVER_PORT);
#endif
    }

    // Flush buffered logs to the server ~1 Hz (or sooner if the buffer is
    // filling).
    static unsigned long s_last_log_flush_ms = 0;
    bool flush_due;
    {
        HfLogLock lock;
        flush_due = !g_logbuf.empty() &&
                    (g_logbuf.nearFull() || now - s_last_log_flush_ms >= 1000);
    }
    if (flush_due) {
        s_last_log_flush_ms = now;
        flushLogs(s);
    }
}

inline void networkTask(void* arg) {
    CoreState& s = *static_cast<TaskArgs*>(arg)->s;
    const Config& cfg = *static_cast<TaskArgs*>(arg)->cfg;
    unsigned long next_stack_log_ms = millis() + 5000;
    bool stack_logged = false;
    watchdogSubscribe("network");
    TickType_t last_wake = xTaskGetTickCount();
    for (;;) {
        watchdogCheckIn();
        networkStep(s, cfg);
        maybeLogStackHeadroom("network", next_stack_log_ms, stack_logged);
        vTaskDelayUntil(&last_wake, NET_TASK_PERIOD_TICKS);
    }
}

/** Create the queues and start both tasks. Called at the end of setup(). */
inline void startTasks(CoreState& s, const Config& cfg) {
    static TaskArgs args;
    args.s = &s;
    args.cfg = &cfg;
    g_drdy_sleeps = conversionPeriodUs(cfg.adc_rate_code) >= 2000;
    g_drdy_timeout_us =
        drdyTimeoutUs(cfg.adc_rate_code, cfg.adc_settle_conversions);

    s.chunk_queue = xQueueCreate(CHUNK_QUEUE_DEPTH, sizeof(Chunk));
    s.adc_commands = xQueueCreate(ADC_COMMAND_QUEUE_DEPTH, sizeof(AdcCommand));
    s.adc_results = xQueueCreate(1, sizeof(AdcSelfTestResult));
    if (!s.chunk_queue || !s.adc_commands || !s.adc_results) {
        Serial.println("FATAL: could not allocate task queues; restarting");
        Serial.flush();
        delay(1000);
        ESP.restart();
    }

    xTaskCreatePinnedToCore(adcTask, "adc", ADC_TASK_STACK_BYTES, &args,
                            SENSOR_TASK_PRIORITY, nullptr, 1);
    xTaskCreatePinnedToCore(networkTask, "network", NET_TASK_STACK_BYTES,
                            &args, SENSOR_TASK_PRIORITY, nullptr, 0);
}

/** Arduino's loop() has nothing left to do: the tasks run the board. */
inline void loop(CoreState& s, const Config& cfg) {
    (void)s;
    (void)cfg;
    vTaskDelete(nullptr);
}

}  // namespace SensorHotfire
