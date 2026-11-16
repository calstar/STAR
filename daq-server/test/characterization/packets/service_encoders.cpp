// Characterization: the board-bound bytes the services build by hand, outside daqv2_comms.
//
//   service_config_broadcast.txt  config_broadcast_service buildPackets() for patched copies of
//                                 config_base.toml and the default / digital-twin profiles
//                                 (every 192.168.2.x rewritten to 127.0.0.x), plus variants that
//                                 reach the calibration-threshold and physics-inversion paths
//   service_packets.txt           heartbeat_service SERVER_HEARTBEAT and its state map,
//                                 daq_bridge SERVER_HEARTBEAT, board-type maps and the backend log
//                                 envelope, stacklight's state map, AbortBroadcaster
//                                 ABORT / ABORT_DONE / CLEAR_ABORT, ControllerService PWM packets
//
// Normalised: the 4 timestamp bytes of packets stamped from a clock. They are printed as
// <system_clock ms> / <steady_clock ms> after checking the value lies between clock readings
// taken before and after the call (a value outside that window prints OUT OF RANGE and fails).
//
// service_packets binds loopback UDP sockets (ephemeral ports on 127.0.0.1): run under
// with_stack_lock.sh (RUN_SERIAL in ctest).
//
// Usage: char_service_encoders config_broadcast <daq-server source dir>
//        char_service_encoders packets
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <chrono>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "control/AbortBroadcaster.hpp"
#include "golden.hpp"
#include "svc_bridge.hpp"

namespace charsvc {
std::vector<bool> controller_send_pwm(int fd, uint16_t port);
}

namespace fs = std::filesystem;
using chargold::hex;
using chargold::Out;
using F = Out::F;

namespace {

int g_fail = 0;

std::string read_file(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    std::stringstream s;
    s << f.rdbuf();
    return s.str();
}

void write_file(const fs::path& p, const std::string& t) {
    fs::create_directories(p.parent_path());
    std::ofstream f(p, std::ios::binary);
    f << t;
}

std::string replace_all(std::string s, const std::string& a, const std::string& b) {
    for (size_t i = s.find(a); i != std::string::npos; i = s.find(a, i + b.size()))
        s.replace(i, a.size(), b);
    return s;
}

/** The loopback rewrite the integration harness relies on: no stand address survives. */
std::string patch_ips(const std::string& toml) {
    return replace_all(toml, "192.168.2.", "127.0.0.");
}

uint64_t sys_ms() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                     std::chrono::system_clock::now().time_since_epoch())
                                     .count());
}
uint64_t steady_ms() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                     std::chrono::steady_clock::now().time_since_epoch())
                                     .count());
}

std::string ts_check(const uint8_t* p, uint64_t lo, uint64_t hi, const char* clock) {
    uint32_t v;
    std::memcpy(&v, p, 4);
    const uint32_t l = static_cast<uint32_t>(lo & 0xFFFFFFFFu);
    const uint32_t h = static_cast<uint32_t>(hi & 0xFFFFFFFFu);
    const bool ok = (l <= h) ? (v >= l && v <= h) : (v >= l || v <= h);
    if (!ok) {
        ++g_fail;
        return std::string("OUT OF RANGE (") + clock + ")";
    }
    return std::string("<") + clock + " ms, LE u32>";
}

// ── config_broadcast ─────────────────────────────────────────────────────────

uint32_t rd32(const std::vector<uint8_t>& b, size_t o) {
    uint32_t v = 0;
    if (o + 4 <= b.size())
        std::memcpy(&v, b.data() + o, 4);
    return v;
}

std::vector<F> config_packet_fields(const std::vector<uint8_t>& b) {
    std::vector<F> v = {{"header.packet_type", 1}, {"header.version", 1}, {"header.timestamp", 4}};
    if (b.empty())
        return v;
    if (b[0] == 6 && b.size() > 7) {  // ACTUATOR_CONFIG
        v.push_back({"is_abort_controller", 1});
        v.push_back({"num_abort_actuators", 1});
        const size_t n = b[7];
        for (size_t i = 0; i < n; ++i) {
            const std::string p = "abort_actuator[" + std::to_string(i) + "]";
            v.push_back({p + ".ip_address", 4});
            v.push_back({p + ".actuator_id", 1});
            v.push_back({p + ".vent_state", 1});
            v.push_back({p + ".abort_state", 1});
        }
        v.push_back({"num_abort_pts", 1});
        const size_t xo = 8 + n * 7;
        const size_t x = xo < b.size() ? b[xo] : 0;
        for (size_t i = 0; i < x; ++i) {
            const std::string p = "abort_pt[" + std::to_string(i) + "]";
            v.push_back({p + ".ip_address", 4});
            v.push_back({p + ".sensor_id", 1});
            v.push_back({p + ".pressure_threshold_adc", 4});
        }
        v.push_back({"enable_serial_printing", 1});
    } else if (b[0] == 5 && b.size() > 6) {  // SENSOR_CONFIG
        const size_t n = b[6];
        v.push_back({"num_sensors", 1});
        for (size_t i = 0; i < n; ++i)
            v.push_back({"sensor_id[" + std::to_string(i) + "]", 1});
        v.push_back({"reference_voltage", 1});
        v.push_back({"necessary_for_abort", 1});
        if (7 + n + 1 < b.size() && b[7 + n + 1])
            v.push_back({"controller_ip", 4});
        v.push_back({"enable_serial_printing", 1});
    }
    return v;
}

