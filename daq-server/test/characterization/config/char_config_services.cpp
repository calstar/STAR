// Characterization of the config parsing that lives inside service mains, where it is file-static
// and cannot be linked against. Each service's main.cpp is #included into its own executable (the
// SERVICE macro, set by CMake, picks which), with its main() renamed out of the way — the real
// function runs, not a copy of it. Production code is untouched.
//
//   char_cfg_<service> <config.toml>
//
// Same output convention as char_config_dump: the dump, then everything the code printed.

#include <cstdio>
#include <fstream>
#include <initializer_list>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#define main char_service_main_unused
#if CHAR_SERVICE_STACKLIGHT
#include "../../../diablo_server/services/stacklight/stacklight_service_main.cpp"
#elif CHAR_SERVICE_DAQ_BRIDGE
#include "../../../diablo_server/daq_bridge/daq_bridge_main.cpp"
#elif CHAR_SERVICE_CONFIG_BROADCAST
#include "../../../diablo_server/services/config_broadcast/config_broadcast_service_main.cpp"
#else
#error "set one CHAR_SERVICE_*"
#endif
#undef main

namespace {

std::string qs(const std::string& s) {
    return "\"" + s + "\"";
}

#if CHAR_SERVICE_STACKLIGHT
// stacklight_service_main.cpp's own line scanner (getTomlValue), for every key main() asks it for,
// with the conversion main() applies to each.
void dump(const std::string& path, std::ostream& out) {
    std::ifstream f(path);
    std::ostringstream ss;
    ss << f.rdbuf();
    const std::string content = ss.str();
    for (const char* key :
         {"interval_ms", "target_ip", "target_port", "elodin_host", "elodin_port"}) {
        const std::string v = getTomlValue(content, "stacklight_service", key, "");
        out << "getTomlValue(stacklight_service, " << key << ") = " << qs(v);
        if (!v.empty() && std::string(key).find("_ip") == std::string::npos &&
            std::string(key) != "elodin_host") {
            try {
                out << " stoi=" << std::stoi(v);
            } catch (const std::exception& e) {
                out << " stoi threw " << e.what();
            }
        }
        out << "\n";
    }
    // Same scanner against sections other services read by name, to freeze how it treats a key
    // in a different section, a commented line and a missing section.
    for (const auto& [sec, key] : std::initializer_list<std::pair<const char*, const char*>>{
             {"database", "port"},
             {"network", "sensor_port"},
             {"server_heartbeat", "broadcast_ip"},
             {"no_such_section", "x"}})
        out << "getTomlValue(" << sec << ", " << key
            << ") = " << qs(getTomlValue(content, sec, key, "<fallback>")) << "\n";
}
#endif

#if CHAR_SERVICE_DAQ_BRIDGE
const char* bt(BoardType t) {
    switch (t) {
        case BoardType::PT:
            return "PT";
        case BoardType::LC:
            return "LC";
        case BoardType::TC:
            return "TC";
        case BoardType::RTD:
            return "RTD";
        case BoardType::ACTUATOR:
            return "ACTUATOR";
        case BoardType::ENCODER:
            return "ENCODER";
        case BoardType::ENVIRONMENTAL:
            return "ENVIRONMENTAL";
        case BoardType::BALL_VALVE:
            return "BALL_VALVE";
        default:
            return "UNKNOWN";
    }
}
void board(std::ostream& out, const BoardConfig& c) {
    out << "{type=" << bt(c.type) << " ip=" << qs(c.ip) << " active_channels=" << c.active_channels
        << " enabled=" << (c.enabled ? "true" : "false") << " board_id=" << c.board_id
        << " wire_u8=" << static_cast<int>(config_board_type_to_wire_u8(c.type)) << "}";
}
// daq_bridge_main.cpp's load_board_map_from_config, every out-parameter.
void dump(const std::string& path, std::ostream& out) {
    std::map<std::string, BoardConfig> board_map;
    BoardByOctet by_octet;
    std::string db_host = "unset";
    uint16_t db_port = 0, sensor_port = 0, log_port = 0;
    std::string bind_ip = "unset";
    ServerHeartbeatConfig hb;
    fsw::time::TimeSyncConfig ts;
    load_board_map_from_config(path, board_map, &by_octet, db_host, db_port, &sensor_port, &bind_ip,
                               &hb, &ts, &log_port);
    out << "db_host = " << qs(db_host) << "\ndb_port = " << db_port
        << "\nsensor_port = " << sensor_port << "\nbind_ip = " << qs(bind_ip)
        << "\nlog_port = " << log_port << "\n";
    out << "hb = {interval_ms=" << hb.interval_ms << " broadcast_port=" << hb.broadcast_port
        << " broadcast_ip=" << qs(hb.broadcast_ip)
        << " send_from_daq_bridge=" << (hb.send_from_daq_bridge ? "true" : "false") << "}\n";
    out << "time_sync = {mode="
        << (ts.mode == fsw::time::TimeSyncConfig::Mode::Arrival ? "Arrival" : "BoardClock")
        << " window_seconds=" << ts.window_seconds
        << " max_plausible_gap_s=" << ts.max_plausible_gap_s
        << " max_batch_age_s=" << ts.max_batch_age_s
        << " resync_threshold_ms=" << ts.resync_threshold_ms
        << " log_interval_s=" << ts.log_interval_s << "}\n";
    for (const auto& [ip, c] : board_map) {
        out << "board_map[" << qs(ip) << "] = ";
        board(out, c);
        out << "\n";
    }
    for (const auto& [octet, c] : by_octet) {
        out << "board_by_octet[" << octet << "] = ";
        board(out, c);
        out << "\n";
    }
    // How a packet's source address resolves to a board: each configured IP, its loopback
    // twin, and an address nothing claims.
    std::vector<std::string> probes;
    for (const auto& [ip, c] : board_map) {
        probes.push_back(ip);
        const int o = ipv4_host_octet(ip);
        if (o >= 0)
            probes.push_back("127.0.0." + std::to_string(o));
    }
    probes.push_back("10.9.8.7");
    for (const auto& ip : probes) {
        const BoardConfig* r = resolve_board_config_by_source_ip(ip, board_map, by_octet);
        out << "resolve(" << qs(ip) << ") = ";
        if (r)
            board(out, *r);
        else
            out << "null";
        out << "\n";
    }
}
#endif

#if CHAR_SERVICE_CONFIG_BROADCAST
// config_broadcast_service_main.cpp's buildPackets — the config.toml + actuators CSV -> board
// config packets translation, byte for byte — and parseVentAbortFromCsv on its own.
void dump(const std::string& path, std::ostream& out) {
    std::map<std::string, int> vent, abort;
    parseVentAbortFromCsv("config/state_machine_actuators.csv", vent, abort);
    for (const auto& [n, v] : vent)
        out << "vent[" << qs(n) << "] = " << v << "\n";
    for (const auto& [n, v] : abort)
        out << "abort[" << qs(n) << "] = " << v << "\n";
    const auto pkts = buildPackets(path);
    out << "packets.count = " << pkts.size() << "\n";
    for (size_t i = 0; i < pkts.size(); ++i) {
        const auto& [type, bytes, ip, port] = pkts[i];
        out << "packet[" << i << "] type=" << static_cast<int>(type) << " dest=" << ip << ":"
            << port << " len=" << bytes.size() << "\n";
        for (size_t off = 0; off < bytes.size(); off += 16) {
            char buf[16];
            std::snprintf(buf, sizeof(buf), "  %04zx:", off);
            out << buf;
            for (size_t k = off; k < bytes.size() && k < off + 16; ++k) {
                std::snprintf(buf, sizeof(buf), " %02x", bytes[k]);
                out << buf;
            }
            out << "\n";
        }
    }
}
#endif

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: " << argv[0] << " <config.toml>\n";
        return 2;
    }
    std::ostringstream body, cap_out, cap_err;
    std::streambuf* so = std::cout.rdbuf(cap_out.rdbuf());
    std::streambuf* se = std::cerr.rdbuf(cap_err.rdbuf());
    int code = 0;
    try {
        dump(argv[1], body);
    } catch (const std::exception& e) {
        body << "EXCEPTION " << e.what() << "\n";
        code = 1;
    }
    std::cout.rdbuf(so);
    std::cerr.rdbuf(se);
    std::cout << body.str() << "\n=== captured stdout\n"
              << cap_out.str() << "\n=== captured stderr\n"
              << cap_err.str() << "\n=== exit " << code << "\n";
    return 0;
}
