#pragma once

// Internal to the script library. Not installed, not included outside lib/src/script.

#include <cstdint>
#include <string>
#include <vector>

#include "script/StateScript.hpp"

namespace fsw {
namespace script {

enum class Tok : uint8_t {
    Eof,
    Newline,
    Indent,
    Dedent,

    Ident,
    Number,

    Colon,
    LParen,
    RParen,
    Comma,
    Assign,

    Plus,
    Minus,
    Star,
    Slash,

    Lt,
    Le,
    Gt,
    Ge,
    EqEq,
    Ne,

    KwIf,
    KwElif,
    KwElse,
    KwWhile,
    KwAnd,
    KwOr,
    KwNot,
};

const char* tok_name(Tok t);

struct Token {
    Tok kind = Tok::Eof;
    std::string text;     // Ident spelling; Number source text
    double number = 0.0;  // Number value
    uint32_t line = 1;    // 1-based
    uint32_t col = 1;     // 1-based
    uint32_t len = 0;
};

struct LexResult {
    std::vector<Token> tokens;
    std::vector<Diagnostic> diagnostics;

    bool ok() const {
        return diagnostics.empty();
    }
};

/**
 * Tokenize, emitting INDENT/DEDENT for block structure.
 *
 * Stops at the first error. Every ambiguity Python resolves by convention is rejected here
 * instead: tabs are refused outright (the editor is a bare <textarea>, where mixed indentation is
 * invisible on screen and the failure mode is a valve opening in the wrong branch), and the first
 * indented line fixes the indent unit that every later indent must be an exact multiple of.
 */
LexResult lex(const std::string& source);

}  // namespace script
}  // namespace fsw
