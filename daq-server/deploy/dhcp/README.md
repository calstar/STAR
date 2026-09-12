# Board-LAN DHCP (`star-dhcp`)

The DAQ server hands out board IP addresses over DHCP on the isolated board LAN,
so boards no longer need their IP hardcoded in firmware. Each board gets a
**static reservation** keyed by its MAC; the IP it receives is exactly the one it
had before (`192.168.2.<board_id>`), so nothing downstream changes — this
replaces *how* a board gets its address, not *which* address.

- **Server:** `dnsmasq`, DHCP-only (no DNS), running as the root system unit
  `star-dhcp.service`, bound to the board NIC only.
- **Source of truth:** the `[boards.*]` table in the DAQ config. Each board's
  `mac` field drives its reservation. See `config/README.md`.
- **Sole authority:** the board LAN is a flat L2 segment (unmanaged switch + wifi
  bridge, no router) that the DAQ server owns, so it's safe to be the only DHCP
  server here. Do **not** point this at a shared office/lab LAN — it will fight
  the existing router's DHCP.

## Addressing plan (ground, `192.168.2.0/24`)

| Range          | Use                                             |
|----------------|-------------------------------------------------|
| `.20`          | DAQ server (static, set outside DHCP)           |
| `.11`–`.61`    | Board static reservations (`ip` == `board_id`)  |
| `.100`–`.150`  | Board discovery range (reserved, not DHCP)      |
| `.200`–`.250`  | **Dynamic pool** for unknown boards (2h lease)  |

Flight (`192.168.3.0/24`) uses the same last-octet layout; the generator derives
the subnet from the active config.

## Install (once, on the DAQ host)

`bootstrap_daq.sh` already installs `dnsmasq` and disables the distro instance.
Then:

```bash
sudo daq-server/deploy/dhcp/install_dhcp.sh
```

This generates `/etc/star-dhcp/{star-dhcp.conf,star-dhcp.hosts}` from the active
config and enables (but does **not** start) `star-dhcp.service`. Starting it
makes this host the DHCP authority on the board LAN, so start it deliberately:

```bash
sudo systemctl start star-dhcp
journalctl -u star-dhcp -f
```

## Onboarding a new board (the discovery → promote → reload loop)

Boards have no MACs recorded yet, so the first time you see a board you learn its
MAC from the pool, then pin it:

1. **Plug the board into the board LAN.** With no reservation, it gets a lease
   from the `.200`–`.250` pool.
2. **Read its MAC from the lease table:**
   ```bash
   cat /var/lib/misc/star-dhcp.leases
   # <expiry> <mac> <ip> <hostname> <client-id>
   ```
   Match the board by the pool IP it picked up (and its hostname if it sets one).
3. **Add the MAC to that board** in `config/config_base.toml` (or the active
   config), in its `[boards.*]` entry:
   ```toml
   [boards.pt_board]
   ip = "192.168.2.21"
   mac = "aa:bb:cc:dd:ee:ff"   # lowercase, colon-separated
   ```
4. **Regenerate + reload** (SIGHUP, no service bounce, no lease disruption):
   ```bash
   sudo daq-server/deploy/dhcp/reload_dhcp.sh
   ```
5. **Power-cycle the board.** On its next DHCP request it gets its reserved
   static IP (`192.168.2.<board_id>`) instead of a pool address.

## Changing the base config (subnet / pool / interface)

`reload_dhcp.sh` (SIGHUP) only re-reads reservations. Changes to the pool range,
subnet, bound interface, or handed-out options are in the base conf and need a
full restart:

```bash
sudo daq-server/deploy/dhcp/install_dhcp.sh   # regenerates everything
sudo systemctl restart star-dhcp
```

## Preview without touching the host

`generate_dhcp_config.py --check` prints the config it would write to stdout and
validates it (duplicate/malformed MACs, IPs outside the subnet, reservations that
collide with the pool) without writing files:

```bash
python3 daq-server/deploy/dhcp/generate_dhcp_config.py \
  --config daq-server/config/config_base.toml --check
```

## Files

| File | Role |
|------|------|
| `generate_dhcp_config.py` | Reads `[boards.*]`, emits `star-dhcp.conf` + `star-dhcp.hosts`. |
| `install_dhcp.sh` | One-time install: dnsmasq + generate + enable the system unit. |
| `reload_dhcp.sh` | Regenerate reservations + `systemctl reload` (use after MAC edits). |
| `../systemd/star-dhcp.service` | Root system unit running dnsmasq on the board NIC. |
| `/etc/star-dhcp/star-dhcp.conf` | Generated base config (interface, pool, options). |
| `/etc/star-dhcp/star-dhcp.hosts` | Generated MAC→IP reservations. |
| `/var/lib/misc/star-dhcp.leases` | dnsmasq lease table (read board MACs here). |
