/**
 * ElodinClient::read_packet() framing — what happens when a packet does not fit.
 *
 * The stream is length-prefixed packets back to back on one TCP connection, so the only thing
 * keeping a reader aligned is consuming exactly as many bytes as each length announced.
 *
 * read_packet() used to break that. On a packet larger than the caller's buffer it returned -1
 * having already consumed the 8-byte header but *not* the body, leaving the rest of that packet in
 * the socket. Every later read then parsed payload bytes as a header, and since nothing marked the
 * socket dead, is_connected() kept reporting true and callers looped on garbage forever. Observed
 * against a real elodin-db: one 179-byte packet against a 160-byte buffer, then "Invalid packet
 * length: 1638688", "134742016", "268436225" ... indefinitely.
 *
 * It also mis-sized its own bound. The check was `packet_len > max_len`, but the function writes
 * 8 + (packet_len - 4) = packet_len + 4 bytes, so packet_len == max_len passed and overran the
 * caller's buffer by 4. Confirmed with a guard page: the kernel returned EFAULT at exactly that
 * boundary.
 *
 * These tests use a fake elodin-db rather than the real one so they can produce packet sizes on
 * demand — nothing a live db emits today is big enough to trip either bug, which is why neither
 * was noticed.
 */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "elodin/ElodinClient.hpp"

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/**
 * One wire packet: len(4, LE) then len bytes of body, where the first 4 body bytes are
 * ty/packet_id(2)/request_id. So `len` = payload + 4, and the whole frame is payload + 8.
 * read_packet() reports packet_len + 4, i.e. the same payload + 8.
 */
static std::vector<uint8_t> frame(uint8_t hi, uint8_t lo, size_t payload_len, uint8_t fill) {
    const uint32_t len = static_cast<uint32_t>(payload_len + 4);
    std::vector<uint8_t> f(8 + payload_len, fill);
    std::memcpy(f.data(), &len, 4);
    f[4] = 0x01;  // ty = TABLE
    f[5] = hi;
    f[6] = lo;
    f[7] = 0x00;
    return f;
}

/** Fake elodin-db: accept one connection, write `blob`, then hold the socket open. */
struct FakeDb {
    std::thread th;
    std::atomic<bool> run{true};
    std::atomic<uint16_t> port{0};
    std::atomic<bool> closed_early{false};

