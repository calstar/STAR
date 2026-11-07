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
- **Identity comes with the address:** a board takes its ID from the address it
  is given (`192.168.2.31` -> board 31), so every board of a type runs the same
  firmware image. Which physical board is which is its `mac =` line here.
- **Hands-off after install:** `star-dhcp-sync.path` regenerates and reloads the
  reservations whenever the deployed `config.toml` changes. Saving a board's
  `mac =` in the config editor is the whole procedure; no shell, no sudo.
- **Sole authority:** the board LAN is a flat L2 segment (unmanaged switch + wifi
  bridge, no router) that the DAQ server owns, so it's safe to be the only DHCP
  server here. Do **not** point this at a shared office/lab LAN — it will fight
  the existing router's DHCP.

## Addressing plan (ground, `192.168.2.0/24`)

| Range          | Use                                             |
|----------------|-------------------------------------------------|
| `.20`          | DAQ server (static, set outside DHCP)           |
| `.11`–`.61`    | Board static reservations (`ip` == `board_id`)  |
| `.81`          | LabJack T7 (`boards.labjack_1`, `board_id` 81)  |
| `.100`–`.150`  | Board discovery range (reserved, not DHCP)      |
| `.200`–`.250`  | **Dynamic pool** for unknown boards (2h lease)  |

### Recovery addresses (`169.254.0.0/16`)

A board that gets no DHCP answer at boot (server down, or the board booted before
the switch) takes `169.254.<1 + mac[4] % 254>.<mac[5]>` and asks again every 15 s.
Nothing runs there; it exists so the board can still be reflashed:

```bash
python3 firmware/tools/ota_upload.py --board rtd_board --bin firmware.bin  # DHCP address, then recovery
python3 firmware/tools/ota_upload.py --mac 4a:27:e2:3a:ad:71 --bin firmware.bin
```

`star-dhcp.service` gives the board NIC `169.254.0.20/16` so the server can reach
them (`.0.x` is outside the range boards use). The address is derived from the
MAC, which no flash erase can touch, so it needs no per-board firmware. Two boards
whose MACs end alike would share one: the config editor and the generator both
refuse that. When DHCP comes back the board moves to its reserved address by
itself, without a reboot.

Flight (`192.168.3.0/24`) uses the same last-octet layout; the generator derives
the subnet from the active config.

## Install (once, on the DAQ host)

`bootstrap_daq.sh` already installs `dnsmasq` and disables the distro instance.
Then:

```bash
sudo daq-server/deploy/dhcp/install_dhcp.sh
```

This generates `/etc/star-dhcp/{star-dhcp.conf,star-dhcp.hosts}` from the deployed
`config.toml`, installs `star-dhcp-sync.{service,path}` (which keep the
reservations following that file from then on), and enables `star-dhcp.service`.
The board NIC is found by its address in the board subnet; set
`DHCP_INTERFACE=...` only to override. If the service is already running it is
restarted on the new config; otherwise it is **not** started, because starting it
makes this host the DHCP authority on the board LAN:

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
3. **Add the MAC to that board** in the config editor (Boards tab), or in its
   `[boards.*]` entry, and save:
   ```toml
   [boards.pt_board]
   ip = "192.168.2.21"
   board_id = 21               # must equal the last octet of ip
   mac = "aa:bb:cc:dd:ee:ff"   # lowercase, colon-separated
   ```
   `star-dhcp-sync` serves it within a second (`journalctl -u star-dhcp-sync`).
   If it refuses the config, the Boards page says why and the previous
   reservations stay in force.
4. **Power-cycle the board.** A board takes its address at boot, so until then it
   keeps the pool address; the Boards page shows "reboot to move to ...".
5. **Refresh the Test-GUI's copy**, so the bench server agrees with this one:
   ```bash
   python3 daq-server/deploy/dhcp/generate_dhcp_config.py \
     --config daq-server/config/config_base.toml \
     --out-dir /etc/star-dhcp \
     --gui-reservations Test-GUI/config/reservations.json
   ```
   Commit the regenerated file. See "Two servers, one registry" below.

## Two servers, one registry

The Test-GUI carries its own DHCP server (`Test-GUI/boardgui/dhcp.py`) for
benches with no DAQ host — a switch, a board and a laptop. **dnsmasq here is the
authority; that one is the fallback, and they must never serve the same wire at
once.** Two servers on one segment is a race: a board takes whichever OFFER
arrives first, so it can come up on a different address every boot.

Two things keep them from fighting:

* **One registry.** `Test-GUI/config/reservations.json` is generated from the
  same `[boards.*]` table by `--gui-reservations`, so the two cannot disagree
  about which board owns which address. Do not hand-edit it.
* **A check at startup.** The GUI probes for an existing DHCP server before it
  starts its own and makes the operator confirm if one answers.

## Changing the base config (subnet / pool / interface)

The sync only rewrites reservations. Changes to the pool range, subnet, bound
interface or handed-out options are in the base conf; re-run the installer, which
regenerates everything and restarts a running service:

```bash
sudo daq-server/deploy/dhcp/install_dhcp.sh
```

Re-run it too after pulling a change to `generate_dhcp_config.py`: the sync runs
a root-owned copy in `/usr/local/lib/star-dhcp/`, never the checkout's.

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
| `generate_dhcp_config.py` | Reads `[boards.*]`, emits `star-dhcp.conf` + `star-dhcp.hosts`, and with `--gui-reservations` the Test-GUI's table too. |
| `install_dhcp.sh` | One-time install: dnsmasq + generate + the units below. Safe to re-run. |
| `reload_dhcp.sh` | Regenerate reservations by hand from a config other than the deployed one. |
| `../systemd/star-dhcp.service` | Root system unit running dnsmasq on the board NIC; adds the recovery address. |
| `../systemd/star-dhcp-sync.{service,path}` | Regenerate + reload reservations whenever `config.toml` changes. |
| `test_generate_dhcp_config.py` | `python3 -m pytest daq-server/deploy/dhcp -q` |
| `/etc/star-dhcp/star-dhcp.conf` | Generated base config (interface, pool, options). |
| `/etc/star-dhcp/star-dhcp.hosts` | Generated MAC→IP reservations. |
| `/var/lib/misc/star-dhcp.leases` | dnsmasq lease table (read board MACs here). |
| `Test-GUI/config/reservations.json` | Generated table for the GUI's bench server; never hand-edited. |
