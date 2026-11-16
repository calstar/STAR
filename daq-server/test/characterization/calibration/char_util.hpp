#pragma once
// Shared helpers for the calibration characterization harnesses (test-only).
//
// Every number is printed with %.17g so it round-trips: a change in the last bit of a coefficient
// shows up as a changed line in the golden. Wall-clock timestamps written into the stores are the
// only thing masked, and only when they are within an hour of now (a timestamp that came from a
// fixture file is a fixed number and is kept, so the load/save round-trip of it stays frozen).

#include <unistd.h>

#include <chrono>
#include <cinttypes>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <regex>
#include <sstream>
#include <string>
#include <vector>

namespace charcal {

inline std::string d(double v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

inline std::string f32(float v) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.9g", static_cast<double>(v));
    return buf;
}

inline void section(const char* name) {
    std::printf("\n== %s ==\n", name);
}

inline std::string read_file(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f.is_open())
        return "<missing>";
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}

inline void write_file(const std::string& p, const std::string& s) {
    std::ofstream f(p, std::ios::binary | std::ios::trunc);
    f << s;
}

/** Replace a numeric value of a timestamp key with "<NOW>" when it is within an hour of now. */
inline std::string mask_now(const std::string& text) {
    const double now_s =
        std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
    static const std::regex re(
        R"re(("(?:generated_unix|updatedAt|t|set_at_ms)": )(-?[0-9][0-9.eE+-]*))re");
    std::string out;
    auto begin = std::sregex_iterator(text.begin(), text.end(), re);
    size_t last = 0;
    for (auto it = begin; it != std::sregex_iterator(); ++it) {
        const auto& m = *it;
        out.append(text, last, static_cast<size_t>(m.position(0)) - last);
        const double v = std::strtod(m[2].str().c_str(), nullptr);
        const bool recent = std::fabs(v - now_s) < 3600.0 || std::fabs(v - now_s * 1000.0) < 3.6e6;
        out += m[1].str();
        out += recent ? std::string("\"<NOW>\"") : m[2].str();
        last = static_cast<size_t>(m.position(0) + m.length(0));
    }
    out.append(text, last, std::string::npos);
    return out;
}

/** Print a file's bytes (timestamps near now masked), framed so a missing newline shows. */
inline void dump_file(const std::string& label, const std::string& path) {
    std::printf("--- file %s ---\n%s\n--- end %s ---\n", label.c_str(),
                mask_now(read_file(path)).c_str(), label.c_str());
}

/** A fresh private directory under TMPDIR, removed by the caller. */
inline std::string make_tmp_dir(const char* tag) {
    std::string tmpl = (std::filesystem::temp_directory_path() / (std::string(tag) + ".XXXXXX"));
    std::vector<char> buf(tmpl.begin(), tmpl.end());
    buf.push_back('\0');
    if (::mkdtemp(buf.data()) == nullptr) {
        std::perror("mkdtemp");
        std::exit(2);
    }
    return std::string(buf.data());
}

/** The environment variables any calibration code consults: pinned unset for every run. */
inline void pin_env() {
    for (const char* v : {"CAL_PT_JSON_FIRST", "CAL_PT_JSON_MISSING_ONLY", "CAL_USE_FACTORY_PT",
                          "CAL_USE_ROBUST_BLEND", "CAL_USE_ROBUST_PT", "CAL_VERBOSE",
                          "CAL_BACKUP_PATH", "CAL_HP_MA_HYST", "CAL_ROBUST_PRIOR_MAX_PSI_ERR"})
        ::unsetenv(v);
}

}  // namespace charcal
