/**
 * Ball Valve Hotfire — STAR Prop Receiver v2 (ESP32-S3-WROOM-1-N16R2 + W5500).
 *
 * The board's own notes (pins, values, designators, bring-up) are in
 * HARDWARE.md next to this file. Two channels, each:
 *
 *   command   MCP4728 DAC (I2C 0x60, channel A = valve 1, B = valve 2) into
 *             an XTR111, 10 mA per volt: a 4-20 mA loop sourced from the 24 V
 *             supply into the actuator's input. ACTUATOR_COMMAND state 1 is
 *             20 mA (valve open), state 0 is 4 mA (valve closed).
 *   position  The actuator's 4-20 mA feedback (FB) across 120 ohm into ADC1,
 *             streamed to the server as SENSOR_DATA. Read calibrated (mV),
 *             then sent as the 12-bit counts daq-server's ideal loop model
 *             expects (calibration/ValvePosition.hpp: 100 ohm, counts / 4095
 *             * 3.3 V), so the server needs no change for this board.
 *   checks    The command loop's return current (RET, 120 ohm), the XTR111
 *             error flag (FAULT, low = fault) and the 24 V input monitor.
 *             Faults are logged (serial and the server's log stream) when they
 *             set and clear; they never move a valve, which stays the
 *             server's call.
 *
 * State machine: WaitingForServer -> Active while SERVER_HEARTBEATs are
 * current, back to WaitingForServer with every valve in SAFE_STATE (1, open)
 * when they stop for HEARTBEAT_TIMEOUT_MS, and when an OTA starts. A command
 * to SAFE_STATE is always obeyed; leaving it needs Active. Position is
 * streamed in both states.
 *
 * Boot is 0 (closed, 4 mA): the MCP4728 loads 4 mA from its EEPROM at power-
 * up, and setup() writes it again first thing, because an ESP32 reset does not
 * reset the DAC — it holds the last command until we write. A board whose DAC
 * EEPROM does not hold 4 mA (a fresh chip comes up at 0 mA on VREF = VDD) is
 * programmed once at boot. Losing the 3.3 V logic supply takes the DAC to
 * 0 mA, below the loop's 4 mA: the actuator's own loss-of-signal behaviour.
 *
 * Networking, heartbeats, logs, firmware hash and Ethernet OTA match the
 * hotfire boards (Actuator_Hotfire, common/). The server's
 * [boards.ball_valve_board] lists the valves as active_connectors [1, 2].
 */

#include "main.h"

#include <Arduino.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <SPI.h>
#include <STAR_EthernetOTA.h>
#include <Wire.h>
#include <daq-protocol.h>
#include <esp_mac.h>

#include <cmath>
#include <cstring>
#include <vector>

#include "actuator_config.h"
#include "board_net.h"
#include "firmware_hash.h"

//-----------------------------------------------------------------------------
// Pin definitions — STAR Prop Receiver v2 (HARDWARE.md, "GPIO map")
//-----------------------------------------------------------------------------

// W5500 on SPI2 through the GPIO matrix (not SPI2's IO_MUX pins)
static constexpr int ETH_MOSI = 10;
static constexpr int ETH_SCLK = 11;
static constexpr int ETH_CS = 12;
static constexpr int ETH_INT =
    13;  // active low; unused by the Ethernet library
static constexpr int ETH_RST = 14;  // active low
static constexpr int ETH_MISO = 21;

// MCP4728 DAC
static constexpr int I2C_SDA = 47;
static constexpr int I2C_SCL = 48;
static constexpr uint32_t I2C_HZ = 400000;

// 24 V input monitor: 100k over 10k
static constexpr int V24_MON_PIN = 9;
static constexpr float V24_DIVIDER = 11.0f;

//-----------------------------------------------------------------------------
// Loop scaling
//-----------------------------------------------------------------------------

// MCP4728 on its internal 2.048 V reference, gain x1: 0.5 mV per code, and
// the XTR111's 1.00 k R_SET gives 10 mA per volt, so 5 uA per code.
static constexpr float DAC_CODES_PER_MA = 200.0f;
static constexpr uint16_t CODE_CLOSED = 800;  // 4 mA (state 0)
static constexpr uint16_t CODE_OPEN = 4000;   // 20 mA (state 1)

// FB and RET are both sensed on 120 ohm to GND.
static constexpr float SENSE_OHMS = 120.0f;

