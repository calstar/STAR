/**
 * Which NIC board traffic leaves from.
 *
 * The DAQ used to own its machine, so an unbound socket and "the board NIC" were the same thing.
 * It now shares the apps box with the Docker stack and the site LAN, and resolveDaqBindAddress()
 * is what re-establishes the guarantee. Every sender in the pipeline routes through it, so its
 * four outcomes are pinned here rather than left to be discovered on a rig.
 *
 * Addresses are chosen so the results do not depend on the machine running the test:
 *   - 127.0.0.x   is loopback, present everywhere (this is also the shape the sim uses)
 *   - 192.0.2.x   is TEST-NET-1 (RFC 5737), guaranteed not assigned to any interface
 *   - 198.51.100.x is TEST-NET-2, likewise — used for "no NIC on the board subnet"
 *
 * The ambiguous case (two interfaces on the board subnet) is deliberately not tested: it cannot
 * be produced without adding an address to the host, which a unit test has no business doing.
 */
#include <sys/socket.h>
#include <unistd.h>

#include <iostream>
#include <string>

#include "config/Config.hpp"
#include "net/DaqInterface.hpp"

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** A config with two boards on the given subnet, and an optional explicit [network].bind_ip. */
static fsw::config::Config makeConfig(const std::string& board_prefix,
                                      const std::string& bind_ip = "") {
    std::string toml;
    if (!bind_ip.empty())
        toml += "[network]\nbind_ip = \"" + bind_ip + "\"\n\n";
    toml += "[boards.a]\ntype = \"PT\"\nip = \"" + board_prefix + ".21\"\nboard_id = 21\n";
    toml += "enabled = true\n\n";
    toml += "[boards.b]\ntype = \"PT\"\nip = \"" + board_prefix + ".22\"\nboard_id = 22\n";
    toml += "enabled = true\n";
    return fsw::config::load_from_string(toml);
}

int main() {
    std::cout << "=== DAQ interface resolution ===" << std::endl;

    // 1. Auto-detect finds the interface holding the board subnet. Loopback holds 127.0.0.0/8, so
    //    boards at 127.0.0.x resolve to it — which is exactly how a sim run resolves.
    {
        const auto r = fsw::net::resolveDaqBindAddress(makeConfig("127.0.0"), "test");
        check(r.ok, "auto: loopback boards resolve without error");
        check(r.pinned, "auto: loopback boards are pinned to a NIC");
        check(r.address.rfind("127.", 0) == 0,
              "auto: pinned address is on loopback (got " + r.address + ")");
    }

    // 2. No interface on the board subnet — a dev laptop or a CI runner. Must stay soft: hard
    //    failing here would break ./dev.sh on every machine without a test stand attached.
    {
        const auto r = fsw::net::resolveDaqBindAddress(makeConfig("198.51.100"), "test");
        check(r.ok, "no match: does not fail startup");
        check(!r.pinned, "no match: reports itself as unpinned");
        check(r.address == "0.0.0.0", "no match: falls back to 0.0.0.0");
    }

    // 3. An explicit [network].bind_ip wins over auto-detection.
    {
        const auto r = fsw::net::resolveDaqBindAddress(makeConfig("127.0.0", "127.0.0.1"), "test");
        check(r.ok && r.pinned, "explicit: accepted");
        check(r.address == "127.0.0.1", "explicit: uses the configured address");
    }

    // 4. An explicit bind_ip that is not on this host fails startup rather than degrading to
    //    0.0.0.0. Silently ignoring the operator's pin is the original bug wearing a config key.
    {
        const auto r = fsw::net::resolveDaqBindAddress(makeConfig("127.0.0", "192.0.2.1"), "test");
        check(!r.ok, "explicit but absent: refuses to start");
        check(!r.pinned, "explicit but absent: not reported as pinned");
    }

    // 5. bindToDaqInterface on real sockets. "0.0.0.0" is a no-op returning success, so every
    //    caller can invoke it unconditionally and the dev path needs no special case.
    {
        int s1 = ::socket(AF_INET, SOCK_DGRAM, 0);
        check(fsw::net::bindToDaqInterface(s1, "0.0.0.0", "test"), "bind: 0.0.0.0 is a no-op");
        ::close(s1);

        int s2 = ::socket(AF_INET, SOCK_DGRAM, 0);
        check(fsw::net::bindToDaqInterface(s2, "127.0.0.1", "test"), "bind: a local address binds");
        ::close(s2);

        int s3 = ::socket(AF_INET, SOCK_DGRAM, 0);
        check(!fsw::net::bindToDaqInterface(s3, "192.0.2.1", "test"),
              "bind: an address not on this host fails rather than silently not binding");
        ::close(s3);
    }

    std::cout << (g_failures ? "FAILED" : "PASSED") << std::endl;
    return g_failures ? 1 : 0;
}
