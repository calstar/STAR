#include "Lexer.hpp"

#include <cctype>
#include <cstdlib>

namespace fsw {
namespace script {

const char* tok_name(Tok t) {
    switch (t) {
        case Tok::Eof:
            return "end of script";
        case Tok::Newline:
            return "end of line";
        case Tok::Indent:
            return "indent";
        case Tok::Dedent:
            return "dedent";
        case Tok::Ident:
            return "a name";
        case Tok::Number:
            return "a number";
        case Tok::Colon:
            return "':'";
        case Tok::LParen:
            return "'('";
        case Tok::RParen:
            return "')'";
        case Tok::Comma:
            return "','";
        case Tok::Assign:
            return "'='";
        case Tok::Plus:
            return "'+'";
        case Tok::Minus:
            return "'-'";
        case Tok::Star:
            return "'*'";
        case Tok::Slash:
            return "'/'";
        case Tok::Lt:
            return "'<'";
        case Tok::Le:
            return "'<='";
        case Tok::Gt:
            return "'>'";
        case Tok::Ge:
            return "'>='";
        case Tok::EqEq:
            return "'=='";
        case Tok::Ne:
            return "'!='";
        case Tok::KwIf:
            return "'if'";
        case Tok::KwElif:
            return "'elif'";
        case Tok::KwElse:
            return "'else'";
        case Tok::KwWhile:
            return "'while'";
        case Tok::KwAnd:
            return "'and'";
        case Tok::KwOr:
            return "'or'";
        case Tok::KwNot:
            return "'not'";
    }
    return "?";
}

namespace {

bool identStart(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
}
bool identChar(char c) {
    return identStart(c) || (c >= '0' && c <= '9');
}

Tok keywordOf(const std::string& s) {
    if (s == "if")
        return Tok::KwIf;
    if (s == "elif")
        return Tok::KwElif;
    if (s == "else")
        return Tok::KwElse;
    if (s == "while")
        return Tok::KwWhile;
    if (s == "and")
        return Tok::KwAnd;
    if (s == "or")
        return Tok::KwOr;
    if (s == "not")
        return Tok::KwNot;
    return Tok::Ident;
}

struct Lexer {
    const std::string& src;
    LexResult out;
    size_t i = 0;
    uint32_t line = 1;
    uint32_t col = 1;
    /** Column stack for open blocks; [0] is always 0. */
    std::vector<uint32_t> indents{0};
    /** Set by the first indented line; every later indent must be a multiple of it. 0 = unset. */
    uint32_t unit = 0;
    bool failed = false;

    explicit Lexer(const std::string& s) : src(s) {
    }

    void fail(Diag code, uint32_t l, uint32_t c, std::string msg) {
        if (failed)
            return;
        failed = true;
        out.diagnostics.push_back({code, l, c, std::move(msg)});
    }

    void push(Tok k, uint32_t l, uint32_t c, uint32_t len, std::string text = {},
              double num = 0.0) {
        Token t;
        t.kind = k;
        t.line = l;
        t.col = c;
        t.len = len;
        t.text = std::move(text);
        t.number = num;
        out.tokens.push_back(std::move(t));
    }

    char peek(size_t off = 0) const {
        return (i + off < src.size()) ? src[i + off] : '\0';
    }

    void run() {
        bool at_line_start = true;
        while (!failed && i < src.size()) {
            if (at_line_start) {
                if (!handleLineStart(at_line_start))
                    return;
                continue;
            }
            char c = peek();
            if (c == '\n') {
                push(Tok::Newline, line, col, 1);
                i++;
                line++;
                col = 1;
                at_line_start = true;
                continue;
            }
            if (c == '\r') {  // CRLF normalised at the door
                i++;
                continue;
            }
            if (c == ' ') {
                i++;
                col++;
                continue;
            }
            if (c == '#') {
                while (i < src.size() && src[i] != '\n')
                    i++;
                continue;
            }
            if (!lexToken())
                return;
        }
        if (failed)
            return;
        // A file that does not end in a newline still closes its last statement.
        if (!out.tokens.empty() && out.tokens.back().kind != Tok::Newline)
            push(Tok::Newline, line, col, 0);
        while (indents.size() > 1) {
            indents.pop_back();
            push(Tok::Dedent, line, col, 0);
        }
        push(Tok::Eof, line, col, 0);
    }

    /**
     * Measure one line's indentation and emit INDENT/DEDENT.
     * @return false on a hard error. Sets at_line_start=false when real content follows.
     */
    bool handleLineStart(bool& at_line_start) {
        uint32_t width = 0;
        size_t j = i;
        while (j < src.size()) {
            char c = src[j];
            if (c == ' ') {
                width++;
                j++;
            } else if (c == '\t') {
                fail(Diag::TabIndent, line, width + 1,
                     "tab in indentation — use spaces (a tab is invisible in the editor, and "
                     "mixed indentation silently changes which branch a valve command is in)");
                return false;
            } else if (c == '\r') {
                j++;
            } else {
                break;
            }
        }
        // Blank or comment-only line: no NEWLINE, no INDENT/DEDENT — it has no structure.
        if (j >= src.size() || src[j] == '\n' || src[j] == '#') {
            while (j < src.size() && src[j] != '\n')
                j++;
            if (j < src.size()) {
                j++;  // consume '\n'
                line++;
            }
            i = j;
            col = 1;
            at_line_start = true;
            return true;
        }

        i = j;
        col = width + 1;
        at_line_start = false;

        const uint32_t cur = indents.back();
        if (width > cur) {
            if (unit == 0) {
                const uint32_t u = width - cur;
                if (u > kMaxIndentUnit) {
                    fail(Diag::BadIndentUnit, line, width + 1,
                         "indent of " + std::to_string(u) + " spaces is wider than the " +
                             std::to_string(kMaxIndentUnit) + "-space maximum");
                    return false;
                }
                unit = u;
            }
            if (width != cur + unit) {
                fail(Diag::BadIndentUnit, line, width + 1,
                     "indented " + std::to_string(width - cur) + " spaces; this script indents " +
                         std::to_string(unit) + " at a time, so " + std::to_string(cur + unit) +
                         " was expected");
                return false;
            }
            indents.push_back(width);
            push(Tok::Indent, line, col, 0);
        } else if (width < cur) {
            while (indents.size() > 1 && indents.back() > width) {
                indents.pop_back();
                push(Tok::Dedent, line, col, 0);
            }
            if (indents.back() != width) {
                fail(Diag::BadDedent, line, width + 1,
                     "unindent to column " + std::to_string(width + 1) +
                         " does not line up with any enclosing block");
                return false;
            }
        }
        return true;
    }