// daq-server's ideal loop (calibration/ValvePosition.hpp, ball-valve-cal.ts):
// counts = mA * 100 ohm / 3.3 V * 4095. Position goes out on this scale.
static constexpr float SERVER_SHUNT_OHMS = 100.0f;
static constexpr float SERVER_ADC_REF_MV = 3300.0f;
static constexpr float SERVER_ADC_MAX_COUNTS = 4095.0f;

// Samples averaged per reading; the ESP32 ADC is noisy.
static constexpr int ADC_SAMPLES = 16;

// Where every valve goes when the server is lost: 1 = 20 mA = open.
static constexpr uint8_t SAFE_STATE = 1;

//-----------------------------------------------------------------------------
// Fault thresholds (NAMUR NE43; HARDWARE.md, "Suggested fault logic")
//-----------------------------------------------------------------------------
static constexpr float V24_MISSING_V = 18.0f;
static constexpr float V24_OVER_V = 28.0f;  // input TVS conducts near 29 V
static constexpr float LOOP_LOW_MA = 3.6f;  // RET or FB below: open / lost
static constexpr float FB_HIGH_MA = 21.0f;  // FB above: over-range / short
static constexpr float TRACKING_MA =
    0.5f;  // |RET - command| above: not tracking

static constexpr unsigned long MONITOR_INTERVAL_MS = 20;
// A condition must hold (or be gone) this long before it is reported. Longer
// than the 1 ms sense filters and the XTR111's ~0.7 ms error-flag delay.
static constexpr unsigned long FAULT_HOLD_MS = 50;
// After 24 V arrives, or a command steps, before the loop is judged.
static constexpr unsigned long SETTLE_MS = 100;
// The DAC's setpoints are rewritten this often, so a glitch on the bus or a
// DAC that reloaded its EEPROM cannot leave a valve somewhere we did not say.
static constexpr unsigned long DAC_REFRESH_MS = 1000;

//-----------------------------------------------------------------------------
// Valves
//-----------------------------------------------------------------------------

/** A condition reported only once it has held, or been gone, FAULT_HOLD_MS. */
struct Debounced {
    bool active = false;
    bool pending = false;
    unsigned long since = 0;

    /** True when `active` changed. */
    bool update(bool cond, unsigned long now) {
        if (cond == active) {
            pending = false;
            return false;
        }
        if (!pending) {
            pending = true;
            since = now;
        }
        if (now - since < FAULT_HOLD_MS)
            return false;
        active = cond;
        pending = false;
        return true;
    }

    void reset() {
        *this = Debounced();
    }
};

enum LoopFault : uint8_t {
    FAULT_LOOP_OPEN,     // RET < 3.6 mA while commanding >= 4 mA
    FAULT_NOT_TRACKING,  // RET more than 0.5 mA from the command
    FAULT_FB_LOST,       // FB < 3.6 mA
    FAULT_FB_OVER,       // FB > 21 mA
    FAULT_XTR111,        // XTR111 EF low: cannot regulate the loop
    NUM_LOOP_FAULTS
};

static const char* const LOOP_FAULT_NAMES[NUM_LOOP_FAULTS] = {
    "command loop open", "command loop not tracking", "feedback lost",
    "feedback over-range", "XTR111 error flag"};

struct Valve {
    uint8_t actuator_id;  // ACTUATOR_COMMAND id (1-based)
    uint8_t sensor_id;    // SENSOR_DATA id of its position readback
    uint8_t dac_channel;  // MCP4728 channel: 0 = A, 1 = B
    int fb_pin;           // ADC1: actuator position feedback, 120 ohm
    int ret_pin;          // ADC1: command-loop return current, 120 ohm
    int fault_pin;        // XTR111 EF, open drain with pull-up, low = fault
    uint8_t state;        // last commanded state
    unsigned long commanded_at_ms;
    float fb_ma;  // last monitor readings
    float ret_ma;
    bool ef_low;
    Debounced faults[NUM_LOOP_FAULTS];
};

// Strapping pins (0, 3, 45, 46) and USB (19, 20) are not used.
static Valve valves[] = {
    {1, 1, 0, 7, 5, 15, 0, 0, 0, 0, false, {}},
    {2, 2, 1, 2, 1, 40, 0, 0, 0, 0, false, {}},
};
static constexpr uint8_t NUM_VALVES = sizeof(valves) / sizeof(valves[0]);

static float v24_volts = 0.0f;
static Debounced v24_missing;
static Debounced v24_over;
static unsigned long v24_present_since_ms = 0;

