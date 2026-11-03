# 0007 — People read psia; the wire and the files stay gauge

**Status:** Accepted · 2026-10-17
**Supersedes:** [ADR 0004](0004-pressure-references.md) item 6 only. Items 1–5 and 7 stand.
**Affects:** `lib/feedtwin`, `feed-twin`

## Context

ADR 0004 item 6 put everything a person sets or reads in psig: the console, the GSE
knobs, the Hookup tab, the Engine page and every API field named `*_psi`. The model
was absolute and the drawings were read as gauge; the screen followed the drawings.

The team works in psia (2026-10-07: every pressure in psia, in chat, docs and the
software; the split below agreed 2026-10-16). EngineDesign, Layer X, the engine
configs, the CDR and the slides all quote psia. The Feed Twin was the one place that
did not, and the mismatch showed up everywhere a number crossed over (the 2026-10-17
dry run, D-13):

* **Every number was 14.7 psi off its neighbour.** The same dome setting read 500 in
  the cockpit and 514.7 psia in Layer X. A T-0 lockup of 483.7 in the cockpit is
  498.4 psia everywhere else. A slide made from one screen was wrong for the other.
* **The trip message was gauge, against psia limits.** "LOX-Tank reached 766 psig
  against a 750 psig MAWP" is a 780.4 psia tank over a 764.7 psia limit, the numbers
  the rest of the suite quotes.
* **The chamber gauge read below zero.** Idle Pc showed -1.1, which is 13.6 psia: the
  engine card's site ambient measured against a sea-level gauge zero.
* **Bare "psi" crept back in.** "COPV is down to 27 psi" said nothing about which
  reference.

Two things kept the gauge convention, and neither is a display question:

* **The stand's DAQ logs psig.** Its PTs are gauge transducers and its files are
  gauge. A twin trace laid over a DAQ trace must match it number for number.
* **Every saved file is gauge.** Run records, hookups (`Knob.psig`), stand documents,
  saved setups (`dome_psi`, `copv_target_psi`, `dewar_psi`) and the browser's own
  storage hold gauge numbers. Rewriting them to psia would make each old record mean
  something different from what it says, and a replay of one would move 14.7 psi.

## Decision

1. **Inside the model, absolute Pa.** Unchanged.
2. **On the wire and on disk, gauge.** Unchanged from ADR 0004. Every `*_psi` and
   `psig` field, every saved file and every run record stays gauge. A channel keeps
   `unit: "psig"` as a machine tag: it says "this value is gauge", not "show psig".
   `feedtwin.session.gauge.psig` and `from_psig` are still where the wire meets the
   model.
3. **What a person reads or types is psia.** That covers the console and its gauges,
   the GSE knobs, the trip overlay, notes, hovers, Engine, Runs, Study, Plots and the
   Configuration tab.
   * The client converts a gauge number to psia for display and takes the atmosphere
     off what is typed before it goes on the wire
     (`feed-twin/frontend/src/lib/pressure.ts`).
   * Text the server writes for people goes through one formatter,
     `feedtwin.session.gauge.say(pa, places=0)`: `"514.7 psia"`. Nothing adds an
     atmosphere by hand. The formatter lives in `feedtwin.model.pressure` so the
     drawing reader can use it without importing the session.
4. **A difference is plain psi.** Bias, droop, sag, lockup rise, feed loss,
   injector drop, a residual: the same size in either reference. Written `psi`,
   never `psia` or `psig`.
5. **A tunable carried gauge says so.** `backend/tunables.py` marks the dome, the
   COPV fill and the dewar pressure `gauge_wire: true` with `unit: "psia"`. Their
   `value`, `low`, `high`, `default` and `step` stay gauge on the wire; the client
   shows them in psia.
6. **The real DAQ is gauge, and the console says so in a hover.** A gauge's hover
   also gives the psig reading, so an operator can cross-check the console against
   the stand's own screen.
7. **A percentage of a pressure is of the absolute.** The Runs diff takes a chamber
   pressure change as a share of psia. The chamber's amber and red bands sit 10 % and
   25 % over the design chamber pressure, which is quoted absolute.

## Consequences

* No number in the model moves. Physics, benchmark figures, run outcomes and replays
  are unchanged. An old run record replays and diffs against a new one with zero
  difference (`feed-twin/tests/test_psia_display.py`).
* Every pressure on screen is 14.696 psi higher than before. A screenshot taken
  before 2026-10-17 is psig.
* The chamber gauge reads 13.6 psia at idle on an engine whose card states its
  site's ambient. That is now visibly an absolute pressure, not a negative gauge
  reading.
* The Runs diff percentage on Mean Pc moves slightly (a 10 psi change on a 350 psia
  chamber is 2.9 %, not 3.0 %). The chamber's amber and red bands move up 1.5 and
  3.7 psi.
* The docs that described the old display rule are updated: CLAUDE.md, the Feed Twin
  glossary and getting-started guide, and the ADR index. `docs/PHYSICS-BENCHMARK.md`
  keeps its tank and bottle figures in psig, each marked, because they are checked
  against `psig()` traces off the wire; a note at its head says to add 14.696.
* **Not decided here:** the site-ambient question in ADR 0004's Consequences. The
  psig hover uses the standard atmosphere, as the DAQ does.

## Alternatives considered

* **Convert the wire and the files to psia.** One reference everywhere, no
  conversion in the client. Rejected: every saved hookup, stand and run record would
  need a migration, and a missed one would be silently 14.7 psi off. The DAQ's files
  would still be gauge, so the conversion would only move to the DAQ import.
* **Show both on every gauge.** Rejected: twice the numbers and still ambiguous at a
  glance. psia on the face, psig in the hover.
* **Keep psig and convert the slides instead.** Rejected by the team (2026-10-07).
  The rest of the suite is psia, and the twin is the one tool that has to agree
  with it.
