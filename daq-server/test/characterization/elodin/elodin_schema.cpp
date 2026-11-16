// Characterization: the Elodin schema the C++ services register, captured byte for byte.
//
// An ElodinClient connects to a loopback TCP listener this test owns (127.0.0.1, ephemeral port)
// instead of elodin-db, and each service's registration sequence is replayed through the real
// fsw::elodin::DatabaseConfig with the boards fsw::config::load_active_boards() derives from a
// patched copy of a config (every 192.168.2. rewritten to 127.0.0.). Every captured Elodin packet
// is printed with its header, decoded with db.hpp's own postcard decoder (VTableMsg: ops, fields,
// data; SetComponentMetadata / SetEntityMetadata: id and name; VTableStream: table id), and its
// raw bytes. Goldens: schema_<config>.txt.
//
//   daq_bridge   register_tables, register_calibrated_tables, register_ball_valve_tables,
//                register_heartbeat_tables(config board ids), register_environmental_tables,
//                register_self_test_tables — in daq_bridge_main.cpp's order
//   calibration  register_calibrated_tables, register_ball_valve_calibrated_tables
//   sequencer    register_non_sensor_tables(actuator boards), register_ball_valve_cmd_tables
//   t7           register_t7_raw_tables / register_t7_calibrated_tables with FIXED arguments
//                (slot 1; AIN 0-3 + CJC raw; three calibrated fields) — not config-derived
//   subscribe    ElodinClient::subscribe_table / subscribe_tables framing
//
// Usage: char_elodin_schema <daq-server source dir> <config_base|profile_default|...>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "config/LoadActiveBoards.hpp"
#include "db.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "golden.hpp"
#include "svc_bridge.hpp"

namespace fs = std::filesystem;
using chargold::hex;
using chargold::hexu;
using chargold::Out;

