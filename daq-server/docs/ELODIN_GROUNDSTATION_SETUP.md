# Elodin Smoke-Test & Fake-Data Setup

How to bring up an Elodin database and push data into it without real hardware,
so you can verify the Elodin side of the pipeline and inspect data in the editor.

> The standalone "groundstation GUI" (`groundstation/ground_station_elodin_gui.py`)
> and the `send_fake_pt` / `test_fsw_simulator` helpers referenced by older
> versions of this guide are **no longer part of the tree**. The supported
> fake-data path today is the board simulator → `daq_bridge` → Elodin stack and
> the web GUI.

## Option A — Full fake-data stack (recommended)

Brings up Elodin DB, `daq_bridge`, the board simulator, and the web backend/GUI:

```bash
cd /path/to/STAR/daq-server
./deploy/startup/start_fake_data_stack.sh
```

Pipeline: `sim/board_simulator.py` → UDP :5006 → `build/bin/daq_bridge` →
Elodin DB (:2240) → backend → web UI. The simulator emits DiabloAvionics-format
heartbeats and sensor data, so the whole server path exercises real parsing,
routing, and calibration.

For the full dev stack (all services in tmux) with the simulator enabled:

```bash
USE_SIM=1 ./deploy/startup/start_tmux_dev.sh
```

## Option B — Just an Elodin DB

To stand up only the database (e.g. to point the editor or an ad-hoc client at
it):

```bash
cd /path/to/STAR/daq-server
./test/test_elodin_groundstation.sh 2240 test_groundstation
```

This:
- starts `elodin-db` on port `2240`,
- creates the database at `~/.local/share/elodin/test_groundstation`,
- runs until Ctrl+C.

Arguments are `<db_port> <db_name>` (defaults `2240` / `test_groundstation`).

## Inspecting data in the Elodin editor

```bash
elodin editor ~/.local/share/elodin/test_groundstation
# or, for the fake-data stack DB:
elodin editor ~/.local/share/elodin/daq_fake
```

In the editor you can watch the per-board, per-channel tables update live
(`PT1.CH3`, `PT1_Cal.CH3`, `ACT4.CH5`, …; see
[web-gui/DATA_FLOW.md](web-gui/DATA_FLOW.md) for the entity/packet-ID scheme),
and query historical data.

## Validation checklist

- **Sensor data flowing:** with the fake stack running, raw and calibrated PT
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

# Stack logs (fake-data stack writes to /tmp)
tail -f /tmp/elodin_fake.log /tmp/daq_fake.log
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