//-----------------------------------------------------------------------------
// Board identity and network
//-----------------------------------------------------------------------------
static uint8_t board_id = 0;  // from the DHCP-assigned address; see board_net.h
static byte mac[6];
static IPAddress gateway(0, 0, 0, 0);
static IPAddress subnet(255, 255, 255, 0);
static IPAddress dns(192, 168, 2, 1);
static IPAddress serverIP(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
static const int udpListenPort = 5005;
static const int serverPort = HOTFIRE_SERVER_PORT;
static EthernetUDP udp;
static StarOTA::Server otaServer(HOTFIRE_OTA_PORT);
static BoardNet::State net;
// False when no W5500 answered at boot. The Ethernet library then reads
// garbage socket state and network calls can stall, so they are all skipped
// and the valves stay at 0.
static bool eth_present = false;

#include "hotfire_log.h"
bool g_verbose = true;

//-----------------------------------------------------------------------------
// State machine
//-----------------------------------------------------------------------------
enum class BallValveState : uint8_t {
    WaitingForServer = 1,  // SETUP
    Active = 2
};

static BallValveState state = BallValveState::WaitingForServer;
static unsigned long last_server_heartbeat_ms = 0;
static unsigned long last_position_send_ms = 0;
static unsigned long last_monitor_ms = 0;
static unsigned long last_dac_refresh_ms = 0;
static unsigned long lastHeartbeatMillis = 0;

static const char* stateName(BallValveState s) {
    switch (s) {
        case BallValveState::WaitingForServer:
            return "WaitingForServer";
        case BallValveState::Active:
            return "Active";
        default:
            return "?";
    }
}

static void setState(BallValveState new_state) {
    if (state != new_state) {
        HF_LOG("State -> ");
        HF_LOGLN(stateName(new_state));
        Serial.flush();
        state = new_state;
    }
}

//-----------------------------------------------------------------------------
// MCP4728 (HARDWARE.md, "Command output")
//-----------------------------------------------------------------------------
static constexpr uint8_t DAC_ADDR = 0x60;
static constexpr uint8_t DAC_CMD_VREF_ALL_INTERNAL = 0x8F;  // 100x VA VB VC VD
static constexpr uint8_t DAC_CMD_GAIN_ALL_X1 = 0xC0;        // 110x GA GB GC GD
static constexpr uint8_t DAC_CMD_SINGLE_WRITE = 0x58;  // 01011 DAC1 DAC0 UDAC
static constexpr uint8_t DAC_VREF_INTERNAL = 0x80;     // VREF bit, data byte
static constexpr unsigned long DAC_EEPROM_WRITE_MS =
    100;  // datasheet: 50 ms max

static bool dac_ok = false;

static uint16_t codeForState(uint8_t s) {
    return s ? CODE_OPEN : CODE_CLOSED;
}

static float commandedMa(const Valve& v) {
    return codeForState(v.state) / DAC_CODES_PER_MA;
}

static bool dacCommand(uint8_t cmd) {
    Wire.beginTransmission(DAC_ADDR);
    Wire.write(cmd);
    return Wire.endTransmission() == 0;
}

/**
 * Internal reference, gain x1, then every channel's code in one fast write
 * (input registers only, never the EEPROM). With LDAC tied low each output
 * moves as its bytes arrive. C and D are not connected and get code 0.
 */
static bool dacApply() {
    uint16_t codes[4] = {0, 0, 0, 0};
    for (const auto& v : valves)
        codes[v.dac_channel] = codeForState(v.state);

    bool ok = dacCommand(DAC_CMD_VREF_ALL_INTERNAL) &&
              dacCommand(DAC_CMD_GAIN_ALL_X1);
    Wire.beginTransmission(DAC_ADDR);
    for (uint16_t code : codes) {
        Wire.write(static_cast<uint8_t>((code >> 8) & 0x0F));  // 00 PD=00 D11-8
        Wire.write(static_cast<uint8_t>(code & 0xFF));
    }
    ok = (Wire.endTransmission() == 0) && ok;

    if (ok != dac_ok) {
        dac_ok = ok;
        HF_LOGLN(ok ? "[DAC] MCP4728 answering"
                    : "[DAC] MCP4728 not answering at 0x60 -- valves cannot be "
                      "commanded; check I2C (SDA 47, SCL 48) and 3.3 V");
    }
    return ok;
}

/** All 24 bytes: per channel, 3 of DAC register then 3 of EEPROM. */
static bool dacReadAll(uint8_t (&buf)[24]) {
    if (Wire.requestFrom(DAC_ADDR, static_cast<uint8_t>(sizeof(buf))) !=
        sizeof(buf))
        return false;
    for (auto& b : buf)
        b = Wire.read();
    return true;
}

/**
 * Make the EEPROM hold what the board assumes at power-up on every valve's
 * channel: internal reference, gain x1, PD 00, 4 mA. A fresh chip holds
 * VREF = VDD and code 0. Written only when it differs, so this costs one
 * EEPROM cycle per board, not per boot.
 */
static void dacEnsureEeprom() {
    uint8_t buf[24];
    if (!dacReadAll(buf)) {
        HF_LOGLN("[DAC] EEPROM read failed");
        return;
    }
    const uint8_t want_hi = DAC_VREF_INTERNAL | (CODE_CLOSED >> 8);
    const uint8_t want_lo = CODE_CLOSED & 0xFF;
    for (const auto& v : valves) {
        const uint8_t* ee = &buf[v.dac_channel * 6 + 3];
        if (ee[1] == want_hi && ee[2] == want_lo)
            continue;
        HF_LOGF(
            "[DAC] channel %c EEPROM 0x%02X%02X, writing 4 mA power-up "
            "default\n",
            'A' + v.dac_channel, ee[1], ee[2]);
        Wire.beginTransmission(DAC_ADDR);
        Wire.write(
            static_cast<uint8_t>(DAC_CMD_SINGLE_WRITE | (v.dac_channel << 1)));
        Wire.write(want_hi);
        Wire.write(want_lo);
        if (Wire.endTransmission() != 0) {
            HF_LOGLN("[DAC] EEPROM write failed");
            continue;
        }
        // RDY/BSY is not wired: poll its bit (byte 0 bit 7, 1 = ready).
        unsigned long t0 = millis();
        do {
            delay(5);
        } while (millis() - t0 < DAC_EEPROM_WRITE_MS && dacReadAll(buf) &&
                 !(buf[0] & 0x80));
    }
}

//-----------------------------------------------------------------------------
// Valves
//-----------------------------------------------------------------------------
static Valve* findValve(uint8_t actuator_id) {
    for (auto& v : valves)
        if (v.actuator_id == actuator_id)
            return &v;
    return nullptr;
}

static void setValve(Valve& v, uint8_t new_state, const char* reason) {
    bool changed = v.state != new_state;
    v.state = new_state;
    if (changed)
        v.commanded_at_ms = millis();
    dacApply();
    if (changed) {
        HF_LOG("[VALVE ");
        HF_LOG(static_cast<unsigned>(v.actuator_id));
        HF_LOG("] -> ");
        HF_LOG(static_cast<unsigned>(new_state));
        HF_LOG(" (");
        HF_LOG(reason);
        HF_LOGLN(")");
    }
}

static void setAllValvesSafe(const char* reason) {
    for (auto& v : valves)
        setValve(v, SAFE_STATE, reason);
}

static void processActuatorCommands(
    const std::vector<daq::ActuatorCommand>& commands) {
    for (const auto& cmd : commands) {
        Valve* v = findValve(cmd.actuator_id);
        if (v == nullptr)
            continue;
        uint8_t new_state = (cmd.actuator_state != 0) ? 1 : 0;
        if (new_state == SAFE_STATE || state == BallValveState::Active) {
            setValve(*v, new_state, "command");
        } else {
            HF_LOG("[VALVE ");
            HF_LOG(static_cast<unsigned>(v->actuator_id));
            HF_LOG("] ");
            HF_LOG(static_cast<unsigned>(new_state));
            HF_LOGLN(" ignored -- no current SERVER_HEARTBEAT");
        }
    }
}

//-----------------------------------------------------------------------------
// Read-back and fault monitor
//-----------------------------------------------------------------------------

/** Calibrated pin voltage (eFuse curve fit), averaged over ADC_SAMPLES. */
static float readMillivolts(int pin) {
    uint32_t sum = 0;
    for (int i = 0; i < ADC_SAMPLES; i++)
        sum += analogReadMilliVolts(pin);
    return static_cast<float>(sum) / ADC_SAMPLES;
}

static float readLoopMa(int pin) {
    return readMillivolts(pin) / SENSE_OHMS;
}

/** A loop current as the counts daq-server's ideal 100 ohm loop reads. */
static uint32_t serverCounts(float ma) {
    float counts =
        ma * SERVER_SHUNT_OHMS / SERVER_ADC_REF_MV * SERVER_ADC_MAX_COUNTS;
    if (!(counts > 0.0f))
        return 0;
    if (counts > SERVER_ADC_MAX_COUNTS)
        return static_cast<uint32_t>(SERVER_ADC_MAX_COUNTS);
    return static_cast<uint32_t>(lroundf(counts));
}

static void logLoopFault(const Valve& v, LoopFault f) {
    HF_LOGF(
        "[VALVE %u] %s %s (command %.2f mA, RET %.2f mA, FB %.2f mA, "
        "EF %s)\n",
        static_cast<unsigned>(v.actuator_id), LOOP_FAULT_NAMES[f],
        v.faults[f].active ? "FAULT" : "cleared", commandedMa(v), v.ret_ma,
        v.fb_ma, v.ef_low ? "low" : "high");
}

static void readInputs() {
    v24_volts = readMillivolts(V24_MON_PIN) * V24_DIVIDER / 1000.0f;
    for (auto& v : valves) {
        v.fb_ma = readLoopMa(v.fb_pin);
        v.ret_ma = readLoopMa(v.ret_pin);
        v.ef_low = digitalRead(v.fault_pin) == LOW;
    }
}

/**
 * Without 24 V the XTR111s are unpowered: EF means nothing and both senses
 * read ~0, so loop faults are judged only once 24 V has been present for
 * SETTLE_MS, and dropped silently when it goes.
 */
static void monitor(unsigned long now) {
    readInputs();

    if (v24_missing.update(v24_volts < V24_MISSING_V, now))
        HF_LOGF(v24_missing.active
                    ? "[24V] missing (%.1f V) -- loop faults suppressed\n"
                    : "[24V] present (%.1f V)\n",
                v24_volts);
    if (v24_over.update(v24_volts > V24_OVER_V, now))
        HF_LOGF(v24_over.active ? "[24V] over-voltage (%.1f V)\n"
                                : "[24V] over-voltage cleared (%.1f V)\n",
                v24_volts);

    if (v24_missing.active || v24_volts < V24_MISSING_V) {
        v24_present_since_ms = 0;
        for (auto& v : valves)
            for (auto& f : v.faults)
                f.reset();
        return;
    }
    if (v24_present_since_ms == 0)
        v24_present_since_ms = now;
    if (now - v24_present_since_ms < SETTLE_MS)
        return;

    for (auto& v : valves) {
        const float cmd_ma = commandedMa(v);
        const bool settled = now - v.commanded_at_ms >= SETTLE_MS;
        const bool open = cmd_ma >= 4.0f && v.ret_ma < LOOP_LOW_MA;
        const bool cond[NUM_LOOP_FAULTS] = {
            open,
            settled && !open && fabsf(v.ret_ma - cmd_ma) > TRACKING_MA,
            v.fb_ma<LOOP_LOW_MA, v.fb_ma> FB_HIGH_MA,
            v.ef_low,
        };
        for (uint8_t f = 0; f < NUM_LOOP_FAULTS; f++)
            if (v.faults[f].update(cond[f], now))
                logLoopFault(v, static_cast<LoopFault>(f));
    }
}

//-----------------------------------------------------------------------------
// Outgoing packets
//-----------------------------------------------------------------------------
static daq::BoardState getBoardStateForHeartbeat() {
    switch (state) {
        case BallValveState::Active:
            return daq::BoardState::ACTIVE;
        case BallValveState::WaitingForServer:
        default:
            return daq::BoardState::SETUP;
    }
}

static void sendBoardHeartbeatTo(IPAddress dest_ip, int dest_port) {
    daq::BoardHeartbeatPacket hb;
    memcpy(hb.firmware_hash, FirmwareHash::get(), 32);
    hb.board_id = board_id;
    hb.engine_state = daq::EngineState::SAFE;
    hb.board_state = getBoardStateForHeartbeat();

    uint8_t packetBuffer[MAX_PACKET_SIZE];
    size_t len = daq::create_board_heartbeat_packet(hb, millis(), packetBuffer,
                                                    sizeof(packetBuffer));
    if (len == 0)
        return;

    udp.beginPacket(dest_ip, dest_port);
    udp.write(packetBuffer, len);
    udp.endPacket();
    HF_VERBOSE("Sent: heartbeat to ");
    HF_VERBOSE(dest_ip);
    HF_VERBOSE(":");
    HF_VERBOSELN(dest_port);
}

static void sendPositions() {
    daq::SensorDataChunkCollection chunk(millis(), NUM_VALVES);
    for (const auto& v : valves)
        chunk.add_datapoint(v.sensor_id, serverCounts(v.fb_ma));

    uint8_t packetBuffer[MAX_PACKET_SIZE];
    std::vector<daq::SensorDataChunkCollection> chunks;
    chunks.push_back(chunk);
    size_t len = daq::create_sensor_data_packet(
        chunks, NUM_VALVES, millis(), packetBuffer, sizeof(packetBuffer));
    if (len == 0)
        return;

    udp.beginPacket(serverIP, serverPort);
    udp.write(packetBuffer, len);
    udp.endPacket();
    HF_VERBOSE("Sent: sensor_data to ");
    HF_VERBOSE(serverIP);
    HF_VERBOSE(":");
    HF_VERBOSELN(serverPort);
}

static void flushLogs() {
    if (g_logbuf.empty())
        return;
    static uint8_t pkt[sizeof(daq::PacketHeader) + 3 + LOG_BUF_SIZE];
    size_t n =
        daq::create_log_packet(g_logbuf.flags(), g_logbuf.data(),
                               g_logbuf.length(), millis(), pkt, sizeof(pkt));
    if (n > 0) {
        udp.beginPacket(serverIP, serverPort);
        udp.write(pkt, n);
        udp.endPacket();
    }
    g_logbuf.clear();
}

//-----------------------------------------------------------------------------
// Incoming packets
//-----------------------------------------------------------------------------
static void processIncomingPacket(const uint8_t* buffer, size_t len,
                                  IPAddress remoteIP) {
    if (len < sizeof(daq::PacketHeader))
        return;
    daq::PacketHeader hdr;
    memcpy(&hdr, buffer, sizeof(hdr));

    switch (hdr.packet_type) {
        case daq::PacketType::SERVER_HEARTBEAT: {
            daq::PacketHeader dummy;
            daq::ServerHeartbeatPacket data;
            if (daq::parse_server_heartbeat_packet(buffer, len, dummy, data)) {
                last_server_heartbeat_ms = millis();
#ifdef SENSOR_ETH_USE_DHCP
                BoardNet::onServerPacket(net, remoteIP, serverIP);
#endif
                setState(BallValveState::Active);
            }
            break;
        }
        case daq::PacketType::ACTUATOR_CONFIG: {
            // Only the logging mode is used; this board takes no part in the
            // abort sequence.
            daq::PacketHeader dummy;
            uint8_t is_controller = 0;
            uint8_t enable_serial = 0;
            std::vector<daq::AbortActuatorLocation> act_locs;
            std::vector<daq::AbortPTLocation> pt_locs;
            if (daq::parse_actuator_config_packet(buffer, len, dummy,
                                                  is_controller, act_locs,
                                                  pt_locs, enable_serial)) {
                g_verbose = (enable_serial & 1);
                g_log_stream_level =
                    (enable_serial >= 2) ? (enable_serial - 1) : 0;
            }
            break;
        }
        case daq::PacketType::ACTUATOR_COMMAND: {
            daq::PacketHeader dummy;
            std::vector<daq::ActuatorCommand> commands;
            if (daq::parse_actuator_command_packet(buffer, len, dummy,
                                                   commands))
                processActuatorCommands(commands);
            break;
        }
        default:
            break;
    }
}

//-----------------------------------------------------------------------------
// Setup and loop
//-----------------------------------------------------------------------------

/**
 * An OTA blocks the loop until the board reboots, so the heartbeat watchdog
 * cannot run: put every valve in SAFE_STATE first, then freeze our DHCP
 * address for the duration of the flash. The DAC holds SAFE_STATE through the
 * reboot until setup() writes 0.
 */
static void otaStart(void*, uint32_t) {
    setAllValvesSafe("OTA starting");
    BoardNet::beginOtaHold(net);
}

/**
 * Read the W5500's VERSIONR (common register 0x0039, always 0x04) straight
 * over SPI and say what the answer implies, so a dead link can be traced to
 * a wire without a logic analyser.
 */
static void probeW5500Version() {
    SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
    digitalWrite(ETH_CS, LOW);
    SPI.transfer(0x00);  // address high
    SPI.transfer(0x39);  // address low: VERSIONR
    SPI.transfer(0x00);  // control: common block, read, variable length
    uint8_t version = SPI.transfer(0x00);
    digitalWrite(ETH_CS, HIGH);
    SPI.endTransaction();

    Serial.print("[ETH] W5500 VERSIONR read: 0x");
    if (version < 0x10)
        Serial.print("0");
    Serial.print(version, HEX);
    if (version == 0x04)
        Serial.println(" -- chip answers; init failed, try a reset");
    else if (version == 0x00)
        Serial.println(
            " -- MISO stuck low: check MISO (21), SCK (11), CS (12)"
            " and the module's GND");
    else if (version == 0xFF)
        Serial.println(
            " -- MISO floating/high: check MISO (21), CS (12), RST (14)"
            " and the module's 3.3 V");
    else
        Serial.println(" -- garbled: check MOSI (10), SCK (11)");
}

/**
 * Every valve to 0 (4 mA) before anything that waits: the DAC still holds
 * whatever it was last told if only the ESP32 reset.
 */
static void initializeValves() {
    Wire.begin(I2C_SDA, I2C_SCL, I2C_HZ);
    unsigned long now = millis();
    for (auto& v : valves) {
        v.state = 0;
        v.commanded_at_ms = now;
        pinMode(v.fault_pin, INPUT);  // 10k pull-up on the board
        pinMode(v.fb_pin, INPUT);
        pinMode(v.ret_pin, INPUT);
        analogSetPinAttenuation(v.fb_pin, ADC_11db);  // 12 dB on the S3
        analogSetPinAttenuation(v.ret_pin, ADC_11db);
    }
    pinMode(V24_MON_PIN, INPUT);
    analogSetPinAttenuation(V24_MON_PIN, ADC_11db);
    dacApply();
}

/** Hold the W5500 in reset, release, and give its PLL time to lock. */
static void resetW5500() {
    pinMode(ETH_INT, INPUT_PULLUP);
    digitalWrite(ETH_RST, LOW);
    pinMode(ETH_RST, OUTPUT);
    delay(2);
    digitalWrite(ETH_RST, HIGH);
    delay(60);
}

void setup() {
    initializeValves();

    Serial.begin(115200);
    delay(SERIAL_MONITOR_READY_DELAY_MS);
    FirmwareHash::print();
    Serial.println("Ball Valve Hotfire (Prop Receiver v2) starting...");
    if (!dac_ok)
        Serial.println(
            "[DAC] MCP4728 not answering at 0x60 -- valves cannot be "
            "commanded");
    else
        dacEnsureEeprom();

    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_ETH));
    BoardNet::configure(net, mac);
    BoardNet::printMac(net);
    resetW5500();
    SPI.begin(ETH_SCLK, ETH_MISO, ETH_MOSI, ETH_CS);
    delay(ETHERNET_SPI_DELAY_MS);
    Ethernet.init(ETH_CS);
    delay(ETHERNET_INIT_DELAY_MS);
