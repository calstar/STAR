/**
 * Sensor hotfire core: the decisions, with no hardware attached.
 *
 * Everything here is plain C++ (no Arduino, Ethernet or FreeRTOS), so the
 * host unit tests in Hotfire_Tests exercise this exact code rather than a
 * copy of it. SensorHotfireCore.h does the I/O and calls in here for:
 *
 *   - turning an incoming packet into an event (and the config it carries)
 *   - the state machine: WaitingForServer -> SelfTest -> Active <->
 *     StandaloneAbort
 *   - batching chunks into one SENSOR_DATA packet, never mixing layouts
 *   - the drop-oldest rule for a full chunk queue
 *   - how long to wait for the ADC's data-ready line before giving up
 */

#pragma once

#include <stdint.h>
#include <string.h>

#include <vector>

#include "daq-protocol.h"
#include "hotfire_config.h"

#ifndef SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE
#define SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE 11
#endif

namespace SensorHotfire {

enum class State : uint8_t {
    WaitingForServer = 1,  // SETUP
    Active = 2,            // ACTIVE
    StandaloneAbort = 9,   // STANDALONE_ABORT
    SelfTest = 10          // SELF_TEST
};

enum class IncomingPacketKind {
    None,
    ServerHeartbeat,
    SensorConfig,
    ClearAbort,
    NoConnAbort
};

struct StoredSensorConfig {
    bool valid;
    uint8_t reference_voltage;  // 0 = internal 2.5V, 1 = VDD, 2 = 5V (ignored;
                                // treat as 0)
    bool necessary_for_abort;
    uint32_t actuator_controller_ip;
    uint8_t num_sensors;                        // 0 = use board default
    uint8_t sensor_ids[MAX_SENSORS_PER_BOARD];  // connector IDs to read and
                                                // transmit
};

inline const char* stateName(State s) {
    switch (s) {
        case State::WaitingForServer:
            return "WaitingForServer";
        case State::Active:
            return "Active";
        case State::StandaloneAbort:
            return "StandaloneAbort";
        case State::SelfTest:
            return "SelfTest";
    }
    return "Unknown";
}

inline const char* packetTypeName(uint8_t type) {
    switch (type) {
        case 1:
            return "BOARD_HEARTBEAT";
        case 2:
            return "SERVER_HEARTBEAT";
        case 3:
            return "SENSOR_DATA";
        case 4:
            return "ACTUATOR_COMMAND";
        case 5:
            return "SENSOR_CONFIG";
        case 6:
            return "ACTUATOR_CONFIG";
        case 7:
            return "ABORT";
        case 8:
            return "ABORT_DONE";
        case 9:
            return "CLEAR_ABORT";
        case 10:
            return "PWM_ACTUATOR_COMMAND";
        case SENSOR_HOTFIRE_NO_CONN_ABORT_TYPE:
            return "NO_CONNECTION_ABORT";
        case 12:
            return "SELF_TEST";
        default:
            return "UNKNOWN";
    }
}

/** What the heartbeat reports for each state. */
inline daq::BoardState boardStateFor(State s) {
    switch (s) {
        case State::WaitingForServer:
            return daq::BoardState::SETUP;
        case State::Active:
            return daq::BoardState::ACTIVE;
        case State::StandaloneAbort:
            return daq::BoardState::STANDALONE_ABORT;
        case State::SelfTest:
            return daq::BoardState::SELF_TEST;
    }
    return daq::BoardState::SETUP;
}

/**
 * Classify one received packet. For a SENSOR_CONFIG that parses, the new
 * config is written to `config_out` and the config's log-mode byte to
 * `log_mode_out`; on a parse failure both are left untouched and the result
 * is None.
 */
inline IncomingPacketKind parseIncoming(const uint8_t* buffer, size_t len,
                                        StoredSensorConfig& config_out,
                                        uint8_t& log_mode_out) {
    if (len < sizeof(daq::PacketHeader))
        return IncomingPacketKind::None;
    daq::PacketHeader hdr;
    memcpy(&hdr, buffer, sizeof(hdr));

    switch (hdr.packet_type) {
        case daq::PacketType::SERVER_HEARTBEAT: {
            daq::PacketHeader dummy;
            daq::ServerHeartbeatPacket data;
            return daq::parse_server_heartbeat_packet(buffer, len, dummy, data)
                       ? IncomingPacketKind::ServerHeartbeat
                       : IncomingPacketKind::None;
        }
        case daq::PacketType::SENSOR_CONFIG: {
            daq::PacketHeader dummy;
            std::vector<uint8_t> sensor_ids;
            uint8_t reference_voltage = 0;
            bool necessary_for_abort = false;
            uint32_t controller_ip = 0;
            uint8_t log_mode = 1;
            if (!daq::parse_sensor_config_packet(
                    buffer, len, dummy, sensor_ids, reference_voltage,
                    necessary_for_abort, controller_ip, log_mode))
                return IncomingPacketKind::None;

            config_out.valid = true;
            config_out.reference_voltage = reference_voltage;
            config_out.necessary_for_abort = necessary_for_abort;
            config_out.actuator_controller_ip = controller_ip;
            config_out.num_sensors = static_cast<uint8_t>(
                sensor_ids.size() <= MAX_SENSORS_PER_BOARD
                    ? sensor_ids.size()
                    : MAX_SENSORS_PER_BOARD);
            for (uint8_t i = 0; i < config_out.num_sensors; ++i)
                config_out.sensor_ids[i] = sensor_ids[i];
            log_mode_out = log_mode;
            return IncomingPacketKind::SensorConfig;
        }
        case daq::PacketType::CLEAR_ABORT:
            return IncomingPacketKind::ClearAbort;
        case daq::PacketType::NO_CONNECTION_ABORT:
            return IncomingPacketKind::NoConnAbort;
        default:
            return IncomingPacketKind::None;
    }
}

/**
 * The state a packet moves the board to. SelfTest ignores packets: it is a
 * transient state the core leaves on its own once the test has run.
 */
inline State nextState(State s, IncomingPacketKind kind,
                       bool necessary_for_abort, bool has_self_test) {
    switch (s) {
        case State::WaitingForServer:
            if (kind == IncomingPacketKind::SensorConfig)
                return has_self_test ? State::SelfTest : State::Active;
            break;
        case State::Active:
            if (kind == IncomingPacketKind::NoConnAbort && necessary_for_abort)
                return State::StandaloneAbort;
            break;
        case State::StandaloneAbort:
            if (kind == IncomingPacketKind::ClearAbort)
                return State::Active;
            break;
        case State::SelfTest:
            break;
    }
    return s;
}

/** Same sensor list, in the same order (what a chunk's layout depends on). */
inline bool sameSensorList(const StoredSensorConfig& a,
                           const StoredSensorConfig& b) {
    if (a.num_sensors != b.num_sensors)
        return false;
    return memcmp(a.sensor_ids, b.sensor_ids, a.num_sensors) == 0;
}

//-----------------------------------------------------------------------------
// Chunks and batching
//-----------------------------------------------------------------------------

/**
 * One reading of every configured channel. Fixed size, so it can go through
 * a FreeRTOS queue by value with no allocation on the sampling path.
 *
 * `config_seq` is internal only (never sent over Ethernet): it is the number
 * of the config the chunk was read under, so the batcher can tell when the
 * sensor layout changed.
 */
struct Chunk {
    uint32_t timestamp_ms;
    uint32_t config_seq;
    uint8_t num_sensors;
    uint8_t sensor_ids[MAX_SENSORS_PER_BOARD];
    uint32_t values[MAX_SENSORS_PER_BOARD];
};

/**
 * Collects chunks into one SENSOR_DATA packet. A packet only ever holds one
 * sensor layout, so a chunk read under a different config must not join the
 * current batch: send what is held first (a short packet is fine, the
 * packet carries its own chunk count), then add it.
 */
class ChunkBatch {
public:
    explicit ChunkBatch(uint8_t capacity = HOTFIRE_CHUNKS_PER_PACKET)
        : capacity_(capacity <= MAX_CHUNKS_PER_PACKET ? capacity
                                                      : MAX_CHUNKS_PER_PACKET) {
    }

