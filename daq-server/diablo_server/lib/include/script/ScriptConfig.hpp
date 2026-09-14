#pragma once

#include <string>
#include <vector>

#include "config/Config.hpp"
#include "script/StateScript.hpp"

/**
 * The bridge between config and the script language.
 *
 * Kept out of StateScript.hpp on purpose: the language itself is pure — strings in, diagnostics
 * out, no config, no I/O, no clock — which is what lets it be tested exhaustively and linked into
 * a hermetic checker binary. This header is where it learns what a real rig declares.
 */
namespace fsw {
namespace script {

/** A name that could not be turned into a usable slug, reported so config can refuse it loudly. */
struct BadSlug {
    std::string canonical;  // the config spelling
    std::string slug;       // what slugify produced
    std::string where;      // "actuator" / "sensor" / "state"
};

/** Two config names in one namespace that slug to the same identifier — genuinely ambiguous. */
struct SlugCollision {
    std::string slug;
    std::string first;
    std::string second;
    std::string where;
};

struct TableBuild {
    SlugTables tables;
    std::vector<BadSlug> bad;
    std::vector<SlugCollision> collisions;

    bool ok() const {
        return bad.empty() && collisions.empty();
    }
};

/**
 * Build the actuator / sensor / state slug tables from a loaded config.
 *
 * `allowed_transitions` is left empty — it depends on which state owns the script and on
 * state_transitions.csv, neither of which this library reads. The caller fills it.
 *
 * Collisions are reported per namespace only. Across namespaces they are expected and harmless:
 * on the shipped `server` profile FUEL_VENT is both a valve and a state, and on `digital-twin`
 * FUEL_UPSTREAM is both a valve and a sensor. Positional resolution is what makes that fine, and a
 * blanket collision rule would refuse config that runs today.
 */
TableBuild build_slug_tables(const fsw::config::Config& cfg);

}  // namespace script
}  // namespace fsw
