#include <algorithm>
#include <set>

#include "Lexer.hpp"
#include "script/StateScript.hpp"

namespace fsw {
namespace script {

const char* ns_name(Ns ns) {
    switch (ns) {
        case Ns::Actuator:
            return "actuator";
        case Ns::PtSensor:
            return "sensor";
        case Ns::State:
            return "state";
    }
    return "?";
}

const char* op_name(Op op) {
    switch (op) {
        case Op::Neg:
            return "neg";
        case Op::Not:
            return "not";
        case Op::Add:
            return "+";
        case Op::Sub:
            return "-";
        case Op::Mul:
            return "*";
        case Op::Div:
            return "/";
        case Op::Lt:
            return "<";
        case Op::Le:
            return "<=";
        case Op::Gt:
            return ">";
        case Op::Ge:
            return ">=";
        case Op::Eq:
            return "==";
        case Op::Ne:
            return "!=";
        case Op::And:
            return "and";
        case Op::Or:
            return "or";
    }
    return "?";
}

const char* diag_name(Diag d) {
    switch (d) {
        case Diag::TabIndent:
            return "E_TAB_INDENT";
        case Diag::BadIndentUnit:
            return "E_BAD_INDENT_UNIT";
        case Diag::BadDedent:
            return "E_BAD_DEDENT";
        case Diag::UnexpectedIndent:
            return "E_UNEXPECTED_INDENT";
        case Diag::UnexpectedChar:
            return "E_UNEXPECTED_CHAR";
        case Diag::BadNumber:
            return "E_BAD_NUMBER";
        case Diag::ExpectedColon:
            return "E_EXPECTED_COLON";
        case Diag::ExpectedLParen:
            return "E_EXPECTED_LPAREN";
        case Diag::ExpectedRParen:
            return "E_EXPECTED_RPAREN";
        case Diag::ExpectedNewline:
            return "E_EXPECTED_NEWLINE";
        case Diag::ExpectedName:
            return "E_EXPECTED_NAME";
        case Diag::ExpectedExpr:
            return "E_EXPECTED_EXPR";
        case Diag::ExpectedBlock:
            return "E_EXPECTED_BLOCK";
        case Diag::UnknownCall:
            return "E_UNKNOWN_CALL";
        case Diag::ChainedComparison:
            return "E_CHAINED_COMPARISON";
        case Diag::CallNotAStatement:
            return "E_CALL_NOT_A_STATEMENT";
        case Diag::AssignToCall:
            return "E_ASSIGN_TO_CALL";
        case Diag::ProgramTooLarge:
            return "E_PROGRAM_TOO_LARGE";
        case Diag::TooManyLines:
            return "E_TOO_MANY_LINES";
        case Diag::TooDeep:
            return "E_TOO_DEEP";
        case Diag::TooManyStatements:
            return "E_TOO_MANY_STATEMENTS";
        case Diag::TooManyVariables:
            return "E_TOO_MANY_VARIABLES";
        case Diag::ExprTooDeep:
            return "E_EXPR_TOO_DEEP";
        case Diag::DelayNotPositive:
            return "E_DELAY_NOT_POSITIVE";
        case Diag::LoopWithoutDelay:
            return "E_LOOP_WITHOUT_DELAY";
        case Diag::VarUsedBeforeAssign:
            return "E_VAR_USED_BEFORE_ASSIGN";
        case Diag::DivideByZeroLiteral:
            return "E_DIVIDE_BY_ZERO_LITERAL";
        case Diag::UnknownActuator:
            return "E_UNKNOWN_ACTUATOR";
        case Diag::UnknownSensor:
            return "E_UNKNOWN_SENSOR";
        case Diag::UnknownState:
            return "E_UNKNOWN_STATE";
        case Diag::TransitionNotAllowed:
            return "E_TRANSITION_NOT_ALLOWED";
        case Diag::VarShadowsSlug:
            return "E_VAR_SHADOWS_SLUG";
    }
    return "E_UNKNOWN";
}

namespace {

/** The builtin call names. A bare Ident in call position that is not one of these is refused, so a
 *  typo becomes an error rather than a silently ignored statement. */
constexpr const char* kOpenValve = "open_valve";
constexpr const char* kCloseValve = "close_valve";
constexpr const char* kDelay = "delay";
constexpr const char* kTransitionTo = "transition_to";
constexpr const char* kPressure = "pressure";
constexpr const char* kElapsed = "elapsed";

bool isBuiltin(const std::string& s) {
    return s == kOpenValve || s == kCloseValve || s == kDelay || s == kTransitionTo ||
           s == kPressure || s == kElapsed;
}

struct Parser {
    const std::vector<Token>& toks;
    ParseResult out;
    size_t p = 0;
    bool failed = false;
    uint32_t depth = 0;
    /** Variables assigned somewhere at or before the current point, for use-before-assign.
     *  Deliberately flow-insensitive: a variable first assigned inside an `if` counts as assigned
     *  afterwards. Being stricter would reject readable scripts; being looser would let a NaN
     *  reach a comparison that decides whether a valve opens. */
    std::set<std::string> assigned;

