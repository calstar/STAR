// Golden-master helpers shared by the packets/ and elodin/ characterization tests.
//
// A test builds its output text with Out, then calls finish(name). With CHAR_UPDATE=1 in the
// environment the golden is (re)written; otherwise the text is compared with
// <CHAR_GOLDEN_DIR>/<name> and every differing line is printed, so a failure names the field.
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <type_traits>
#include <vector>

#ifndef CHAR_GOLDEN_DIR
#error "CHAR_GOLDEN_DIR must be defined by the build"
#endif

namespace chargold {

inline std::string hex(const uint8_t* p, size_t n) {
    static const char* d = "0123456789abcdef";
    std::string s;
    s.reserve(n * 3);
    for (size_t i = 0; i < n; ++i) {
        if (i)
            s += ' ';
        s += d[p[i] >> 4];
        s += d[p[i] & 15];
    }
    return s;
}

inline std::string hex(const std::vector<uint8_t>& v) {
    return hex(v.data(), v.size());
}

inline std::string hexu(uint64_t v, int width = 0) {
    char b[32];
    std::snprintf(b, sizeof b, "0x%0*llx", width, static_cast<unsigned long long>(v));
    return b;
}

/** Portable float text: shortest round-trip-ish %.9g / %.17g plus the raw bits. */
inline std::string fstr(float f) {
    uint32_t bits;
    std::memcpy(&bits, &f, 4);
    char b[64];
    std::snprintf(b, sizeof b, "%.9g (bits %08x)", static_cast<double>(f), bits);
    return b;
}
inline std::string fstr(double f) {
    uint64_t bits;
    std::memcpy(&bits, &f, 8);
    char b[80];
    std::snprintf(b, sizeof b, "%.17g (bits %016llx)", f, static_cast<unsigned long long>(bits));
    return b;
}

class Out {
public:
    std::ostringstream s;

    Out& line(const std::string& l) {
        s << l << '\n';
        return *this;
    }

    /** One byte span: "<name> @<off> +<size>: <hex>". */
    Out& span(const std::string& name, size_t off, const uint8_t* p, size_t n) {
        char b[48];
        std::snprintf(b, sizeof b, " @%-4zu +%-3zu: ", off, n);
        s << "  " << name << b << hex(p, n) << '\n';
        return *this;
    }

    /**
     * Walk a byte buffer with a list of named field widths. Bytes beyond the listed fields are
     * printed as "<trailing>"; a field that runs past the end prints what is there and is marked
     * "(short)".
     */
    struct F {
        std::string name;
        size_t size;
    };
    Out& fields(const uint8_t* p, size_t n, const std::vector<F>& fs) {
        size_t off = 0;
        for (const auto& f : fs) {
            if (off >= n) {
                s << "  " << f.name << " @" << off << ": <missing>\n";
                continue;
            }
            size_t take = f.size;
            bool shortf = false;
            if (off + take > n) {
                take = n - off;
                shortf = true;
            }
            span(f.name + (shortf ? " (short)" : ""), off, p + off, take);
            off += take;
        }
        if (off < n)
            span("<trailing>", off, p + off, n - off);
        return *this;
    }

    template <typename T>
    Out& kv(const std::string& k, const T& v) {
        if constexpr (std::is_same_v<T, float> || std::is_same_v<T, double>)
            s << "  " << k << " = " << fstr(v) << '\n';
        else if constexpr (std::is_same_v<T, bool>)
            s << "  " << k << " = " << (v ? "true" : "false") << '\n';
        else if constexpr (std::is_integral_v<T>)
            s << "  " << k << " = " << static_cast<long long>(v) << '\n';
        else
            s << "  " << k << " = " << v << '\n';
        return *this;
    }
};

inline bool update_mode() {
    const char* e = std::getenv("CHAR_UPDATE");
    return e && *e && std::string(e) != "0";
}

inline std::vector<std::string> split_lines(const std::string& t) {
    std::vector<std::string> v;
    std::istringstream is(t);
    std::string l;
    while (std::getline(is, l))
        v.push_back(l);
    return v;
}

/** Compare (or with CHAR_UPDATE=1, write) one golden file. Returns 0 on pass. */
inline int finish(const std::string& name, const std::string& actual) {
    const std::string path = std::string(CHAR_GOLDEN_DIR) + "/" + name;
    if (update_mode()) {
        std::ofstream f(path, std::ios::binary);
        f << actual;
        std::cout << "[golden] wrote " << path << " (" << actual.size() << " bytes)" << std::endl;
        return f ? 0 : 1;
    }
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        std::cerr << "[golden] MISSING " << path << " (run with CHAR_UPDATE=1 on main's behaviour)"
                  << std::endl;
        return 1;
    }
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string expected = ss.str();
    if (expected == actual) {
        std::cout << "[golden] " << name << ": match (" << actual.size() << " bytes)" << std::endl;
        return 0;
    }
    const auto e = split_lines(expected), a = split_lines(actual);
    std::cerr << "[golden] " << name << ": MISMATCH (" << e.size() << " golden lines, " << a.size()
              << " actual lines)" << std::endl;
    size_t shown = 0;
    const size_t n = std::max(e.size(), a.size());
    for (size_t i = 0; i < n && shown < 60; ++i) {
        const std::string* el = i < e.size() ? &e[i] : nullptr;
        const std::string* al = i < a.size() ? &a[i] : nullptr;
        if (el && al && *el == *al)
            continue;
        std::cerr << "  line " << (i + 1) << ":\n";
        if (el)
            std::cerr << "    - " << *el << '\n';
        if (al)
            std::cerr << "    + " << *al << '\n';
        ++shown;
    }
    const std::string act_path = name + ".actual";
    std::ofstream o(act_path, std::ios::binary);
    o << actual;
    std::cerr << "  (full actual output written to " << act_path << " in the test's working dir)"
              << std::endl;
    return 1;
}

}  // namespace chargold
