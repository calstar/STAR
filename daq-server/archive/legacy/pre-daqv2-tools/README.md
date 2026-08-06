# Pre-DAQv2 tools (archived 2026-07)

Tools from the pre-DAQv2-Comms protocol era, kept for reference only. None of
them work against the current stack:

- `fake_packet_generator.cpp` — emitted the old encrypted-frame wire format
  (0xAA magic byte, 16-byte header with sequence_id, XOR key). The current
  `daq_bridge` parses DAQv2-Comms packets (`lib/DAQv2-Comms/src/DiabloPackets.h`)
  and cannot decode these frames. It had no CMake target since the monorepo
  merge. The current data simulator is `sim/board_simulator.py`.
- `test_full_pipeline.sh` — drove the generator above; expects binaries in
  `./build/daq_comms/`, a build layout that no longer exists.
- `test_elodin_editor.sh` — same dead paths, plus `config/sensor_routing.toml`
  which no longer exists.

Note: `diablo_server/transport/include/protocol/EncryptedFrame.hpp` is NOT
part of this era despite its name — it holds the current host-side sample
structs and is live (included by SensorRouter / SensorFramePipeline). Only the
file name is a fossil.