    explicit Parser(const std::vector<Token>& t) : toks(t) {
    }

    const Token& cur() const {
        return toks[std::min(p, toks.size() - 1)];
    }
    bool at(Tok k) const {
        return cur().kind == k;
    }
    const Token& advance() {
        const Token& t = toks[std::min(p, toks.size() - 1)];
        if (p < toks.size() - 1)
            p++;
        return t;
    }

    void fail(Diag code, const Token& t, std::string msg) {
        if (failed)
            return;
        failed = true;
        out.diagnostics.push_back({code, t.line, t.col, std::move(msg)});
    }

    bool expect(Tok k, Diag code, const char* what) {
        if (at(k)) {
            advance();
            return true;
        }
        fail(code, cur(), std::string("expected ") + what + ", found " + tok_name(cur().kind));
        return false;
    }

    int32_t addExpr(Expr e) {
        out.program.exprs.push_back(e);
        return static_cast<int32_t>(out.program.exprs.size() - 1);
    }
    int32_t addStmt(Stmt s) {
        out.program.stmts.push_back(s);
        return static_cast<int32_t>(out.program.stmts.size() - 1);
    }
    int32_t internVar(const std::string& name) {
        auto& v = out.program.variables;
        for (size_t k = 0; k < v.size(); k++)
            if (v[k] == name)
                return static_cast<int32_t>(k);
        v.push_back(name);
        return static_cast<int32_t>(v.size() - 1);
    }
    int32_t addSlug(const Token& t, Ns ns) {
        out.program.slugs.push_back(SlugRef{t.text, ns, t.line, t.col, t.len});
        return static_cast<int32_t>(out.program.slugs.size() - 1);
    }

    // ── Statements ───────────────────────────────────────────────────────────────────────────

    /** Parse statements until DEDENT/EOF, appending indices to block_items; returns [begin,end). */
    std::pair<int32_t, int32_t> parseBlockBody() {
        std::vector<int32_t> items;
        while (!failed && !at(Tok::Dedent) && !at(Tok::Eof)) {
            const int32_t s = parseStatement();
            if (failed)
                break;
            items.push_back(s);
        }
        if (failed)
            return {0, 0};
        auto& bi = out.program.block_items;
        const int32_t begin = static_cast<int32_t>(bi.size());
        bi.insert(bi.end(), items.begin(), items.end());
        return {begin, static_cast<int32_t>(bi.size())};
    }

    /** `: NEWLINE INDENT stmt+ DEDENT` */
    std::pair<int32_t, int32_t> parseIndentedBlock() {
        if (!expect(Tok::Colon, Diag::ExpectedColon, "':'"))
            return {0, 0};
        if (!expect(Tok::Newline, Diag::ExpectedNewline, "a line break after ':'"))
            return {0, 0};
        if (!at(Tok::Indent)) {
            fail(Diag::ExpectedBlock, cur(), "expected an indented block after ':'");
            return {0, 0};
        }
        advance();  // INDENT
        depth++;
        out.program.max_depth = std::max(out.program.max_depth, depth);
        if (depth > kMaxNestingDepth) {
            fail(Diag::TooDeep, cur(),
                 "nested " + std::to_string(depth) + " deep; the limit is " +
                     std::to_string(kMaxNestingDepth));
            return {0, 0};
        }
        const auto range = parseBlockBody();
        if (failed)
            return {0, 0};
        depth--;
        if (!at(Tok::Dedent)) {
            fail(Diag::ExpectedBlock, cur(), "block did not close as expected");
            return {0, 0};
        }
        advance();  // DEDENT
        if (range.first == range.second) {
            fail(Diag::ExpectedBlock, cur(),
                 "an indented block must contain at least one statement");
            return {0, 0};
        }
        return range;
    }

