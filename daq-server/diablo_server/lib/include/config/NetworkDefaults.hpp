#pragma once

// Network defaults shared by every C++ binary.
//
// These are FALLBACKS, used only when config.toml does not say otherwise; the stand's real
// addresses and ports belong in the config ([network], [database], [server_heartbeat],
// [actuator_service], [controller_service], [boards.*]). Each one used to be repeated as a bare
// literal at a dozen call sites, which made "what port do the boards listen on?" a grep rather
// than a lookup, and let one copy drift from the rest. Change a default here, once.
//
// "0.0.0.0" (any interface) and "127.0.0.1" (this machine) are left as literals where they appear:
// they mean the same thing on every network, so naming them adds nothing.

#include <cstdint>

namespace fsw {
namespace config {
namespace defaults {

/// UDP port the DiabloAvionics boards listen on: actuator commands, sensor/actuator config,
/// server heartbeat and the ABORT broadcast all go here.
inline constexpr uint16_t kBoardPort = 5005;

/// UDP port this server receives board sensor data on ([network].sensor_port).
inline constexpr uint16_t kSensorPort = 5006;

/// Elodin DB TCP port ([database].port).
inline constexpr uint16_t kElodinPort = 2240;

/// TCP command port of sequencer_service ([actuator_service].port).
inline constexpr uint16_t kActuatorServicePort = 9998;

/// TCP command port of controller_service ([controller_service].port).
inline constexpr uint16_t kControllerServicePort = 9999;

/// Limited broadcast: reaches every host on the local segment, whatever its subnet.
inline constexpr const char* kLimitedBroadcast = "255.255.255.255";

/// Directed broadcast of the GSE board network.
inline constexpr const char* kGseBroadcast = "192.168.2.255";

/// Board networks: ground support equipment and the flight vehicle.
inline constexpr const char* kGseSubnet = "192.168.2.0";
inline constexpr const char* kFlightSubnet = "192.168.3.0";

}  // namespace defaults
}  // namespace config
}  // namespace fsw
