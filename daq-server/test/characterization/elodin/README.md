# elodin/ — the Elodin schema, black box

`blackbox_schema.py` starts the real services against a loopback copy of a committed config whose
`[database]` points at a stand-in elodin-db (`../packets/bb.py` `FakeElodin`) and records every
MSG packet each one sends at start-up: VTableMsg, SetComponentMetadata, SetEntityMetadata and
VTableStream subscriptions, decoded by an independent postcard reader and printed with their raw
bytes. TABLE rows are data, not schema; only which tables a service sends rows for is listed.
`run.sh` dumps the backend's TypeScript view (registry, protocol parser, client framing).

Sections: `daq_bridge`, `calibration` (calibration_service), `sequencer` (sequencer_service),
`controller_service`, `t7_bridge --fake`, `heartbeat_service`, `stacklight_service`.

## Lines the white-box version had that no black-box run reproduces

The first version replayed `DatabaseConfig` calls with arguments derived inside the test. These
lines from it are gone, with the reason:

- `boards PT: ...` … `boards BALL_VALVE: ...`, `daq_bridge config_board_ids: ...`,
  `raw_sensor_tables: ...`, `calibrated_sensor_tables: ...`, `ball_valve raw/cal/cmd tables: ...`:
  the test's own calls to `load_active_boards()` / `raw_sensor_tables()` etc. No service prints
  them; what they decide is visible as the tables each service registers below.
- `# <section> returns: register_tables=1 ...`: return values of `DatabaseConfig::register_*`
  inside the services; not observable from outside.
- `## calibration: 343 packets, ...`: calibration_service also registers the T7 calibrated tables
  config declares and subscribes to the raw tables it calibrates, so its section is longer; every
  packet of the old section is still there, in the same order, at the start of the new one.
- `## t7 (fixed arguments)` and its packets: called `register_t7_raw_tables(slot 1, AIN 0-3, cjc)`
  and `register_t7_calibrated_tables` with arguments no config declares. t7_bridge's real
  registration (from config, `--fake` device) is the `t7_bridge --fake` section, and the
  config-derived calibrated T7 tables are in `calibration`.
- `## subscribe framing` and its packets: called `subscribe_table(0x50,0x00,7)` and
  `subscribe_tables(...)` directly. The real subscriptions (heartbeat_service and
  stacklight_service to `[0x50,0x00]`, calibration_service and sequencer_service to the sensor
  tables) are in their sections; the request id 7 and the `[0x46,0x00]` / `[0x20,0x01]` trio were
  the test's own choices.
- Packet-index lines (`#N len=... `) that only those removed sections had at that index.

The `daq_bridge` and `sequencer` sections are line-for-line what the white-box version had.
