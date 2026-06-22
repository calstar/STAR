# Jetson Xavier NX Deployment Guide

Deploy the Sensor System on NVIDIA Jetson Xavier NX (or other ARM64 Ubuntu devices).

## Prerequisites

- Jetson Xavier NX with JetPack 5.x or 6.x (Ubuntu 20.04 / 22.04)
- Network connectivity for apt, npm, pip
- ~2 GB free disk for build artifacts and dependencies

## Quick Setup (One Command)

From the repo root:

```bash
./deploy/setup/setup_jetson.sh
```

This installs:

- System packages (cmake, build-essential, Eigen, OpenSSL, etc.)
- **elodin-db** (built from source — Jetson uses glibc; prebuilt ARM64 is musl-only)
- Node.js 20+ (NodeSource)
- Python venv + requirements
- Web GUI dependencies
- C++ binaries (daq_bridge, controller_service, etc.)

## Manual Steps (if needed)

### 1. Clone the repo

```bash
git clone <repo-url> sensor_system
cd sensor_system
```

(The repo has no submodules — a plain clone gets everything.)

### 2. Run the setup script

```bash
./deploy/setup/setup_jetson.sh
```

### 3. Start the stack

**Full stack** (DB, backend, frontend, DAQ, calibration, controller, sequencer):

```bash
source .venv/bin/activate
./deploy/startup/start_tmux_dev.sh
```

**Minimal** (DB + DAQ only):

```bash
mkdir -p ~/.local/share/elodin
elodin-db run '[::]:2240' ~/.local/share/elodin/daq_live &
./build/bin/daq_bridge config/config.toml
```

### 4. Access the Web GUI

From another machine on the same network:

```
http://<jetson-ip>:3000
```

## Configuration

- **config/config.toml** — main config (network, database, boards, sensors)
- **config/config_ground_daq.toml** — GSE / hotfire
- **config/config_flight_daq.toml** — flight ops

Update `[network].bind_ip` if needed (default `0.0.0.0` listens on all interfaces).

## Optional: Run as systemd services

```bash
./deploy/systemd/install_services.sh
systemctl --user start sensor-elodin sensor-daq sensor-relay sensor-backend sensor-frontend sensor-sidecar sensor-heartbeat sensor-config-broadcast
```

Enable on boot:

```bash
systemctl --user enable sensor-elodin sensor-daq sensor-relay sensor-backend sensor-frontend sensor-sidecar sensor-heartbeat sensor-config-broadcast
```

## Troubleshooting

### elodin-db not found

- Built from source via Rust; install can take 10–20 min on Jetson.
- If installer fails, ensure Rust is installed: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

### Node.js too old

- Setup uses NodeSource 20.x. If issues persist, try: `nvm install 20`

### C++ build fails (Eigen, OpenSSL)

```bash
sudo apt install -y libeigen3-dev libssl-dev zlib1g-dev
```

### Out of memory during build

- Reduce parallelism: `make -j2` instead of `make -j$(nproc)`

### Web GUI not reachable

- Check firewall: `sudo ufw allow 3000`
- Ensure backend/frontend are running (see tmux panes)

## Architecture Notes

- **Jetson** = ARM64 (aarch64), Ubuntu with glibc
- **elodin-db** prebuilt binaries are musl-only for Linux ARM64; glibc systems need a source build
- NodeSource and pip support ARM64; no special flags needed
