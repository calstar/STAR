#include "config/LoadActiveBoards.hpp"

#include <fstream>
#include <sstream>
#include <string>

namespace fsw {
namespace config {

std::map<ActiveBoardKind, std::vector<elodin::BoardChannels>> load_active_boards(
    const std::string& config_path) {
    using BoardChannels = elodin::BoardChannels;
    std::map<ActiveBoardKind, std::vector<BoardChannels>> result;

    std::ifstream f(config_path);
    if (!f.is_open())
        return result;

    std::string line, section;
    std::string board_type_str;
    int board_id = -1;
    bool board_enabled = true;
    std::vector<uint8_t> active_conn;
    int num_sensors = 10;

    auto flush = [&]() {
        if (board_type_str.empty() || !board_enabled || board_id < 0)
            return;
        ActiveBoardKind bt = ActiveBoardKind::UNKNOWN;
        if (board_type_str == "PT")
            bt = ActiveBoardKind::PT;
        else if (board_type_str == "TC")
            bt = ActiveBoardKind::TC;
        else if (board_type_str == "RTD")
            bt = ActiveBoardKind::RTD;
        else if (board_type_str == "LC")
            bt = ActiveBoardKind::LC;
        else if (board_type_str == "ENCODER")
            bt = ActiveBoardKind::ENCODER;
        else if (board_type_str == "ACTUATOR")
            bt = ActiveBoardKind::ACTUATOR;
        if (bt == ActiveBoardKind::UNKNOWN)
            return;

        BoardChannels bc;
        bc.board_id = static_cast<uint8_t>(board_id);
        {
            int m = board_id % 10;
            bc.board_number = static_cast<uint8_t>(m == 0 ? 10 : m);
        }
        if (!active_conn.empty()) {
            bc.channels = active_conn;
        } else {
            for (int i = 1; i <= num_sensors; i++)
                bc.channels.push_back(static_cast<uint8_t>(i));
        }
        result[bt].push_back(std::move(bc));
    };

    while (std::getline(f, line)) {
        size_t c = line.find('#');
        if (c != std::string::npos)
            line = line.substr(0, c);
        while (!line.empty() && (line.back() == ' ' || line.back() == '\r'))
            line.pop_back();
        size_t start = line.find_first_not_of(" \t");
        if (start != std::string::npos)
            line = line.substr(start);
        if (line.empty())
            continue;

        if (line.size() >= 2 && line[0] == '[' && line.back() == ']') {
            flush();
            section = line.substr(1, line.size() - 2);
            if (section.rfind("boards.", 0) == 0) {
                board_type_str.clear();
                board_id = -1;
                board_enabled = true;
                active_conn.clear();
                num_sensors = 10;
            } else {
                board_type_str.clear();
            }
            continue;
        }
        if (section.rfind("boards.", 0) != 0)
            continue;

        size_t eq = line.find('=');
        if (eq == std::string::npos)
            continue;
        std::string key = line.substr(0, eq);
        std::string val = line.substr(eq + 1);
        while (!key.empty() && (key.back() == ' ' || key.back() == '\t'))
            key.pop_back();
        while (!val.empty() && val[0] == ' ')
            val.erase(0, 1);

        if (key == "type") {
            if (val.size() >= 2 && val.front() == '"' && val.back() == '"')
                val = val.substr(1, val.size() - 2);
            board_type_str = val;
        } else if (key == "enabled" && val == "false") {
            board_enabled = false;
        } else if (key == "board_id") {
            try {
                board_id = std::stoi(val);
            } catch (...) {
            }
        } else if (key == "num_sensors") {
            try {
                num_sensors = std::stoi(val);
            } catch (...) {
            }
        } else if (key == "active_connectors") {
            size_t b = val.find('['), e = val.find(']');
            if (b != std::string::npos && e != std::string::npos) {
                std::string inner = val.substr(b + 1, e - b - 1);
                std::istringstream iss(inner);
                std::string tok;
                while (std::getline(iss, tok, ',')) {
                    try {
                        active_conn.push_back(static_cast<uint8_t>(std::stoi(tok)));
                    } catch (...) {
                    }
                }
            }
        }
    }
    flush();

    return result;
}

}  // namespace config
}  // namespace fsw
