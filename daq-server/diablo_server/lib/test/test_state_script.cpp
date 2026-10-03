// The state-script language: lexer, parser, parse-time caps, and config-dependent validation.
//
// Pure — no sockets, no files, no clock. Everything is a string in and a verdict out.
//
// The accept cases pin a canonical s-expression of the parsed AST, not just "it parsed". Two
// readings of a script can both be "accepted" while disagreeing about precedence — `a - b - c`,
// `not a and b`, `-x * y` — and a precedence disagreement between what the operator was shown and
// what the interpreter runs is the worst bug this feature can have. Pinning the shape catches it.
//
// The corpus lives inline rather than in files. The plan called for a shared on-disk corpus so a
// TypeScript parser could run the same cases; there is no TypeScript parser (the frontend does
// regex slug scans and the backend shells out to state_script_check), so a second consumer never
// materialised and files would be machinery with no reader.

#include <iostream>
#include <string>
#include <vector>

#include "script/StateScript.hpp"

using namespace fsw::script;

static int g_failures = 0;

static void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << std::endl;
    if (!ok)
        g_failures++;
}

/** The tables every case validates against. Deliberately includes the cross-namespace collisions
 *  that exist on the shipped profiles: FUEL_VENT is both a valve and a state on `server`, and
 *  FUEL_UPSTREAM is both a valve and a sensor on `digital-twin`. */
static SlugTables tables() {
    SlugTables t;
    t.actuators = {
        {"GSE_HIGH_PRESS_CONTROL", "GSE High Press Control"},
        {"GSE_HIGH_PRESS_VENT", "GSE High Press Vent"},
        {"FUEL_VENT", "Fuel Vent"},
        {"FUEL_MAIN", "Fuel Main"},
        {"FUEL_UPSTREAM", "Fuel Upstream"},
    };
    t.sensors = {
        {"GN2_HIGH", "GN2 High"},
        {"GN2_REGULATED", "GN2 Regulated"},
        {"CHAMBER", "Chamber"},
        {"FUEL_UPSTREAM", "Fuel Upstream"},
    };
    t.states = {
        {"PRESS_STANDBY", "Press Standby"}, {"IDLE", "Idle"}, {"VENT", "Vent"},
        {"FUEL_VENT", "Fuel Vent"},         {"FIRE", "Fire"},
    };
    // Everything except FIRE is reachable from the state owning these scripts.
    t.allowed_transitions = {"PRESS_STANDBY", "IDLE", "VENT", "FUEL_VENT"};
    return t;
}

struct Accept {
    const char* name;
    const char* src;
    const char* ast;
};

