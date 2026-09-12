# feed-twin physics paper

`feed-twin-physics.tex` — governing equations, constitutive closure, and
numerical method. **Revision 2, audited line-by-line against the code:** the mathematics is complete and matches the
implementation; the prose is skeletal on purpose.

## Building

No TeX toolchain on this machine. Either:

```bash
brew install --cask mactex-no-gui && eval "$(/usr/libexec/path_helper)"
```

or the lighter single-binary option, which fetches only the packages used:

```bash
brew install tectonic && tectonic docs/paper/feed-twin-physics.tex
```

With MacTeX, build twice so `cleveref` resolves:

```bash
cd docs/paper && pdflatex feed-twin-physics.tex && pdflatex feed-twin-physics.tex
```

## Where to write

Two kinds of marker sit where you write: `% EXPAND` (narrative belongs here; the
mathematics is already stated) and `% NOTE:` (what the paragraph needs to *say*). Each one is under a heading
whose mathematics is already stated, so the prose has something to be *about*
rather than having to carry the content.

```bash
grep -nE "% (EXPAND|NOTE)" feed-twin-physics.tex
```

## House rules this document follows

- Every constitutive relation names its source; §A.2 is the provenance table.
- Assumptions are numbered (`\begin{assumption}`) and cross-referenced from
  §12, so a limitation is traceable to the equation that introduced it.
- Numbers quoted in the text are the ones the benchmark asserts
  (`docs/PHYSICS-BENCHMARK.md`), not fresh ones. If a benchmark value moves,
  this paper moves with it.
