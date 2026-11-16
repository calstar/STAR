# packets/ and elodin/ — how each golden is reached

White box only on library APIs with stable signatures; everything a service does is reached black
box, by running the built binary against a loopback copy of a committed config and capturing what
it sends. Nothing here compiles a service's `*_main.cpp` or reaches a private member.

| golden | test | reached through |
|---|---|---|
| `wire_{layout,encode,decode,malformed}.txt` | `char_packets_wire_*` | `lib/daq-protocol` create/parse (white box, pure) |
| `pipeline_decode.txt` | `char_packets_pipeline_decode` | `fsw::streams::SensorFramePipeline` over loopback UDP |
| `comms_messages.txt` | `char_packets_comms_messages` | `CommsMessage` types, `ElodinClient::serialize_msg`, `BoardDiscovery`, `ElodinProtocol.hpp`, `BoardTypeWire.hpp` (pure) |
| `service_config_broadcast.txt` | `char_packets_service_config_broadcast` | `config_broadcast_service` binary, first cycle captured at the boards' port 5005 by destination address |
| `service_heartbeat.txt` | `char_packets_service_heartbeat` | `heartbeat_service` binary fed SequencerState rows by a stand-in elodin-db |
| `service_stacklight.txt` | `char_packets_service_stacklight` | `stacklight_service` binary, likewise |
| `service_daq_bridge.txt` | `char_packets_service_daq_bridge` | `daq_bridge` binary: SERVER_HEARTBEAT, LOGS → backend envelope |
| `service_abort.txt` | `char_packets_service_abort` | `sequencer_service` binary, TRANSITIONs over its TCP command port |
| `service_pwm.txt` | `char_packets_service_pwm` | `controller_service` binary, FIRE_START / FIRE_STOP over its TCP control port |
| `../elodin/golden/schema_*.txt` | `char_elodin_schema_*` | the services' own registration traffic to a stand-in elodin-db |
| `../elodin/golden/ts_*.json` | `elodin/run.sh` | the backend's TS modules (white box, no sockets) |

The black-box tests bind real ports (the board port 5005 among them): run them under
`test/characterization/with_stack_lock.sh`. On macOS they need the `127.0.0.<board>` lo0 aliases.

## Golden lines no black-box run reproduces

Every line removed from a golden when the service goldens moved from white box to black box, and
why it is not reproduced. Nothing else was removed.

- `service_config_broadcast.txt`: none. The two `ipToU32Le(...)` lines are now derived from the
  `config_base+ip_probe` case (printed last): a probe actuator on board 11 (127.0.0.11) and one on
  board 13 whose `ip` is `not-an-ip`; the lines report the address each gets in the
  ACTUATOR_CONFIG sent to board 12.
- `service_packets.txt` (the white-box golden, deleted: nothing checked it once the services
  moved to black box). Everything in it is covered black box elsewhere except:
  - `buildHeartbeatPacket(255)`: no sequencer state maps to engine state 255, so no running
    heartbeat_service can emit it. The state → engine map itself is in `service_heartbeat.txt`.
  - `discovery_board_type_to_enum`, `config_board_type_to_wire_u8`, `ipv4_host_octet`: private
    helpers of daq_bridge's main with no output of their own.
  - `AbortBroadcaster` `configure -> 1` and `sendClearAbort`: nothing in any service calls
    `sendClearAbort()`, so CLEAR_ABORT never reaches the wire (see `service_abort.txt`: leaving an
    abort state sends nothing). ABORT / ABORT_DONE are in `service_abort.txt`.
  - The BackendLogForwarder envelopes (boards 21, 0, 71) are in `service_daq_bridge.txt`.
  - ControllerService's single-command packet (`sendPWMCommand`) is in `service_pwm.txt`, from a
    config variant that puts the two PWM actuators on different boards; the dual-command packet
    is the config_base case above it.
- `../elodin/golden/schema_*.txt`: see `../elodin/README.md`.
