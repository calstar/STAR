# design-stubs/cpp — interfaces before implementations

Declaration-only headers for every **new** C++ header the decided designs of WP3, WP8, WP9 and
WP10 introduce. They are review material, not code: nothing here is compiled, no CMake target lists this
directory, and no product file includes it. Each stub's path mirrors its target under
`daq-server/diablo_server/` (e.g. `lib/include/net/TcpCommandServer.hpp` → `diablo_server/lib/include/net/TcpCommandServer.hpp`).

Every stub opens with the STYLE-S36 doc comment: what it owns, which threads call in and under
which lock, what it must not know, and the contract surfaces it touches with the golden that
freezes them. Bodies are today's code moved verbatim (the design notes give the line ranges);
where a stub shows `inline`/`constexpr`, the real header keeps the body there (D22: inlining
context is part of the float contract).

| WP | stubs | note |
|---|---|---|
| WP3 | `lib/src/elodin/SendMsg.hpp` | DESIGN-WP3 §2.3; no `TableId.hpp` (`table_id_for` dropped by D62, §2.5) |
| WP8 | `lib/include/service/StopSignals.hpp` (pass 1), `lib/include/net/TcpCommandServer.hpp` (pass 2) | DESIGN-WP8 §2; no `UdpSocket.hpp`, no `ConfigFile.hpp`, no `TcpListener` (dropped by the WP8 debate verdict, D54: sockets and config paths stay in the mains); no `SequencerStateFollower.hpp` (D57: the heartbeat/stacklight followers stay in their mains) |
| WP9 | `services/calibration/{Conversions,SensorModels,CalibrationContext,CalibrationActions,AbortThresholds,CalibrationCommands,RawStream}.hpp` | DESIGN-WP9 §2-§3, amendments |
| WP10 | `daq_bridge/{BoardMap,BackendLogForwarder,ElodinPublish}.hpp` | DESIGN-WP10 §4.3; the class splits add no header; no `TableRegistration` (D49: the two registration sites stay separate) |

Names follow STYLE-S1 as ruled in D43(2).
