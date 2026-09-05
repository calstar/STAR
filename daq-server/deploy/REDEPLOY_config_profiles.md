# Redeploying the DAQ server onto `star-openrocket-merge`

Moving an already-running server from an **old commit (pre-branch)** to this branch and preserving your
rig's config. Native `systemd --user` deploy (see `deploy/README.md` for the full reference).

## What changed on this branch (the only thing that makes this non-standard)

- **`config/config.toml` is now a git-ignored, generated runtime artifact.** The committed source of
  truth is **`config/profiles/*.toml`**. `config.toml` is produced by *deploying* a profile.
- Your rig's real config must live as a **profile** and be the **active** profile — because a **live
  session start deploys the active profile into `config.toml`**. If the active profile isn't your rig,
  the first run overwrites `config.toml` with the repo default.
- Everything else (systemd units, ports 8081/3000/2240/5005/5006/9998, elodin-db v0.16.1, Node 20+) is
  unchanged. No unit files changed on this branch, so no unit reinstall is needed.

## Prerequisites (network) — CRITICAL, confirm this

The board-LAN Ethernet NIC must be statically set to **`192.168.2.20/24`** (netmask `255.255.255.0`) —
**this exact address, not any free one.** The board firmware **hardcodes the server IP at compile time**:
`firmware/Hotfire_Code/common/hotfire_config.h` → `HOTFIRE_SERVER_IP_OCTET_4 20` → boards send all sensor
data, heartbeats, and self-test to **`192.168.2.20:5006`**. If the NIC is any other address, board packets
never arrive (boards show DISCONNECTED / no data even though the software is healthy).

This is OS-level networking (netplan / NetworkManager), NOT part of the app deploy. On a box that was
already talking to boards it's already `192.168.2.20`; the branch switch doesn't change it — just confirm
`ip -4 addr show` shows `192.168.2.20/24` on the board-LAN port. (Changing the server IP means re-flashing
firmware; a flight config uses `192.168.3.x`, which requires a firmware rebuild too.)

## Redeploy (one-time migration)

Find your checkout (the git repo root that contains `daq-server/`):
```bash
systemctl --user cat sensor-backend | grep WorkingDirectory   # → …/daq-server/diablo_server/backend
DAQ=…/daq-server            # the daq-server dir from that path
REPO="$(git -C "$DAQ" rev-parse --show-toplevel)"   # repo root (e.g. ~/STAR-daq)
```
Examples below assume `REPO=~/STAR-daq` and `DAQ=~/STAR-daq/daq-server` — adjust to yours.

### 1. Back up your running config — CRITICAL (the branch switch deletes tracked `config.toml`)
```bash
cd "$DAQ"
cp config/config.toml ~/daq-hw-config.toml
```

### 2. Stop the web layer for the switch
```bash
systemctl --user stop sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat
```

### 3. Switch to the branch
```bash
cd "$REPO"
git fetch origin star-openrocket-merge
git checkout -f -B star-openrocket-merge origin/star-openrocket-merge
```
`-f` discards the old tracked `config.toml` (you backed it up); `-B` points your local branch at the remote.

### 4. Restore your rig's config as the ACTIVE profile — CRITICAL
```bash
cd "$DAQ"
mkdir -p config/profiles
cp ~/daq-hw-config.toml config/profiles/server.toml   # your hardware config → a named profile
printf 'server\n' > config/.active_profile            # make it the active profile
cp ~/daq-hw-config.toml config/config.toml            # deploy it now (pipeline uses it immediately)
```
This makes `server` the active profile, so deploys (idle save, **live session start**) and the config
self-heal all use *your* config, never the repo default. `config/profiles/server.toml` is untracked and
`config/.active_profile` is git-ignored, so both survive future `git reset --hard` updates. **Keep the
`~/daq-hw-config.toml` backup, and never run `git clean -fdx`** (it would delete the untracked profile).

### 5. Build (C++ + frontend)
```bash
cd "$DAQ"
USE_SIM=0 bash scripts/build.sh                              # binaries; won't overwrite your config.toml
FRONTEND_FORCE_BUILD=1 bash deploy/startup/ensure_frontend_build.sh
```

### 6. Restart the web layer
```bash
systemctl --user daemon-reload
systemctl --user restart sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat
```

### 7. Verify
```bash
systemctl --user --no-pager status sensor-backend | head
curl -s localhost:8081/api/config/profiles                  # → "active":"server", profiles list default+server
diff <(curl -s localhost:8081/api/config/export) config/profiles/server.toml \
  && echo "running config == your rig ✓"
curl -s localhost:8081/api/debug | head
journalctl --user -u sensor-backend -n 40 --no-pager
```
Open the GUI (Caddy URL, or `localhost:3000`) → Config tab: the profile dropdown shows **server (active)**;
"View running config.toml" shows your rig's config. Then do a normal **Session → Start run** and confirm
boards connect and data flows (this also exercises the live-deploy path — it should keep `server`).

## Ongoing updates (clean — no config dance after the first migration)
```bash
cd "$REPO" && git fetch origin star-openrocket-merge && git reset --hard origin/star-openrocket-merge
cd daq-server && USE_SIM=0 bash scripts/build.sh && FRONTEND_FORCE_BUILD=1 bash deploy/startup/ensure_frontend_build.sh
systemctl --user restart sensor-backend sensor-frontend
```
`config.toml` (git-ignored), `config/profiles/server.toml` (untracked), `config/.active_profile`
(git-ignored) all survive `git reset --hard`. Never `git clean -fdx`.

## How editing config works now
- The Config tab edits the **active profile** (`server`). An idle save deploys it to `config.toml`
  immediately (and reloads the pipeline via `config_broadcast`).
- **During a run** `config.toml` is frozen; edits become **drafts** applied at the next session start.
  Switching profiles is blocked while a session is active.
- "View running config.toml" is a read-only view of what's deployed.
- To version-control your rig config, `git add config/profiles/server.toml` and commit it on this branch.

## Rollback (to the old version)
```bash
systemctl --user stop sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat \
  sensor-elodin sensor-daq sensor-calibration sensor-controller sensor-actuator sensor-simulator
cd "$REPO" && git checkout -f <old-branch-or-commit>
cd daq-server && cp ~/daq-hw-config.toml config/config.toml     # restore the tracked config.toml
USE_SIM=0 bash scripts/build.sh && FRONTEND_FORCE_BUILD=1 bash deploy/startup/ensure_frontend_build.sh
systemctl --user restart sensor-backend sensor-frontend
```

## Troubleshooting
- **Boards DISCONNECTED / no data:** first check the NIC is exactly `192.168.2.20/24` (`ip -4 addr show`)
  — the firmware sends to a hardcoded `192.168.2.20:5006`, so a wrong server IP silently drops all board
  traffic. Then `journalctl --user -u sensor-config-broadcast -u sensor-heartbeat -f`.
- **GUI shows the wrong boards/roles:** the active profile isn't your rig —
  `cat config/.active_profile` should be `server`, and
  `diff config/config.toml config/profiles/server.toml` should be empty. Re-run step 4 if not.
- **`config.toml` missing:** it self-heals from the active profile on the next backend read /
  `scripts/build.sh` (look for `🌱 Generated config/config.toml from …/profiles/server.toml`).
- **elodin errors:** confirm `~/.cargo/bin/elodin-db --version` is `v0.16.1`.
