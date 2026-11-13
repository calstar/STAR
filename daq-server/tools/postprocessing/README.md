# Postprocessing: Elodin DB Export & Analysis

Export Elodin DB data to parquet, CSV, or Arrow for analysis. This document describes what data the DB stores, **downsampling behavior**, and how to export.

## Data Sources & What Gets Saved

| Source | Data | Rate | Downsampled? |
|--------|------|------|--------------|
| **daq_bridge** | Raw PT, TC, RTD, LC [0x20,0x21,0x22,0x23] | Every packet | No |
| **daq_bridge** | Actuator status [0x30] (actuator state [0x31] is NOT in the publish allowlist) | Every packet | No |
| **daq_bridge** | Board heartbeats [0x10] | Every heartbeat | No |
| **calibration_service** (C++) / **calibration_server** (Python) | Calibrated PT, TC, RTD, LC [0x20/0x21/0x22/0x23 + 0x10] | Max ~100 Hz/ch | **Yes** (throttle) |
| **ControllerService** | Actuation [0x40], diagnostics [0x41] | Every tick | No |
| **ControllerService** | Measurement [0x42] | Every 10th tick | **Yes** (10% sample) |
| **ControllerService** | PSM state [0x43], fire state [0x44] | On change | No |

### Downsampling Details

**Controller measurement (10% sample):**

- Code: `diablo_server/lib/src/control/ControllerService.cpp` — the `tick % 10` measurement-write block (lines ~702–703)
- Logic: `if (tick % 10 == 0) { writeMeasurementToDB(meas); }`
- At 10 Hz: ~1 measurement/sec vs ~10 actuation + ~10 diagnostics/sec

**Calibrated data (100 Hz throttle):**

- Code: `tools/calibration/calibration_server.py` lines 179–183
- Config: `[calibration.sidecar] write_interval_sec = 0.01` (config.toml)
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
| [0x26, (slot-1)·0x20 + ain] | LabJack T7 raw input, `T7<slot>.AIN<n>.volts` (ain 0–13; 14 = internal temperature sensor) | t7_bridge |
| [0x26, (slot-1)·0x20 + 0x0F] | T7 thermocouple cold junction, `T7<slot>.CJC.temperature_c` (TC boards only) | t7_bridge |
| [0x26, (slot-1)·0x20 + 0x10 + ain] | T7 calibrated, `T7<slot>_Cal.AIN<n>.pressure_psi` / `temperature_c` / `force_kg` (+ `raw_uv`, the µV code calibration works in) | calibration_service |
| [0x30, 0x01..0x0A] | Actuator status (current sense) | daq_bridge |
| [0x31, 0x01..0x14] | Actuator state (open/closed) | not in `[daq_bridge] publish` allowlist |
| [0x40, 0x00] | Controller actuation | ControllerService |
| [0x41, 0x00] | Controller diagnostics | ControllerService |
| [0x42, 0x00] | Controller measurement | ControllerService (every 10th tick) |
| [0x43, 0x00] | PSM state transition | ControllerService |
| [0x44, 0x00] | Fire state | ControllerService |
| [0x45, 0x00] | Navigation state | Autopilot |

### Decoding a T7 run afterwards

A T7's channels are named, and their kind (PT / TC / LC) and datasheet numbers recorded, only in
config. A T7 `slot` is its `board_id % 10` (0 → 10), the same rule as every other board. The
session copies the run's config beside the run dir as `<run_id>.toml`. Read the
`[[boards.<name>.channels]]` rows there to know what `T7<slot>.AIN<n>` was. The webviewer does
this (`webviewer/backend/run_config.py`), and `replay_past_db.sh` runs the GUI on that file
rather than on today's config.

## DAQ Bridge Publish Allowlist

Only data in `[daq_bridge] publish` is written. See `config/config.toml`:

```toml
[daq_bridge]
publish = ["pt_raw", "tc_raw", "rtd_raw", "lc_raw", "actuator_status", "actuator_cal", "encoder_raw"]
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
./tools/postprocessing/export_elodin_db.sh ~/.local/share/elodin/daq_20260307_174529 ./export
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

Browse a run interactively in the webviewer (`webviewer/`, see its README); it reads the run's own
config sidecar, so roles and LabJack T7 channels are labelled. The old static-PNG pipeline
(`analyze_run.py`, `plot_latest_db.sh`) and the Cd scripts (`calc_cd.py`, `characterize_cd.py`)
were removed: they expected entity and column names nothing produces any more.

### Validate export (quick DB write check)

After CSV export, summarize what entity families landed on disk (PT cal, actuators, controller, etc.):

```bash
python3 tools/postprocessing/validate_export.py ./export_csv
# Fail the script if no calibrated PT series (typical GSE/hotfire expectation):
python3 tools/postprocessing/validate_export.py ./export_csv --strict
```


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
- `tools/postprocessing/replay_past_db.sh` — Replay past DB for GUI
