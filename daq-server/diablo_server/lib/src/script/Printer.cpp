// Canonical printer for state scripts: print_canonical(ScriptProgram) → the one normalised text
// every parse of an equivalent script produces. Moved verbatim from Parser.cpp (DESIGN-WP3 §2.4);
// one stage per TU, like Lexer.cpp / Parser.cpp / Validate.cpp / Slug.cpp.
//
// Owns:       nothing. A pure function of the program it is handed; no state, no fds, no threads.
// Threads:    any; no lock. Reads the ScriptProgram it is given and nothing else.
// Must not know: the lexer, the parser's helpers (Parser.cpp's first anonymous namespace), the
//             validator or the runtime. Only the AST types and op_name() in script/StateScript.hpp.
// Contract:   the canonical text — config/golden/cpp/script_parse/* (every script fixture), ctest
//             state_script (lib/test/test_state_script.cpp), tools/state_script_check.
// Static init: none (STYLE-S26).
#include <string>

#include "script/StateScript.hpp"

namespace fsw {
namespace script {

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
