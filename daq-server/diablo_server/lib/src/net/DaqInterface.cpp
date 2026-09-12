#include "net/DaqInterface.hpp"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace fsw {
namespace net {

namespace {

bool isUnpinned(const std::string& a) {
    return a.empty() || a == "0.0.0.0";
}

/** Parse dotted-quad into host-order uint32. Returns false on anything else. */
bool parseV4(const std::string& s, uint32_t& out) {
    struct in_addr a{};
    if (inet_pton(AF_INET, s.c_str(), &a) != 1)
        return false;
    out = ntohl(a.s_addr);
    return true;
}

/** Can this address actually be bound on this host? The only honest test is to try. */
bool canBind(const std::string& address) {
    int s = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0)
        return false;
    struct sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = 0;
    if (inet_pton(AF_INET, address.c_str(), &local.sin_addr) != 1) {
        ::close(s);
        return false;
    }
    const bool ok = ::bind(s, reinterpret_cast<struct sockaddr*>(&local), sizeof(local)) == 0;
    ::close(s);
    return ok;
}

/**
 * The board addresses we are trying to reach. Only explicitly configured IPs are used: the
 * synthesized "192.168.2.<board_id>" fallback some services apply would hardcode the very subnet
 * this function exists to discover, and would make the sim (127.0.0.x boards) resolve to the
 * hardware LAN.
 */
std::vector<uint32_t> boardAddresses(const ::fsw::config::Config& cfg) {
    std::vector<uint32_t> out;
    for (const auto& b : cfg.boards) {
        if (!b.enabled || b.ip.empty())
            continue;
        uint32_t v = 0;
        if (parseV4(b.ip, v))
            out.push_back(v);
    }
    // No board carries an explicit IP (a minimal config, as the unit tests write). The broadcast
    // destination names the same subnet, so it answers the same question.
    if (out.empty()) {
        uint32_t v = 0;
        if (parseV4(cfg.server_heartbeat.broadcast_ip, v) && v != 0xFFFFFFFFu)
            out.push_back(v);
    }
    return out;
}

struct Candidate {
    std::string iface;
    std::string address;
};

}  // namespace

// ─────────────────────────────────────────────────────────────────────────────
DaqBindResult resolveDaqBindAddress(const ::fsw::config::Config& cfg, const char* who) {
    DaqBindResult r;

    // 1. Explicit pin wins, and must work.
    if (!isUnpinned(cfg.network.bind_ip)) {
        r.address = cfg.network.bind_ip;
        if (!canBind(r.address)) {
            r.ok = false;
            r.detail = "[network].bind_ip = " + r.address + " is not an address on this host";
            std::cerr << "[" << who << "] " << r.detail
                      << " — refusing to start. Board traffic would leave on an interface nobody "
                         "chose. Fix the NIC or clear the key to auto-detect."
                      << std::endl;
            return r;
        }
        r.pinned = true;
        r.detail = "board traffic pinned to " + r.address + " (explicit [network].bind_ip)";
        std::cout << "[" << who << "] " << r.detail << std::endl;
        return r;
    }

    // 2. Auto-detect: the interface whose subnet holds the configured boards.
    const std::vector<uint32_t> boards = boardAddresses(cfg);
    std::vector<Candidate> matches;

    struct ifaddrs* ifa_head = nullptr;
    if (getifaddrs(&ifa_head) == 0) {
        for (struct ifaddrs* ifa = ifa_head; ifa; ifa = ifa->ifa_next) {
            if (!ifa->ifa_addr || !ifa->ifa_netmask || ifa->ifa_addr->sa_family != AF_INET)
                continue;
            if (!(ifa->ifa_flags & IFF_UP))
                continue;

            const uint32_t addr =
                ntohl(reinterpret_cast<struct sockaddr_in*>(ifa->ifa_addr)->sin_addr.s_addr);
            const uint32_t mask =
                ntohl(reinterpret_cast<struct sockaddr_in*>(ifa->ifa_netmask)->sin_addr.s_addr);

            bool holds_a_board = false;
            for (uint32_t b : boards) {
                if ((b & mask) == (addr & mask)) {
                    holds_a_board = true;
                    break;
                }
            }
            if (!holds_a_board)
                continue;

            // A NIC with two addresses in the subnet is not ambiguous — egress is the same
            // interface either way — so keep the first and do not let it trip the check below.
            const std::string name = ifa->ifa_name ? ifa->ifa_name : "?";
            bool already = false;
            for (const auto& c : matches)
                if (c.iface == name)
                    already = true;
            if (already)
                continue;

            char buf[INET_ADDRSTRLEN] = {0};
            struct in_addr net_order{};
            net_order.s_addr = htonl(addr);
            inet_ntop(AF_INET, &net_order, buf, sizeof(buf));
            matches.push_back({name, buf});
        }
        freeifaddrs(ifa_head);
    }

    // 3. Ambiguous — say so rather than guess. Guessing is the bug.
    if (matches.size() > 1) {
        std::ostringstream os;
        os << "board subnet is reachable on " << matches.size() << " interfaces (";
        for (size_t i = 0; i < matches.size(); ++i)
            os << (i ? ", " : "") << matches[i].iface << " " << matches[i].address;
        os << ")";
        r.ok = false;
        r.detail = os.str();
        std::cerr << "[" << who << "] " << r.detail
                  << " — refusing to start. Set [network].bind_ip to the one board traffic should "
                     "use."
                  << std::endl;
        return r;
    }

    if (matches.size() == 1) {
        r.address = matches[0].address;
        r.pinned = true;
        r.detail = "board traffic pinned to " + matches[0].iface + " " + r.address + " (auto)";
        std::cout << "[" << who << "] " << r.detail << std::endl;
        return r;
    }

    // 4. Nothing on the board subnet: a dev laptop or CI. Stay unpinned — hard-failing here would
    // break ./dev.sh, and there is no wrong wire to leave on when there is only one.
    r.address = "0.0.0.0";
    r.pinned = false;
    r.detail = "no local interface on the board subnet — board traffic is NOT pinned to a NIC";
    std::cout << "[" << who << "] " << r.detail
              << " (expected on a dev box; on the rig this means the 192.168.2.x NIC is missing)"
              << std::endl;
    return r;
}

// ─────────────────────────────────────────────────────────────────────────────
bool bindToDaqInterface(int sock, const std::string& address, const char* who) {
    if (isUnpinned(address))
        return true;  // dev path — nothing to pin to, whatever the socket is
    if (sock < 0)
        return false;

    struct sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = 0;  // ephemeral; we are choosing an interface, not a port
    if (inet_pton(AF_INET, address.c_str(), &local.sin_addr) != 1) {
        std::cerr << "[" << who << "] bad DAQ bind address '" << address << "'" << std::endl;
        return false;
    }
    if (::bind(sock, reinterpret_cast<struct sockaddr*>(&local), sizeof(local)) < 0) {
        std::cerr << "[" << who << "] bind to DAQ interface " << address
                  << " failed: " << strerror(errno) << std::endl;
        return false;
    }
    return true;
}

}  // namespace net
}  // namespace fsw