    bool lexToken() {
        const uint32_t l = line, c = col;
        const char ch = peek();

        if (ch == '\t') {
            fail(Diag::UnexpectedChar, l, c, "tab character — use spaces");
            return false;
        }
        // No string literals exist in this language, and refusing the quote outright is what
        // guarantees a script can never contain ''' — which is what keeps every text-embedding of
        // a script (TOML literal block included) safe without an escaping rule.
        if (ch == '\'' || ch == '"') {
            fail(Diag::UnexpectedChar, l, c,
                 std::string("quote character — names are bare slugs here, e.g. ") +
                     "open_valve(FUEL_VENT), not open_valve(\"Fuel Vent\")");
            return false;
        }

        if (identStart(ch)) {
            size_t start = i;
            while (i < src.size() && identChar(src[i])) {
                i++;
                col++;
            }
            std::string text = src.substr(start, i - start);
            const Tok k = keywordOf(text);
            push(k, l, c, static_cast<uint32_t>(text.size()), text);
            return true;
        }

        if (ch >= '0' && ch <= '9') {
            size_t start = i;
            while (i < src.size() && src[i] >= '0' && src[i] <= '9') {
                i++;
                col++;
            }
            if (i < src.size() && src[i] == '.') {
                i++;
                col++;
                while (i < src.size() && src[i] >= '0' && src[i] <= '9') {
                    i++;
                    col++;
                }
            }
            // "1e3" must not lex as 1 followed by the name e3. HoldParse records the same trap on
            // the wire: atoi("1e3") is 1, so a frame asking for a thousand seconds ran a
            // one-millisecond pulse and the operator weighed a mass against a window that never
            // happened. Refuse it rather than silently truncating.
            if (i < src.size() && (identChar(src[i]) || src[i] == '.')) {
                fail(Diag::BadNumber, l, c,
                     "malformed number — digits and at most one '.', with no exponent and no "
                     "trailing letters");
                return false;
            }
            std::string text = src.substr(start, i - start);
            push(Tok::Number, l, c, static_cast<uint32_t>(text.size()), text,
                 std::atof(text.c_str()));
            return true;
        }

        auto two = [&](char a, char b) {
            return ch == a && peek(1) == b;
        };

        Tok k = Tok::Eof;
        uint32_t len = 1;
        if (two('<', '=')) {
            k = Tok::Le;
            len = 2;
        } else if (two('>', '=')) {
            k = Tok::Ge;
            len = 2;
        } else if (two('=', '=')) {
            k = Tok::EqEq;
            len = 2;
        } else if (two('!', '=')) {
            k = Tok::Ne;
            len = 2;
        } else {
            switch (ch) {
                case ':':
                    k = Tok::Colon;
                    break;
                case '(':
                    k = Tok::LParen;
                    break;
                case ')':
                    k = Tok::RParen;
                    break;
                case ',':
                    k = Tok::Comma;
                    break;
                case '=':
                    k = Tok::Assign;
                    break;
                case '+':
                    k = Tok::Plus;
                    break;
                case '-':
                    k = Tok::Minus;
                    break;
                case '*':
                    k = Tok::Star;
                    break;
                case '/':
                    k = Tok::Slash;
                    break;
                case '<':
                    k = Tok::Lt;
                    break;
                case '>':
                    k = Tok::Gt;
                    break;
                default: {
                    std::string what = "'";
                    what += ch;
                    what += "'";
                    fail(Diag::UnexpectedChar, l, c, "unexpected character " + what);
                    return false;
                }
            }
        }
        i += len;
        col += len;
        push(k, l, c, len);
        return true;
    }
};

}  // namespace

LexResult lex(const std::string& source) {
    Lexer lx(source);
    if (source.size() > kMaxSourceBytes) {
        lx.out.diagnostics.push_back({Diag::ProgramTooLarge, 1, 1,
                                      "script is " + std::to_string(source.size()) +
                                          " bytes; the limit is " +
                                          std::to_string(kMaxSourceBytes)});
        return lx.out;
    }
    uint32_t lines = 1;
    for (char c : source)
        if (c == '\n')
            lines++;
    if (lines > kMaxLines) {
        lx.out.diagnostics.push_back({Diag::TooManyLines, kMaxLines + 1, 1,
                                      "script is " + std::to_string(lines) +
                                          " lines; the limit is " + std::to_string(kMaxLines)});
        return lx.out;
    }
    lx.run();
    return lx.out;
}

}  // namespace script
}  // namespace fsw