void cb_case(Out& o, const fs::path& work, const std::string& name, const std::string& toml,
             const std::string& csv, const std::string& thresholds) {
    const fs::path dir = work / ("cb_" + name);
    fs::remove_all(dir);
    write_file(dir / "config" / "config.toml", toml);
    if (!csv.empty())
        write_file(dir / "config" / "state_machine_actuators.csv", csv);
    if (!thresholds.empty())
        write_file(dir / "scripts" / "calibration" / "calibrations" / "abort_thresholds.txt",
                   thresholds);
    const fs::path prev = fs::current_path();
    fs::current_path(dir);
    const auto packets = charsvc::config_broadcast_build("config/config.toml");
    fs::current_path(prev);

    o.line("## " + name + ": " + std::to_string(packets.size()) + " packets");
    for (const auto& p : packets) {
        o.line("# -> " + p.ip + ":" + std::to_string(p.port) + " type=" + std::to_string(p.type) +
               " len=" + std::to_string(p.bytes.size()));
        o.fields(p.bytes.data(), p.bytes.size(), config_packet_fields(p.bytes));
        if (p.type == 6 && p.bytes.size() > 7) {
            // Decode the address fields both ways so a byte-order change reads plainly.
            const size_t n = p.bytes[7];
            for (size_t i = 0; i < n; ++i) {
                const uint32_t v = rd32(p.bytes, 8 + i * 7);
                o.line("    abort_actuator[" + std::to_string(i) +
                       "].ip as LE u32 = " + chargold::hexu(v, 8));
            }
        }
    }
}

int do_config_broadcast(const fs::path& src) {
    const fs::path work = fs::current_path();
    const std::string base = patch_ips(read_file(src / "config" / "config_base.toml"));
    const std::string dflt = patch_ips(read_file(src / "config/profiles/default/config.toml"));
    const std::string twin = patch_ips(read_file(src / "config/profiles/digital-twin/config.toml"));
    const std::string dflt_csv =
        read_file(src / "config/profiles/default/state_machine_actuators.csv");
    const std::string twin_csv =
        read_file(src / "config/profiles/digital-twin/state_machine_actuators.csv");
    if (base.empty() || dflt.empty() || dflt_csv.empty()) {
        std::cerr << "missing config sources under " << src << std::endl;
        return 1;
    }

    Out o;
    o.line("# config_broadcast_service buildPackets(), one block per destination board.");
    o.line("# Configs are copies with every 192.168.2. rewritten to 127.0.0.; the actuator CSV is");
    o.line(
        "# the profile's, found through the service's config/ fallback; no abort_thresholds.txt");
    o.line("# unless the case says so.");
    o.line("ipToU32Le(127.0.0.11) = " +
           chargold::hexu(charsvc::config_broadcast_ip_le("127.0.0.11"), 8));
    o.line("ipToU32Le(not-an-ip) = " +
           chargold::hexu(charsvc::config_broadcast_ip_le("not-an-ip"), 8));
    cb_case(o, work, "config_base", base, dflt_csv, "");
    cb_case(o, work, "config_base+thresholds", base, dflt_csv,
            "# test thresholds\n2101 400 858993460\n2105 400.4 123456789\n2199 10 1\n");
    cb_case(o, work, "config_base+stale_threshold", base, dflt_csv, "2101 410 858993460\n");
    {
        std::string phys =
            replace_all(base, "\"Fuel Upstream\" = \"cubic\"", "\"Fuel Upstream\" = \"physics\"");
        cb_case(o, work, "config_base+physics_fuel_upstream", phys, dflt_csv, "");
    }
    cb_case(o, work, "config_base_no_csv", base, "", "");
    {
        // No designated survivor: the builder returns nothing (the service keeps last-good).
        std::string none =
            replace_all(base, "designated_survivor = true", "designated_survivor = false");
        cb_case(o, work, "config_base_no_survivor", none, dflt_csv, "");
    }
    cb_case(o, work, "profile_default", dflt, dflt_csv, "");
    cb_case(o, work, "profile_digital-twin", twin, twin_csv, "");
    int r = chargold::finish("service_config_broadcast.txt", o.s.str());
    return r ? r : (g_fail ? 1 : 0);
}

