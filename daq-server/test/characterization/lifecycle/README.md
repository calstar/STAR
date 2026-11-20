# lifecycle characterization

`bash run.sh` (takes the stack lock). `CHAR_UPDATE=1` rewrites `golden/`. Loopback only; see the
module docstrings of `lifecycle.py` and `stack.py` for the config patching and isolation.

Goldens: `startup`, `shutdown`, `reconnect`, `dupsub`, `hbloss`, `ota`, `sim_board`. `ota` ends with
`POST /api/ota-flash` sent as a viewer (`X-Auth-Email` not in `operators.txt`): the route has no
operator gate (LEDGER D-OTA / SEC-2), so its 200 is frozen as today's behaviour, to stay visible.

`shutdown` also carries the `signals` scenario (DESIGN-WP8 §7.2 gaps 1-3, LEDGER D65(6)): every C++
service started alone against a fresh elodin-db, each signal sent only after the service's ready line
(the one printed after its handlers are installed, so a kill before installation cannot pass for a
missing handler). SIGPIPE disposition per service (`kill -PIPE`: alive, or exit -13); SIGTERM and SIGINT
exit codes and bounds for sequencer_service, controller_service and `t7_bridge --fake` with one idle
client held on the sequencer's and the controller's command port at the moment of the signal; each
handler's exact line (`ascii()`, leading newline included) and every line after it; a second SIGTERM
50 ms after the first (heartbeat_service), which must still exit 0. Lines the scenario reads, and so
freezes (STYLE S15): the ready lines `[HeartbeatService] Started`, `[StacklightService] Started`,
`[ConfigBroadcast] Started`, `[OTAService] Listening on port`, `[Sequencer] Listening on port`,
`Controller running. PWM gated to FIRE state` (plus a TCP connect to the control port: the line is
printed when the detached control thread is spawned, before it binds), `[t7_bridge boards.labjack_1]
Elodin connected, tables registered`, `Listening for DiabloAvionics packets`, `[Cal] Connected to
Elodin, registered calibrated VTables, subscribed.`; and the handler lines, matched by
`Shutting down|Caught signal` and frozen byte for byte, plus the service's final line. Nothing else a
service prints after the signal is frozen (LEDGER D89): running loops and the db keep logging on
their own clocks (the controller's 0.5 s `⏳ Waiting for sensor data`, the sequencer's 1 s
`[ActuatorCommander] Sent …`, calibration's first ten `[Cal] Received packet` db replies, the
detached control thread's `control connection closed with no command` racing `main()`'s return).
Where the exit has a side effect to witness, the lines that witness it are checked as an ordered
subsequence of the lines after the handler's (these in this order, other lines ignored):
calibration's `[Cal] Saved robust adjustments on shutdown → <WORK>/adj_sig.json`, with a line saying
whether that file exists afterwards (it is deleted before the service starts); daq_bridge's
`[DAQ Bridge] Shutdown complete` followed by `[ElodinClient] ✅ Disconnected` (its ElodinClient is
destroyed after `main` returns). The SIGTERM/SIGINT passes run the services one at a time.

Found here, frozen as found: with elodin-db up, controller_service never exits on SIGTERM or
SIGINT — `ControllerService::stop()` joins its Elodin subscriber thread, which is blocked in
`read_exact()` on a socket with no receive timeout (`TCPClient::connect` sets only `SO_SNDTIMEO`
and the controller never calls `set_recv_timeout_ms` on that client), and nothing publishes to the
tables it subscribed to. The golden records `still running 3 s after SIGTERM: True`; the harness
then kills it. This is LEDGER C4-5's "> 3 s", sharpened: indefinite. With the db unreachable the
same service exits 0 inside 1 s, which is the case that carries D65(6)'s idle-client bound for
`:9999`.

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
| board marked lost after its heartbeats stop | [4, 8] s | `BOARD_HEARTBEAT_STALE_MS` 5000 (server/board-status.ts), 1 s `markStaleBoards` sweep, 1 s sim heartbeat; +1 s |
| restarted board seen / ACTIVE | [0, 6] s | 1 s config interval + 1 Hz status + 1 s sweep, + 3 s interpreter start-up |
| ball valve opens after server heartbeats stop | [4.8, 6] s | `BALL_VALVE_HEARTBEAT_TIMEOUT_S` 5 from the last of a 200 ms heartbeat stream |
| skip-startup one-shot SELF_TEST | [1.8, 2.6] s after first heartbeat | `now - run_started >= 2.0` |
| exit after SIGTERM/SIGINT | per service | loop slice 100 ms, `kStacklightRecvTimeoutMs` 500, `kElodinRecvTimeoutMs` 3000, ota `select` 1 s |
| sequencer_service exit after SIGTERM/SIGINT, one idle client held | [0, 1] s | `shutdown(SHUT_RDWR)` wakes the client thread's `recv` (`SO_RCVTIMEO` 5 s) before the join; 10 ms `select`; destructor joins in 100 ms slices, PressureFeed `kRecvTimeoutMs` 200; + 0.5 s. Joining before the shutdown lands at ~5 s (D65(6)) |
| controller_service exit, elodin-db unreachable | [0, 1] s | main polls `g_running` every 100 ms, the subscriber's connect retry sleeps 20 x 100 ms checking `running_`, 100 Hz loop; + 0.8 s |
| controller_service with elodin-db up | still running 3 s after the signal | `ControllerService::stop()` joins the Elodin subscriber thread, blocked in `read_exact()` on a socket with no receive timeout (C4-5); killed by the harness after 3 s |
| `t7_bridge --fake` exit | [0, 1] s | the stand-in device blocks one read per 50 ms block (`scan_rate_hz` 100 / 20 scans per read), `g_running` checked between reads, `nap()` in 100 ms slices; + 0.8 s |
| SIGPIPE at the default disposition | exit -13 within [0, 1] s | killed on delivery; 1 s headroom. The four that ignore it are checked alive 1 s after it |

Not derived from our code, and therefore assumptions:

- Python interpreter start-up of a simulator is under 3 s. Simulator windows are timed from the
  board's first packet, not from process launch, so this matters only for `SINCE_START`.
- elodin-db exits within 5 s of SIGTERM/SIGINT.
- calibration_service exits within 3.5 s of SIGTERM.
- A process still alive 30 s after its signal is reported as `exit None` (red) and reaped.
- In the signals scenario an idle client is connected 0.3 s before the signal: long enough for the
  accept loop (10 ms `select`) to have spawned its reader thread, short against the reader's 5 s
  `SO_RCVTIMEO`, so the connection is still held when the signal lands.

Load: all 7 goldens pass 3/3 with 14 busy loops on 14 cores (1x) on top of whatever else the host
runs. The suite gate waits for load < cores before running it (`gate.sh wait_for_load`).

## Isolation

Each capture accepts only the expected sender's source port, and each simulator run targets its
own capture port, so a process left over from an earlier step cannot be read as the next one.
