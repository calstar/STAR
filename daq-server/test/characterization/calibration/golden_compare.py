#!/usr/bin/env python3
"""Compare a characterization output with its golden: text exactly, floating numbers within ULPs.

    golden_compare.py <golden> <output> [--ulps 4] [--tolerances tolerances.txt]

One golden serves every build type, OS and arch. The C++ math is not bit-identical across them
(clang contracts a*b+c into an FMA at -O2 on arm64; libm differs between Apple and glibc; moving
code to another translation unit changes inlining), so each line is split into number tokens and
the text between them:

- the text between numbers must match exactly (ids, names, hex, nan/inf, JSON structure);
- a token that looks like an integer on BOTH sides (raw codes, counts, ids, uids) must match
  exactly, as text;
- otherwise both are floats and |out - golden| <= ULPS * ulp(golden). A token with an `f` suffix
  is a float32 (a published calibrated value) and is measured in float32 ULPs.

A number is only a token at a word boundary, so digits inside identifiers and hex strings stay
text.

A few computations are ill-conditioned (a cancellation, a least-squares solve) and differ between
builds by more than a few ULP of their result. Those, and only those, are named in the tolerance
file, one family per line (the first rule that matches a value wins):

    family=<name> [section=<header>] [line=<regex>] [fields=<i,j>] [below=<x>]
                  [ulps=<n>] [abs=<x>] [rel=<x>]

`section` is the text of the enclosing `== <header> ==` line in the golden, `line` a regex the
golden line must match (search), `fields` the 0-based indices of the numbers on that line it
covers, `below` restricts the rule to golden values with |v| < x. A value
under a rule passes when it is within the rule's ulps (default ULPS), or |out - golden| <= abs, or
<= rel * |golden|. Integers and text are never relaxed. Every failure prints its family, the limit
applied and the observed distance.
"""

from __future__ import annotations

import math
import re
import sys
from dataclasses import dataclass

NUM = re.compile(r"(?<![\w.])[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?f?(?![\w.])")
INT = re.compile(r"^[-+]?\d+$")
SECTION = re.compile(r"^== (.*) ==$")


@dataclass
class Rule:
    family: str
    section: str | None = None
    line: re.Pattern | None = None
    fields: set[int] | None = None
    below: float | None = None
    ulps: float | None = None
    abs: float = 0.0
    rel: float = 0.0

    def describe(self, default_ulps: float) -> str:
        parts = [f"{self.ulps if self.ulps is not None else default_ulps:g} ULP"]
        if self.abs:
            parts.append(f"abs {self.abs:g}")
        if self.rel:
            parts.append(f"rel {self.rel:g}")
        return f"family {self.family}: " + " or ".join(parts)


def load_rules(path: str | None) -> list[Rule]:
    rules: list[Rule] = []
    if not path:
        return rules
    with open(path, encoding="utf-8") as f:
        for raw in f:
            text = raw.strip()
            if not text or text.startswith("#"):
                continue
            kv = {k: v.strip('"') for k, v in re.findall(r'(\w+)=("[^"]*"|\S+)', text)}
            if "family" not in kv:
                raise SystemExit(f"golden_compare: rule without family: {text}")
            rules.append(
                Rule(
                    family=kv["family"],
                    section=kv.get("section"),
                    line=re.compile(kv["line"]) if "line" in kv else None,
                    fields=(
                        {int(x) for x in kv["fields"].split(",")}
                        if "fields" in kv
                        else None
                    ),
                    below=float(kv["below"]) if "below" in kv else None,
                    ulps=float(kv["ulps"]) if "ulps" in kv else None,
                    abs=float(kv.get("abs", 0)),
                    rel=float(kv.get("rel", 0)),
                )
            )
    return rules


def f32_ulp(x: float) -> float:
    x = abs(x)
    if x == 0.0 or x < 2.0**-126:
        return 2.0**-149
    _, e = math.frexp(x)
    return 2.0 ** (e - 24)


def split(line: str) -> tuple[list[str], list[str]]:
    texts, nums, last = [], [], 0
    for m in NUM.finditer(line):
        texts.append(line[last : m.start()])
        nums.append(m.group(0))
        last = m.end()
    texts.append(line[last:])
    return texts, nums


def rule_for(
    rules: list[Rule], section: str, line: str, field: int, value: float
) -> Rule | None:
    for r in rules:
        if r.fields is not None and field not in r.fields:
            continue
        if r.section is not None and r.section != section:
            continue
        if r.line is not None and not r.line.search(line):
            continue
        if r.below is not None and not abs(value) < r.below:
            continue
        return r
    return None


def compare(
    gold: str, out: str, ulps: float, rules: list[Rule] | None = None
) -> list[str]:
    g_lines, o_lines = gold.split("\n"), out.split("\n")
    errs: list[str] = []
    rules = rules or []
    section = ""
    if len(g_lines) != len(o_lines):
        errs.append(f"line count: golden {len(g_lines)}, output {len(o_lines)}")
    for n, (g, o) in enumerate(zip(g_lines, o_lines), 1):
        sm = SECTION.match(g)
        if sm:
            section = sm.group(1)
        if g == o:
            continue
        gt, gn = split(g)
        ot, on = split(o)
        if gt != ot or len(gn) != len(on):
            errs.append(f"line {n}: text differs\n  - {g}\n  + {o}")
            continue
        for k, (a, b) in enumerate(zip(gn, on)):
            if a == b:
                continue
            if INT.match(a) and INT.match(b):
                errs.append(f"line {n} field {k}: integer {a} -> {b} (exact)\n  - {g}")
                continue
            single = a.endswith("f") or b.endswith("f")
            if single and not (a.endswith("f") and b.endswith("f")):
                errs.append(f"line {n} field {k}: float32 {a} -> {b}\n  - {g}")
                continue
            ga, ob = float(a.rstrip("f")), float(b.rstrip("f"))
            diff = abs(ob - ga)
            dist = diff / (f32_ulp(ga) if single else math.ulp(ga))
            r = rule_for(rules, section, g, k, ga)
            limit = r.ulps if r is not None and r.ulps is not None else ulps
            if dist <= limit:
                continue
            if r is not None and (diff <= r.abs or diff <= r.rel * abs(ga)):
                continue
            rel = diff / abs(ga) if ga else math.inf
            what = r.describe(ulps) if r is not None else f"default: {ulps:g} ULP"
            errs.append(
                f"line {n} field {k}: {a} -> {b}: {dist:.4g} {'float32 ' if single else ''}ULP,"
                f" abs {diff:.3g}, rel {rel:.3g}; limit {what}\n  - {g}"
            )
        if len(errs) > 200:
            errs.append("... (stopped after 200 differences)")
            break
    return errs


def main() -> int:
    args = sys.argv[1:]
    ulps = 4.0
    tolerances = None
    if "--ulps" in args:
        i = args.index("--ulps")
        ulps = float(args[i + 1])
        del args[i : i + 2]
    if "--tolerances" in args:
        i = args.index("--tolerances")
        tolerances = args[i + 1]
        del args[i : i + 2]
    golden, output = args
    with open(golden, encoding="utf-8") as f:
        gold = f.read()
    with open(output, encoding="utf-8") as f:
        out = f.read()
    errs = compare(gold, out, ulps, load_rules(tolerances))
    if errs:
        print(
            f"golden_compare: {len(errs)} difference(s) beyond their limits:",
            file=sys.stderr,
        )
        for e in errs:
            print(e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
