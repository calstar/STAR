# Deploying the DAQ server (native, systemd)

The DAQ backend runs **natively on the host as `systemd --user` services** — *not* in
Docker — because `daq_bridge` needs raw UDP to the test-stand boards. This is the same box
that runs the Docker apps stack (`/opt/STAR`), and the Caddy container already proxies
`daq-server.<domain>` to the native backend on the host (`host.docker.internal:8081` for the
API/WS and `:3000` for the SPA, via `extra_hosts: host-gateway`). So once the native services
are up on the host, the public URL just works — nothing to change in the Docker stack.

> **tmux vs systemd — read this first.** The tmux panes you may have seen
> (`deploy/startup/start_tmux_dev.sh`) are the **dev/laptop** launcher only. On the server
> the DAQ runs as **background systemd services**; there are **no tmux panes**. The command
> that actually *starts* it is the `systemctl --user enable --now …` in Step 6 — everything
> before that is just clone/build/install. You watch it with `journalctl`, not tmux.

## Automated (bootstrap)

On the combined apps+DAQ box, the apps bootstrap can provision all of this in one shot —
it runs the exact steps below as the DAQ user:

```bash
WITH_DAQ=1 sudo -E bash deploy/apps/bootstrap.sh      # add USE_SIM=1 for a no-hardware box
```

That clones to `~/STAR-daq`, installs the build deps + Node + elodin-db, builds the C++ and
the SPA, installs the systemd units, and starts the web layer. The rest of this doc is the
manual/reference version of the same steps (and what to do if the bootstrap run warns).

## Where it goes

In the **DAQ user's home**, not `/opt`:

- The tree must be **writable by the non-root DAQ user** (the build writes `build/bin`,
  `node_modules`, `frontend/dist`, and runtime state). `/opt` is root-owned.
- Everything else DAQ already lives in that home: `~/.local/share/elodin` (the DB),
  `~/.config/daq/` (session/pipeline env).

Clone wherever you like in that home — `install_services.sh` writes a systemd drop-in that
points every unit's `WorkingDirectory` at wherever you cloned, so **no symlink is needed**.
This doc uses `~/STAR-daq`; the DAQ lives in its `daq-server/` subdir.

> Run every step below **as the DAQ user (no `sudo`)** except the `apt-get` prereqs — the
> `--user` services, home-rooted paths, and `enable-linger` all key off that user.
> Every DAQ command runs from **`~/STAR-daq/daq-server`**.

---

## 1. Clone (shallow, no history)

```bash
git clone --depth 1 -b main https://github.com/calstar/STAR.git ~/STAR-daq
cd ~/STAR-daq/daq-server
```

`--depth 1` grabs only the tip of `main` (no history). Full tree (not sparse), so all current
file contents — including the repo-root `lib/` that the C++ build reaches via `../lib` — are
present up front. Works on an air-gapped test-stand with no further fetches.

## 2. Prerequisites (once per box)

```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential cmake ninja-build libeigen3-dev pkg-config python3 python3-venv \
  zlib1g-dev libssl-dev
#   CMake requires ZLIB + OpenSSL (zlib1g-dev, libssl-dev) and Eigen (libeigen3-dev).
# Node 20+ :  bash deploy/setup/install_nodejs.sh   (or nvm)
# elodin-db :  curl -LsSf https://github.com/elodin-sys/elodin/releases/download/v0.16.1/elodin-db-installer.sh | sh
#              (installs to ~/.cargo/bin — make sure that's on PATH)
```

## 3. Build the C++ binaries

```bash
cd ~/STAR-daq/daq-server
USE_SIM=0 bash scripts/build.sh      # USE_SIM=1 to run without hardware (simulator)
```

Binaries land in `build/bin/` (what the units resolve as `./build/bin/<name>`).

## 4. Web-GUI dependencies + build the SPA

```bash
cd ~/STAR-daq/daq-server
(cd diablo_server/backend  && (npm ci || npm install))
(cd diablo_server/frontend && (npm ci || npm install))
bash deploy/startup/ensure_frontend_build.sh   # builds frontend/dist (served on :3000)
```

## 5. Install the systemd --user units

```bash
bash ~/STAR-daq/daq-server/deploy/systemd/install_services.sh
```

This symlinks the unit files into `~/.config/systemd/user/` **and** writes a
`…/<unit>.service.d/workdir.conf` drop-in setting `WorkingDirectory` to your checkout
(`~/STAR-daq/daq-server`), then reloads the daemon. No `~/sensor_system` symlink involved.

## 6. Start it (this is the actual "run" step)

```bash
loginctl enable-linger "$USER"     # let --user services run headless across reboots

# Always-on web + support layer. sensor-backend carries SESSION_SERVICE_MODE=systemd,
# so the run pipeline is started on demand by the GUI's Session button — do NOT enable
# the pipeline units on boot.
systemctl --user enable --now \
  sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat
```

That's the start. The services are now running in the background.

- **Bring up a data run:** open the GUI → **Session → Start run** (starts
  `sensor-elodin`/`sensor-daq`/`sensor-calibration`/`sensor-controller`/`sensor-actuator`).
- Or start the pipeline by hand:
  `systemctl --user start sensor-elodin sensor-daq sensor-calibration sensor-controller sensor-actuator`
- **No hardware on this box?** Use sim instead of the hardware pipeline:
  `bash ~/STAR-daq/daq-server/deploy/startup/start_systemd_sim.sh`.

## Verify

```bash
systemctl --user status sensor-backend --no-pager
curl -s  localhost:8081/api/debug | head    # backend API responds
curl -sI localhost:3000 | head -1           # SPA returns 200
# then browse https://daq-server.<domain> (through Caddy)
```

## Watch logs (the "tmux panes" equivalent)

```bash
journalctl --user -u sensor-backend -f                 # one service, follow
journalctl --user -u sensor-elodin -u sensor-daq -f    # several at once
bash ~/STAR-daq/daq-server/deploy/startup/start_tmux_logs.sh   # optional tmux multi-pane journal view
```

## Update to the latest main

```bash
cd ~/STAR-daq
git fetch --depth 1 origin main && git reset --hard origin/main   # stays shallow
cd ~/STAR-daq/daq-server
USE_SIM=0 bash scripts/build.sh
bash deploy/startup/ensure_frontend_build.sh
systemctl --user restart sensor-backend sensor-frontend
```

## Common gotcha

`bash: scripts/build.sh: No such file or directory` — you're in the **repo root**
(`~/STAR-daq`) instead of the **daq-server dir**. `cd ~/STAR-daq/daq-server` first; every DAQ
command in this doc runs from there.
