# Elodin Smoke-Test & Fake-Data Setup

How to bring up an Elodin database and push data into it without real hardware,
so you can verify the Elodin side of the pipeline and inspect data in the editor.

> The standalone "groundstation GUI" (`groundstation/ground_station_elodin_gui.py`)
> and the `send_fake_pt` / `test_fsw_simulator` helpers referenced by older
> versions of this guide are **no longer part of the tree**. The supported
> fake-data path today is the board simulator → `daq_bridge` → Elodin stack and
> the web GUI.

## Option A — Full dev stack with the board simulator (recommended)

Brings up Elodin DB, `daq_bridge`, the board simulator, and the web backend/GUI
in one tmux session (the database is named `daq_<timestamp>` unless you set
`ELODIN_DB_NAME`):

```bash
cd /path/to/STAR/daq-server
USE_SIM=1 ./deploy/startup/start_tmux_dev.sh
```

Pipeline: `sim/board_simulator.py` → UDP :5006 → `build/bin/daq_bridge` →
Elodin DB (:2240) → backend → web UI. The simulator emits DiabloAvionics-format
heartbeats and sensor data, so the whole server path exercises real parsing,
routing, and calibration.

## Option B — Just an Elodin DB

To stand up only the database (e.g. to point the editor or an ad-hoc client at
it):

```bash
mkdir -p ~/.local/share/elodin
elodin-db run "[::]:2240" ~/.local/share/elodin/test_groundstation
```

This:
- starts `elodin-db` on port `2240`,
- creates the database at `~/.local/share/elodin/test_groundstation`,
- runs until Ctrl+C.

Use `0.0.0.0:2240` instead of `[::]:2240` on a host without IPv6.

## Inspecting data in the Elodin editor

```bash
elodin editor ~/.local/share/elodin/test_groundstation
# or, for a dev-stack DB (replace the timestamp):
elodin editor ~/.local/share/elodin/daq_<timestamp>
```

In the editor you can watch the per-board, per-channel tables update live
(`PT1.CH3`, `PT1_Cal.CH3`, `ACT4.CH5`, …; see
[web-gui/DATA_FLOW.md](web-gui/DATA_FLOW.md) for the entity/packet-ID scheme),
and query historical data.

## Validation checklist

- **Sensor data flowing:** with the dev stack running, raw and calibrated PT
  tables grow with increasing timestamps in the editor, and the web UI plots
  update.
- **Calibration:** `*_Cal.*` tables populate, confirming `calibration_service`
  is reading RAW and writing CALIBRATED.
- **Commands:** state transitions from the UI reach boards via the sequencer's
  TCP control path (see [ACTUATOR_PIPELINE_AND_TMUX.md](ACTUATOR_PIPELINE_AND_TMUX.md)).

## Debugging

```bash
# Is the DB up?
ps aux | grep elodin-db
ss -tuln | grep 2240

# Does the DB dir exist?
ls -la ~/.local/share/elodin/

# Stack logs (start_tmux_dev.sh writes to /tmp/gui_logs)
tail -f /tmp/gui_logs/db.log /tmp/gui_logs/daq.log
```

If sensor data is not appearing, confirm the board simulator is running and the
`daq_bridge` is bound to `:5006`; see
[ADC_AND_ELODIN_DIAGNOSTICS.md](ADC_AND_ELODIN_DIAGNOSTICS.md).

## See also

- [web-gui/DATA_FLOW.md](web-gui/DATA_FLOW.md) — full data-flow architecture and
  packet IDs.
- [ADC_AND_ELODIN_DIAGNOSTICS.md](ADC_AND_ELODIN_DIAGNOSTICS.md) — diagnosing
  data that doesn't reach Elodin.
- Elodin documentation: https://elodin.dev
