#pragma once

#include <charconv>
#include <cstdint>
#include <map>
#include <string>

namespace sequencer {

/**
 * A per-run override of what one state's actuator column does to one valve.
 *
 * Why this exists at all: the delays CSV and the positions CSV are config, and config is frozen
 * for the life of a run — the backend deploys the active profile at session start and the pipeline
 * is started against it. Feed-system characterization is the one job that needs to change valve
 * timing between shots: you open both mains, see on the trace that one leads the other by 120 ms,
 * and want to trim it and shoot again. Through the CSVs that is a session stop, a config edit, a
 * redeploy and a session start per trim, and the trace you are comparing against lives in the
 * previous run's directory.
 *
 * So a plan is carried WITH the transition instead of being stored anywhere: it describes one
 * entry into one state, it is never persisted, and the next transition is unaffected by it. The
 * CSVs remain the authority for every state and every valve the plan does not mention — a plan is
 * read as a delta against the column, never as a replacement for it.
 *
 * It is accepted only for a state whose hold rule is `gui_settable`, which the burn state never is
 * (SequencerService::HoldRule). That is the same gate the client-settable hold duration passes,
 * and for the same reason: a client must not be able to retime the valves of a burn.
 */
struct ValveOverride {
    /**
     * Command this role's CLOSED position on entry, whatever its column says.
     *
     * This is how "characterize one tank at a time" is expressed: the flow state's column opens
     * both sides, and a plan that holds one side shut runs the same state with only the other
     * side flowing. It can only ever move a valve towards shut — there is no override that opens a
     * valve the column closes, because that would be a client inventing a flow path the
     * drawing-derived config does not have.
     */
    bool hold_shut = false;

    /**
     * Milliseconds after state entry before this valve is commanded. 0 means "with the first
     * stage", which is also how a plan cancels a stagger the CSV declares — an absent entry
     * inherits the CSV delay, an entry of 0 overrides it to none. Ignored when hold_shut: a valve
     * being held shut is already in that position and has nothing to wait for.
     */
    uint32_t delay_ms = 0;
};

/** role name -> what this run does with it. Roles absent from the map follow the CSVs exactly. */
using ValvePlan = std::map<std::string, ValveOverride>;

/**
 * Ceiling on a plan's delay, independent of the hold.
 *
 * Not the real limit — SequencerService refuses any delay that reaches past the end of the hold,
 * which on a one-second pulse is far smaller than this. This one exists so a garbage frame is
 * rejected at the wire.
 */
inline constexpr uint32_t kMaxValveDelayMs = 60000;

/**
 * Parse the wire form of a plan: `<role>=<ms|shut>[,<role>=<ms|shut>...]`.
 *
 * Role names contain spaces ("Fuel Main"), so the separators are ',' and '=' and a role carrying
 * either cannot be expressed — such a plan is REFUSED rather than guessed at, here and in the
 * backend that builds the frame. Strict throughout: a half-parsed plan would retime valves in a
 * way nobody asked for, and the fail-safe reading of a malformed one is "do not move anything",
 * which is what a false return gets the caller.
 *
 * @param out written only on success.
 * @param error on a false return, a short phrase for the protocol reply.
 * @return true if the whole string is a usable plan.
 */
inline bool parseValvePlan(const std::string& text, ValvePlan& out, std::string* error = nullptr) {
    auto fail = [&](const std::string& why) {
        if (error)
            *error = why;
        return false;
    };
    auto trim = [](const std::string& s) {
        const size_t a = s.find_first_not_of(" \t\r\n");
        if (a == std::string::npos)
            return std::string();
        const size_t b = s.find_last_not_of(" \t\r\n");
        return s.substr(a, b - a + 1);
    };

    ValvePlan plan;
    size_t pos = 0;
    while (pos <= text.size()) {
        const size_t comma = text.find(',', pos);
        const std::string field =
            trim(comma == std::string::npos ? text.substr(pos) : text.substr(pos, comma - pos));
        if (field.empty())
            return fail("empty entry in valve plan");

        const size_t eq = field.rfind('=');
        if (eq == std::string::npos || eq == 0)
            return fail("valve plan entry is not <valve>=<ms|shut>");
        const std::string role = trim(field.substr(0, eq));
        const std::string value = trim(field.substr(eq + 1));
        if (role.empty())
            return fail("valve plan entry with no valve name");
        if (plan.count(role))
            return fail("valve \"" + role + "\" appears twice in the valve plan");

        ValveOverride ov;
        if (value == "shut") {
            ov.hold_shut = true;
        } else {
            // Strictly digits, exactly like parseHoldMs and for the same reason: atoi("1e3") is 1,
            // so a lenient parse turns a 1000 ms request into a 1 ms one and the operator weighs a
            // catch against a window that never happened. Zero IS accepted here, unlike a hold —
            // it is the override that cancels a configured stagger.
            if (value.empty())
                return fail("valve \"" + role + "\" has no delay");
            uint64_t v = 0;
            const char* first = value.data();
            const char* last = value.data() + value.size();
            const auto res = std::from_chars(first, last, v);
            if (res.ec != std::errc() || res.ptr != last)
                return fail("valve \"" + role + "\" has a non-numeric delay");
            if (v > kMaxValveDelayMs)
                return fail("valve \"" + role + "\" delay exceeds " +
                            std::to_string(kMaxValveDelayMs) + " ms");
            ov.delay_ms = static_cast<uint32_t>(v);
        }
        plan.emplace(role, ov);

        if (comma == std::string::npos)
            break;
        pos = comma + 1;
    }

    if (plan.empty())
        return fail("empty valve plan");
    out = std::move(plan);
    return true;
}

}  // namespace sequencer
