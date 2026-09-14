#pragma once

#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

/**
 * The state-script language: a small Python-looking language an operator writes in the config UI,
 * which the sequencer runs on entry to a dynamic state.
 *
 * ── What this is, and what it deliberately is not ─────────────────────────────────────────────
 *
 * A script never becomes a C++ function. It is parsed once, at sequencer startup, into the flat
 * arena below, and an interpreter walks that arena. There is no code generation, no dlopen, no
 * eval, and no compiler anywhere near the stand.
 *
 * That is not merely the easier option, it is the correct one. Because the program is data being
 * walked, the runner can check a stop flag, a wall deadline and an iteration budget between any
 * two statements — which is what lets an abort preempt a running script at a known boundary and
 * what makes a runaway loop bounded. Compiled code offers no such seam.
 *
 * ── Names are slugs, resolved positionally ───────────────────────────────────────────────────
 *
 * `open_valve(GSE_HIGH_PRESS_CONTROL)`, not `open_valve("GSE High Press Control")`. The slug is
 * the canonical config name uppercased with whitespace collapsed to underscores.
 *
 * The namespace comes from the ARGUMENT SLOT, never from the name itself: the argument of
 * open_valve/close_valve is an actuator role, of pressure() a PT sensor role, of transition_to()
 * a state. An identifier anywhere else is a variable.
 *
 * That is not a style choice. On the shipped `server` profile FUEL_PRESS and FUEL_VENT are each
 * BOTH a valve and a state, and on `digital-twin` FUEL_UPSTREAM is both a valve and a PT sensor.
 * A flat namespace would be ambiguous against config that exists today. Positional resolution
 * also means collisions WITHIN a namespace are an error while collisions ACROSS namespaces are
 * fine and expected — a blanket collision rule would refuse this rig's live config.
 *
 * ── Everything checkable at parse time is checked at parse time ──────────────────────────────
 *
 * A script that cannot be proven bounded, or that names something config does not define, is
 * refused at load. The state then never becomes enterable, so the failure is an unavailable
 * button rather than a valve opening on a script that was going to fail anyway.
 */
namespace fsw {
namespace script {

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resource caps
//
// These bound the program, not the rig. The rig's bound is the per-state script_timeout_ms, which
// is mandatory and enforced separately. These exist so that an unbounded script is refused before
// it can run at all, rather than discovered mid-run with a valve open.
// ─────────────────────────────────────────────────────────────────────────────────────────────
inline constexpr size_t kMaxSourceBytes = 4096;
inline constexpr uint32_t kMaxLines = 200;
inline constexpr uint32_t kMaxStatements = 500;
inline constexpr uint32_t kMaxNestingDepth = 8;
inline constexpr uint32_t kMaxVariables = 32;
inline constexpr uint32_t kMaxExprDepth = 32;
/** Widest indent unit accepted. The first indented line sets the unit; every later indent must be
 *  an exact multiple of it, which kills "3 spaces here, 4 there" without a stack of columns. */
inline constexpr uint32_t kMaxIndentUnit = 8;

/** Which table a slug is resolved against. Determined by argument position, never by spelling. */
enum class Ns : uint8_t {
    Actuator,  // open_valve / close_valve
    PtSensor,  // pressure
    State,     // transition_to
};

const char* ns_name(Ns ns);

/** One slug reference, with its source span so a rename can rewrite exactly this token. */
struct SlugRef {
    std::string slug;
    Ns ns = Ns::Actuator;
    uint32_t line = 0;  // 1-based
    uint32_t col = 0;   // 1-based
    uint32_t len = 0;
};

enum class StmtKind : uint8_t {
    Assign,
    OpenValve,
    CloseValve,
    Delay,
    TransitionTo,
    If,
    While,
};

enum class ExprKind : uint8_t {
    Number,
    Var,
    Pressure,
    Elapsed,
    Unary,   // op: Neg, Not
    Binary,  // op: arithmetic, comparison, And, Or
};

enum class Op : uint8_t {
    Neg,
    Not,
    Add,
    Sub,
    Mul,
    Div,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    And,
    Or,
};

const char* op_name(Op op);

struct Stmt {
    StmtKind kind = StmtKind::Delay;
    uint32_t line = 0;
    uint32_t col = 0;
    /** Assign: index into ScriptProgram::variables. */
    int32_t var = -1;
    /** Assign value, Delay seconds, If/While condition. Index into ScriptProgram::exprs. */
    int32_t expr = -1;
    /** OpenValve/CloseValve/TransitionTo target. Index into ScriptProgram::slugs. */
    int32_t slug = -1;
    /** If/While body, and If's else arm: [begin, end) into ScriptProgram::block_items. */
    int32_t body_begin = -1;
    int32_t body_end = -1;
    int32_t else_begin = -1;
    int32_t else_end = -1;
};

struct Expr {
    ExprKind kind = ExprKind::Number;
    uint32_t line = 0;
    uint32_t col = 0;
    double number = 0.0;  // Number
    int32_t var = -1;     // Var -> variables index
    int32_t slug = -1;    // Pressure -> slugs index
    Op op = Op::Add;      // Unary / Binary
    int32_t lhs = -1;
    int32_t rhs = -1;  // Binary only
};

/**
 * A parsed script, as a flat arena.
 *
 * Children are int32_t indices, never pointers, and -1 means none. This is deliberate: the whole
 * program copies by value into ScriptRunner::start() with no ownership question — matching
 * HoldSpec's "a number that is passed in cannot go stale" discipline — and every size cap becomes
 * a vector size check rather than a tree walk.
 */
struct ScriptProgram {
    std::vector<Stmt> stmts;
    std::vector<Expr> exprs;
    /** Statement indices, grouped into contiguous [begin, end) block ranges. */
    std::vector<int32_t> block_items;
    int32_t top_begin = 0;
    int32_t top_end = 0;
    /** Every slug reference in SOURCE ORDER, with spans. The rename path rewrites these; the
     *  pressure subscriber derives its subscribe list from the Ns::PtSensor ones. */
    std::vector<SlugRef> slugs;
    std::vector<std::string> variables;
    uint32_t max_depth = 0;