    uint8_t size() const {
        return count_;
    }
    bool empty() const {
        return count_ == 0;
    }
    bool full() const {
        return count_ >= capacity_;
    }

    /** True if `c` cannot join the batch until the batch has been sent. */
    bool mustSendBefore(const Chunk& c) const {
        if (empty())
            return false;
        return full() || c.config_seq != chunks_[0].config_seq ||
               c.num_sensors != chunks_[0].num_sensors;
    }

    /** Add a chunk. Returns false (and adds nothing) if mustSendBefore(c). */
    bool add(const Chunk& c) {
        if (mustSendBefore(c))
            return false;
        chunks_[count_++] = c;
        return true;
    }

    /** Serialize the batch. Returns the packet size, 0 if it did not fit. */
    size_t buildPacket(uint32_t now_ms, uint8_t* buffer,
                       size_t buffer_size) const {
        if (empty())
            return 0;
        std::vector<daq::SensorDataChunkCollection> collections;
        collections.reserve(count_);
        for (uint8_t i = 0; i < count_; ++i) {
            const Chunk& c = chunks_[i];
            daq::SensorDataChunkCollection col(c.timestamp_ms, c.num_sensors);
            for (uint8_t j = 0; j < c.num_sensors; ++j)
                col.add_datapoint(c.sensor_ids[j], c.values[j]);
            collections.push_back(col);
        }
        return daq::create_sensor_data_packet(collections,
                                              chunks_[0].num_sensors, now_ms,
                                              buffer, buffer_size);
    }

