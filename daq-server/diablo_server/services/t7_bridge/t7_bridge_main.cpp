// t7_bridge — streams LabJack T7 analog inputs into Elodin.
//
// Inputs only: this process never writes a DIO, DAC or anything else that drives hardware. The
// only device writes are the stream configuration in fsw::t7::plan_stream() (ranges, input mode,
// stream timing), sent to the T7s declared in config and nowhere else.
//
// One thread per enabled [boards.*] type = "T7". Each opens its T7 by IP over Ethernet, streams
// the configured AINs, and publishes every sample to Elodin table {0x26, (slot-1)*0x20 + ain}
// (entity T7<slot>.AIN<n>, value in volts). A lost link, a stream error or a missing Elodin is
// retried with backoff; samples taken while Elodin is down are counted and dropped.
//
// Usage: t7_bridge [--config config/config.toml] [--fake] [--board <section>]
//          [--elodin-host H] [--elodin-port P]
//   --fake   stand-in T7s (FakeT7Device) instead of LJM: for a dev box with no hardware or LJM.

#include <signal.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "comms/messages/sensor/T7Messages.hpp"
#include "config/Config.hpp"
#include "elodin/DatabaseConfig.hpp"
#include "elodin/ElodinClient.hpp"
#include "t7/T7Stream.hpp"

#ifdef T7_HAVE_LJM
#include "LjmT7Device.hpp"
#endif

namespace {

std::atomic<bool> g_running{true};

// One line per statement even with a thread per T7: buffer, then write under a lock.
std::mutex g_log_mutex;
class Line {
public:
    explicit Line(std::ostream& out) : out_(out) {
    }
    ~Line() {
        std::lock_guard<std::mutex> lock(g_log_mutex);
        out_ << buf_.str() << std::flush;
    }
    template <typename T>
    Line& operator<<(const T& v) {
        buf_ << v;
        return *this;
    }
    Line& operator<<(std::ostream& (*manip)(std::ostream&)) {
        buf_ << manip;
        return *this;
    }

private:
    std::ostream& out_;
    std::ostringstream buf_;
};

void on_signal(int) {
    g_running = false;
}

uint64_t epoch_ns() {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                     std::chrono::system_clock::now().time_since_epoch())
                                     .count());
}

// Sleep that wakes early on shutdown.
void nap(std::chrono::milliseconds d) {
    const auto until = std::chrono::steady_clock::now() + d;
    while (g_running && std::chrono::steady_clock::now() < until)
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
}

struct Options {
    std::string config_path = "config/config.toml";
    std::string only_board;  // "" = every enabled T7
    std::string elodin_host;
    int elodin_port = 0;
    bool fake = false;
};

std::unique_ptr<fsw::t7::T7Device> make_device(bool fake) {
    if (fake) {
        fsw::t7::FakeT7Device::Options o;
        o.realtime = true;
        return std::make_unique<fsw::t7::FakeT7Device>(o);
    }
#ifdef T7_HAVE_LJM
    return std::make_unique<fsw::t7::LjmT7Device>();
#else
    return nullptr;  // main() refuses to start without --fake in this build
#endif
}

