#include "script/ScriptConfig.hpp"

#include <map>

#include "config/SensorTables.hpp"

namespace fsw {
namespace script {

namespace {

/** Insert canonical->slug into `table`, recording a bad slug or an in-namespace collision. */
void addName(const std::string& canonical, const char* where,
             std::map<std::string, std::string>& table, TableBuild& out) {
    if (canonical.empty())
        return;
    const std::string slug = slugify(canonical);
    if (!is_valid_slug(slug)) {
        // Refused rather than mangled. Every name on all three shipped profiles slugs cleanly, so
        // this only fires on something new — and inventing a punctuation mangling would be a rule
        // the operator cannot see and the editor's autocomplete would have to guess at.
        out.bad.push_back({canonical, slug, where});
        return;
    }
    auto it = table.find(slug);
    if (it != table.end()) {
        if (it->second != canonical)
            out.collisions.push_back({slug, it->second, canonical, where});
        return;
    }
    table.emplace(slug, canonical);
}

}  // namespace

TableBuild build_slug_tables(const fsw::config::Config& cfg) {
    TableBuild out;

    for (const auto& [name, role] : cfg.actuator_roles)
        addName(name, "actuator", out.tables.actuators, out);

    // Sensors come through the shared resolver rather than by walking [sensor_roles_*] again, so
    // the set a script may name is exactly the set the pressure subscriber can resolve to a table.
    // Two walks would eventually disagree, and the disagreement would look like a sensor that
    // validates fine and then reads nothing.
    for (const auto& ref : fsw::config::pt_role_tables(cfg))
        addName(ref.role, "sensor", out.tables.sensors, out);

    for (const auto& s : cfg.states)
        addName(s.name, "state", out.tables.states, out);

    return out;
}

}  // namespace script
}  // namespace fsw