#ifdef SENSOR_ETH_USE_DHCP
    // The ground station decides our address, and our ID with it.
    BoardNet::begin(net, dns, gateway);
    board_id = BoardNet::boardId(net);
#else
    board_id = static_cast<uint8_t>(BOARD_ID);
    Ethernet.begin(mac, IPAddress(192, 168, 2, board_id), dns, gateway, subnet);
#endif
    Serial.print("Board ID: ");
    Serial.println(static_cast<unsigned>(board_id));
    delay(ETHERNET_BEGIN_DELAY_MS);

    // Same prints as the other hotfire boards so the shared test-GUI serial
    // parser understands this one too.
    eth_present = Ethernet.hardwareStatus() == EthernetW5500;
    Serial.println("[ETH] Ethernet initialized (SPI WIZnet)");
    Serial.print("Address source: ");
    Serial.println(BoardNet::sourceName(net.source));
    Serial.print("Stack IP (Ethernet.localIP): ");
    Serial.println(Ethernet.localIP());
    Serial.print("Hardware: ");
    Serial.println(eth_present ? "W5500"
                               : "no chip detected — check CS / SPI wiring. "
                                 "Ethernet disabled; valves held at 0.");
    if (!eth_present) {
        probeW5500Version();
    } else {
        Serial.print("Link status: ");
        Serial.println(Ethernet.linkStatus() == LinkON ? "Connected"
                                                       : "Disconnected");
        udp.begin(udpListenPort);
        otaServer.onStart(otaStart);
        otaServer.begin();
        Serial.print("UDP listening on port ");
        Serial.println(udpListenPort);
    }

    readInputs();
    Serial.printf("24 V input: %.1f V\n", v24_volts);
    for (const auto& v : valves) {
        Serial.printf(
            "Valve: actuator_id %u (DAC %c), position sensor_id %u (GPIO%d), "
            "state 0 -- FB %.2f mA, RET %.2f mA, EF %s\n",
            static_cast<unsigned>(v.actuator_id), 'A' + v.dac_channel,
            static_cast<unsigned>(v.sensor_id), v.fb_pin, v.fb_ma, v.ret_ma,
            v.ef_low ? "low" : "high");
    }
    Serial.println("State -> WaitingForServer");
    Serial.flush();

    HF_LOG("ONLINE board=");
    HF_LOG(static_cast<unsigned>(board_id));
    HF_LOG(" ip=");
    HF_LOG(Ethernet.localIP());
    HF_LOGLN_();
    if (eth_present)
        flushLogs();
}

