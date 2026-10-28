/**
 * A ball valve through the sequencer's actuator path, asserted on the wire.
 *
 *  1. It is commanded like any actuator: its state's column, and a manual/script command, reach
 *     the board as actuator_id 1 — pass-through, even when the role was written "NO" (a ball valve
 *     has no polarity; 1 opens it).
 *  2. Its commanded state is recorded on [0x35] BV_CMD, never on [0x32] ACT_CMD: board 71 is
 *     slot 1, the same slot as actuator board 11, and [0x32] carries no board type.
 */
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "BoardListener.hpp"
#include "control/ActuatorCommander.hpp"
#include "control/StateMachine.hpp"
#include "elodin/ElodinClient.hpp"

namespace fs = std::filesystem;
using daqtest::BoardListener;
using sequencer::ActuatorCommander;
using sequencer::State;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** Stands in for Elodin: accepts one connection and keeps every byte written to it. */
class FakeElodin {
public:
    bool start() {
        fd_ = socket(AF_INET, SOCK_STREAM, 0);
        int opt = 1;
        setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = 0;
        if (bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0)
            return false;
        socklen_t len = sizeof(addr);
        getsockname(fd_, reinterpret_cast<sockaddr*>(&addr), &len);
        port_ = ntohs(addr.sin_port);
        listen(fd_, 1);
        thread_ = std::thread([this]() {
            int c = accept(fd_, nullptr, nullptr);
            if (c < 0)
                return;
            timeval tv{0, 50000};
            setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
            uint8_t buf[4096];
            while (run_) {
                ssize_t n = read(c, buf, sizeof(buf));
                if (n == 0)
                    break;
                if (n > 0) {
                    std::lock_guard<std::mutex> lk(m_);
                    bytes_.insert(bytes_.end(), buf, buf + n);
                }
            }
            close(c);
        });
        return true;
    }
    void stop() {
        run_ = false;
        if (thread_.joinable())
            thread_.join();
        close(fd_);
    }
    uint16_t port() const {
        return port_;
    }

    /** Every commanded state written to [hi, lo], in order: the actuator_state byte. */
    std::vector<uint8_t> commanded(uint8_t hi, uint8_t lo) {
        std::lock_guard<std::mutex> lk(m_);
        // TABLE packet: u32 len (= 10 + 4) | u8 type (1) | u8 id[2] | u8 req | u64 ts | u8 ch | u8
        // st
        std::vector<uint8_t> out;
        for (size_t i = 0; i + 18 <= bytes_.size(); i++) {
            uint32_t len;
            std::memcpy(&len, &bytes_[i], 4);
            if (len == 14 && bytes_[i + 4] == 1 && bytes_[i + 5] == hi && bytes_[i + 6] == lo &&
                bytes_[i + 16] == lo)
                out.push_back(bytes_[i + 17]);
        }
        return out;
    }

private:
    int fd_ = -1;
    uint16_t port_ = 0;
    std::atomic<bool> run_{true};
    std::thread thread_;
    std::mutex m_;
    std::vector<uint8_t> bytes_;
};

static std::string writeFixture(const fs::path& dir, uint16_t port) {
    {
        std::ofstream act(dir / "state_machine_actuators.csv");
        act << ",Idle,Armed\n";
        act << "Ball Valve,CLOSE,OPEN\n";
        act << "Act Valve,CLOSE,OPEN\n";
    }
    {
        std::ofstream del(dir / "state_machine_actuator_delays.csv");
        del << ",Idle,Armed\n";
        del << "Ball Valve,0,0\n";
        del << "Act Valve,0,0\n";
    }
    // Both boards on loopback; the ball valve on channel 1, the actuator on channel 2, so the
    // listener can tell them apart. "NO" on the ball valve is deliberate: it must not invert.
    return "[network]\nactuator_cmd_port = " + std::to_string(port) +
           "\n\n[actuator_service]\nbind_address = \"0.0.0.0\"\n\n"
           "[boards.ball_valve_board]\ntype = \"BALL_VALVE\"\nip = \"127.0.0.1\"\nboard_id = 71\n"
           "enabled = true\nactive_connectors = [1]\n\n"
           "[boards.act_11]\ntype = \"ACTUATOR\"\nip = \"127.0.0.1\"\nboard_id = 11\n"
           "enabled = true\nnum_actuators = 10\n\n"
           "[actuator_roles]\n\"Ball Valve\" = [\"NO\", 1, 71]\n"
           "\"Act Valve\" = [\"NC\", 2, 11]\n";
}

static bool sawCommand(const std::vector<daqtest::Burst>& bursts, uint8_t ch, uint8_t hw) {
    for (const auto& b : bursts) {
        auto it = b.state.find(ch);
        if (it != b.state.end() && it->second == hw)
            return true;
    }
    return false;
}

int main() {
    std::cout << "=== Ball valve through the actuator commander ===" << std::endl;

    const uint16_t port = 45931;
    fs::path dir = fs::temp_directory_path() / "daq_ball_valve_commander_test";
    fs::remove_all(dir);
    fs::create_directories(dir);
    const std::string cfg = writeFixture(dir, port);
    const std::string csv = (dir / "state_machine_actuators.csv").string();

    FakeElodin elodin;
    if (!elodin.start()) {
        std::cerr << "could not start the fake Elodin" << std::endl;
        return 1;
    }
    fsw::elodin::ElodinClient client;
    if (!client.connect("127.0.0.1", elodin.port())) {
        std::cerr << "could not connect to the fake Elodin" << std::endl;
        return 1;
    }

    BoardListener listener(port);
    if (!listener.start()) {
        std::cerr << "could not bind UDP " << port << std::endl;
        return 1;
    }
    ActuatorCommander ac;
    if (!ac.load(cfg, csv)) {
        std::cerr << "load failed" << std::endl;
        return 1;
    }
    ac.setElodinClient(&client);

    // Entering Armed opens both (the column), then a manual command closes the ball valve.
    ac.applyForState(State::ARMED, /*is_transition=*/true);
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    check(ac.sendSingleActuator("Ball Valve", 0), "manual close of the ball valve accepted");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    listener.stop();

    const auto bursts = listener.bursts();
    check(sawCommand(bursts, 1, 1), "Armed column: ball valve sent 1 (open), not inverted by NO");
    check(sawCommand(bursts, 1, 0), "manual close: ball valve sent 0");
    check(sawCommand(bursts, 2, 1), "Armed column: the actuator on board 11 still sent 1");

    // Board 71 slot 1 ch 1 -> [0x35, 0x01]; board 11 slot 1 ch 2 -> [0x32, 0x02].
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const auto bv = elodin.commanded(0x35, 0x01);
    check(bv.size() >= 2 && bv.front() == 1 && bv.back() == 0,
          "BV_CMD [0x35, 0x01] recorded open then closed (" + std::to_string(bv.size()) +
              " writes)");
    check(elodin.commanded(0x32, 0x01).empty(),
          "nothing written to ACT_CMD [0x32, 0x01], actuator board 11's channel 1");
    const auto act = elodin.commanded(0x32, 0x02);
    check(!act.empty() && act.back() == 1, "the actuator's own state is still on [0x32, 0x02]");

    client.disconnect();
    elodin.stop();
    fs::remove_all(dir);

    if (g_failures) {
        std::cout << g_failures << " check(s) failed" << std::endl;
        return 1;
    }
    std::cout << "Ball valve commander passed" << std::endl;
    return 0;
}