struct Reject {
    const char* name;
    const char* src;
    Diag code;
    uint32_t line;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
static const std::vector<Accept> kAccept = {
    // The two motivating scripts, verbatim in shape.
    {"vent pulse (motivating example 1)",
     "open_valve(GSE_HIGH_PRESS_VENT)\n"
     "delay(0.5)\n"
     "close_valve(GSE_HIGH_PRESS_VENT)\n"
     "transition_to(PRESS_STANDBY)\n",
     "(seq (open GSE_HIGH_PRESS_VENT) (delay 0.5) (close GSE_HIGH_PRESS_VENT) "
     "(goto PRESS_STANDBY))"},

    {"COPV press (motivating example 2)",
     "target = 0.9 * pressure(GN2_HIGH)\n"
     "while pressure(GN2_REGULATED) < target:\n"
     "    open_valve(GSE_HIGH_PRESS_CONTROL)\n"
     "    delay(0.2)\n"
     "    close_valve(GSE_HIGH_PRESS_CONTROL)\n"
     "    delay(0.2)\n"
     "transition_to(PRESS_STANDBY)\n",
     "(seq (set target (* 0.9 (pressure GN2_HIGH))) "
     "(while (< (pressure GN2_REGULATED) target) "
     "(seq (open GSE_HIGH_PRESS_CONTROL) (delay 0.2) (close GSE_HIGH_PRESS_CONTROL) (delay 0.2))) "
     "(goto PRESS_STANDBY))"},

    // ── Precedence. These are the whole reason the AST shape is pinned. ──────────────────────
    {"subtraction is left-associative", "a = 1\nb = 2\nc = 3\nd = a - b - c\ndelay(1)\n",
     "(seq (set a 1) (set b 2) (set c 3) (set d (- (- a b) c)) (delay 1))"},

    {"multiplication binds tighter than addition", "a = 1\nb = 2\nc = 3\nd = a + b * c\ndelay(1)\n",
     "(seq (set a 1) (set b 2) (set c 3) (set d (+ a (* b c))) (delay 1))"},

    {"unary minus binds tighter than multiplication", "x = 2\ny = 3\nz = -x * y\ndelay(1)\n",
     "(seq (set x 2) (set y 3) (set z (* (neg x) y)) (delay 1))"},

    {"not binds looser than comparison, tighter than and",
     "a = 1\nb = 2\nif not a < b and a == 1:\n    delay(1)\n",
     "(seq (set a 1) (set b 2) (if (and (not (< a b)) (== a 1)) (seq (delay 1))))"},

    {"and binds tighter than or", "a = 1\nb = 2\nc = 3\nif a or b and c:\n    delay(1)\n",
     "(seq (set a 1) (set b 2) (set c 3) (if (or a (and b c)) (seq (delay 1))))"},

    {"parentheses override precedence", "a = 1\nb = 2\nc = 3\nd = (a + b) * c\ndelay(1)\n",
     "(seq (set a 1) (set b 2) (set c 3) (set d (* (+ a b) c)) (delay 1))"},

    // ── Structure ────────────────────────────────────────────────────────────────────────────
    {"elif desugars to a nested if in the else arm",
     "if pressure(CHAMBER) > 500:\n"
     "    transition_to(VENT)\n"
     "elif pressure(CHAMBER) > 100:\n"
     "    transition_to(IDLE)\n"
     "else:\n"
     "    transition_to(PRESS_STANDBY)\n",
     "(seq (if (> (pressure CHAMBER) 500) (seq (goto VENT)) "
     "(seq (if (> (pressure CHAMBER) 100) (seq (goto IDLE)) (seq (goto PRESS_STANDBY))))))"},

    {"conditional transition — the point of the feature",
     "if pressure(GN2_HIGH) > 4000:\n    transition_to(FUEL_VENT)\nelse:\n    "
     "transition_to(VENT)\n",
     "(seq (if (> (pressure GN2_HIGH) 4000) (seq (goto FUEL_VENT)) (seq (goto VENT))))"},

    {"comments and blank lines carry no structure",
     "# lead-in\n\nopen_valve(FUEL_VENT)   # trailing\n\n\ndelay(1)\n",
     "(seq (open FUEL_VENT) (delay 1))"},

    {"two-space indent is fine as long as it is consistent", "while elapsed() < 5:\n  delay(0.1)\n",
     "(seq (while (< (elapsed) 5) (seq (delay 0.1))))"},

    {"nested blocks",
     "while elapsed() < 10:\n"
     "    if pressure(CHAMBER) > 100:\n"
     "        open_valve(FUEL_VENT)\n"
     "    delay(0.1)\n",
     "(seq (while (< (elapsed) 10) (seq (if (> (pressure CHAMBER) 100) (seq (open FUEL_VENT))) "
     "(delay 0.1))))"},

    // ── The collision cases that make positional resolution necessary ────────────────────────
    {"FUEL_VENT resolves as a valve and as a state in the same script",
     "open_valve(FUEL_VENT)\ndelay(0.5)\nclose_valve(FUEL_VENT)\ntransition_to(FUEL_VENT)\n",
     "(seq (open FUEL_VENT) (delay 0.5) (close FUEL_VENT) (goto FUEL_VENT))"},

    {"FUEL_UPSTREAM resolves as a valve and as a sensor in the same script",
     "if pressure(FUEL_UPSTREAM) > 100:\n    open_valve(FUEL_UPSTREAM)\ndelay(1)\n",
     "(seq (if (> (pressure FUEL_UPSTREAM) 100) (seq (open FUEL_UPSTREAM))) (delay 1))"},

    {"a loop whose every if-arm delays satisfies the delay rule",
     "while elapsed() < 5:\n"
     "    if pressure(CHAMBER) > 100:\n"
     "        delay(0.1)\n"
     "    else:\n"
     "        delay(0.2)\n",
     "(seq (while (< (elapsed) 5) (seq (if (> (pressure CHAMBER) 100) (seq (delay 0.1)) "
     "(seq (delay 0.2))))))"},
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
static const std::vector<Reject> kReject = {
    // Lexer
    {"tab indentation", "while elapsed() < 5:\n\tdelay(1)\n", Diag::TabIndent, 2},
    {"a quoted name", "open_valve(\"Fuel Vent\")\n", Diag::UnexpectedChar, 1},
    {"exponent notation", "delay(1e3)\n", Diag::BadNumber, 1},
    {"two decimal points", "delay(1.2.3)\n", Diag::BadNumber, 1},
    {"stray character", "delay(1) @\n", Diag::UnexpectedChar, 1},
    {"inconsistent indent unit",
     "while elapsed() < 5:\n    delay(1)\nif elapsed() > 1:\n      delay(1)\n", Diag::BadIndentUnit,
     4},
    {"dedent to no enclosing block",
     "while elapsed() < 5:\n    if elapsed() > 1:\n        delay(1)\n  delay(2)\n", Diag::BadDedent,
     4},

    // Parser
    {"missing colon", "while elapsed() < 5\n    delay(1)\n", Diag::ExpectedColon, 1},
    {"unclosed paren", "open_valve(FUEL_VENT\n", Diag::ExpectedRParen, 1},
    {"unknown command", "opne_valve(FUEL_VENT)\n", Diag::UnknownCall, 1},
    {"unknown function in an expression", "x = flowrate(FUEL_VENT)\ndelay(1)\n", Diag::UnknownCall,
     1},
    {"chained comparison", "a = 1\nif 1 < a < 3:\n    delay(1)\n", Diag::ChainedComparison, 2},
    {"pressure() as a bare statement", "pressure(GN2_HIGH)\n", Diag::CallNotAStatement, 1},
    {"assigning to a built-in", "delay = 5\n", Diag::AssignToCall, 1},
    {"a block with no body", "while elapsed() < 5:\ndelay(1)\n", Diag::ExpectedBlock, 2},
    {"elapsed() takes no argument", "x = elapsed(5)\ndelay(1)\n", Diag::ExpectedRParen, 1},
    {"a variable where a valve name belongs", "v = 1\nopen_valve(v)\ndelay(1)\n",
     Diag::UnknownActuator, 2},

    // Caps and bounded-ness
    {"delay(0) is a spin", "delay(0)\n", Diag::DelayNotPositive, 1},
    // -1 must fold to a negative literal, or this check looks straight past Unary(Neg, Number(1))
    // and delay(-1) becomes a clamped 10 ms spin at runtime instead of a refusal at load.
    {"negative delay", "delay(-1)\n", Diag::DelayNotPositive, 1},
    {"loop with no delay", "while elapsed() < 5:\n    open_valve(FUEL_VENT)\n",
     Diag::LoopWithoutDelay, 1},
    {"loop whose if-arm delays but has no else",
     "while elapsed() < 5:\n    if elapsed() > 1:\n        delay(1)\n", Diag::LoopWithoutDelay, 1},
    {"variable read before assignment", "delay(x)\n", Diag::VarUsedBeforeAssign, 1},
    {"division by a literal zero", "x = 1 / 0\ndelay(1)\n", Diag::DivideByZeroLiteral, 1},

    // Config-dependent (validate())
    {"unknown actuator", "open_valve(FUEL_VNT)\ndelay(1)\n", Diag::UnknownActuator, 1},
    {"unknown sensor", "x = pressure(GN2_HIGHH)\ndelay(1)\n", Diag::UnknownSensor, 1},
    {"unknown state", "transition_to(NOWHERE)\n", Diag::UnknownState, 1},
    {"a real state the matrix forbids", "transition_to(FIRE)\n", Diag::TransitionNotAllowed, 1},
    {"variable shadowing a slug", "GN2_HIGH = 1\ndelay(GN2_HIGH)\n", Diag::VarShadowsSlug, 1},
};

/** Parse then validate, returning every diagnostic in one list the way a caller would see them. */
static std::vector<Diagnostic> run(const std::string& src, const SlugTables& t) {
    ParseResult r = parse(src);
    if (!r.ok())
        return r.diagnostics;
    return validate(r.program, t);
}

int main() {
    const SlugTables t = tables();

    std::cout << "── accept ──" << std::endl;
    for (const Accept& a : kAccept) {
        ParseResult r = parse(a.src);
        if (!r.ok()) {
            check(false, std::string(a.name) + " — parse failed: " + r.diagnostics[0].message +
                             " (line " + std::to_string(r.diagnostics[0].line) + ")");
            continue;
        }
        const auto issues = validate(r.program, t);
        if (!issues.empty()) {
            check(false, std::string(a.name) + " — validate failed: " + issues[0].message);
            continue;
        }
        const std::string got = print_canonical(r.program);
        if (got != a.ast) {
            check(false, std::string(a.name) + " — AST shape");
            std::cout << "         want " << a.ast << std::endl;
            std::cout << "         got  " << got << std::endl;
            continue;
        }
        check(true, a.name);
    }

    std::cout << "── reject ──" << std::endl;
    for (const Reject& rj : kReject) {
        const auto issues = run(rj.src, t);
        if (issues.empty()) {
            check(false, std::string(rj.name) + " — accepted, but should have been refused");
            continue;
        }
        const Diagnostic& d = issues[0];
        if (d.code != rj.code) {
            check(false, std::string(rj.name) + " — wrong code: wanted " + diag_name(rj.code) +
                             ", got " + diag_name(d.code) + " (\"" + d.message + "\")");
            continue;
        }
        if (d.line != rj.line) {
            check(false, std::string(rj.name) + " — wrong line: wanted " + std::to_string(rj.line) +
                             ", got " + std::to_string(d.line));
            continue;
        }
        check(true,
              std::string(rj.name) + " -> " + diag_name(d.code) + " @ " + std::to_string(d.line));
    }

    std::cout << "── caps ──" << std::endl;
    {
        std::string deep = "";
        std::string indent = "";
        for (uint32_t i = 0; i <= kMaxNestingDepth; i++) {
            deep += indent + "while elapsed() < 5:\n";
            indent += "    ";
        }
        deep += indent + "delay(1)\n";
        const auto issues = run(deep, t);
        check(!issues.empty() && issues[0].code == Diag::TooDeep,
              "nesting deeper than " + std::to_string(kMaxNestingDepth) + " is refused");
    }
    {
        std::string many;
        for (uint32_t i = 0; i < kMaxLines + 5; i++)
            many += "delay(1)\n";
        const auto issues = run(many, t);
        check(!issues.empty() && issues[0].code == Diag::TooManyLines,
              "more than " + std::to_string(kMaxLines) + " lines is refused");
    }
    {
        std::string big(kMaxSourceBytes + 1, 'x');
        const auto issues = run(big, t);
        check(!issues.empty() && issues[0].code == Diag::ProgramTooLarge,
              "a script over " + std::to_string(kMaxSourceBytes) + " bytes is refused");
    }

    std::cout << "── slugify ──" << std::endl;
    check(slugify("GN2 High") == "GN2_HIGH", "\"GN2 High\" -> GN2_HIGH");
    check(slugify("GSE High Press Control") == "GSE_HIGH_PRESS_CONTROL",
          "\"GSE High Press Control\" -> GSE_HIGH_PRESS_CONTROL");
    check(slugify("  Fuel   Vent  ") == "FUEL_VENT", "whitespace is trimmed and collapsed");
    check(slugify("Chamber Mid PT 1") == "CHAMBER_MID_PT_1", "digits survive");
    check(is_valid_slug("GN2_HIGH"), "GN2_HIGH is a valid slug");
    check(!is_valid_slug("2COLD"), "a slug may not start with a digit");
    check(!is_valid_slug("FUEL-VENT"), "a punctuated name is refused rather than mangled");
    check(!is_valid_slug(""), "an empty slug is refused");

    std::cout << "── diagnostics are useful ──" << std::endl;
    {
        const auto issues = run("open_valve(FUEL_VNT)\ndelay(1)\n", t);
        check(!issues.empty() && issues[0].message.find("FUEL_VENT") != std::string::npos,
              "a near-miss actuator name suggests the real one");
    }
    {
        // An empty script is structurally fine. It is the config layer's job to decide whether a
        // state may have one, not the parser's.
        ParseResult r = parse("");
        check(r.ok() && r.program.empty(), "an empty script parses to an empty program");
    }

    std::cout << (g_failures == 0 ? "\nAll state-script checks passed.\n"
                                  : "\nFAILURES: " + std::to_string(g_failures) + "\n");
    return g_failures == 0 ? 0 : 1;
}
