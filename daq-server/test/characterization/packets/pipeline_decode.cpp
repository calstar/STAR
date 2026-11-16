// Characterization: the decode path daq_bridge actually runs on board datagrams —
// fsw::streams::SensorFramePipeline::poll() and its get_last_{environmental,heartbeat,log}()
// stashes — fed real UDP datagrams over loopback (127.0.0.1, an ephemeral port).
//
// For every case the datagram is followed by a marker SENSOR_DATA datagram; everything poll()
// produced before the marker's batch is the pipeline's verdict on the case. Empty polls are not
// recorded (they depend on timing), only what was produced. Golden: pipeline_decode.txt.
//
// Normalised: frame_timestamp_ns is steady_clock::now() for SELF_TEST and for a SENSOR_DATA with
// zero chunks; it is printed as <steady_clock> there and literally everywhere else.
//
// Binds a UDP port on 127.0.0.1: run under with_stack_lock.sh (RUN_SERIAL in ctest).
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstring>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include "daq-protocol.h"
#include "golden.hpp"
#include "streams/SensorFramePipeline.hpp"

using chargold::hex;
using chargold::hexu;
using chargold::Out;

namespace {

constexpr uint32_t kTs = 0x12345678u;

uint16_t free_udp_port() {
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = 0;
    bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a);
    socklen_t l = sizeof a;
    getsockname(s, reinterpret_cast<sockaddr*>(&a), &l);
    close(s);
    return ntohs(a.sin_port);
}

std::vector<uint8_t> sensor_data(int chunks, int sensors, uint8_t first_id = 1, uint32_t ts = kTs) {
    std::vector<daq::SensorDataChunkCollection> v;
    for (int c = 0; c < chunks; ++c) {
        daq::SensorDataChunkCollection col(0x00010000u + static_cast<uint32_t>(c) * 10,
                                           static_cast<uint8_t>(sensors));
        for (int s = 0; s < sensors; ++s)
            col.add_datapoint(static_cast<uint8_t>(first_id + s),
                              0x00ABC000u + static_cast<uint32_t>(c * 16 + s));
        v.push_back(col);
    }
    std::vector<uint8_t> b(16384);
    b.resize(
        daq::create_sensor_data_packet(v, static_cast<uint8_t>(sensors), ts, b.data(), b.size()));
    return b;
}

std::vector<uint8_t> env(float t, uint32_t p, float h) {
    std::vector<uint8_t> b(64);
    b.resize(daq::create_environmental_data_packet(t, p, h, kTs, b.data(), b.size()));
    return b;
}

std::vector<uint8_t> self_test() {
    std::vector<uint8_t> b(64);
    std::vector<daq::SelfTestResult> r = {{1, 1}, {2, 0}, {9, 1}};
    b.resize(daq::create_self_test_packet(1, r, kTs, b.data(), b.size()));
    return b;
}

std::vector<uint8_t> heartbeat() {
    daq::BoardHeartbeatPacket hb{};
    for (int i = 0; i < 32; ++i)
        hb.firmware_hash[i] = static_cast<uint8_t>(i);
    hb.board_id = 21;
    hb.engine_state = daq::EngineState::SAFE;
    hb.board_state = daq::BoardState::ACTIVE;
    std::vector<uint8_t> b(64);
    b.resize(daq::create_board_heartbeat_packet(hb, kTs, b.data(), b.size()));
    return b;
}

std::vector<uint8_t> logs() {
    const std::string t = "boot ok\nadc ok\n";
    std::vector<uint8_t> b(64);
    b.resize(daq::create_log_packet(0, reinterpret_cast<const uint8_t*>(t.data()),
                                    static_cast<uint16_t>(t.size()), kTs, b.data(), b.size()));
    return b;
}

std::vector<uint8_t> actuator_command() {
    std::vector<uint8_t> b(64);
    b.resize(daq::create_actuator_command_packet({{1, 1}}, kTs, b.data(), b.size()));
    return b;
}

std::vector<uint8_t> stacklight() {
    std::vector<uint8_t> b(64);
    b.resize(daq::create_stacklight_command_packet({1, 1, 1, 1}, kTs, b.data(), b.size()));
    return b;
}

std::vector<uint8_t> header_only(uint8_t type) {
    return {type, 0x00, 0x78, 0x56, 0x34, 0x12};
}

struct Harness {
    fsw::streams::SensorFramePipeline pipe;
    int tx;
    sockaddr_in dest{};
    uint32_t marker = 0;

    explicit Harness(uint16_t port) : pipe("127.0.0.1", port) {
        tx = socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in src{};
        src.sin_family = AF_INET;
        src.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        bind(tx, reinterpret_cast<sockaddr*>(&src), sizeof src);
        dest.sin_family = AF_INET;
        dest.sin_port = htons(port);
        dest.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    }
    ~Harness() {
        close(tx);
    }

    void send(const std::vector<uint8_t>& b) {
        ssize_t n =
            sendto(tx, b.data(), b.size(), 0, reinterpret_cast<sockaddr*>(&dest), sizeof dest);
        if (n != static_cast<ssize_t>(b.size()))
            std::cerr << "sendto short: " << n << " of " << b.size() << std::endl;
    }

