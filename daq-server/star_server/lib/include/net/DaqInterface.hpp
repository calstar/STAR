#ifndef FSW_DAQ_INTERFACE_HPP
#define FSW_DAQ_INTERFACE_HPP

#include <string>

#include "config/Config.hpp"

namespace fsw {
namespace net {

/**
 * Which local NIC board traffic leaves from.
 *
 * The DAQ used to own its machine, so "the route the kernel picks" and "the board LAN" were the
 * same sentence. It now shares the apps box with the Docker stack and the site LAN, and they are
 * not: an unbound UDP socket sending to a broadcast address, or to a board whose subnet is
 * reachable two ways, can leave on the wrong wire with no error anywhere.
 *
 * The fix every board-facing socket uses is to bind its *local address* to the NIC holding the
 * board subnet. That is deliberately not SO_BINDTODEVICE: the services run as unprivileged
 * `systemd --user` units and SO_BINDTODEVICE needs CAP_NET_RAW, which none of them has.
 *
 * The selection rule mirrors deploy/bootstrap_daq.sh, which already picks the board NIC by
 * address rather than by name (the name varies — eth0, enxXXXXXXXX — the address does not,
 * because the firmware hardcodes the server at 192.168.2.20).
 */
struct DaqBindResult {
    /** False means the caller must abort startup: the operator asked for something impossible. */
    bool ok = true;
    /** Address to bind. "0.0.0.0" means unpinned — see `pinned`. */
    std::string address = "0.0.0.0";
    /** True when `address` names a real NIC. False on the dev/CI path, where nothing matched. */
    bool pinned = false;
    /** Human-readable account of the decision. Already logged by resolveDaqBindAddress(). */
    std::string detail;
};

/**
 * Decide which local address board traffic should leave from, and log the decision.
 *
 * 1. `[network].bind_ip` set to something other than 0.0.0.0 — use it verbatim. If it cannot be
 *    bound, return ok=false. An explicit pin that silently degrades to 0.0.0.0 is this bug
 *    wearing a config key.
 * 2. Otherwise auto-detect: the local IPv4 interface whose subnet contains the configured board
 *    addresses. Exactly one match is the normal case, on the rig and under the sim (whose boards
 *    are 127.0.0.x, matched by loopback's /8).
 * 3. More than one match — return ok=false, naming the candidates. Ambiguity is the defect;
 *    picking one is how we got here.
 * 4. No match — 0.0.0.0 with a warning. This is a dev laptop or CI, where the board subnet does
 *    not exist and hard-failing would break `./dev.sh`.
 *
 * @param who Service name for log lines, e.g. "Sequencer".
 */
// NOTE the leading "::". FSWConfigManager declares a nested `fsw::fsw` namespace, so inside
// `namespace fsw` the name `fsw` resolves to it and a plain `fsw::config::Config` becomes
// `fsw::fsw::config::Config` — which compiles or not depending on include order alone.
DaqBindResult resolveDaqBindAddress(const ::fsw::config::Config& cfg, const char* who);

/**
 * bind() an already-created socket to `address` on an ephemeral port.
 * A no-op returning true for "0.0.0.0" or "", so callers need no special case for the dev path.
 * Logs and returns false on failure.
 */
bool bindToDaqInterface(int sock, const std::string& address, const char* who);

}  // namespace net
}  // namespace fsw

#endif