    int32_t parseStatement() {
        if (out.program.stmts.size() >= kMaxStatements) {
            fail(Diag::TooManyStatements, cur(),
                 "more than " + std::to_string(kMaxStatements) + " statements");
            return -1;
        }
        if (at(Tok::KwIf))
            return parseIf();
        if (at(Tok::KwWhile))
            return parseWhile();
        if (at(Tok::Indent)) {
            fail(Diag::UnexpectedIndent, cur(), "unexpected indent — nothing here opens a block");
            return -1;
        }
        return parseSimple();
    }

    int32_t parseIf() {
        const Token kw = advance();  // if / elif
        const int32_t cond = parseExpr();
        if (failed)
            return -1;
        const auto body = parseIndentedBlock();
        if (failed)
            return -1;

        Stmt s;
        s.kind = StmtKind::If;
        s.line = kw.line;
        s.col = kw.col;
        s.expr = cond;
        s.body_begin = body.first;
        s.body_end = body.second;

        // `elif` desugars to an else arm holding a single nested If, so the interpreter has one
        // shape to walk rather than a chain it has to special-case.
        if (at(Tok::KwElif)) {
            const int32_t nested = parseIf();
            if (failed)
                return -1;
            auto& bi = out.program.block_items;
            const int32_t begin = static_cast<int32_t>(bi.size());
            bi.push_back(nested);
            s.else_begin = begin;
            s.else_end = static_cast<int32_t>(bi.size());
        } else if (at(Tok::KwElse)) {
            advance();
            const auto els = parseIndentedBlock();
            if (failed)
                return -1;
            s.else_begin = els.first;
            s.else_end = els.second;
        }
        return addStmt(s);
    }

    int32_t parseWhile() {
        const Token kw = advance();
        const int32_t cond = parseExpr();
        if (failed)
            return -1;
        const auto body = parseIndentedBlock();
        if (failed)
            return -1;

        Stmt s;
        s.kind = StmtKind::While;
        s.line = kw.line;
        s.col = kw.col;
        s.expr = cond;
        s.body_begin = body.first;
        s.body_end = body.second;
        const int32_t idx = addStmt(s);

        // A loop body with no delay() on ANY path is a busy-wait. Refusing it at parse time makes
        // a spin unrepresentable rather than something the iteration budget has to catch at
        // runtime with a valve already open — and it is trivially explainable to an operator: a
        // loop has to wait for something.
        if (!blockHasDelay(body.first, body.second)) {
            fail(Diag::LoopWithoutDelay, kw,
                 "this loop's body never calls delay() — add one (e.g. delay(0.05)) so the loop "
                 "waits rather than spinning, and so its poll rate is visible where it is read");
            return -1;
        }
        return idx;
    }

    bool blockHasDelay(int32_t begin, int32_t end) const {
        for (int32_t k = begin; k < end; k++) {
            const Stmt& s = out.program.stmts[out.program.block_items[k]];
            if (s.kind == StmtKind::Delay)
                return true;
            // A nested `while` must itself contain a delay (checked when it was parsed), so it
            // counts. An `if` only counts when EVERY arm delays — an else-less if does not.
            if (s.kind == StmtKind::While)
                return true;
            if (s.kind == StmtKind::If) {
                const bool then_ok = blockHasDelay(s.body_begin, s.body_end);
                const bool has_else = s.else_begin >= 0;
                const bool else_ok = has_else && blockHasDelay(s.else_begin, s.else_end);
                if (then_ok && else_ok)
                    return true;
            }
        }
        return false;
    }

