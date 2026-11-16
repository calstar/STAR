// DESIGN STUB (DESIGN-WP8 §2.5, pass 2 only; names AMENDED per D43(2)/STYLE-S1) — not compiled.
// Becomes diablo_server/lib/include/config/ConfigFile.hpp (+ lib/src/config/ConfigFile.cpp).
//
// Which config file a service reads, and its text: the fallback blocks of heartbeat (202-213),
// stacklight (211-228), config_broadcast (468-485) and the controller (276-301).
//
// Owns:       nothing; opens each candidate with std::ifstream and closes it before returning.
// Threads:    the main thread, before any other thread exists.
// Errors:     never throws, never logs. find_config_file reports found / fell_back; read_file_text
//             returns "" when the file does not open. The CALLER prints its own lines in today's
//             order (the controller's four: "❌ Cannot open config", "ℹ️  Using fallback config",
//             "❌ No config.toml found. Using defaults.", "📋 Loaded config") and decides exit
//             codes (config_broadcast: empty text → "[ConfigBroadcast] No config loaded", exit 1).
//             Nothing here wraps or checks fsw::config::load (C2-4 defaults and C2-12's SIGABRT
//             stay exactly as they are).
// Must not know: TOML, Config, any service's precedence (STYLE-S18: each main resolves its own).
// Observable difference (why this is pass 2, not pass 1): stacklight, config_broadcast and the
//             controller read the chosen file through a second open instead of the probing stream.
//             Same bytes.
// Contract:   config/golden/bin/{stacklight,config_broadcast,daq_bridge}; DESIGN-WP8 §7.2 gap 8
//             (a missing --config with a fallback present) must close before pass 2.
#pragma once

#include <initializer_list>
#include <string>

namespace fsw::config {

struct ConfigFileChoice {
    std::string path;
    bool found;
    bool fell_back;
};

/** `requested` if it opens; else the first of `fallbacks` that opens (fell_back = true); else
 *  `requested` with found = false. */
ConfigFileChoice find_config_file(const std::string& requested,
                                  std::initializer_list<const char*> fallbacks);

/** The whole file as text; "" if it does not open. */
std::string read_file_text(const std::string& path);

}  // namespace fsw::config
