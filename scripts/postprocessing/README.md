# Postprocessing: Elodin DB Export & Analysis

Export Elodin DB data to parquet, CSV, or Arrow for analysis. This document describes what data the DB stores, **downsampling behavior**, and how to export.

## Data Sources & What Gets Saved

| Source | Data | Rate | Downsampled? |
|--------|------|------|--------------|
| **daq_bridge** | Raw PT, TC, RTD, LC [0x20,0x21,0x22,0x23] | Every packet | No |
| **daq_bridge** | Actuator status [0x30], actuator state [0x31] | Every packet | No |
| **daq_bridge** | Board heartbeats [0x10] | Every heartbeat | No |
| **calibration_server** | Calibrated PT, TC, RTD, LC [0x20/0x21/0x22/0x23 + 0x10] | Max 100 Hz/ch | **Yes** (throttle) |
| **ControllerService** | Actuation [0x40], diagnostics [0x41] | Every tick | No |
| **ControllerService** | Measurement [0x42] | Every 10th tick | **Yes** (10% sample) |
| **ControllerService** | PSM state [0x43], fire state [0x44] | On change | No |

### Downsampling Details

**Controller measurement (10% sample):**

- Code: `FSW/src/control/ControllerService.cpp` lines 657–658
- Logic: `if (tick % 10 == 0) { writeMeasurementToDB(meas); }`
- At 10 Hz: ~1 measurement/sec vs ~10 actuation + ~10 diagnostics/sec

**Calibrated data (100 Hz throttle):**

- Code: `scripts/calibration/calibration_server.py` lines 179–183
- Config: `[calibration.sidecar] write_interval_sec = 0.01` (config.toml line 673)
- Effect: Max ~100 calibrated writes/sec per channel

## Packet IDs (sensor_system convention)

| Packet ID | Description | Source |
|-----------|-------------|--------|
| [0x10, board_id] | Board heartbeat | daq_bridge |
| [0x20, 0x01..0x0E] | Raw PT ADC counts | daq_bridge |
| [0x20, 0x11..0x1E] | Calibrated PT (PSI) | calibration_server |
| [0x21, 0x01..0x14] | Raw TC ADC counts | daq_bridge |
| [0x21, 0x11..] | Calibrated TC (°C) | calibration_server |
| [0x22, 0x01..0x14] | Raw RTD resistance counts | daq_bridge |
| [0x22, 0x11..] | Calibrated RTD (°C) | calibration_server |
| [0x23, 0x01..0x14] | Raw LC ADC counts | daq_bridge |
| [0x23, 0x11..] | Calibrated LC (force) | calibration_server |
| [0x30, 0x01..0x0A] | Actuator status (current sense) | daq_bridge |
| [0x31, 0x01..0x14] | Actuator state (open/closed) | daq_bridge |
| [0x40, 0x00] | Controller actuation | ControllerService |
| [0x41, 0x00] | Controller diagnostics | ControllerService |
| [0x42, 0x00] | Controller measurement | ControllerService (every 10th tick) |
| [0x43, 0x00] | PSM state transition | ControllerService |
| [0x44, 0x00] | Fire state | ControllerService |
| [0x45, 0x00] | Navigation state | Autopilot |

## DAQ Bridge Publish Allowlist

Only data in `[daq_bridge] publish` is written. See `config/config.toml`:

```toml
[daq_bridge]
publish = ["pt_raw", "tc_raw", "rtd_raw", "lc_raw", "actuator_status", "actuator_state"]
```

Calibrated PT/TC/RTD/LC come from `calibration_server.py` (when `use_robust_stack = true`).

## Export

### Option 1: elodin-db export (recommended)

Requires elodin-db with `export` subcommand (newer versions).