    int32_t parseSimple() {
        if (!at(Tok::Ident)) {
            fail(Diag::ExpectedName, cur(),
                 std::string("expected a statement, found ") + tok_name(cur().kind));
            return -1;
        }
        const Token name = advance();

        if (at(Tok::Assign)) {
            if (isBuiltin(name.text)) {
                fail(Diag::AssignToCall, name,
                     "'" + name.text + "' is a built-in and cannot be assigned to");
                return -1;
            }
            advance();
            const int32_t value = parseExpr();
            if (failed)
                return -1;
            if (!expect(Tok::Newline, Diag::ExpectedNewline, "a line break"))
                return -1;
            if (out.program.variables.size() >= kMaxVariables &&
                std::find(out.program.variables.begin(), out.program.variables.end(), name.text) ==
                    out.program.variables.end()) {
                fail(Diag::TooManyVariables, name,
                     "more than " + std::to_string(kMaxVariables) + " variables");
                return -1;
            }
            Stmt s;
            s.kind = StmtKind::Assign;
            s.line = name.line;
            s.col = name.col;
            s.var = internVar(name.text);
            s.expr = value;
            assigned.insert(name.text);
            return addStmt(s);
        }

        if (!at(Tok::LParen)) {
            fail(Diag::ExpectedLParen, cur(),
                 "expected '=' or '(' after '" + name.text + "', found " + tok_name(cur().kind));
            return -1;
        }

        StmtKind kind;
        Ns ns;
        if (name.text == kOpenValve) {
            kind = StmtKind::OpenValve;
            ns = Ns::Actuator;
        } else if (name.text == kCloseValve) {
            kind = StmtKind::CloseValve;
            ns = Ns::Actuator;
        } else if (name.text == kTransitionTo) {
            kind = StmtKind::TransitionTo;
            ns = Ns::State;
        } else if (name.text == kDelay) {
            return parseDelay(name);
        } else if (name.text == kPressure || name.text == kElapsed) {
            fail(Diag::CallNotAStatement, name,
                 "'" + name.text + "' produces a value and cannot stand alone as a statement");
            return -1;
        } else {
            fail(Diag::UnknownCall, name,
                 "unknown command '" + name.text +
                     "' — the commands are open_valve, close_valve, delay and transition_to");
            return -1;
        }

        advance();  // '('
        if (!at(Tok::Ident)) {
            fail(Diag::ExpectedName, cur(),
                 std::string("expected a bare ") + ns_name(ns) + " name here (e.g. " +
                     (ns == Ns::State ? "PRESS_STANDBY" : "FUEL_VENT") + "), found " +
                     tok_name(cur().kind));
            return -1;
        }
        const Token slug = advance();
        if (isBuiltin(slug.text)) {
            fail(Diag::ExpectedName, slug, "'" + slug.text + "' is a built-in, not a name");
            return -1;
        }
        if (!expect(Tok::RParen, Diag::ExpectedRParen, "')'"))
            return -1;
        if (!expect(Tok::Newline, Diag::ExpectedNewline, "a line break"))
            return -1;

        Stmt s;
        s.kind = kind;
        s.line = name.line;
        s.col = name.col;
        s.slug = addSlug(slug, ns);
        return addStmt(s);
    }

    int32_t parseDelay(const Token& name) {
        advance();  // '('
        const int32_t e = parseExpr();
        if (failed)
            return -1;
        if (!expect(Tok::RParen, Diag::ExpectedRParen, "')'"))
            return -1;
        if (!expect(Tok::Newline, Diag::ExpectedNewline, "a line break"))
            return -1;

        // A literal, non-positive delay is a spin the iteration budget would have to catch at
        // runtime. It is knowable now, so it is refused now.
        const Expr& ex = out.program.exprs[e];
        if (ex.kind == ExprKind::Number && !(ex.number > 0.0)) {
            fail(Diag::DelayNotPositive, name,
                 "delay(" + std::to_string(ex.number) +
                     ") — a delay must be a positive number of "
                     "seconds");
            return -1;
        }

        Stmt s;
        s.kind = StmtKind::Delay;
        s.line = name.line;
        s.col = name.col;
        s.expr = e;
        return addStmt(s);
    }

    // ── Expressions ──────────────────────────────────────────────────────────────────────────

    uint32_t edepth = 0;
    struct EDepth {
        Parser& p;
        explicit EDepth(Parser& pp) : p(pp) {
            p.edepth++;
        }
        ~EDepth() {
            p.edepth--;
        }
    };

    int32_t parseExpr() {
        EDepth g(*this);
        if (edepth > kMaxExprDepth) {
            fail(Diag::ExprTooDeep, cur(),
                 "expression nested deeper than " + std::to_string(kMaxExprDepth));
            return -1;
        }
        return parseOr();
    }

