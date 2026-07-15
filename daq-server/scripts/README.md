# scripts/

Build and developer-tooling scripts for the DAQ server. This directory is small
and flat; most operational tooling lives elsewhere (see *Where things live*).

## Contents

- `build.sh` — Configure and build the C++ tree with CMake. Binaries land in
  `build/bin/`. Set `USE_SIM=1` to build the simulator targets too.
  ```bash
  bash scripts/build.sh           # normal build
  USE_SIM=1 bash scripts/build.sh # build with simulator
  ```
- `export_sensor_config.py` — Export the active sensor configuration from
  `config/config.toml` (see `config/README.md`).
- `setup_pre_commit.sh` — Install the local pre-commit hooks
  (`.pre-commit-config.yaml`). Equivalent to `pip install pre-commit && pre-commit install`.
- `test_udp.py` — Quick UDP send/receive helper for poking the bridge.

## Where things live

| Need | Location |
|------|----------|
| Start/stop the stack (tmux), DB, web GUI | `deploy/startup/` (e.g. `start_tmux_dev.sh`, `start_calibration_stack.sh`, `start_web_gui.sh`, `stop_tmux.sh`) |
| systemd unit files + installer | `deploy/systemd/` |
| Host/Jetson provisioning | `deploy/setup/` |
| Integration / E2E / pipeline tests | `test/` (e.g. `test_integration.sh`, `e2e_guitest_playwright.sh`) |
| Sensor calibration scripts + GUIs | `tools/calibration/` |
| Controller LUT generation | `tools/controller_lut/` |
| Elodin DB export & analysis | `tools/postprocessing/` |
| Operator GUIs | `tools/gui/` |
| Debug utilities | `tools/debug/` |
| Board simulator | `sim/board_simulator.py` |

## Notes

- Shell scripts should be executable (`chmod +x`).
- Python scripts require Python 3.8+ and `requirements.txt` dependencies.
