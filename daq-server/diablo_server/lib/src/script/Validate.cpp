#include <algorithm>

#include "script/StateScript.hpp"

namespace fsw {
namespace script {

namespace {

/** A short "did you mean" for a slug that did not resolve. Cheap edit-distance-1-ish: same length
 *  with one character different, or a one-character insertion/deletion. Enough to catch the real
 *  typo (FUEL_VNT for FUEL_VENT) without pretending to be a spell checker. */
std::string nearest(const std::string& want, const std::map<std::string, std::string>& table) {
    auto close = [&](const std::string& a, const std::string& b) {
        const size_t la = a.size(), lb = b.size();
        if (la == lb) {
            int diff = 0;
            for (size_t i = 0; i < la; i++)
                if (a[i] != b[i] && ++diff > 1)
                    return false;
            return diff == 1;
        }
        if (la + 1 != lb && lb + 1 != la)
            return false;
        const std::string& s = (la < lb) ? a : b;  // shorter
        const std::string& l = (la < lb) ? b : a;  // longer
        size_t i = 0, j = 0;
        bool skipped = false;
        while (i < s.size() && j < l.size()) {
            if (s[i] == l[j]) {
                i++;
                j++;
            } else if (!skipped) {
                skipped = true;
                j++;
            } else {
                return false;
            }
        }
        return true;
    };
    for (const auto& [slug, canonical] : table)
        if (close(want, slug))
            return slug;
    return {};
}

std::string suffixFor(const std::string& want, const std::map<std::string, std::string>& table) {
    const std::string near = nearest(want, table);
    if (!near.empty())
        return " — did you mean " + near + "?";
    if (table.empty())
        return "";
    // No near match: name a couple of real options so the operator can see the spelling shape.
    std::string s = " — known names include ";
    int n = 0;
    for (const auto& [slug, canonical] : table) {
        if (n++ >= 3)
            break;
        if (n > 1)
            s += ", ";
        s += slug;
    }
    return s;
}

}  // namespace

std::vector<Diagnostic> validate(const ScriptProgram& program, const SlugTables& tables) {
    std::vector<Diagnostic> out;

    // ── Slugs resolve in the namespace their argument slot names ─────────────────────────────
    //
    // Positional, never by spelling. On the shipped server profile FUEL_VENT is both a valve and a
    // state; open_valve(FUEL_VENT) and transition_to(FUEL_VENT) are both legitimate and mean
    // different things. Checking each reference against only its own slot's table is what makes
    // that work.
    for (const SlugRef& ref : program.slugs) {
        const std::map<std::string, std::string>* table = nullptr;
        Diag code = Diag::UnknownActuator;
        switch (ref.ns) {
            case Ns::Actuator:
                table = &tables.actuators;
                code = Diag::UnknownActuator;
                break;
            case Ns::PtSensor:
                table = &tables.sensors;
                code = Diag::UnknownSensor;
                break;
            case Ns::State:
                table = &tables.states;
                code = Diag::UnknownState;
                break;
        }
        if (table->count(ref.slug) == 0) {
            out.push_back({code, ref.line, ref.col,
                           std::string("no ") + ns_name(ref.ns) + " named " + ref.slug +
                               suffixFor(ref.slug, *table)});
            continue;
        }
        // Every transition_to target is checked against the matrix, not just the two configured
        // fallbacks. A script that runs for 25 seconds and only THEN discovers it cannot leave is
        // strictly worse than one that never starts.
        if (ref.ns == Ns::State && tables.allowed_transitions.count(ref.slug) == 0) {
            out.push_back({Diag::TransitionNotAllowed, ref.line, ref.col,
                           "this state is not allowed to transition to " + ref.slug +
                               " — state_transitions.csv does not permit it"});
        }
    }

    // ── A variable must not be named like any slug in any namespace ──────────────────────────
    //
    // Positional resolution means `target = 1` beside `pressure(TARGET)` is technically
    // unambiguous, but an operator reading it has to know the rule to see which is which. Refusing
    // the overlap keeps the error messages honest and costs nothing: rename the variable.
    for (const std::string& var : program.variables) {
        const std::string slug = slugify(var);
        const char* where = nullptr;
        if (tables.actuators.count(slug))
            where = "an actuator";
        else if (tables.sensors.count(slug))
            where = "a sensor";
        else if (tables.states.count(slug))
            where = "a state";
        if (where == nullptr)
            continue;
        // Point at the variable's first appearance rather than line 0.
        uint32_t line = 0, col = 0;
        for (const Stmt& s : program.stmts) {
            if (s.kind == StmtKind::Assign &&
                program.variables[static_cast<size_t>(s.var)] == var) {
                line = s.line;
                col = s.col;
                break;
            }
        }
        out.push_back({Diag::VarShadowsSlug, line, col,
                       "variable '" + var + "' has the same name as " + where + " (" + slug +
                           ") — rename the variable"});
    }

    std::stable_sort(out.begin(), out.end(), [](const Diagnostic& a, const Diagnostic& b) {
        if (a.line != b.line)
            return a.line < b.line;
        return a.col < b.col;
    });
    return out;
}

}  // namespace script
}  // namespace fsw