    int32_t parseOr() {
        int32_t lhs = parseAnd();
        while (!failed && at(Tok::KwOr)) {
            const Token t = advance();
            const int32_t rhs = parseAnd();
            if (failed)
                return -1;
            Expr e;
            e.kind = ExprKind::Binary;
            e.op = Op::Or;
            e.lhs = lhs;
            e.rhs = rhs;
            e.line = t.line;
            e.col = t.col;
            lhs = addExpr(e);
        }
        return lhs;
    }

    int32_t parseAnd() {
        int32_t lhs = parseNot();
        while (!failed && at(Tok::KwAnd)) {
            const Token t = advance();
            const int32_t rhs = parseNot();
            if (failed)
                return -1;
            Expr e;
            e.kind = ExprKind::Binary;
            e.op = Op::And;
            e.lhs = lhs;
            e.rhs = rhs;
            e.line = t.line;
            e.col = t.col;
            lhs = addExpr(e);
        }
        return lhs;
    }

    int32_t parseNot() {
        if (at(Tok::KwNot)) {
            const Token t = advance();
            const int32_t operand = parseNot();
            if (failed)
                return -1;
            Expr e;
            e.kind = ExprKind::Unary;
            e.op = Op::Not;
            e.lhs = operand;
            e.line = t.line;
            e.col = t.col;
            return addExpr(e);
        }
        return parseComparison();
    }

    int32_t parseComparison() {
        const int32_t lhs = parseSum();
        if (failed)
            return -1;
        Op op;
        switch (cur().kind) {
            case Tok::Lt:
                op = Op::Lt;
                break;
            case Tok::Le:
                op = Op::Le;
                break;
            case Tok::Gt:
                op = Op::Gt;
                break;
            case Tok::Ge:
                op = Op::Ge;
                break;
            case Tok::EqEq:
                op = Op::Eq;
                break;
            case Tok::Ne:
                op = Op::Ne;
                break;
            default:
                return lhs;
        }
        const Token t = advance();
        const int32_t rhs = parseSum();
        if (failed)
            return -1;

        // Non-associative on purpose. Python would read `a < b < c` as a chained comparison, which
        // almost nobody reading a pressure condition under time pressure expects. Refuse it.
        switch (cur().kind) {
            case Tok::Lt:
            case Tok::Le:
            case Tok::Gt:
            case Tok::Ge:
            case Tok::EqEq:
            case Tok::Ne:
                fail(Diag::ChainedComparison, cur(),
                     "two comparisons in a row — write it as a and b, e.g. "
                     "(x > 100) and (x < 200)");
                return -1;
            default:
                break;
        }

        Expr e;
        e.kind = ExprKind::Binary;
        e.op = op;
        e.lhs = lhs;
        e.rhs = rhs;
        e.line = t.line;
        e.col = t.col;
        return addExpr(e);
    }

    int32_t parseSum() {
        int32_t lhs = parseTerm();
        while (!failed && (at(Tok::Plus) || at(Tok::Minus))) {
            const Op op = at(Tok::Plus) ? Op::Add : Op::Sub;
            const Token t = advance();
            const int32_t rhs = parseTerm();
            if (failed)
                return -1;
            Expr e;
            e.kind = ExprKind::Binary;
            e.op = op;
            e.lhs = lhs;
            e.rhs = rhs;
            e.line = t.line;
            e.col = t.col;
            lhs = addExpr(e);
        }
        return lhs;
    }

    int32_t parseTerm() {
        int32_t lhs = parseUnary();
        while (!failed && (at(Tok::Star) || at(Tok::Slash))) {
            const bool is_div = at(Tok::Slash);
            const Token t = advance();
            const int32_t rhs = parseUnary();
            if (failed)
                return -1;
            if (is_div) {
                const Expr& r = out.program.exprs[rhs];
                if (r.kind == ExprKind::Number && r.number == 0.0) {
                    fail(Diag::DivideByZeroLiteral, t, "division by a literal zero");
                    return -1;
                }
            }
            Expr e;
            e.kind = ExprKind::Binary;
            e.op = is_div ? Op::Div : Op::Mul;
            e.lhs = lhs;
            e.rhs = rhs;
            e.line = t.line;
            e.col = t.col;
            lhs = addExpr(e);
        }
        return lhs;
    }