namespace {

// ── loopback capture server ──────────────────────────────────────────────────

class Capture {
public:
    Capture() {
        lfd_ = socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        setsockopt(lfd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        bind(lfd_, reinterpret_cast<sockaddr*>(&a), sizeof a);
        listen(lfd_, 4);
        socklen_t l = sizeof a;
        getsockname(lfd_, reinterpret_cast<sockaddr*>(&a), &l);
        port_ = ntohs(a.sin_port);
        th_ = std::thread([this] {
            loop();
        });
    }
    ~Capture() {
        stop_ = true;
        shutdown(lfd_, SHUT_RDWR);
        close(lfd_);
        if (th_.joinable())
            th_.join();
    }
    uint16_t port() const {
        return port_;
    }
    /** Bytes of connection n, once its peer has closed it. */
    std::vector<uint8_t> wait(size_t n) {
        std::unique_lock<std::mutex> lk(m_);
        cv_.wait_for(lk, std::chrono::seconds(20), [&] {
            return done_.size() > n;
        });
        return done_.size() > n ? done_[n] : std::vector<uint8_t>{};
    }

private:
    void loop() {
        while (!stop_) {
            int c = accept(lfd_, nullptr, nullptr);
            if (c < 0)
                return;
            std::vector<uint8_t> buf;
            uint8_t b[65536];
            for (;;) {
                ssize_t n = recv(c, b, sizeof b, 0);
                if (n <= 0)
                    break;
                buf.insert(buf.end(), b, b + n);
            }
            close(c);
            std::lock_guard<std::mutex> lk(m_);
            done_.push_back(std::move(buf));
            cv_.notify_all();
        }
    }
    int lfd_ = -1;
    uint16_t port_ = 0;
    std::atomic<bool> stop_{false};
    std::thread th_;
    std::mutex m_;
    std::condition_variable cv_;
    std::vector<std::vector<uint8_t>> done_;
};

// ── decoding ─────────────────────────────────────────────────────────────────

const char* kPrim[] = {"U8", "U16", "U32", "U64", "I8", "I16", "I32", "I64", "Bool", "F32", "F64"};

std::string msg_kind(uint8_t a, uint8_t b) {
    auto is = [&](std::string_view n) {
        auto id = fsw::elodin::msg_id(n);
        return id[0] == a && id[1] == b;
    };
    if (is("VTableMsg"))
        return "VTableMsg";
    if (is("SetComponentMetadata"))
        return "SetComponentMetadata";
    if (is("SetEntityMetadata"))
        return "SetEntityMetadata";
    if (is("VTableStream"))
        return "VTableStream";
    return "?";
}

struct Pkt {
    uint32_t len;
    uint8_t ty, id0, id1, req;
    std::vector<uint8_t> payload, raw;
};

std::vector<Pkt> split(const std::vector<uint8_t>& s, std::string& tail_note) {
    std::vector<Pkt> v;
    size_t o = 0;
    while (o + 8 <= s.size()) {
        uint32_t len;
        std::memcpy(&len, s.data() + o, 4);
        if (len < 4 || o + 4 + len > s.size())
            break;
        Pkt p{len, s[o + 4], s[o + 5], s[o + 6], s[o + 7], {}, {}};
        p.payload.assign(s.begin() + static_cast<long>(o + 8),
                         s.begin() + static_cast<long>(o + 4 + len));
        p.raw.assign(s.begin() + static_cast<long>(o), s.begin() + static_cast<long>(o + 4 + len));
        v.push_back(std::move(p));
        o += 4 + len;
    }
    if (o != s.size())
        tail_note = "UNFRAMED TAIL " + std::to_string(s.size() - o) +
                    " bytes: " + hex(s.data() + o, s.size() - o);
    return v;
}

uint64_t data_u64(const VTable& vt, const OpData& d) {
    uint64_t v = 0;
    if (d.offset + d.len <= vt.data.size())
        std::memcpy(&v, vt.data.data() + d.offset, std::min<size_t>(8, d.len));
    return v;
}

std::string op_str(const Op& op) {
    switch (op.index()) {
        case 0: {
            const auto& d = std::get<0>(op);
            return "Data(off=" + std::to_string(d.offset) + ",len=" + std::to_string(d.len) + ")";
        }
        case 1: {
            const auto& t = std::get<1>(op);
            return "Table(off=" + std::to_string(t.offset) + ",len=" + std::to_string(t.len) + ")";
        }
        case 3:
            return "Component(op=" + std::to_string(std::get<3>(op).component_id) + ")";
        case 4: {
            const auto& s = std::get<4>(op);
            return "Schema(ty=op" + std::to_string(s.ty) + ",dim=op" + std::to_string(s.dim) +
                   ",arg=op" + std::to_string(s.arg) + ")";
        }
        case 5: {
            const auto& t = std::get<5>(op);
            return "Timestamp(src=op" + std::to_string(t.source) + ",arg=op" +
                   std::to_string(t.arg) + ")";
        }
        case 6:
            return "Ext";
        default:
            return "variant#" + std::to_string(op.index());
    }
}

/** Resolve a field's arg chain to "type shape component" text. */
std::string field_str(const VTable& vt, const Field& f,
                      const std::map<uint64_t, std::string>& names) {
    auto op_at = [&](uint16_t i) -> const Op* {
        return i < vt.ops.size() ? &vt.ops[i] : nullptr;
    };
    const Op* a = op_at(f.arg);
    if (!a || a->index() != 4)
        return "arg=" + (a ? op_str(*a) : std::string("<bad op>"));
    const auto& sch = std::get<4>(*a);
    std::string out;
    const Op* ty = op_at(sch.ty);
    if (ty && ty->index() == 0) {
        uint64_t t = data_u64(vt, std::get<0>(*ty));
        out += "type=" + (t < 11 ? std::string(kPrim[t]) : "prim#" + std::to_string(t));
    }
    const Op* dim = op_at(sch.dim);
    if (dim && dim->index() == 0) {
        const auto& d = std::get<0>(*dim);
        out += " shape=[";
        for (size_t k = 0; k + 8 <= d.len; k += 8) {
            uint64_t x;
            std::memcpy(&x, vt.data.data() + d.offset + k, 8);
            out += (k ? "," : "") + std::to_string(x);
        }
        out += "]";
    }
    const Op* arg = op_at(sch.arg);
    if (arg && arg->index() == 3) {
        const Op* cid = op_at(std::get<3>(*arg).component_id);
        if (cid && cid->index() == 0) {
            uint64_t id = data_u64(vt, std::get<0>(*cid));
            auto it = names.find(id);
            out += " component=" + (it != names.end() ? it->second : "<unnamed>") + " (" +
                   hexu(id, 16) + ")";
        }
    } else if (arg) {
        out += " arg=" + op_str(*arg);
    }
    return out;
}

void dump_section(Out& o, const std::string& title, const std::vector<uint8_t>& stream) {
    std::string tail;
    auto pkts = split(stream, tail);
    o.line("## " + title + ": " + std::to_string(pkts.size()) + " packets, " +
           std::to_string(stream.size()) + " bytes");
    // First pass: component names this section declares.
    std::map<uint64_t, std::string> names;
    for (const auto& p : pkts) {
        if (msg_kind(p.id0, p.id1) != "SetComponentMetadata")
            continue;
        SetComponentMetadata m;
        postcard_slice_t sl;
        postcard_init_slice(&sl, const_cast<uint8_t*>(p.payload.data()), p.payload.size());
        if (m.decode_raw(&sl) == POSTCARD_SUCCESS)
            names[m.value.component_id] = m.value.name;
    }
    size_t k = 0;
    for (const auto& p : pkts) {
        const std::string kind = p.ty == 0 ? msg_kind(p.id0, p.id1) : "TABLE?";
        o.line("#" + std::to_string(k++) + " len=" + std::to_string(p.len) +
               " ty=" + std::to_string(p.ty) + " id=[" + hexu(p.id0, 2) + "," + hexu(p.id1, 2) +
               "] req=" + std::to_string(p.req) + " " + kind);
        postcard_slice_t sl;
        postcard_init_slice(&sl, const_cast<uint8_t*>(p.payload.data()), p.payload.size());
        if (kind == "VTableMsg") {
            VTableMsg m;
            if (m.decode_raw(&sl) != POSTCARD_SUCCESS) {
                o.line("  <decode failed>");
            } else {
                const auto& vt = m.vtable;
                o.line("  table=[" + hexu(std::get<0>(m.id), 2) + "," + hexu(std::get<1>(m.id), 2) +
                       "] ops=" + std::to_string(vt.ops.size()) +
                       " fields=" + std::to_string(vt.fields.size()) + " data_len=" +
                       std::to_string(vt.data.size()) + " consumed=" + std::to_string(sl.len) +
                       "/" + std::to_string(p.payload.size()));
                for (size_t i = 0; i < vt.fields.size(); ++i) {
                    const auto& f = vt.fields[i];
                    o.line("  field[" + std::to_string(i) + "] offset=" + std::to_string(f.offset) +
                           " len=" + std::to_string(f.len) + " " + field_str(vt, f, names));
                }
                std::string ops = "  ops:";
                for (size_t i = 0; i < vt.ops.size(); ++i)
                    ops += " " + std::to_string(i) + "=" + op_str(vt.ops[i]);
                o.line(ops);
                o.line("  data: " + hex(vt.data));
            }
        } else if (kind == "SetComponentMetadata") {
            SetComponentMetadata m;
            if (m.decode_raw(&sl) == POSTCARD_SUCCESS) {
                const bool id_ok = m.value.component_id == fsw::elodin::component_id(m.value.name);
                o.line("  component \"" + m.value.name + "\" id=" + hexu(m.value.component_id, 16) +
                       (id_ok ? "" : " (id != component_id(name))") +
                       " metadata=" + std::to_string(m.value.metadata.size()) +
                       " asset=" + std::to_string(m.value.asset));
            } else {
                o.line("  <decode failed>");
            }
        } else if (kind == "SetEntityMetadata") {
            SetEntityMetadata m;
            if (m.decode_raw(&sl) == POSTCARD_SUCCESS)
                o.line("  entity \"" + m.value.name + "\" id=" + hexu(m.value.entity_id, 16) +
                       " metadata=" + std::to_string(m.value.metadata.size()));
            else
                o.line("  <decode failed>");
        } else if (kind == "VTableStream" && p.payload.size() == 2) {
            o.line("  subscribe table=[" + hexu(p.payload[0], 2) + "," + hexu(p.payload[1], 2) +
                   "]");
        }
        o.line("  raw: " + hex(p.raw));
    }
    if (!tail.empty())
        o.line("  " + tail);
}

std::string read_file(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    std::stringstream s;
    s << f.rdbuf();
    return s.str();
}

std::string patch_ips(std::string s) {
    const std::string a = "192.168.2.", b = "127.0.0.";
    for (size_t i = s.find(a); i != std::string::npos; i = s.find(a, i + b.size()))
        s.replace(i, a.size(), b);
    return s;
}

std::string boards_str(const std::vector<fsw::elodin::BoardChannels>& v) {
    std::string s;
    for (const auto& b : v) {
        s += " {id=" + std::to_string(b.board_id) + " slot=" + std::to_string(b.board_number) +
             " ch=";
        for (auto c : b.channels)
            s += std::to_string(c) + ",";
        s += "}";
    }
    return s.empty() ? " (none)" : s;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: char_elodin_schema <daq-server dir> <config name>" << std::endl;
        return 2;
    }
    const fs::path src = argv[1];
    const std::string which = argv[2];
    fs::path cfg_src;
    if (which == "config_base")
        cfg_src = src / "config" / "config_base.toml";
    else if (which.rfind("profile_", 0) == 0)
        cfg_src = src / "config" / "profiles" / which.substr(8) / "config.toml";
    const std::string text = read_file(cfg_src);
    if (text.empty()) {
        std::cerr << "cannot read " << cfg_src << std::endl;
        return 2;
    }
    const fs::path cfg = fs::current_path() / ("elodin_" + which + ".toml");
    {
        std::ofstream f(cfg, std::ios::binary);
        f << patch_ips(text);
    }

