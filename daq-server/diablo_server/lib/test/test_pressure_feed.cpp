/**
 * PressureFeed: the sequencer's one reader of live calibrated pressure.
 *
 * Driven against a fake elodin-db so the whole path is exercised — connect, subscribe, decode,
 * key by table, gate — with no real database and no boards.
 *
 * The two failures this is really here to prevent are both silent:
 *
 *  1. Reading the WRONG SENSOR. ControllerService keys its measurements by channel number, which
 *     is how its `P_copv` came to be assigned from channel 6 — "GN2 Regulated" on this rig, the
 *     regulated downstream pressure, not the COPV. Here the table id is computed from the role, so
 *     the test asserts that a packet on board 2's table lands under the board-2 role and nowhere
 *     else.
 *
 *  2. Acting on a number that must not be acted on. A PT whose model is "cubic" with no captured
 *     points publishes a smooth, plausible 0.0 PSI with calibration_status = 0. A script taking
 *     90% of that computes a target of zero and then does nothing at all, successfully, while an
 *     operator watches the state enter and cleanly exit. Both that and a stale reading must be
 *     refused rather than returned.
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "comms/messages/sensor/CalibratedPTMessage.hpp"
#include "config/Config.hpp"
#include "control/PressureFeed.hpp"

using sequencer::PressureFeed;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** One calibrated-PT frame for table [0x20, lo]. */
static std::vector<uint8_t> ptFrame(uint8_t lo, uint8_t channel, float psi, uint8_t cal_status) {
    comms::messages::sensor::CalibratedPTMessage msg(
        /*timestamp_ns=*/1, channel, std::array<uint8_t, 3>{0, 0, 0}, psi,
        /*raw_adc=*/12345u, cal_status);

    std::vector<uint8_t> payload(comms::messages::sensor::CalibratedPTMessage::nbytes());
    msg.serialize(payload.data());

    const uint32_t len = static_cast<uint32_t>(payload.size() + 4);
    std::vector<uint8_t> f(8 + payload.size());
    std::memcpy(f.data(), &len, 4);
    f[4] = 0x01;  // ty = TABLE
    f[5] = 0x20;  // calibrated PT
    f[6] = lo;
    f[7] = 0x00;
    std::memcpy(f.data() + 8, payload.data(), payload.size());
    return f;
}

/**
 * Fake elodin-db: accept one connection, drain whatever the client subscribes with, then write
 * `blob` and hold the socket open so the feed stays connected.
 */
struct FakeDb {
    std::thread th;
    std::atomic<bool> run{true};
    std::atomic<uint16_t> port{0};

    void start(std::vector<uint8_t> blob) {
        th = std::thread([this, blob = std::move(blob)]() {
            int srv = socket(AF_INET, SOCK_STREAM, 0);
            int opt = 1;
            setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
            struct sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            a.sin_port = 0;  // OS-assigned, so parallel runs cannot collide
            if (bind(srv, reinterpret_cast<struct sockaddr*>(&a), sizeof(a)) < 0) {
                close(srv);
                return;
            }
            socklen_t sl = sizeof(a);
            getsockname(srv, reinterpret_cast<struct sockaddr*>(&a), &sl);
            port = ntohs(a.sin_port);
            listen(srv, 1);

            int c = accept(srv, nullptr, nullptr);
            if (c < 0) {
                close(srv);
                return;
            }
            // Let the subscribe messages land before answering.
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            ssize_t unused = write(c, blob.data(), blob.size());
            (void)unused;
            while (run)
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            close(c);
            close(srv);
        });
        for (int i = 0; i < 500 && port.load() == 0; i++)
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    void stop() {
        run = false;
        if (th.joinable())
            th.join();
    }
};


/**
 * Fake elodin-db that REFUSES the first subscription, the way the real one does when the
 * calibrated VTable does not exist yet.
 *
 * It says nothing back — which is the whole problem: a refusal is invisible to the C++ client,
 * which sends request id 0 and never reads a reply. Data is published only once a RE-subscribe
 * arrives, so this passes if and only if PressureFeed asks again.
 */
struct FakeDbRefuseFirst {
    std::thread th;
    std::atomic<bool> run{true};
    std::atomic<uint16_t> port{0};
    std::atomic<int> subscribes{0};

