#!/usr/bin/env python3
"""Generate dnsmasq DHCP config from the DAQ board registry.

The board LAN is an isolated segment (unmanaged switch + wifi bridge, no router)
that the DAQ server owns end-to-end, so the server runs dnsmasq as the sole DHCP
authority. Each board's static IP is a *reservation* keyed by its MAC; unknown
boards get a lease from a small dynamic pool so their MAC can be discovered and
promoted to a reservation.

Single source of truth is the `[boards.*]` table in the active DAQ config
(the same TOML the rest of the stack reads): each board already carries `ip`
and `board_id`; this reads the `mac` field added alongside them. IP is handed
out unchanged (== 192.168.2.<board_id>), so DHCP replaces *how* a board gets its
address, not *which* address — nothing downstream renumbers.

Emits two files into --out-dir:
  star-dhcp.conf   stable base config (interface, pool, options); DHCP-only.
  star-dhcp.hosts  MAC->IP reservations, one per board that has a mac.

The systemd unit points dnsmasq at star-dhcp.conf, which references the hosts
file via dhcp-hostsfile. Reservations reload on SIGHUP (systemctl reload) with
no service bounce; base-config changes need a restart.
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import sys
from pathlib import Path

try:
    import tomllib as _toml  # stdlib since Python 3.11
except ModuleNotFoundError:  # pragma: no cover - older Python on the Jetson
    import tomli as _toml  # type: ignore[no-redef]

# Board LAN NIC on the DAQ host. The USB Ethernet adapter is statically
# 192.168.2.20/24 (see deploy/setup/fix_board_ip.sh). Override with --interface
# or $DHCP_INTERFACE if the adapter (and thus the enx… name) ever changes.
DEFAULT_INTERFACE = os.environ.get("DHCP_INTERFACE", "enx00e04c680240")
DEFAULT_POOL_START = 200
DEFAULT_POOL_END = 250
DEFAULT_LEASE = "2h"
DEFAULT_LEASEFILE = "/var/lib/misc/star-dhcp.leases"

_MAC_RE = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")


def _die(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _warn(msg: str) -> None:
    print(f"warning: {msg}", file=sys.stderr)


def normalize_mac(raw: str) -> str | None:
    """Return a lowercase colon-form MAC, or None if `raw` isn't a MAC.

    Accepts colon- or hyphen-separated, any case. Blank -> None (no reservation
    yet, not an error)."""
    s = raw.strip().lower().replace("-", ":")
    if not s:
        return None
    if not _MAC_RE.match(s):
        _die(f"malformed MAC {raw!r} (want aa:bb:cc:dd:ee:ff)")
    return s


def resolve_subnet(cfg: dict) -> ipaddress.IPv4Network:
    """Board-LAN subnet. Prefer [discovery].subnet, fall back to
    [system.network].base_ip, else derive from the board IPs."""
    disc = cfg.get("discovery", {})
    if isinstance(disc, dict) and disc.get("subnet"):
        return ipaddress.ip_network(disc["subnet"], strict=False)
    net = cfg.get("system", {}).get("network", {}) if isinstance(cfg.get("system"), dict) else {}
    if net.get("base_ip"):
        return ipaddress.ip_network(f"{net['base_ip']}/24", strict=False)
    ips = [b["ip"] for b in cfg.get("boards", {}).values() if isinstance(b, dict) and b.get("ip")]
    if not ips:
        _die("cannot determine board subnet: no [discovery].subnet, "
             "[system.network].base_ip, or [boards.*].ip in config")
    return ipaddress.ip_network(f"{ipaddress.ip_address(ips[0])}/24", strict=False)


def collect_reservations(cfg: dict, subnet: ipaddress.IPv4Network) -> list[tuple[str, str, str]]:
    """(name, mac, ip) per board that has a usable mac. Boards without a mac are
    skipped with a warning — that's the normal pre-discovery state."""
    boards = cfg.get("boards", {})
    if not isinstance(boards, dict) or not boards:
        _warn("no [boards.*] table in config — emitting an empty reservations file")
        return []

    reservations: list[tuple[str, str, str]] = []
    seen_mac: dict[str, str] = {}
    seen_ip: dict[str, str] = {}
    for name, b in boards.items():
        if not isinstance(b, dict):
            continue
        ip = b.get("ip")
        if not ip:
            _warn(f"board {name!r} has no ip — skipped")
            continue
        mac = normalize_mac(str(b.get("mac", "")))
        if mac is None:
            _warn(f"board {name!r} ({ip}) has no mac yet — no static lease; "
                  "plug it in, read its MAC from the lease table, then fill it in")
            continue
        if ipaddress.ip_address(ip) not in subnet:
            _die(f"board {name!r} ip {ip} is outside subnet {subnet}")
        if mac in seen_mac:
            _die(f"duplicate MAC {mac} on {name!r} and {seen_mac[mac]!r}")
        if ip in seen_ip:
            _die(f"duplicate IP {ip} on {name!r} and {seen_ip[ip]!r}")
        seen_mac[mac] = name
        seen_ip[ip] = name
        reservations.append((name, mac, ip))
    return reservations


def sanitize_hostname(name: str) -> str:
    """dnsmasq accepts a hostname label per reservation; keep it DNS-safe."""
    h = re.sub(r"[^a-zA-Z0-9-]", "-", name).strip("-")
    return h[:63] or "board"


def build_hosts(reservations: list[tuple[str, str, str]]) -> str:
    lines = [
        "# GENERATED by generate_dhcp_config.py — do not edit by hand.",
        "# Reservations reload on SIGHUP (systemctl reload star-dhcp). One per line:",
        "#   <mac>,<ip>,<hostname>,infinite",
        "",
    ]
    for name, mac, ip in reservations:
        lines.append(f"{mac},{ip},{sanitize_hostname(name)},infinite")
    lines.append("")
    return "\n".join(lines)