    using fsw::config::ActiveBoardKind;
    using fsw::elodin::DatabaseConfig;
    auto active = fsw::config::load_active_boards(cfg.string());
    const auto& pt = active[ActiveBoardKind::PT];
    const auto& act = active[ActiveBoardKind::ACTUATOR];
    const auto& tc = active[ActiveBoardKind::TC];
    const auto& rtd = active[ActiveBoardKind::RTD];
    const auto& env = active[ActiveBoardKind::ENVIRONMENTAL];
    const auto& lc = active[ActiveBoardKind::LC];
    const auto& enc = active[ActiveBoardKind::ENCODER];
    const auto& bv = active[ActiveBoardKind::BALL_VALVE];
    const auto ids = charsvc::daq_bridge_config_board_ids(cfg.string());

    Out o;
    o.line("# Elodin registration captured from fsw::elodin::DatabaseConfig for " + which +
           " (IPs patched to 127.0.0.x)");
    o.line("boards PT:" + boards_str(pt));
    o.line("boards ACTUATOR:" + boards_str(act));
    o.line("boards TC:" + boards_str(tc));
    o.line("boards RTD:" + boards_str(rtd));
    o.line("boards LC:" + boards_str(lc));
    o.line("boards ENCODER:" + boards_str(enc));
    o.line("boards ENVIRONMENTAL:" + boards_str(env));
    o.line("boards BALL_VALVE:" + boards_str(bv));
    o.line("daq_bridge config_board_ids: " + hex(ids));
    {
        auto raw = fsw::elodin::raw_sensor_tables(pt, act, tc, rtd, lc, enc);
        auto cal = fsw::elodin::calibrated_sensor_tables(pt, tc, rtd, lc, enc, act);
        std::string s = "raw_sensor_tables:";
        for (auto [h, l] : raw)
            s += " " + hexu(h, 2) + "/" + hexu(l, 2);
        o.line(s);
        s = "calibrated_sensor_tables:";
        for (auto [h, l] : cal)
            s += " " + hexu(h, 2) + "/" + hexu(l, 2);
        o.line(s);
        s = "ball_valve raw/cal/cmd tables:";
        for (auto [h, l] : fsw::elodin::ball_valve_raw_tables(bv))
            s += " " + hexu(h, 2) + "/" + hexu(l, 2);
        for (auto [h, l] : fsw::elodin::ball_valve_calibrated_tables(bv))
            s += " " + hexu(h, 2) + "/" + hexu(l, 2);
        for (auto [h, l] : fsw::elodin::ball_valve_cmd_tables(bv))
            s += " " + hexu(h, 2) + "/" + hexu(l, 2);
        o.line(s);
    }