// ── UDP capture ──────────────────────────────────────────────────────────────

struct Rx {
    int fd = -1;
    uint16_t port = 0;
    Rx() {
        fd = socket(AF_INET, SOCK_DGRAM, 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof a);
        socklen_t l = sizeof a;
        getsockname(fd, reinterpret_cast<sockaddr*>(&a), &l);
        port = ntohs(a.sin_port);
        timeval tv{0, 50000};
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    }
    ~Rx() {
        close(fd);
    }
    /** Collect datagrams until `want` arrived or `ms` elapsed. */
    std::vector<std::vector<uint8_t>> take(size_t want, int ms) {
        std::vector<std::vector<uint8_t>> out;
        auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
        while (out.size() < want && std::chrono::steady_clock::now() < end) {
            uint8_t b[2048];
            ssize_t n = recv(fd, b, sizeof b, 0);
            if (n >= 0)
                out.emplace_back(b, b + n);
        }
        return out;
    }
};

std::string clocked(const std::vector<uint8_t>& b, size_t ts_off, uint64_t lo, uint64_t hi,
                    const char* clock) {
    if (b.size() < ts_off + 4)
        return hex(b);
    std::string s = hex(b.data(), ts_off);
    s += " [" + ts_check(b.data() + ts_off, lo, hi, clock) + "]";
    if (b.size() > ts_off + 4)
        s += " " + hex(b.data() + ts_off + 4, b.size() - ts_off - 4);
    return s;
}