static void pollNetwork() {
#ifdef SENSOR_ETH_USE_DHCP
    // Renew the lease as it expires; no-op while an OTA is in flight.
    BoardNet::maintainLease(net);
    // On the recovery address, keep asking; a lease brings our ID with it.
    if (BoardNet::retryDhcp(net, dns, gateway)) {
        board_id = BoardNet::boardId(net);
        HF_LOG("ONLINE board=");
        HF_LOG(static_cast<unsigned>(board_id));
        HF_LOG(" ip=");
        HF_LOG(Ethernet.localIP());
        HF_LOGLN_();
        flushLogs();
    }
#endif
    // Blocks only if a client connects; never returns on success.
    otaServer.poll();
    StarOTA::printTestMessage();

    int packetSize = udp.parsePacket();
    if (packetSize > 0) {
        IPAddress remoteIP = udp.remoteIP();
        uint8_t packetBuffer[MAX_PACKET_SIZE];
        int bytesRead = udp.read(packetBuffer, sizeof(packetBuffer));
        if (bytesRead > 0)
            processIncomingPacket(packetBuffer, static_cast<size_t>(bytesRead),
                                  remoteIP);
    }

#ifdef SENSOR_ETH_USE_DHCP
    // Server gone quiet: forget it and resume discovery broadcasts. Our
    // address stays; only the outbound destination resets.
    if (BoardNet::serverWentSilent(net)) {
        net.serverLearned = false;
        serverIP = IPAddress(192, 168, 2, HOTFIRE_SERVER_IP_OCTET_4);
        Serial.println("[NET] server silent -- resuming discovery");
        Serial.flush();
    }
#endif

    unsigned long now = millis();
    if (now - last_position_send_ms >= ADC_READ_INTERVAL_MS) {
        last_position_send_ms = now;
        sendPositions();
    }

    if (now - lastHeartbeatMillis >= BOARD_HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMillis = now;
        sendBoardHeartbeatTo(serverIP, serverPort);
#ifdef SENSOR_ETH_USE_DHCP
        // Discovery: announce to everyone until a server is learned.
        if (!net.serverLearned)
            sendBoardHeartbeatTo(IPAddress(255, 255, 255, 255),
                                 HOTFIRE_SERVER_PORT);
#endif
    }

    // Flush buffered logs to the server ~1 Hz (or sooner if filling).
    static unsigned long s_last_log_flush_ms = 0;
    if (!g_logbuf.empty() &&
        (g_logbuf.nearFull() || now - s_last_log_flush_ms >= 1000)) {
        s_last_log_flush_ms = now;
        flushLogs();
    }
}

void loop() {
    // Failsafe: no current server heartbeat -> every valve to SAFE_STATE.
    if (state == BallValveState::Active &&
        millis() - last_server_heartbeat_ms > HEARTBEAT_TIMEOUT_MS) {
        setAllValvesSafe("server heartbeat lost");
        setState(BallValveState::WaitingForServer);
    }

    unsigned long now = millis();
    if (now - last_dac_refresh_ms >= DAC_REFRESH_MS) {
        last_dac_refresh_ms = now;
        dacApply();
    }
    if (now - last_monitor_ms >= MONITOR_INTERVAL_MS) {
        last_monitor_ms = now;
        monitor(now);
    }

    if (eth_present)
        pollNetwork();

    delay(LOOP_DELAY_MS);
}
