#!/usr/bin/env python3
"""WP7 step-1 move-only check (DESIGN-WP7 §6.1).

Splits the baseline router ladder (`api-server.ts` 394-1256 at the given revision, located by
content) into branches at every `^      (} else )?if (` header. For each branch, `[COND] + BODY`
with leading whitespace stripped from every line must occur as one contiguous run in exactly one
file among `src/api/*.ts` and `src/api-server.ts`, and nowhere twice. The one permitted
substitution is applied to the old text first: the two `path.join(__dirname, …)` candidates of the
`/api/cubic_calibration` branch become `path.join(SRC_DIR, …)` (WP7-S3).

Every other line of an `src/api/*.ts` file must be an import (or re-export), the handler
signature, its `opts` destructuring, `return true;`, `return false;`, a closing brace, the
`SRC_DIR` line, blank, or a comment line (`//`, `/**`, `*`, `*/`) — the STYLE-S36 header.

    python3 test/wp7-checks/move_only_check.py [--rev backend-remastered] [--all-moved]

Exit 0 when every branch is found exactly once and every leftover line is allowed; `--all-moved`
also requires that no branch is still in `src/api-server.ts` (the state after commit 1.12).
"""
import argparse
import glob
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO_PATH = "daq-server/diablo_server/backend/src/api-server.ts"

HEADER_RE = re.compile(r"^      (\} else )?if \((.*)\) \{$")
ALLOWED_RE = re.compile(
    r"^(//.*|/\*\*.*|\*.*|\*/|import .*|export (type )?\{.*|export async function handle[A-Za-z]+Request\(.*|"
    r"const \{ [A-Za-z, ]+ \} = opts;|return true;|return false;|\}|\} from '[^']+';|"
    r"const SRC_DIR = path\.join\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\);)$"
)


def old_text(rev):
    root = subprocess.check_output(
        ["git", "-C", BACKEND, "rev-parse", "--show-toplevel"], text=True
    ).strip()
    return subprocess.check_output(
        ["git", "-C", root, "show", f"{rev}:{REPO_PATH}"], text=True
    )


def branches(text):
    lines = text.split("\n")
    start = next(
        i
        for i, l in enumerate(lines)
        if l == "      if (url.pathname === '/api/config' && req.method === 'GET') {"
    )
    end = next(
        i
        for i, l in enumerate(lines)
        if i > start and l == "      } else {" and "404" in lines[i + 1]
    )
    heads = [i for i in range(start, end) if HEADER_RE.match(lines[i])]
    out = []
    for n, h in enumerate(heads):
        stop = heads[n + 1] if n + 1 < len(heads) else end
        cond = HEADER_RE.match(lines[h]).group(2)
        body = lines[h + 1 : stop]
        if cond.startswith("url.pathname === '/api/cubic_calibration'"):
            body = [
                l.replace("path.join(__dirname,", "path.join(SRC_DIR,") for l in body
            ]
        out.append((cond, ["if (" + cond + ") {"] + [l.strip() for l in body]))
    return out


def helper_block(text):
    """Baseline 305-361 (the types and the two request helpers), the two helpers now exported."""
    lines = text.split("\n")
    start = lines.index(
        "/**",
        lines.index(
            "export function buildSensorConfig(config: any = readConfig()): SensorConfigEntry[] {"
        ),
    )
    end = lines.index("/**", start + 1)  # createAPIHandler's doc comment
    out = []
    for l in lines[start:end]:
        l = l.strip()
        if l.startswith("function isConfigWriteAuthorized(") or l.startswith(
            "function readJsonBody("
        ):
            l = "export " + l
        out.append(l)
    while out and out[-1] == "":
        out.pop()
    return out


def find_runs(needle, hay):
    n = len(needle)
    return [i for i in range(len(hay) - n + 1) if hay[i : i + n] == needle]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rev", default="backend-remastered")
    ap.add_argument("--all-moved", action="store_true")
    args = ap.parse_args()

    files = {}
    for p in sorted(glob.glob(os.path.join(BACKEND, "src", "api", "*.ts"))) + [
        os.path.join(BACKEND, "src", "api-server.ts")
    ]:
        raw = open(p).read().split("\n")
        if p.endswith(
            "api-server.ts"
        ):  # a branch still in the ladder reads `} else if (` at its level
            raw = [re.sub(r"^      \} else if \(", "      if (", l) for l in raw]
            # until 1.10 moves it, the cubic branch still reads `__dirname` here (WP7-S3)
            raw = [l.replace("path.join(__dirname,", "path.join(SRC_DIR,") for l in raw]
        files[os.path.relpath(p, BACKEND)] = [l.strip() for l in raw]
    covered = {f: set() for f in files}
    bad = 0
    missing = 0
    remaining = 0
    brs = branches(old_text(args.rev))
    for cond, needle in brs:
        hits = [(f, i) for f, hay in files.items() for i in find_runs(needle, hay)]
        if len(hits) != 1:
            bad += 1
            missing += 1
            print(f"BAD branch ({len(hits)} hits): {cond}")
            continue
        f, i = hits[0]
        if f.endswith("api-server.ts"):
            remaining += 1
        covered[f].update(range(i, i + len(needle)))
    helpers = helper_block(old_text(args.rev))
    hits = find_runs(helpers, files.get("src/api/http.ts", []))
    if len(hits) != 1:
        bad += 1
        print(
            f"BAD helpers (types, isConfigWriteAuthorized, readJsonBody): {len(hits)} hits in src/api/http.ts"
        )
    for f, hay in files.items():
        if f.endswith("api-server.ts") or f.endswith("api/http.ts"):
            continue
        in_import = False
        for i, l in enumerate(hay):
            if (
                in_import
            ):  # continuation of a multi-line import / re-export, up to its `;`
                in_import = not l.endswith(";")
                continue
            if re.match(r"^(import|export) (type )?\{", l) and not l.endswith(";"):
                in_import = True
                continue
            if i in covered[f] or l == "" or ALLOWED_RE.match(l):
                continue
            bad += 1
            print(f"BAD line {f}:{i + 1}: {l}")
    print(
        f"branches: {len(brs)}, missing or duplicated: {missing}, still in api-server.ts: {remaining}"
    )
    if args.all_moved and remaining:
        print("BAD: branches remain in src/api-server.ts")
        bad += 1
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
