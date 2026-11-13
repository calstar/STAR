#include <cctype>

#include "script/StateScript.hpp"

namespace fsw {
namespace script {

std::string slugify(const std::string& name) {
    std::string out;
    out.reserve(name.size());
    bool pending_gap = false;
    bool seen = false;
    for (unsigned char c : name) {
        if (std::isspace(c)) {
            if (seen)
                pending_gap = true;  // collapse runs, and drop trailing space entirely
            continue;
        }
        if (pending_gap) {
            out += '_';
            pending_gap = false;
        }
        out += static_cast<char>(std::toupper(c));
        seen = true;
    }
    return out;
}

bool is_valid_slug(const std::string& slug) {
    if (slug.empty())
        return false;
    if (!(slug[0] >= 'A' && slug[0] <= 'Z'))
        return false;
    for (char c : slug) {
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
        if (!ok)
            return false;
    }
    return true;
}

}  // namespace script
}  // namespace fsw