    void start(std::vector<uint8_t> blob, int publishAfterSubscribes) {
        th = std::thread([this, blob = std::move(blob), publishAfterSubscribes]() {
            int srv = socket(AF_INET, SOCK_STREAM, 0);
            int opt = 1;
            setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
            struct sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            a.sin_port = 0;
            if (bind(srv, reinterpret_cast<struct sockaddr*>(&a), sizeof(a)) < 0) {
                close(srv);
                return;
            }
            socklen_t sl = sizeof(a);
            getsockname(srv, reinterpret_cast<struct sockaddr*>(&a), &sl);
            port = ntohs(a.sin_port);
            listen(srv, 1);

            int c = accept(srv, nullptr, nullptr);
            if (c < 0) {
                close(srv);
                return;
            }
            // Each subscribe_tables() entry is a 10-byte MSG. Count them; publish only once
            // enough have arrived that at least one must have been a RE-subscribe.
            bool published = false;
            uint8_t buf[512];
            while (run) {
                const ssize_t n = recv(c, buf, sizeof(buf), MSG_DONTWAIT);
                if (n > 0)
                    subscribes += static_cast<int>(n / 10);
                if (!published && subscribes.load() >= publishAfterSubscribes) {
                    ssize_t unused = write(c, blob.data(), blob.size());
                    (void)unused;
                    published = true;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
            close(c);
            close(srv);
        });
        for (int i = 0; i < 500 && port.load() == 0; i++)
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    void stop() {
        run = false;
        if (th.joinable())
            th.join();
    }
};

/** Two PT boards laid out as the server profile lays them out. */
static const char* kConfig = R"TOML(
[boards.pt_board]
type = "PT"
ip = "127.0.0.1"
board_id = 21
enabled = true

[boards.pt_board_2]
type = "PT"
ip = "127.0.0.1"
board_id = 22
enabled = true

[sensor_roles_pt_board]
"GN2 Regulated" = 6

[sensor_roles_pt_board_2]
"GN2 High" = 4
)TOML";

int main() {
    std::cout << "=== PressureFeed ===" << std::endl;

    const fsw::config::Config cfg = fsw::config::load_from_string(kConfig);

    // GN2 Regulated -> board 1 ch 6 -> 0x16. GN2 High -> board 2 ch 4 -> 0x34.
    // 0x34 is outside the 0x11..0x1A window ControllerService filters on, which is exactly how it
    // loses every board-2 sensor.
    {
        std::vector<uint8_t> blob;
        const auto a = ptFrame(0x16, 6, 250.0f, /*cal=*/1);
        const auto b = ptFrame(0x34, 4, 4321.0f, /*cal=*/1);
        blob.insert(blob.end(), a.begin(), a.end());
        blob.insert(blob.end(), b.begin(), b.end());

        FakeDb db;
        db.start(blob);
        check(db.port.load() != 0, "fake elodin-db is listening");

        PressureFeed feed;
        feed.start(cfg, {"GN2 Regulated", "GN2 High"}, "127.0.0.1", db.port.load());
        std::this_thread::sleep_for(std::chrono::milliseconds(400));

        double psi = 0.0;
        check(feed.read("GN2 Regulated", psi) == PressureFeed::Status::Ok && psi == 250.0,
              "a board-1 reading lands under its own role");

        psi = 0.0;
        check(feed.read("GN2 High", psi) == PressureFeed::Status::Ok && psi == 4321.0,
              "a BOARD-2 reading lands too — table 0x34, which a board-1 filter would drop");

        check(feed.read("Nonexistent", psi) == PressureFeed::Status::NotSubscribed,
              "a role nothing subscribed to is NotSubscribed, not a stale zero");

        feed.stop();
        db.stop();
    }

    // ── An uncalibrated reading is refused, not returned ──────────────────────────────────────
    {
        FakeDb db;
        db.start(ptFrame(0x16, 6, 0.0f, /*cal=*/0));  // the plausible-looking 0.0 PSI

        PressureFeed feed;
        feed.start(cfg, {"GN2 Regulated"}, "127.0.0.1", db.port.load());
        std::this_thread::sleep_for(std::chrono::milliseconds(400));

        double psi = -1.0;
        const auto s = feed.read("GN2 Regulated", psi);
        check(s == PressureFeed::Status::Uncalibrated,
              "calibration_status = 0 is refused even though a number arrived");
        check(psi == -1.0, "and no value is handed back to be acted on");
        check(PressureFeed::explain("GN2 Regulated", s).find("UNCALIBRATED") != std::string::npos,
              "the refusal says why, in words an operator can act on");

        feed.stop();
        db.stop();
    }

    // ── A reading that stops arriving goes stale ──────────────────────────────────────────────
    {
        FakeDb db;
        db.start(ptFrame(0x16, 6, 250.0f, /*cal=*/1));

        PressureFeed feed;
        feed.start(cfg, {"GN2 Regulated"}, "127.0.0.1", db.port.load());
        std::this_thread::sleep_for(std::chrono::milliseconds(300));

        double psi = 0.0;
        check(feed.read("GN2 Regulated", psi) == PressureFeed::Status::Ok, "fresh at first");

        // Nothing more is published; the socket stays open, so this is the "db alive but this
        // sensor stopped" case rather than a disconnect.
        std::this_thread::sleep_for(std::chrono::milliseconds(PressureFeed::kMaxAgeMs + 300));
        check(feed.read("GN2 Regulated", psi) == PressureFeed::Status::Stale,
              "and stale once it stops arriving — a press loop must not cycle against a frozen "
              "number");

        feed.stop();
        db.stop();
    }


    // ── A refused subscription is asked for again ────────────────────────────────────────────
    //
    // The stand, 2026-09-16: PressureFeed subscribed to the calibrated PT tables 146 ms BEFORE
    // calibration_service registered them. The db answered "invalid msg id", subscribe_tables
    // reported success because the socket write worked, and nothing ever retried — so the feed
    // was blind for the life of the process and every dynamic state reading a pressure was
    // refused entry with "has produced no reading yet" for the whole session.
    {
        std::vector<uint8_t> blob;
        const auto a = ptFrame(0x16, 6, 250.0f, /*cal=*/1);
        blob.insert(blob.end(), a.begin(), a.end());

        FakeDbRefuseFirst db;
        // Two roles subscribe on connect (2 messages); publishing only at 3 means the feed must
        // have re-sent at least one of them.
        db.start(blob, /*publishAfterSubscribes=*/3);
        check(db.port.load() != 0, "refusing fake db is listening");

        PressureFeed feed;
        feed.start(cfg, {"GN2 Regulated", "GN2 High"}, "127.0.0.1", db.port.load());

        double psi = 0.0;
        bool got = false;
        for (int i = 0; i < 400; i++) {  // up to ~4 s; the resubscribe interval is 1 s
            if (feed.read("GN2 Regulated", psi) == PressureFeed::Status::Ok) {
                got = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        check(got, "a table refused on first subscribe is re-subscribed and starts delivering");
        check(got && psi > 249.0 && psi < 251.0, "and the value that arrives is the right one");
        check(db.subscribes.load() >= 3, "the feed really did send a second subscribe");

        feed.stop();
        db.stop();
    }

    // ── Subscribing to nothing opens no socket at all ─────────────────────────────────────────
    {
        PressureFeed feed;
        feed.start(cfg, {}, "127.0.0.1", 1);  // port 1: nothing is there, and nothing should try
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        check(feed.subscribedRoles().empty(), "no roles, no subscription, no thread");
        double psi = 0.0;
        check(feed.read("GN2 High", psi) == PressureFeed::Status::NotSubscribed,
              "and every read is NotSubscribed");
        feed.stop();
    }

    // ── A role config does not declare is skipped rather than guessed at ──────────────────────
    {
        PressureFeed feed;
        feed.start(cfg, {"Not On Any Board"}, "127.0.0.1", 1);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        check(feed.subscribedRoles().empty(), "an unresolvable role subscribes to nothing");
        feed.stop();
    }

    std::cout << (g_failures == 0 ? "\nAll pressure-feed checks passed.\n"
                                  : "\nFAILURES: " + std::to_string(g_failures) + "\n");
    return g_failures == 0 ? 0 : 1;
}