void run_board(const fsw::config::T7Board& board, const fsw::time::TimeSyncConfig& time_sync,
               const std::string& db_host, uint16_t db_port, bool fake) {
    const std::string tag = "[t7_bridge " + board.section + "] ";
    fsw::elodin::ElodinClient db;
    auto next_db_attempt = std::chrono::steady_clock::now();
    auto backoff = std::chrono::milliseconds(1000);

    while (g_running) {
        fsw::t7::T7Session session(board, make_device(fake), time_sync, epoch_ns);
        try {
            const double rate = session.start();
            Line(std::cout) << tag << "streaming " << session.plan().ains.size() << " AIN from "
                            << board.ip << " at " << rate << " scans/s (asked "
                            << board.scan_rate_hz << ")" << std::endl;
            backoff = std::chrono::milliseconds(1000);

            uint64_t published = 0, skipped = 0, dropped = 0;
            auto next_log = std::chrono::steady_clock::now() + std::chrono::seconds(10);

            while (g_running) {
                // Elodin comes and goes independently of the T7; keep streaming either way so the
                // device buffer never backs up, and (re)register the tables on every connect.
                if (!db.is_connected() && std::chrono::steady_clock::now() >= next_db_attempt) {
                    next_db_attempt = std::chrono::steady_clock::now() + std::chrono::seconds(2);
                    if (db.connect(db_host, db_port)) {
                        if (fsw::elodin::DatabaseConfig::register_t7_tables(db, board.slot(),
                                                                            session.plan().ains))
                            Line(std::cout)
                                << tag << "Elodin connected, tables registered" << std::endl;
                        else
                            Line(std::cerr)
                                << tag << "Elodin table registration incomplete" << std::endl;
                    }
                }

                const fsw::t7::Block block = session.read();
                skipped += block.skipped_samples;
                if (block.skipped_samples > 0)
                    Line(std::cerr) << tag << "stream auto-recovery: " << block.skipped_samples
                                    << " samples lost (device buffer overflowed)" << std::endl;

                if (db.is_connected()) {
                    db.begin_batch();
                    for (const auto& s : block.samples) {
                        comms::messages::sensor::T7RawMessage msg;
                        msg.setField<0>(s.timestamp_ns);
                        msg.setField<1>(s.ain);
                        msg.setField<2>(std::array<uint8_t, 3>{0, 0, 0});
                        msg.setField<3>(s.volts);
                        msg.setField<4>(s.sample_ms);
                        msg.setField<5>(uint8_t{0});
                        db.publish(fsw::t7::table_id(board.slot(), s.ain), msg);
                    }
                    if (db.flush_batch()) {
                        published += block.samples.size();
                    } else {
                        dropped += block.samples.size();
                        Line(std::cerr) << tag << "Elodin write failed (" << db.last_error()
                                        << "), reconnecting" << std::endl;
                        db.disconnect();
                    }
                    // Drain the db's replies so its socket buffer never fills and stalls us.
                    std::array<uint8_t, 4096> drain;
                    while (db.is_connected() && db.read_data(drain.data(), drain.size()) > 0) {
                    }
                } else {
                    dropped += block.samples.size();
                }

                if (std::chrono::steady_clock::now() >= next_log) {
                    next_log += std::chrono::seconds(10);
                    Line(std::cout)
                        << tag << "published " << published << ", dropped (no Elodin) " << dropped
                        << ", lost to auto-recovery " << skipped << " | backlog device "
                        << block.backlog.device_scans << " / LJM " << block.backlog.ljm_scans
                        << " scans" << std::endl;
                }
            }
        } catch (const fsw::t7::T7Error& e) {
            Line(std::cerr) << tag << e.what() << " — retrying in " << backoff.count() << " ms"
                            << std::endl;
        }
        session.stop();
        if (g_running) {
            nap(backoff);
            backoff = std::min(backoff * 2, std::chrono::milliseconds(10000));
        }
    }
    Line(std::cout) << tag << "stopped" << std::endl;
}

}  // namespace

int main(int argc, char* argv[]) {
    Options opt;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) {
                std::cerr << a << " needs a value" << std::endl;
                std::exit(2);
            }
            return argv[++i];
        };
        if (a == "--config")
            opt.config_path = next();
        else if (a == "--board")
            opt.only_board = next();
        else if (a == "--elodin-host")
            opt.elodin_host = next();
        else if (a == "--elodin-port")
            opt.elodin_port = std::atoi(next().c_str());
        else if (a == "--fake")
            opt.fake = true;
        else {
            std::cout << "Usage: " << argv[0]
                      << " [--config path] [--fake] [--board boards.<name>] [--elodin-host H]"
                         " [--elodin-port P]"
                      << std::endl;
            return a == "--help" || a == "-h" ? 0 : 2;
        }
    }

#ifndef T7_HAVE_LJM
    if (!opt.fake) {
        std::cerr << "[t7_bridge] built without LabJack LJM (libLabJackM not found at configure "
                     "time). Install LJM and rebuild, or run with --fake."
                  << std::endl;
        return 3;
    }
#endif

    const fsw::config::Config cfg = fsw::config::load(opt.config_path);
    if (!cfg.t7_errors.empty()) {
        std::cerr << "[t7_bridge] refusing to start, the T7 config has problems:" << std::endl;
        for (const auto& e : cfg.t7_errors)
            std::cerr << "  " << e << std::endl;
        return 2;
    }

    std::vector<fsw::config::T7Board> boards;
    for (const auto& b : cfg.t7_boards)
        if (b.enabled && (opt.only_board.empty() || b.section == opt.only_board))
            boards.push_back(b);
    if (boards.empty()) {
        std::cout << "[t7_bridge] no enabled T7 in " << opt.config_path
                  << (opt.only_board.empty() ? "" : " matching " + opt.only_board)
                  << "; nothing to do" << std::endl;
        return 0;
    }

    const std::string db_host = opt.elodin_host.empty() ? cfg.database.host : opt.elodin_host;
    const uint16_t db_port =
        static_cast<uint16_t>(opt.elodin_port > 0 ? opt.elodin_port : cfg.database.port);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);  // a dropped Elodin socket must not kill the process

    std::cout << "[t7_bridge] " << boards.size() << " T7(s), Elodin " << db_host << ":" << db_port
              << (opt.fake ? ", FAKE devices" : "") << std::endl;
    std::vector<std::thread> threads;
    for (const auto& b : boards)
        threads.emplace_back(run_board, b, cfg.time_sync, db_host, db_port, opt.fake);
    for (auto& t : threads)
        t.join();
    return 0;
}