    static std::string batch_str(const daq_comms::protocol::SensorBatch& b, bool clock_ts) {
        std::string s =
            "batch{frame_timestamp_ns=" +
            (clock_ts ? std::string("<steady_clock>") : std::to_string(b.frame_timestamp_ns)) +
            " sequence_id=" + std::to_string(b.sequence_id) +
            " is_valid=" + std::to_string(b.is_valid) + " error_message=\"" + b.error_message +
            "\"";
        s += " pt_samples=" + std::to_string(b.pt_samples.size()) + "[";
        for (const auto& p : b.pt_samples)
            s += " " + std::to_string(p.channel_id) + ":" + hexu(p.raw_adc_counts, 8) + ":" +
                 hexu(p.sample_timestamp_ms, 8) + ":" + std::to_string(p.status_flags);
        s += " ] tc=" + std::to_string(b.tc_samples.size()) +
             " rtd=" + std::to_string(b.rtd_samples.size()) +
             " lc=" + std::to_string(b.lc_samples.size()) +
             " self_tests=" + std::to_string(b.self_tests.size()) + "[";
        for (const auto& t : b.self_tests) {
            s += " {type=" + std::to_string(t.packet_type) + " ver=" + std::to_string(t.version) +
                 " ts=" + hexu(t.timestamp, 8) + " adc_good=" + std::to_string(t.adc_good) +
                 " num_sensors=" + std::to_string(t.num_sensors) +
                 " is_valid=" + std::to_string(t.is_valid) + " results=";
            for (const auto& r : t.results)
                s += std::to_string(r.sensor_id) + ":" + std::to_string(r.result) + ",";
            s += "}";
        }
        return s + " ]}";
    }

    /** Send `b`, then a marker, and record everything produced before the marker. */
    void run_case(Out& o, const std::string& name, const std::vector<uint8_t>& b) {
        o.line("## " + name + " len=" + std::to_string(b.size()));
        if (b.size() <= 64)
            o.line("  bytes: " + hex(b));
        const bool clock_ts =
            (!b.empty() && b[0] == 12) || (b.size() > 6 && b[0] == 3 && b[6] == 0);
        send(b);
        ++marker;
        send(sensor_data(1, 1, 0xFE, 0xFE000000u + marker));
        auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        bool seen_marker = false;
        while (!seen_marker && std::chrono::steady_clock::now() < deadline) {
            auto r = pipe.poll();
            if (r && r->pt_samples.size() == 1 && r->pt_samples[0].channel_id == 0xFE &&
                r->sequence_id == ((0xFE000000u + marker) & 0xFFFF)) {
                seen_marker = true;
            } else if (r) {
                o.line("  poll -> " + batch_str(*r, clock_ts));
            }
            if (auto e = pipe.get_last_environmental())
                o.line("  last_environmental = {temperature_c=" + chargold::fstr(e->temperature_c) +
                       " pressure_pa=" + std::to_string(e->pressure_pa) +
                       " humidity_rh=" + chargold::fstr(e->humidity_rh) + " sample_timestamp_ms=" +
                       hexu(e->sample_timestamp_ms, 8) + " source_ip=" + e->source_ip + "}");
            if (auto h = pipe.get_last_heartbeat())
                o.line("  last_heartbeat = {len=" + std::to_string(h->data.size()) +
                       " source_ip=" + h->source_ip + " bytes=" + hex(h->data) + "}");
            if (auto l = pipe.get_last_log())
                o.line("  last_log = {len=" + std::to_string(l->data.size()) +
                       " source_ip=" + l->source_ip + " bytes=" + hex(l->data) + "}");
            if (!r)
                std::this_thread::sleep_for(std::chrono::microseconds(200));
        }
        if (!seen_marker)
            o.line("  !! marker never arrived");
        o.line("  last_source_ip = " + pipe.last_source_ip());
    }
};

}  // namespace

