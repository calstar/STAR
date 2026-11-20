// A motorized ball valve board: its own board kind, and actuator roles on it have no polarity.

#include <iostream>
#include <stdexcept>
#include <string>

#include "config/Config.hpp"

using namespace fsw::config;

static void require(bool condition, const char* what) {
    if (!condition)
        throw std::runtime_error(std::string("Ball valve config assertion failed: ") + what);
}

static const char* kConfig = R"(
[boards.act_11]
type = "ACTUATOR"
board_id = 11
active_connectors = [1, 2]

[boards.ball_valve_board]
type = "BALL_VALVE"
board_id = 71
ip = "192.168.2.71"
active_connectors = [1]

[actuator_roles]
"Ball Valve NC" = ["NC", 1, 71]
"Ball Valve NO" = ["NO", 1, 71]
"Actuator NO" = ["NO", 2, 11]
"Actuator NC" = ["NC", 1, 11]
)";

int main() {
    require(kind_of("BALL_VALVE") == ActiveBoardKind::BALL_VALVE, "kind_of(BALL_VALVE)");
    require(kind_of("ACTUATOR") == ActiveBoardKind::ACTUATOR, "kind_of(ACTUATOR) unchanged");

    const Config cfg = load_from_string(kConfig);

    // A ball valve role is pass-through on the wire whatever its first element says.
    require(cfg.actuator_roles.at("Ball Valve NC").ball_valve, "NC role flagged ball_valve");
    require(!cfg.actuator_roles.at("Ball Valve NC").is_no, "NC role pass-through");
    require(cfg.actuator_roles.at("Ball Valve NO").ball_valve, "NO role flagged ball_valve");
    require(!cfg.actuator_roles.at("Ball Valve NO").is_no,
            "NO on a ball valve forced pass-through");

    // Roles on an ACTUATOR board are untouched.
    require(!cfg.actuator_roles.at("Actuator NO").ball_valve, "actuator role not a ball valve");
    require(cfg.actuator_roles.at("Actuator NO").is_no, "actuator NO stays NO");
    require(!cfg.actuator_roles.at("Actuator NC").is_no, "actuator NC stays NC");

    // Board 71 is slot 1, as is actuator board 11; separate kinds, so both are active and the
    // ball valve is listed under its own kind.
    const auto boards = active_boards(cfg);
    require(boards.at(ActiveBoardKind::BALL_VALVE).size() == 1, "one ball valve board");
    require(boards.at(ActiveBoardKind::BALL_VALVE)[0].board_id == 71, "ball valve board id");
    require(boards.at(ActiveBoardKind::BALL_VALVE)[0].board_number == 1, "board 71 is slot 1");
    require(boards.at(ActiveBoardKind::ACTUATOR).size() == 1, "actuator board still listed");

    std::cout << "Ball valve config passed\n";
}