    void start(std::vector<uint8_t> blob, bool close_after_write) {
        th = std::thread([this, blob = std::move(blob), close_after_write]() {
            int srv = socket(AF_INET, SOCK_STREAM, 0);
            int opt = 1;
            setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
            struct sockaddr_in a{};
            a.sin_family = AF_INET;
            a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            a.sin_port = 0;  // let the OS pick, so parallel runs cannot collide
            if (bind(srv, reinterpret_cast<struct sockaddr*>(&a), sizeof(a)) < 0) {
                close(srv);
                return;
            }
            socklen_t alen = sizeof(a);
            getsockname(srv, reinterpret_cast<struct sockaddr*>(&a), &alen);
            listen(srv, 1);
            port.store(ntohs(a.sin_port));

            struct timeval tv{.tv_sec = 5, .tv_usec = 0};
            setsockopt(srv, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
            int c = accept(srv, nullptr, nullptr);
            if (c < 0) {
                close(srv);
                return;
            }
            size_t sent = 0;
            while (sent < blob.size()) {
                ssize_t n = send(c, blob.data() + sent, blob.size() - sent, MSG_NOSIGNAL);
                if (n <= 0)
                    break;
                sent += static_cast<size_t>(n);
            }
            if (close_after_write) {
                close(c);
                closed_early.store(true);
            } else {
                while (run)
                    std::this_thread::sleep_for(std::chrono::milliseconds(20));
                close(c);
            }
            close(srv);
        });
        while (port.load() == 0)
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }

    void stop() {
        run = false;
        if (th.joinable())
            th.join();
    }
};

int main() {
    std::cout << "=== ElodinClient read_packet framing ===" << std::endl;

    // ── 1. An oversized packet is skipped, and the NEXT packet still reads correctly ──────────
    // This is the regression that matters: pre-fix, read 2 returned garbage forever.
    {
        std::vector<uint8_t> blob;
        const auto big = frame(0x20, 0x01, 200, 0xAA);  // 208 wire bytes, will not fit
        const auto small = frame(0x50, 0x00, 8, 0xBB);  // 16 wire bytes, fits
        blob.insert(blob.end(), big.begin(), big.end());
        blob.insert(blob.end(), small.begin(), small.end());

        FakeDb db;
        db.start(blob, /*close_after_write=*/false);
        fsw::elodin::ElodinClient c;
        if (!c.connect("127.0.0.1", db.port.load())) {
            std::cerr << "SKIP: cannot connect to the fake db" << std::endl;
            db.stop();
            return 0;  // environmental
        }

        uint8_t buf[64];
        const ssize_t r1 = c.read_packet(buf, sizeof(buf));
        check(r1 == 0,
              "oversized packet is skipped, not an error (got " + std::to_string(r1) + ")");

        const ssize_t r2 = c.read_packet(buf, sizeof(buf));
        check(r2 == 16, "the packet AFTER an oversized one still reads (got " + std::to_string(r2) +
                            ", want 16)");
        check(r2 == 16 && buf[5] == 0x50 && buf[6] == 0x00,
              "and it is framed correctly — stream stayed aligned");
        check(c.is_connected(), "the connection survives a skipped packet");
        db.stop();
    }

    // ── 2. The bound accounts for all 8 + (packet_len - 4) bytes written ──────────────────────
    // packet_len == max_len used to pass the check and overrun the caller's buffer by 4.
    {
        constexpr size_t kMax = 64;
        // payload 56 → packet_len 60 → writes exactly 64. The largest that legitimately fits.
        const auto exact = frame(0x50, 0x00, kMax - 8, 0xCC);
        // payload 60 → packet_len 64 == max_len: passed the old check, wrote 68 bytes.
        const auto over_by_four = frame(0x50, 0x00, kMax - 4, 0xDD);
        std::vector<uint8_t> blob;
        blob.insert(blob.end(), exact.begin(), exact.end());
        blob.insert(blob.end(), over_by_four.begin(), over_by_four.end());

        FakeDb db;
        db.start(blob, /*close_after_write=*/false);
        fsw::elodin::ElodinClient c;
        c.connect("127.0.0.1", db.port.load());

        uint8_t buf[kMax];
        const ssize_t r1 = c.read_packet(buf, sizeof(buf));
        check(r1 == static_cast<ssize_t>(kMax), "a packet that exactly fills the buffer is read");

        const ssize_t r2 = c.read_packet(buf, sizeof(buf));
        check(r2 == 0, "packet_len == max_len is skipped, not written 4 bytes past the buffer");
        db.stop();
    }

    // ── 3. A closed socket is reported as closed ──────────────────────────────────────────────
    // read_exact() never cleared connected_, so a read-only consumer looped forever on a dead
    // socket believing it was live.
    {
        FakeDb db;
        db.start(frame(0x50, 0x00, 8, 0xEE), /*close_after_write=*/true);
        fsw::elodin::ElodinClient c;
        c.connect("127.0.0.1", db.port.load());

        uint8_t buf[64];
        check(c.read_packet(buf, sizeof(buf)) == 16,
              "reads the packet the peer sent before closing");
        const ssize_t r = c.read_packet(buf, sizeof(buf));
        check(r < 0, "a read past EOF fails");
        check(!c.is_connected(), "and the client reports itself disconnected");
        db.stop();
    }

    std::cout << (g_failures ? "FAILED" : "PASSED") << std::endl;
    return g_failures ? 1 : 0;
}
