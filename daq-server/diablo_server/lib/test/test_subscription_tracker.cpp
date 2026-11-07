/**
 * SubscriptionTracker + ElodinClient::subscribe_table: a subscription the DB refuses is asked for
 * again, and only that one.
 *
 * On 2026-11-05 calibration_service subscribed to the ball valve's raw tables a moment before
 * daq_bridge registered them. The DB refused (ErrorResponse, echoing the request id), nothing
 * noticed, and no ball valve position was published for the whole session. Calibration's only
 * recovery was "no packets at all for 5 s", which never fires while other tables stream.
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <set>
#include <thread>
#include <vector>

#include "elodin/ElodinClient.hpp"
#include "elodin/SubscriptionTracker.hpp"

using fsw::elodin::SubscriptionTracker;
using namespace std::chrono_literals;

static int g_failures = 0;
#define CHECK(cond)                                                      \
    do {                                                                 \
        if (!(cond)) {                                                   \
            std::cerr << "FAIL " << __LINE__ << ": " #cond << std::endl; \
            g_failures++;                                                \
        }                                                                \
    } while (0)

static void test_error_response_is_recognised() {
    // len(4) | ty | [0xE0, 0x1D] | request id | postcard string
    const uint8_t err[] = {5, 0, 0, 0, 0, 0xE0, 0x1D, 7, 4, 'n', 'o', 'p', 'e'};
    const uint8_t data[] = {16, 0, 0, 0, 1, 0x33, 0x01, 0, 1, 2, 3, 4};
    CHECK(fsw::elodin::is_error_response(err, sizeof(err)));
    CHECK(!fsw::elodin::is_error_response(data, sizeof(data)));
    CHECK(!fsw::elodin::is_error_response(err, 7));  // too short to carry a request id
}

static void test_refused_table_is_asked_for_again() {
    SubscriptionTracker tr(1000ms);
    const auto t0 = SubscriptionTracker::Clock::now();
    const uint8_t pt = tr.assign({0x20, 0x01});
    const uint8_t bv = tr.assign({0x33, 0x01});
    CHECK(pt != bv);

    const auto t = tr.rejected(bv, t0);
    CHECK(t.first == 0x33 && t.second == 0x01);
    CHECK(tr.refused() == 1);
    CHECK(tr.due(t0 + 999ms).empty());  // waits before asking again

    const auto again = tr.due(t0 + 1000ms);
    CHECK(again.size() == 1 && again[0].first == 0x33 && again[0].second == 0x01);
    CHECK(tr.due(t0 + 5000ms).empty());  // asked once; only another refusal brings it back
}

static void test_accepted_table_is_never_asked_for_twice() {
    // The reason this is not PressureFeed's "re-ask for anything silent": a table the DB accepted
    // for a board that is off is silent too, and re-asking would give it a second stream.
    SubscriptionTracker tr(1000ms);
    const auto t0 = SubscriptionTracker::Clock::now();
    tr.assign({0x23, 0x01});  // e.g. a TC board that is powered down
    CHECK(tr.due(t0 + 1h).empty());
    CHECK(tr.refused() == 0);
}

static void test_unknown_request_id_names_nothing() {
    SubscriptionTracker tr;
    const auto t = tr.rejected(200, SubscriptionTracker::Clock::now());
    CHECK(t.first == 0 && t.second == 0);
    CHECK(tr.refused() == 0);
}

static void test_ids_rotate_and_skip_0_and_255() {
    SubscriptionTracker tr;
    std::set<int> seen;
    for (int i = 0; i < 600; i++) {
        const uint8_t id = tr.assign({0x20, static_cast<uint8_t>(i)});
        CHECK(id != 0 && id != 255);
        seen.insert(id);
    }
    CHECK(seen.size() == 254);
}

static void test_reset_forgets_everything() {
    SubscriptionTracker tr(1ms);
    const auto t0 = SubscriptionTracker::Clock::now();
    const uint8_t id = tr.assign({0x33, 0x02});
    tr.reset();
    CHECK(tr.rejected(id, t0).first == 0);  // pre-reset id means nothing
    tr.rejected(tr.assign({0x33, 0x02}), t0);
    tr.reset();
    CHECK(tr.due(t0 + 1s).empty());
}

/** subscribe_table puts the request id where the DB echoes it from: header byte 7. */
static void test_request_id_is_on_the_wire() {
    std::atomic<uint16_t> port{0};
    std::vector<uint8_t> got;
    std::thread db([&]() {
        int srv = socket(AF_INET, SOCK_STREAM, 0);
        int opt = 1;
        setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
        struct sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = 0;
        bind(srv, reinterpret_cast<struct sockaddr*>(&a), sizeof(a));
        socklen_t sl = sizeof(a);
        getsockname(srv, reinterpret_cast<struct sockaddr*>(&a), &sl);
        listen(srv, 1);
        port = ntohs(a.sin_port);
        int c = accept(srv, nullptr, nullptr);
        uint8_t buf[64];
        while (got.size() < 20) {
            ssize_t n = read(c, buf, sizeof(buf));
            if (n <= 0)
                break;
            got.insert(got.end(), buf, buf + n);
        }
        close(c);
        close(srv);
    });
    for (int i = 0; i < 500 && port.load() == 0; i++)
        std::this_thread::sleep_for(2ms);

    fsw::elodin::ElodinClient client;
    CHECK(client.connect("127.0.0.1", port.load()));
    CHECK(client.subscribe_table(0x33, 0x01, 42));
    CHECK(client.subscribe_tables({{0x20, 0x05}}));  // untracked: request id 0
    db.join();

    CHECK(got.size() == 20);
    if (got.size() == 20) {
        CHECK(got[5] == 0x11 && got[6] == 0x0d);  // VTableStream
        CHECK(got[7] == 42);
        CHECK(got[8] == 0x33 && got[9] == 0x01);
        CHECK(got[17] == 0);
        CHECK(got[18] == 0x20 && got[19] == 0x05);
    }
}

int main() {
    test_error_response_is_recognised();
    test_refused_table_is_asked_for_again();
    test_accepted_table_is_never_asked_for_twice();
    test_unknown_request_id_names_nothing();
    test_ids_rotate_and_skip_0_and_255();
    test_reset_forgets_everything();
    test_request_id_is_on_the_wire();
    if (g_failures) {
        std::cerr << g_failures << " failure(s)" << std::endl;
        return 1;
    }
    std::cout << "test_subscription_tracker: all passed" << std::endl;
    return 0;
}
