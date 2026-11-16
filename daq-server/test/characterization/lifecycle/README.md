# lifecycle characterization

`bash run.sh` (takes the stack lock). `CHAR_UPDATE=1` rewrites `golden/`. Loopback only; see the
module docstrings of `lifecycle.py` and `stack.py` for the config patching and isolation.

Goldens: `startup`, `shutdown`, `reconnect`, `dupsub`, `hbloss`, `ota`, `sim_board`.

## Exact

Packet bytes (decoded field by field), packet order, message types and order, counts, payloads,
exit codes, notification texts and keys. Normalised only as `normalize.py` states (timestamps,
PIDs, ports, paths, connection ids; masked values keep their key and JSON type).

## Timing assumptions

Every period and latency is checked as a bound whose edges come from a constant in the code or
config under test, cited in the golden line itself, plus stated headroom:

| what | bound | from |
|---|---|---|
| periodic senders | median gap in [0.75 P, 1.5 P] | `[heartbeat_service]`/`[server_heartbeat].interval_ms` 200, `[stacklight_service]`/`[config_broadcast_service].interval_ms` 1000, sim `heartbeat_interval` 1.0, `sensor_interval` 0.1 |
| board marked lost after its heartbeats stop | [4, 8] s | `BOARD_HEARTBEAT_STALE_MS` 5000 (server.ts), 1 s `markStaleBoards` sweep, 1 s sim heartbeat; +1 s |
| restarted board seen / ACTIVE | [0, 6] s | 1 s config interval + 1 Hz status + 1 s sweep, + 3 s interpreter start-up |
| ball valve opens after server heartbeats stop | [4.8, 6] s | `BALL_VALVE_HEARTBEAT_TIMEOUT_S` 5 from the last of a 200 ms heartbeat stream |
| skip-startup one-shot SELF_TEST | [1.8, 2.6] s after first heartbeat | `now - run_started >= 2.0` |
| exit after SIGTERM/SIGINT | per service | loop slice 100 ms, `kStacklightRecvTimeoutMs` 500, `kElodinRecvTimeoutMs` 3000, ota `select` 1 s |

Not derived from our code, and therefore assumptions:

- Python interpreter start-up of a simulator is under 3 s. Simulator windows are timed from the
  board's first packet, not from process launch, so this matters only for `SINCE_START`.
- elodin-db exits within 5 s of SIGTERM/SIGINT.
- calibration_service exits within 3.5 s of SIGTERM.
- A process still alive 30 s after its signal is reported as `exit None` (red) and reaped.

Load: all 7 goldens pass 3/3 with 14 busy loops on 14 cores (1x) on top of whatever else the host
runs. The suite gate waits for load < cores before running it (`gate.sh wait_for_load`).

## Isolation

Each capture accepts only the expected sender's source port, and each simulator run targets its
own capture port, so a process left over from an earlier step cannot be read as the next one.