    bool empty() const {
        return top_begin == top_end;
    }
};

/**
 * Diagnostic codes.
 *
 * Tests and the shared corpus assert on the CODE and the LINE, never the message text, so wording
 * can improve without churning them.
 */
enum class Diag : uint16_t {
    // Lexer
    TabIndent = 1,
    BadIndentUnit,
    BadDedent,
    UnexpectedIndent,
    UnexpectedChar,
    BadNumber,
    // Parser
    ExpectedColon,
    ExpectedLParen,
    ExpectedRParen,
    ExpectedNewline,
    ExpectedName,
    ExpectedExpr,
    ExpectedBlock,
    UnknownCall,
    ChainedComparison,
    CallNotAStatement,
    AssignToCall,
    // Caps
    ProgramTooLarge,
    TooManyLines,
    TooDeep,
    TooManyStatements,
    TooManyVariables,
    ExprTooDeep,
    // Semantics provable without config
    DelayNotPositive,
    LoopWithoutDelay,
    VarUsedBeforeAssign,
    DivideByZeroLiteral,
    // Semantics needing config (validate())
    UnknownActuator,
    UnknownSensor,
    UnknownState,
    TransitionNotAllowed,
    VarShadowsSlug,
};

const char* diag_name(Diag d);

struct Diagnostic {
    Diag code = Diag::UnexpectedChar;
    uint32_t line = 0;  // 1-based
    uint32_t col = 0;   // 1-based
    /** Human wording, including the offending text. Never asserted on by tests. */
    std::string message;
};

struct ParseResult {
    ScriptProgram program;
    std::vector<Diagnostic> diagnostics;

    bool ok() const {
        return diagnostics.empty();
    }
};

/**
 * Lex and parse, applying every check that does not need config.
 *
 * Stops at the first error rather than attempting recovery: this is a 200-line config language
 * written a few lines at a time, and a cascade of speculative follow-on errors would bury the one
 * that matters.
 */
ParseResult parse(const std::string& source);

/**
 * What a script's slugs are allowed to name, built from the loaded config.
 *
 * Maps rather than sets so a diagnostic can name the canonical spelling a slug resolves to, which
 * is what the operator sees elsewhere in the UI.
 */
struct SlugTables {
    std::map<std::string, std::string> actuators;  // slug -> canonical name
    std::map<std::string, std::string> sensors;
    std::map<std::string, std::string> states;
    /** State slugs reachable from the state that owns this script, per state_transitions.csv.
     *  Every transition_to target is checked against this — not just the configured fallbacks —
     *  because a script that runs 25 s and THEN cannot leave is worse than one that never starts.
     */
    std::set<std::string> allowed_transitions;
};

/** Config-dependent checks. Run after a successful parse; returns empty when the script is good. */
std::vector<Diagnostic> validate(const ScriptProgram& program, const SlugTables& tables);

/**
 * Canonical name -> slug: trim, uppercase, collapse internal whitespace runs to a single '_'.
 *
 * The same rule the TS side already uses for sensor entity names
 * (backend/src/sensor-config.ts:104), so the two agree by construction.
 */
std::string slugify(const std::string& name);

/** True when a slug is usable as a bare identifier: ^[A-Z][A-Z0-9_]*$. */
bool is_valid_slug(const std::string& slug);

/**
 * A stable s-expression rendering of the parsed program.
 *
 * This exists for the conformance corpus. Two implementations can agree that a script is
 * "accepted" while disagreeing about precedence — `a - b - c`, `not a and b`, `-x * y` — and a
 * precedence disagreement between the validator the operator sees and the interpreter that opens
 * the valve is the worst bug this feature can have. Pinning the shape catches it.
 */
std::string print_canonical(const ScriptProgram& program);

}  // namespace script
}  // namespace fsw