    const Chunk& at(uint8_t i) const {
        return chunks_[i];
    }

    void clear() {
        count_ = 0;
    }

private:
    uint8_t capacity_;
    uint8_t count_ = 0;
    Chunk chunks_[MAX_CHUNKS_PER_PACKET];
};

/**
 * Push onto a bounded queue, dropping the oldest item when it is full: newer
 * readings are worth more than older ones. `Queue` needs
 * `bool trySend(const T&)` and `bool tryReceive(T&)`, both non-blocking.
 * Only safe with a single producer. Returns true if an item was dropped.
 */
template <typename Queue, typename T>
bool pushDropOldest(Queue& q, const T& item) {
    if (q.trySend(item))
        return false;
    T discarded;
    q.tryReceive(discarded);
    q.trySend(item);
    return true;
}

//-----------------------------------------------------------------------------
// Data-ready timeouts
//-----------------------------------------------------------------------------

/**
 * Nominal ADS126X ADC1 conversion period for each data-rate code (the 4-bit
 * DR field, i.e. the ADS126X_RATE_* values): 2.5, 5, 10, 16.6, 20, 50, 60,
 * 100, 400, 1200, 2400, 4800, 7200, 14400, 19200, 38400 SPS.
 */
inline uint32_t conversionPeriodUs(uint8_t rate_code) {
    static const uint32_t kPeriodUs[16] = {
        400000, 200000, 100000, 60241, 50000, 20000, 16667, 10000,
        2500,   834,    417,    209,   139,   70,    53,    27};
    return rate_code < 16 ? kPeriodUs[rate_code] : kPeriodUs[0];
}

/** Never time out faster than this: SPI and mux overhead dominate at high
 *  data rates, where 3 conversion periods is only tens of microseconds. */
constexpr uint32_t DRDY_TIMEOUT_FLOOR_US = 2000;

/**
 * How long to wait for one data-ready edge before declaring the ADC dead:
 * 3x the conversions expected before it (1 for a plain read, plus any
 * readings discarded after a channel switch), never less than the floor.
 */
inline uint32_t drdyTimeoutUs(uint8_t rate_code, uint8_t conversions = 1) {
    if (conversions == 0)
        conversions = 1;
    const uint32_t t = 3u * conversions * conversionPeriodUs(rate_code);
    return t < DRDY_TIMEOUT_FLOOR_US ? DRDY_TIMEOUT_FLOOR_US : t;
}

}  // namespace SensorHotfire