int do_packets() {
    Out o;
    o.line("# Hand-built service packets. Clock-stamped timestamp bytes are shown as");
    o.line("# [<clock> ms, LE u32] once verified to lie between readings around the call.");

    o.line("## heartbeat_service buildHeartbeatPacket(engine_state)");
    for (uint8_t e : {0, 1, 2, 3, 4, 255}) {
        const uint64_t lo = sys_ms();
        auto b = charsvc::heartbeat_service_packet(e);
        const uint64_t hi = sys_ms();
        o.line("  engine_state=" + std::to_string(e) + " len=" + std::to_string(b.size()) + ": " +
               clocked(b, 2, lo, hi, "system_clock"));
    }
    o.line("## heartbeat_service stateToEngine(sequencer state)");
    {
        std::string s = " ";
        for (int st = 0; st <= 25; ++st)
            s += " " + std::to_string(st) + "->" +
                 std::to_string(
                     charsvc::heartbeat_service_state_to_engine(static_cast<uint8_t>(st)));
        s += " 255->" + std::to_string(charsvc::heartbeat_service_state_to_engine(255));
        o.line(s);
    }

    o.line("## daq_bridge build_server_heartbeat_packet()");
    {
        const uint64_t lo = steady_ms();
        auto b = charsvc::daq_bridge_server_heartbeat();
        const uint64_t hi = steady_ms();
        o.line("  len=" + std::to_string(b.size()) + ": " + clocked(b, 2, lo, hi, "steady_clock"));
    }
    o.line("## daq_bridge discovery_board_type_to_enum(wire) -> ActiveBoardKind");
    {
        std::string s = " ";
        for (int t = 0; t <= 10; ++t)
            s +=
                " " + std::to_string(t) + "->" +
                std::to_string(charsvc::daq_bridge_discovery_type_to_kind(static_cast<uint8_t>(t)));
        s += " 255->" + std::to_string(charsvc::daq_bridge_discovery_type_to_kind(255));
        o.line(s);
    }
    o.line("## daq_bridge config_board_type_to_wire_u8(ActiveBoardKind) -> wire");
    {
        std::string s = " ";
        for (int k = 0; k <= 8; ++k)
            s += " " + std::to_string(k) + "->" +
                 std::to_string(charsvc::daq_bridge_kind_to_wire(k));
        o.line(s);
    }
    o.line("## daq_bridge ipv4_host_octet");
    for (const char* ip : {"127.0.0.21", "192.168.2.61", "10.0.0.255", "1.2.3", "abc", ""})
        o.line(std::string("  \"") + ip + "\" -> " +
               std::to_string(charsvc::daq_bridge_ipv4_host_octet(ip)));
    o.line("## daq_bridge BackendLogForwarder envelope [board_id u8][flags u8][len u16 LE][text]");
    {
        Rx rx;
        const std::string t = "hello\nworld\n";
        charsvc::daq_bridge_forward_log(rx.port, 21, 1, reinterpret_cast<const uint8_t*>(t.data()),
                                        static_cast<uint16_t>(t.size()));
        charsvc::daq_bridge_forward_log(rx.port, 0, 0, nullptr, 0);
        std::string big(300, 'x');
        charsvc::daq_bridge_forward_log(rx.port, 71, 2,
                                        reinterpret_cast<const uint8_t*>(big.data()),
                                        static_cast<uint16_t>(big.size()));
        auto got = rx.take(3, 2000);
        o.line("  datagrams=" + std::to_string(got.size()));
        for (const auto& g : got) {
            o.line("  len=" + std::to_string(g.size()));
            o.fields(g.data(), g.size(),
                     {{"board_id", 1}, {"flags", 1}, {"text_len", 2}, {"text", g.size() - 4}});
        }
    }

    o.line("## stacklight_service stateToStacklight(state) -> r y g buzzer");
    for (int st : {0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12,  13,
                   14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 254, 255})
        o.line("  " + std::to_string(st) + ": " +
               hex(charsvc::stacklight_state_bytes(static_cast<uint8_t>(st))));

    o.line("## AbortBroadcaster (configured to 127.0.0.1, done delay 100 ms)");
    {
        Rx rx;
        sequencer::AbortBroadcaster ab;
        const bool ok = ab.configure("127.0.0.1", rx.port, 100, "127.0.0.1");
        o.line("  configure -> " + std::to_string(ok));
        uint64_t lo = steady_ms();
        ab.sendClearAbort();
        auto clear = rx.take(4, 2000);
        uint64_t hi = steady_ms();
        o.line("  sendClearAbort: datagrams=" + std::to_string(clear.size()));
        for (const auto& g : clear)
            o.line("    len=" + std::to_string(g.size()) + ": " +
                   clocked(g, 2, lo, hi, "steady_clock"));
        lo = steady_ms();
        ab.triggerAbort();
        auto ab_pk = rx.take(8, 3000);
        hi = steady_ms();
        o.line("  triggerAbort: datagrams=" + std::to_string(ab_pk.size()));
        for (const auto& g : ab_pk)
            o.line("    len=" + std::to_string(g.size()) + ": " +
                   clocked(g, 2, lo, hi, "steady_clock"));
    }

    o.line("## ControllerService PWM (sendPWMCommand, sendPWMCommands x2) to 127.0.0.1");
    {
        Rx rx;
        int tx = socket(AF_INET, SOCK_DGRAM, 0);
        const uint64_t lo = sys_ms();
        auto r = charsvc::controller_send_pwm(tx, rx.port);
        const uint64_t hi = sys_ms();
        close(tx);
        std::string rs = "  returns:";
        for (bool b : r)
            rs += b ? " 1" : " 0";
        o.line(rs);
        auto got = rx.take(3, 1000);
        o.line("  datagrams=" + std::to_string(got.size()));
        for (const auto& g : got) {
            o.line("  len=" + std::to_string(g.size()) + " timestamp " +
                   (g.size() >= 6 ? ts_check(g.data() + 2, lo, hi, "system_clock") : "?"));
            std::vector<F> fs = {{"header.packet_type", 1},
                                 {"header.version", 1},
                                 {"header.timestamp (zeroed here, checked above)", 4},
                                 {"num_commands", 1}};
            std::vector<uint8_t> masked = g;
            for (size_t i = 2; i < 6 && i < masked.size(); ++i)
                masked[i] = 0;
            const size_t n = masked.size() > 6 ? masked[6] : 0;
            for (size_t i = 0; i < n; ++i) {
                const std::string p = "cmd[" + std::to_string(i) + "]";
                fs.push_back({p + ".actuator_id", 1});
                fs.push_back({p + ".duration_ms", 4});
                fs.push_back({p + ".duty_cycle", 4});
                fs.push_back({p + ".frequency", 4});
            }
            o.fields(masked.data(), masked.size(), fs);
        }
    }
    int r = chargold::finish("service_packets.txt", o.s.str());
    if (g_fail)
        std::cerr << g_fail << " clock-stamped timestamp(s) out of range" << std::endl;
    return r ? r : (g_fail ? 1 : 0);
}

}  // namespace

int main(int argc, char** argv) {
    const std::string mode = argc > 1 ? argv[1] : "";
    if (mode == "config_broadcast" && argc > 2)
        return do_config_broadcast(argv[2]);
    if (mode == "packets")
        return do_packets();
    std::cerr << "usage: char_service_encoders config_broadcast <daq-server dir> | packets"
              << std::endl;
    return 2;
}