int main() {
    const uint16_t port = free_udp_port();
    Harness h(port);
    if (!h.pipe.is_ready()) {
        std::cerr << "pipeline not ready: " << h.pipe.last_error() << std::endl;
        return 1;
    }
    Out o;
    o.line("# SensorFramePipeline::poll() on loopback datagrams (source 127.0.0.1)");

    // Valid packets of every family a board sends, and some it never should.
    h.run_case(o, "SENSOR_DATA 2 chunks x 3 sensors", sensor_data(2, 3));
    h.run_case(o, "SENSOR_DATA 1 chunk x 10 sensors", sensor_data(1, 10));
    h.run_case(o, "SENSOR_DATA 0 chunks", sensor_data(0, 3));
    h.run_case(o, "SENSOR_DATA 2 chunks x 0 sensors", sensor_data(2, 0));
    h.run_case(o, "SELF_TEST adc_good=1 3 results", self_test());
    h.run_case(o, "ENVIRONMENTAL_DATA 21.5C 101325Pa 45.25%", env(21.5f, 101325u, 45.25f));
    h.run_case(o, "BOARD_HEARTBEAT", heartbeat());
    h.run_case(o, "LOGS", logs());
    h.run_case(o, "ACTUATOR_COMMAND (server->board type)", actuator_command());
    h.run_case(o, "STACKLIGHT_COMMAND (server->board type)", stacklight());
    h.run_case(o, "SERVER_HEARTBEAT", {0x02, 0x00, 0x78, 0x56, 0x34, 0x12, 0x00});
    h.run_case(o, "ABORT header only", header_only(7));
    h.run_case(o, "ABORT_DONE header only", header_only(8));
    h.run_case(o, "unknown type 99", header_only(99));
    h.run_case(o, "type 0", header_only(0));

    // Size boundaries.
    h.run_case(o, "zero-length datagram", {});
    h.run_case(o, "5 bytes (short of a header)", {0x03, 0x00, 0x78, 0x56, 0x34});
    {
        const auto good = sensor_data(2, 3);
        for (size_t L = 6; L < good.size(); ++L)
            h.run_case(o, "SENSOR_DATA truncated to " + std::to_string(L),
                       std::vector<uint8_t>(good.begin(), good.begin() + L));
        auto t = good;
        t.insert(t.end(), {0xEE, 0xEE, 0xEE});
        h.run_case(o, "SENSOR_DATA +3 trailing bytes", t);
        auto v = good;
        v[1] = 7;
        h.run_case(o, "SENSOR_DATA version=7", v);
        auto c = good;
        c[6] = 3;
        h.run_case(o, "SENSOR_DATA num_chunks overclaims (3)", c);
        auto s = good;
        s[7] = 2;
        h.run_case(o, "SENSOR_DATA num_sensors underclaims (2)", s);
    }
    {
        // 166 chunks x 10 sensors = 8972 bytes: fits a loopback datagram on macOS (9216) and
        // Linux, and exceeds the pipeline's 8192-byte receive buffer.
        h.run_case(o, "SENSOR_DATA 8972 bytes (> 8192 receive buffer)", sensor_data(166, 10));
        h.run_case(o, "SENSOR_DATA 151 chunks x 10 sensors (8162 bytes, fits)",
                   sensor_data(151, 10));
    }
    {
        const auto good = self_test();
        for (size_t L = 6; L < good.size(); ++L)
            h.run_case(o, "SELF_TEST truncated to " + std::to_string(L),
                       std::vector<uint8_t>(good.begin(), good.begin() + L));
    }
    {
        const auto good = env(21.5f, 101325u, 45.25f);
        h.run_case(o, "ENVIRONMENTAL truncated to 17",
                   std::vector<uint8_t>(good.begin(), good.end() - 1));
        auto t = good;
        t.push_back(0);
        h.run_case(o, "ENVIRONMENTAL +1 trailing byte", t);
        auto v = good;
        v[1] = 1;
        h.run_case(o, "ENVIRONMENTAL version=1", v);
        h.run_case(o, "ENVIRONMENTAL temperature NaN",
                   env(std::numeric_limits<float>::quiet_NaN(), 101325u, 45.0f));
        h.run_case(o, "ENVIRONMENTAL temperature +inf",
                   env(std::numeric_limits<float>::infinity(), 101325u, 45.0f));
        h.run_case(o, "ENVIRONMENTAL humidity NaN",
                   env(20.0f, 101325u, std::numeric_limits<float>::quiet_NaN()));
        h.run_case(o, "ENVIRONMENTAL humidity -0.5", env(20.0f, 101325u, -0.5f));
        h.run_case(o, "ENVIRONMENTAL humidity 0", env(20.0f, 101325u, 0.0f));
        h.run_case(o, "ENVIRONMENTAL humidity 100", env(20.0f, 101325u, 100.0f));
        h.run_case(o, "ENVIRONMENTAL humidity 100.5", env(20.0f, 101325u, 100.5f));
        h.run_case(o, "ENVIRONMENTAL pressure 0", env(20.0f, 0u, 50.0f));
        h.run_case(o, "ENVIRONMENTAL temperature -300", env(-300.0f, 1u, 50.0f));
    }
    {
        const auto good = heartbeat();
        h.run_case(o, "BOARD_HEARTBEAT truncated to 6",
                   std::vector<uint8_t>(good.begin(), good.begin() + 6));
        h.run_case(o, "BOARD_HEARTBEAT truncated to 40",
                   std::vector<uint8_t>(good.begin(), good.end() - 1));
        auto t = good;
        t.insert(t.end(), {1, 2, 3});
        h.run_case(o, "BOARD_HEARTBEAT +3 trailing bytes", t);
    }
    {
        const auto good = logs();
        h.run_case(o, "LOGS truncated to 8", std::vector<uint8_t>(good.begin(), good.begin() + 8));
        auto c = good;
        c[7] = 0xFF;
        h.run_case(o, "LOGS text_len overclaims", c);
    }
    return chargold::finish("pipeline_decode.txt", o.s.str());
}