    int32_t parseUnary() {
        if (at(Tok::Minus)) {
            const Token t = advance();
            const int32_t operand = parseUnary();
            if (failed)
                return -1;
            // Fold a negated literal into a negative literal. Without this, -1 is
            // Unary(Neg, Number(1)) and every "is this a non-positive constant?" check — delay()'s
            // especially — looks straight past it, so delay(-1) parsed clean and only turned into a
            // clamped 10 ms spin at runtime. A negative literal is knowable here, so it is folded
            // here. Only literals fold: `-x` stays Unary(Neg, Var x).
            if (operand >= 0 &&
                out.program.exprs[static_cast<size_t>(operand)].kind == ExprKind::Number) {
                Expr n = out.program.exprs[static_cast<size_t>(operand)];
                n.number = -n.number;
                n.line = t.line;
                n.col = t.col;
                if (static_cast<size_t>(operand) + 1 == out.program.exprs.size())
                    out.program.exprs.pop_back();  // the un-negated literal has no other referent
                return addExpr(n);
            }
            Expr e;
            e.kind = ExprKind::Unary;
            e.op = Op::Neg;
            e.lhs = operand;
            e.line = t.line;
            e.col = t.col;
            return addExpr(e);
        }
        return parsePrimary();
    }

    int32_t parsePrimary() {
        EDepth g(*this);
        if (edepth > kMaxExprDepth) {
            fail(Diag::ExprTooDeep, cur(),
                 "expression nested deeper than " + std::to_string(kMaxExprDepth));
            return -1;
        }
        if (at(Tok::Number)) {
            const Token t = advance();
            Expr e;
            e.kind = ExprKind::Number;
            e.number = t.number;
            e.line = t.line;
            e.col = t.col;
            return addExpr(e);
        }
        if (at(Tok::LParen)) {
            advance();
            const int32_t inner = parseExpr();
            if (failed)
                return -1;
            if (!expect(Tok::RParen, Diag::ExpectedRParen, "')'"))
                return -1;
            return inner;
        }
        if (at(Tok::Ident)) {
            const Token t = advance();
            if (t.text == kPressure) {
                if (!expect(Tok::LParen, Diag::ExpectedLParen, "'(' after pressure"))
                    return -1;
                if (!at(Tok::Ident)) {
                    fail(Diag::ExpectedName, cur(),
                         std::string("expected a bare sensor name (e.g. GN2_HIGH), found ") +
                             tok_name(cur().kind));
                    return -1;
                }
                const Token slug = advance();
                if (!expect(Tok::RParen, Diag::ExpectedRParen, "')'"))
                    return -1;
                Expr e;
                e.kind = ExprKind::Pressure;
                e.slug = addSlug(slug, Ns::PtSensor);
                e.line = t.line;
                e.col = t.col;
                return addExpr(e);
            }
            if (t.text == kElapsed) {
                if (!expect(Tok::LParen, Diag::ExpectedLParen, "'(' after elapsed"))
                    return -1;
                if (!expect(Tok::RParen, Diag::ExpectedRParen,
                            "')' — elapsed() takes no arguments"))
                    return -1;
                Expr e;
                e.kind = ExprKind::Elapsed;
                e.line = t.line;
                e.col = t.col;
                return addExpr(e);
            }
            if (isBuiltin(t.text)) {
                fail(Diag::CallNotAStatement, t,
                     "'" + t.text +
                         "' does not produce a value and cannot appear in an expression");
                return -1;
            }
            if (at(Tok::LParen)) {
                fail(Diag::UnknownCall, t,
                     "unknown function '" + t.text +
                         "' — the value-producing built-ins are pressure() and elapsed()");
                return -1;
            }
            if (assigned.count(t.text) == 0) {
                fail(Diag::VarUsedBeforeAssign, t,
                     "'" + t.text + "' is read before it is ever assigned");
                return -1;
            }
            Expr e;
            e.kind = ExprKind::Var;
            e.var = internVar(t.text);
            e.line = t.line;
            e.col = t.col;
            return addExpr(e);
        }
        fail(Diag::ExpectedExpr, cur(),
             std::string("expected a value, found ") + tok_name(cur().kind));
        return -1;
    }

