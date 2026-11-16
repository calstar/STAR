# design-stubs/cpp — interfaces before implementations

Declaration-only headers for every **new** C++ header the chosen designs of WP3, WP8, WP9 and WP10
introduce. They are review material, not code: nothing here is compiled, no CMake target lists this
directory, and no product file includes it. Each stub's path mirrors its target under
`daq-server/diablo_server/` (e.g. `lib/include/net/UdpSocket.hpp` → `diablo_server/lib/include/net/UdpSocket.hpp`).

Every stub opens with the STYLE-S36 doc comment: what it owns, which threads call in and under
which lock, what it must not know, and the contract surfaces it touches with the golden that
freezes them. Bodies are today's code moved verbatim (the design notes give the line ranges);
where a stub shows `inline`/`constexpr`, the real header keeps the body there (D22: inlining
context is part of the float contract).

| WP | stubs | note |
|---|---|---|
| WP3 | `lib/src/elodin/SendMsg.hpp`, `lib/include/elodin/TableId.hpp` | DESIGN-WP3 §2.3, §2.5 |
| WP8 | `lib/include/service/StopSignals.hpp`, `lib/include/net/{UdpSocket,TcpCommandServer}.hpp`, `lib/include/elodin/SequencerStateFollower.hpp`, `lib/include/config/ConfigFile.hpp` | DESIGN-WP8 §2, amendments |
| WP9 | `services/calibration/{Conversions,SensorModels,CalibrationContext,CalibrationActions,AbortThresholds,CalibrationCommands,RawStream}.hpp` | DESIGN-WP9 §2-§3, amendments |
| WP10 | `daq_bridge/{BoardMap,BackendLogForwarder,ElodinPublish}.hpp` | DESIGN-WP10 §4.3; the class splits add no header; no `TableRegistration` (D49: the two registration sites stay separate) |

Names follow STYLE-S1 as ruled in D43(2).
