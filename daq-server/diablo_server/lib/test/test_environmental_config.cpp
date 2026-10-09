#include <iostream>
#include <stdexcept>
#include <string>

#include "config/Config.hpp"

using namespace fsw::config;

void require(bool condition) {
    if (!condition)
        throw std::runtime_error("Environmental config assertion failed");
}

std::string board(const std::string& name, const std::string& id, bool enabled = true) {
    return "[boards." + name + "]\ntype = \"ENVIRONMENTAL\"\n" + id +
           "\nenabled = " + (enabled ? "true" : "false") + "\nactive_connectors = [1]\n";
}

int main() {
    for (const auto& id :
         {"board_id = 0", "board_id = -1", "board_id = 256", "board_id = 4294967321",
          "board_id = 25.5", "board_id = 25.0", "board_id = \"25\"", "board_id = true", ""}) {
        bool rejected = false;
        try {
            load_from_string(board("env", id));
        } catch (const std::invalid_argument& e) {
            rejected = std::string(e.what()).find("integer from 1 to 255") != std::string::npos;
        }
        require(rejected);
    }
    bool duplicate_rejected = false;
    try {
        load_from_string(board("first", "board_id = 25") + board("second", "id = 25"));
    } catch (const std::invalid_argument& e) {
        duplicate_rejected = std::string(e.what()).find("claimed by both") != std::string::npos;
    }
    require(duplicate_rejected);

    auto cfg = load_from_string(board("one", "board_id = 1") + board("max", "board_id = 255") +
                                board("first", "board_id = 25") + board("second", "board_id = 35") +
                                board("disabled", "board_id = 25", false) +
                                board("invalid_disabled", "board_id = 256", false));
    require(active_boards(cfg).at(ActiveBoardKind::ENVIRONMENTAL).size() == 4);
    for (auto& b : cfg.boards)
        if (b.enabled) {
            b.board_id = 256;
            break;
        }
    bool narrowing_rejected = false;
    try {
        active_boards(cfg);
    } catch (const std::invalid_argument&) {
        narrowing_rejected = true;
    }
    require(narrowing_rejected);
    std::cout << "Environmental ID validation passed\n";
}