    void run() {
        while (!failed && at(Tok::Newline))
            advance();
        const auto range = parseBlockBody();
        if (failed)
            return;
        if (!at(Tok::Eof)) {
            fail(Diag::ExpectedNewline, cur(),
                 std::string("unexpected ") + tok_name(cur().kind) +
                     " after the end of the script");
            return;
        }
        out.program.top_begin = range.first;
        out.program.top_end = range.second;
    }
};

}  // namespace

ParseResult parse(const std::string& source) {
    ParseResult result;
    LexResult lx = lex(source);
    if (!lx.ok()) {
        result.diagnostics = std::move(lx.diagnostics);
        return result;
    }
    Parser ps(lx.tokens);
    ps.run();
    return std::move(ps.out);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Canonical printer — the conformance corpus's shape check.
// ─────────────────────────────────────────────────────────────────────────────────────────────
namespace {

void printExpr(const ScriptProgram& p, int32_t idx, std::string& out) {
    if (idx < 0) {
        out += "?";
        return;
    }
    const Expr& e = p.exprs[static_cast<size_t>(idx)];
    switch (e.kind) {
        case ExprKind::Number: {
            // Trim a trailing ".000000" so 0.5 prints as 0.5 and 2 prints as 2.
            std::string s = std::to_string(e.number);
            while (s.size() > 1 && s.back() == '0')
                s.pop_back();
            if (!s.empty() && s.back() == '.')
                s.pop_back();
            out += s;
            break;
        }
        case ExprKind::Var:
            out += p.variables[static_cast<size_t>(e.var)];
            break;
        case ExprKind::Pressure:
            out += "(pressure " + p.slugs[static_cast<size_t>(e.slug)].slug + ")";
            break;
        case ExprKind::Elapsed:
            out += "(elapsed)";
            break;
        case ExprKind::Unary:
            out += std::string("(") + op_name(e.op) + " ";
            printExpr(p, e.lhs, out);
            out += ")";
            break;
        case ExprKind::Binary:
            out += std::string("(") + op_name(e.op) + " ";
            printExpr(p, e.lhs, out);
            out += " ";
            printExpr(p, e.rhs, out);
            out += ")";
            break;
    }
}

void printBlock(const ScriptProgram& p, int32_t begin, int32_t end, std::string& out);

void printStmt(const ScriptProgram& p, int32_t idx, std::string& out) {
    const Stmt& s = p.stmts[static_cast<size_t>(idx)];
    switch (s.kind) {
        case StmtKind::Assign:
            out += "(set " + p.variables[static_cast<size_t>(s.var)] + " ";
            printExpr(p, s.expr, out);
            out += ")";
            break;
        case StmtKind::OpenValve:
            out += "(open " + p.slugs[static_cast<size_t>(s.slug)].slug + ")";
            break;
        case StmtKind::CloseValve:
            out += "(close " + p.slugs[static_cast<size_t>(s.slug)].slug + ")";
            break;
        case StmtKind::Delay:
            out += "(delay ";
            printExpr(p, s.expr, out);
            out += ")";
            break;
        case StmtKind::TransitionTo:
            out += "(goto " + p.slugs[static_cast<size_t>(s.slug)].slug + ")";
            break;
        case StmtKind::If:
            out += "(if ";
            printExpr(p, s.expr, out);
            out += " ";
            printBlock(p, s.body_begin, s.body_end, out);
            if (s.else_begin >= 0) {
                out += " ";
                printBlock(p, s.else_begin, s.else_end, out);
            }
            out += ")";
            break;
        case StmtKind::While:
            out += "(while ";
            printExpr(p, s.expr, out);
            out += " ";
            printBlock(p, s.body_begin, s.body_end, out);
            out += ")";
            break;
    }
}

void printBlock(const ScriptProgram& p, int32_t begin, int32_t end, std::string& out) {
    out += "(seq";
    for (int32_t k = begin; k < end; k++) {
        out += " ";
        printStmt(p, p.block_items[static_cast<size_t>(k)], out);
    }
    out += ")";
}

}  // namespace

std::string print_canonical(const ScriptProgram& program) {
    std::string out;
    printBlock(program, program.top_begin, program.top_end, out);
    return out;
}

}  // namespace script
}  // namespace fsw