def build_conf(*, interface: str, subnet: ipaddress.IPv4Network,
               pool_start: int, pool_end: int, lease: str,
               hostsfile: Path, leasefile: str) -> str:
    hosts = list(subnet.hosts())
    base = ".".join(str(subnet.network_address).split(".")[:3])  # /24 prefix
    pool_lo = f"{base}.{pool_start}"
    pool_hi = f"{base}.{pool_end}"
    if ipaddress.ip_address(pool_lo) not in subnet or ipaddress.ip_address(pool_hi) not in subnet:
        _die(f"pool {pool_lo}-{pool_hi} is outside subnet {subnet}")
    netmask = str(subnet.netmask)
    return "\n".join([
        "# GENERATED by generate_dhcp_config.py — do not edit by hand.",
        "# DHCP-only server for the isolated board LAN. dnsmasq is the sole DHCP",
        "# authority on this segment; there is no router and no DNS here.",
        "",
        "# No DNS listener — DHCP only.",
        "port=0",
        "",
        f"# Serve ONLY the board NIC; never touch any other interface.",
        f"interface={interface}",
        "bind-interfaces",
        "except-interface=lo",
        "",
        "# Sole DHCP server on this segment -> answer authoritatively.",
        "dhcp-authoritative",
        "",
        "# Hand out IP + netmask only. Suppress the router (opt 3) and DNS (opt 6)",
        "# options: this is a flat L2 island with nothing to route to.",
        "dhcp-option=3",
        "dhcp-option=6",
        "",
        f"# Dynamic pool for unknown boards (clear of statics and the .100-.150",
        f"# discovery range). Read a new board's MAC from the lease table, then",
        f"# promote it to a reservation in [boards.*].",
        f"dhcp-range={pool_lo},{pool_hi},{netmask},{lease}",
        "",
        "# MAC->IP reservations (infinite lease); regenerated from [boards.*].",
        f"dhcp-hostsfile={hostsfile}",
        "",
        f"dhcp-leasefile={leasefile}",
        "log-dhcp",
        "",
    ])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    default_cfg = os.environ.get("DAQ_CONFIG", "config/config.toml")
    ap.add_argument("--config", default=default_cfg,
                    help=f"DAQ config TOML (default: $DAQ_CONFIG or {default_cfg})")
    ap.add_argument("--out-dir", default="/etc/star-dhcp", type=Path,
                    help="where to write star-dhcp.conf and star-dhcp.hosts "
                         "(default: /etc/star-dhcp)")
    ap.add_argument("--interface", default=DEFAULT_INTERFACE,
                    help=f"board-LAN NIC to serve (default: {DEFAULT_INTERFACE})")
    ap.add_argument("--pool-start", type=int, default=DEFAULT_POOL_START,
                    help=f"last octet of pool start (default: {DEFAULT_POOL_START})")
    ap.add_argument("--pool-end", type=int, default=DEFAULT_POOL_END,
                    help=f"last octet of pool end (default: {DEFAULT_POOL_END})")
    ap.add_argument("--lease", default=DEFAULT_LEASE,
                    help=f"dynamic-pool lease time (default: {DEFAULT_LEASE})")
    ap.add_argument("--leasefile", default=DEFAULT_LEASEFILE,
                    help=f"dnsmasq lease db path (default: {DEFAULT_LEASEFILE})")
    ap.add_argument("--check", action="store_true",
                    help="validate and print to stdout without writing files")
    args = ap.parse_args(argv)

    cfg_path = Path(args.config)
    if not cfg_path.is_file():
        _die(f"config not found: {cfg_path} (cwd {Path.cwd()})")
    with cfg_path.open("rb") as fh:
        cfg = _toml.load(fh)

    subnet = resolve_subnet(cfg)
    reservations = collect_reservations(cfg, subnet)

    # Reservations must not sit inside the dynamic pool, or dnsmasq could hand a
    # board's reserved address to someone else.
    base = ".".join(str(subnet.network_address).split(".")[:3])
    pool = {ipaddress.ip_address(f"{base}.{o}")
            for o in range(args.pool_start, args.pool_end + 1)}
    for name, _mac, ip in reservations:
        if ipaddress.ip_address(ip) in pool:
            _die(f"board {name!r} ip {ip} falls inside the dynamic pool "
                 f"{base}.{args.pool_start}-{args.pool_end}")

    hostsfile = (args.out_dir / "star-dhcp.hosts").resolve()
    conf = build_conf(interface=args.interface, subnet=subnet,
                      pool_start=args.pool_start, pool_end=args.pool_end,
                      lease=args.lease, hostsfile=hostsfile,
                      leasefile=args.leasefile)
    hosts = build_hosts(reservations)

    if args.check:
        print("# ===== star-dhcp.conf =====")
        print(conf)
        print("# ===== star-dhcp.hosts =====")
        print(hosts, end="")
        print(f"# {len(reservations)} reservation(s), subnet {subnet}, "
              f"pool {base}.{args.pool_start}-{args.pool_end}", file=sys.stderr)
        return 0

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "star-dhcp.conf").write_text(conf)
    hostsfile.write_text(hosts)
    print(f"wrote {args.out_dir/'star-dhcp.conf'} and {hostsfile}")
    print(f"{len(reservations)} reservation(s), subnet {subnet}, "
          f"pool {base}.{args.pool_start}-{args.pool_end}, lease {args.lease}")
    if not reservations:
        print("note: no reservations yet — every board will get a pool lease "
              "until you fill in [boards.*].mac", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