    Capture cap;
    size_t conn = 0;
    auto section = [&](const std::string& title,
                       const std::function<std::string(fsw::elodin::ElodinClient&)>& body) {
        fsw::elodin::ElodinClient client;
        if (!client.connect("127.0.0.1", cap.port())) {
            o.line("## " + title + ": CONNECT FAILED");
            return;
        }
        const std::string rets = body(client);
        client.flush_buffer();
        client.disconnect();
        auto bytes = cap.wait(conn++);
        o.line("");
        if (!rets.empty())
            o.line("# " + title + " returns: " + rets);
        dump_section(o, title, bytes);
    };
    auto b = [](bool v) {
        return std::string(v ? "1" : "0");
    };

    section("daq_bridge", [&](fsw::elodin::ElodinClient& c) {
        std::string r =
            "register_tables=" + b(DatabaseConfig::register_tables(c, pt, act, tc, rtd, lc, enc));
        r += " register_calibrated_tables=" +
             b(DatabaseConfig::register_calibrated_tables(c, pt, tc, rtd, lc, enc, act));
        if (!bv.empty())
            r += " register_ball_valve_tables=" +
                 b(DatabaseConfig::register_ball_valve_tables(c, bv));
        r += " register_heartbeat_tables=" + b(DatabaseConfig::register_heartbeat_tables(c, ids));
        r += " register_environmental_tables=" +
             b(DatabaseConfig::register_environmental_tables(c, env));
        r += " register_self_test_tables=" + b(DatabaseConfig::register_self_test_tables(c, ids));
        return r;
    });
    section("calibration", [&](fsw::elodin::ElodinClient& c) {
        std::string r = "register_calibrated_tables=" +
                        b(DatabaseConfig::register_calibrated_tables(c, pt, tc, rtd, lc, enc, act));
        if (!bv.empty())
            r += " register_ball_valve_calibrated_tables=" +
                 b(DatabaseConfig::register_ball_valve_calibrated_tables(c, bv));
        return r;
    });
    section("sequencer", [&](fsw::elodin::ElodinClient& c) {
        std::string r =
            "register_non_sensor_tables=" + b(DatabaseConfig::register_non_sensor_tables(c, act));
        if (!bv.empty())
            r += " register_ball_valve_cmd_tables=" +
                 b(DatabaseConfig::register_ball_valve_cmd_tables(c, bv));
        return r;
    });
    if (which == "config_base") {
        section("t7 (fixed arguments)", [&](fsw::elodin::ElodinClient& c) {
            std::string r = "register_t7_raw_tables=" +
                            b(DatabaseConfig::register_t7_raw_tables(c, 1, {0, 1, 2, 3}, true));
            r += " register_t7_calibrated_tables=" +
                 b(DatabaseConfig::register_t7_calibrated_tables(
                     c, 1, {{0, "pressure_psi"}, {1, "temperature_c"}, {2, "force_kg"}}));
            return r;
        });
        section("subscribe framing", [&](fsw::elodin::ElodinClient& c) {
            std::string r = "subscribe_table(0x50,0x00,7)=" + b(c.subscribe_table(0x50, 0x00, 7));
            r += " subscribe_tables({50/00,46/00,20/01})=" +
                 b(c.subscribe_tables({fsw::elodin::kTableSequencerState,
                                       fsw::elodin::kTableCalibrationCommand,
                                       {0x20, 0x01}}));
            return r;
        });
    }
    return chargold::finish("schema_" + which + ".txt", o.s.str());
}
