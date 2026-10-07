# 0004 — Pressure references: absolute inside, gauge on the drawing, never ambiguous

**Status:** Accepted · 2026-10-06
**Affects:** `lib/feedtwin`, `feed-twin`, `EngineDesign` (Layer X), `pid-designer`

## Context

The model works in absolute pascals; people work in gauge. The library's unit table
read a bare `psi` as absolute and refused `psig` outright. The intent was "convert
before authoring", but nobody authoring a drawing did. An audit (2026-10-06) found
the same drawn number meaning two things a few lines apart:

* **Every drawing's notes say gauge.** "500 psig operating pressure", "bottle gauge",
  "gives 550 at the tanks". The model read each as an atmosphere lower.
* **The two dome sources disagreed.** A drawn dome loader at 500 was read as 500 psia,
  while the cockpit's dome knob at 500 was 500 psig. The same stand locked up 14.7 psi
  apart depending on which one set it.
* **Readouts mixed references.**
  * A delivered bottle started 14.7 psi under its own fill target.
  * The steady-state dome (`live.py`) used the knob's number as absolute.
  * The Hookup tab printed a psia number labelled psig.
  * Layer X used the drawn bottle as gauge.
* **The limits were gauge and said nothing.** MAWP and burst were silently gauge
  (`_trip_limit` added an atmosphere), against pid-designer's "absolute, not gauge"
  tooltip.

## Decision

1. **Inside the model, absolute Pa.** Unchanged.
2. **The unit table spells references out.**
   * `psia`/`bara`/`kPaa`/`MPaa` are absolute; `psig`/`barg`/`kPag`/`MPag`/`Pag` are
     one standard atmosphere (101 325 Pa, the DAQ's zero) above.
   * Bare `psi`/`bar`/`kPa`/`MPa`/`Pa` carry **no offset**, so they convert a
     difference exactly.
3. **On a drawing, an absolute pressure written bare is gauge** (`feedtwin.model.pressure`):
   * it reads as what its dial reads;
   * write `psia` to mean absolute;
   * `atm` is absolute by nature;
   * on an ENGINE or INJECTOR symbol a bare pressure is absolute, because a chamber
     pressure is quoted psia, as EngineDesign quotes it everywhere.
4. **A difference never carries a reference.** Bias, droop, lockup rise, crack, relief
   set and reseat, and minimum differential are the same in psig and psia. A drawing
   that writes `psig` on one is refused, naming the parameter.
5. **The rule lives in one place.** `drawn_unit()` is applied wherever a drawing's
   parameters are read. A test fails if the catalogue or a shipped drawing uses a
   pressure name that is in neither list.
6. **Everything a person sets or reads is psig, and says so.** That covers the
   console, GSE knobs, Hookup, Engine page and API fields named `*_psi`. Layer X and
   EngineDesign keep psia for engine quantities, labelled as such.
7. **pid-designer offers the references.**
   * Absolute fields offer `psi` (reads as gauge), `psig` and `psia`; differences
     offer only the bare units.
   * The field tooltip says which kind each field is.
   * Its drawing checks compare everything as gauge.

## Consequences

* Drawn absolute pressures move up 14.7 psi in absolute terms, to what their authors
  meant. Most cockpit and Layer X numbers do not move: the dome, tank pressures and
  bottle fill come from the panel (already psig). Where a drawn value reaches a burn,
  results move slightly. The Study's regulator `inlet_reference` shifts the
  supply-pressure effect by ~0.25 psi, which moves Tier 2.1 within tolerance (see
  docs/PHYSICS-BENCHMARK.md §2.1). LE4 burns do not move.
* The trip limit reads MAWP and burst as the drawing does. Burst over the safety factor
  divides the pressure across the wall, not the absolute.
* **Known, not decided here:** Layer X judges MAWP against the *site* ambient (94 kPa at
  627 m), feedtwin's trip against the standard atmosphere, a ~1 psi difference. The
  DAQ's gauge zero is standard; the wall feels the site. Pick one when a vessel's limit
  is close enough for a psi to matter.
