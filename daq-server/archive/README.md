# Archive Directory

Legacy utilities kept for FSW/daq_comms build. All other legacy code has been removed.

## Contents

### `legacy/cpp/data_logger/` - Data Logger Service (deprecated 2026-09)

Never ran. Not in `BASE_UNITS` (`service-controller.ts`) so the Session button never started it,
not in `PIPELINE_UNITS`/`WEB_UNITS` (`start_systemd_sim.sh`), never referenced by
`install_services.sh` (so `systemctl --user is-enabled sensor-data-logger` reported `not-found`),
and `data/runs/` was never created — it never wrote a single `.sensorlog`.

- `DataLoggerService.{cpp,hpp}`, `data_logger_main.cpp` - the C++ service (built, never launched)
- `sensor-data-logger.service` - the systemd unit that was never installed

A TypeScript reimplementation (`backend/src/data-logger.ts`) was deleted at the same time; nothing
imported it. The Python original remains in `legacy/python-services/data_logger_service.py`.

Two bugs in the C++ that were never hit because it never ran: it auto-armed on state literals
`4`/`0`/`6` (commented ARMED/IDLE/ABORT, actually Ox Fill / Debug / GN2 Low Vent), and wrote the
state to `active_channels_.size() - 1` when `"PSM.state"` sits at index 0.

If run archiving is wanted, design it fresh against Elodin's per-run DB directories. Run configs
are now snapshotted alongside each Elodin DB as `<dbDir>.toml`.

### `legacy/utl/` - FSW Utilities
Used by FSW and daq_comms:
- `Elodin.hpp` - Elodin protocol helpers
- `TCPSocket.hpp` - TCP socket wrapper
- `db.hpp` - Database utilities (via ElodinClient)
- `dbConfig.hpp` - VTable builder, postcard encoding
- `LinearAlgebra.hpp` - Math utilities