```bash
# Export to parquet (default)
elodin-db export ~/.local/share/elodin/daq_20260307_174529 -o ./export

# Export to CSV with flattened vectors
elodin-db export ~/.local/share/elodin/daq_20260307_174529 -o ./export --format csv --flatten

# Export only PT/controller data
elodin-db export ~/.local/share/elodin/daq_20260307_174529 -o ./export --pattern "PT*"
elodin-db export ~/.local/share/elodin/daq_20260307_174529 -o ./export --pattern "Controller*"
```

### Option 2: export_elodin_db.sh wrapper

```bash
./scripts/postprocessing/export_elodin_db.sh ~/.local/share/elodin/daq_20260307_174529 ./export
```

### Option 3: Elodin Editor + Lua REPL

If `elodin-db export` is not available:

```bash
# Start Elodin DB in replay mode
elodin-db run "[::]:2240" ~/.local/share/elodin/daq_20260307_174529 --replay

# In another terminal, Lua REPL
elodin-db lua --db ~/.local/share/elodin/daq_20260307_174529
# Then: :sql localhost:2240
# Then run SQL queries

# Or use elodin editor for visual export
elodin editor ~/.local/share/elodin/daq_20260307_174529
```

## Analysis & Plots

### Quick: plot latest DB run

```bash
./scripts/postprocessing/plot_latest_db.sh
```

Finds the most recent Elodin DB (by mtime), exports to CSV, and generates plots. Optional: pass a DB name or path to plot a specific run.

```bash
./scripts/postprocessing/plot_latest_db.sh daq_20260307_174529
```

### Full pipeline (export CSV → analyze → plots)

```bash
# 1. Export last run to CSV
FORMAT=csv ./scripts/postprocessing/export_elodin_db.sh ~/.local/share/elodin/daq_YYYYMMDD_HHMMSS ./export_csv

# 2. Run analysis and generate plots
python scripts/postprocessing/analyze_run.py ./export_csv -o ./output/postprocessing/latest
```

Plots are written to `./output/postprocessing/latest/`:
- `pressures.png` — PT pressure time series (LOX, Fuel, GN2, GSE, Chamber)
- `temperatures.png` — TC/RTD temperature time series
- `load_cells.png` — Load cell force (N)
- `actuators.png` — Actuator state (0=OFF, 1=ON; forward-fill, no interpolation)
- `states.png` — System state (PSM / engine_state; forward-fill, no interpolation)
- `controller.png` — Controller outputs (duty_F/O, F_ref, F_estimated, P_ch, MR)
- `pressure_summary.png` — Summary statistics table
- `overview.png` — 5-panel overview (state, pressures, temps, actuators)
- `run_data_combined.csv` — All raw + calibrated channels, aligned to common time grid

**Discrete data (states, actuators):** Uses forward-fill resampling (no interpolation) so step changes are preserved. Previously, linear interpolation produced bogus intermediate values (e.g. 0.5 between 0 and 1).

**State source:** Prefers `CONTROLLER.state.to_state` (authoritative from PSM) when available; falls back to `BOARD.HB_*.engine_state` from heartbeat.

### Data semantics

- **Actuator state**: Hardware reports 0=OFF, 1=ON. Whether OFF/ON means open or closed depends on valve type (NO vs NC). See `config/state_machine_actuators.csv`.
- **System state**: `BOARD.*.engine_state` or `CONTROLLER.state.to_state` — numeric enum (0=DEBUG, 1=IDLE, 2=ARMED, …, 16=FIRE, etc.).
- **Raw vs calibrated**: Export includes both. PT/TC/LC raw = ADC counts; RTD raw = resistance counts. Calibrated = PSI, °C, N.

### Analysis with DuckDB (parquet)

After exporting to parquet:

```python
import duckdb
con = duckdb.connect()
df = con.execute("SELECT * FROM './export/*.parquet'").fetchdf()
```

## Related Docs

- `docs/CONTROLLER_STACK_AND_DB_WRITES.md` — Full write pattern and verification
- `web-gui/replay_past_db.sh` — Replay past DB for GUI
