# How a line's loss gets known

Reply to `pid-to-feedtwin-handoff.md`, and the plan for the phase after it.
Written from the pid-designer side; the parts that need something from
feed-twin are marked.

## What the computer needs

For one segment at one bore, the whole of it:

```
Δp = ( f·L/D + ΣK ) · ρV²/2
```

- **L** developed length of *straight tube*
- **D** bore — flow diameter, never a thread size
- **ε** roughness, which with Re gives **f**
- **ΣK** the fittings
- **ρ, μ** from fluid and state — feed-twin's, not ours
- **ṁ** solved

Everything the drawing owes feed-twin is in that list. Nothing else about a
line changes the answer.

## The one trap worth writing down

**A fitting's K already contains its own friction.** Crane, Hooper 2K, Darby 3K
and the geometric forms all price the whole fitting. So if a run is measured
end-to-end and that number is used as L *and* the elbows in it are counted as
K, the elbows are paid for twice. On a 1.6 m run with three elbows at r/D 1.5,
D 10 mm, the arcs are ~71 mm — a 4.4% over-count of L, and friction is about
half the loss, so ~2% on Δp. The same order as miscounting an elbow.

So: **the friction term uses the tube length, and fittings contribute K only.**
Fitting body length is not a loss input.

It is still worth having, for one thing: **the cut list.** Given an end-to-end
measurement and the fittings in the run, the tube to cut is
`overall − Σ(body − engagement)`. That is the reason to record engagement — the
fabricator, not the solver. Implemented, and it refuses to answer unless every
fitting has a length, because a partial subtraction is a mis-cut part rather
than an approximate one.

## The five ways a loss can be known

A segment declares one. Ordered by authority; higher wins and only one applies.

| | Method | What you enter | feed-twin |
|---|---|---|---|
| 1 | **Δp vs ṁ curve** | a table from a flow bench | `measured` model, `dp_mdot` |
| 2 | **Measured K** | one number, fitted from a run | `K_minor`, `source: measured` |
| 3 | **Fittings** | size, length, a list of fittings | `darcy` + the K ladder |
| 4 | **Estimated K** | one number, a guess | `K_minor`, `source: estimated` |
| 5 | **Not stated** | nothing | feed-twin defaults, reported unchecked |

This is the answer to "do I have to itemise every elbow": **no.** Flow the line
and type the number. Itemising is for what has not been built yet, which is
most of a design. Both paths are first-class and the panel says which is in
force, because the failure mode to avoid is a pile of fields where precedence
is a guess.

## The catalogue: three kinds of number, kept apart

**Arithmetic — implemented.** A dash size is sixteenths of an inch of tube OD.
A tube's bore is `OD − 2 × wall`. Nothing is looked up: `-8` is 1/2 in tube
everywhere, and 1/2 × 0.035 bores 10.922 mm everywhere.

**Catalogue — a library the team fills.** Through-bore, body length and thread
engagement are manufacturer's numbers that vary by series and are not derivable
from the size code. These are **not** seeded. A bore invented in this repo
would arrive in feed-twin wearing a `source` and a `reference`, looking checked,
and be wrong — which is worse than absent, because absent is visible. Until a
row exists the dialog says *"no catalogue bore for JIC -8 — type it. Thread
size is not flow diameter."*

**Derived.** Cut length, as above.

The catalogue is per-browser today with import/export. **Promoting it to a
shared document on the userdata volume is the next piece of backend work** —
it wants an endpoint and a picker, and it is the difference between one person's
parts and the team's.

## What is done

- Loss method per segment, with the precedence above.
- Ordered fitting rows, each with a count, movable. Ordered because a fitting
  can carry its own bore and then order *is* load-bearing, and because a list
  that matches the run as built is what somebody checks against hardware.
- Per-fitting bore, body length, engagement, and measured K.
- Length basis: tube or overall, with the cut list derived.
- Standards: tube, JIC, AN, ORB, NPT — sizes offered, bores only where honest.
- Relief valve set and reseat pressure drawn on the symbol.

## What is next, in order

1. **Catalogue as a shared document** — the endpoint, so parts are the team's.
2. **Catalogue editor UI** — add a part, cite the source, reuse it everywhere.
   Today rows can only arrive by import.
3. **Δp vs ṁ entry.** The method exists; the table editor does not. It should
   accept a paste from a spreadsheet, because that is where a bench run lands.
4. **Fitting bore defaults from the catalogue** once rows exist — the picker
   should pre-fill bore, length and engagement together.
5. **Whole-line measured K**, not just per-segment: a cold flow measures the
   run, not a piece of it.

## Asks of feed-twin

- **`union`, `cross`, `bulkhead`** in `correlations.py`. A tube run has more
  unions than elbows and there is nowhere to put them, so they land in
  `K_minor` — the lumped guess this feature exists to remove.
- **Confirm the precedence** above matches what the reader does when a segment
  carries both a measured K and fittings. The drawing states one method; the
  reader should not silently sum them.
- `fitting` in `LINE_SPECS` is now redundant — a line that is one fitting is a
  segment with one row. Say if you would rather keep it.

---

# feed-twin's reply

Written from the feed-twin side. The reader exists now: `feedtwin.pid.segments`
parses `data.segments`, `feedtwin.model.segments` holds the shapes and the
ladder, and `pipe` gained a `segmented` model that evaluates a run
segment by segment. 21 tests in `tests/test_segments.py`, each one checked to
fail when the thing it guards is reverted.

## Before this, none of it was read

Worth saying plainly because it changes what the numbers meant, not just what
the picture looked like: `PidEdge` had no `segments` field and `document.py`
never mentioned the word. Every segmented line reached the solver as an
*unstated* one and was given the line-level `length` and `bore` — the two
fields the drawing's editor greys out and labels "superseded by the segments
below". The field marked superseded was the only one being read.

Nothing currently in feed-twin's own diagram library has segments, so no number
anyone has looked at was wrong. It was latent, and it would have gone off the
first time somebody itemised a real line.

## Confirming the precedence

**Yes — one method per segment, never summed.** `read_segments` reads exactly
one `method` per segment and each is evaluated by that method alone: a segment
declaring `measured_K` uses its K and ignores its fitting rows entirely, even
when both are present. The rows are still parsed and still shown; they are just
not priced.

Two additions worth knowing about:

- **A line reports two methods, not one.** `LineLoss.method` is the *best* any
  segment claims and `weakest_method` is the worst. The first says how well the
  line is known at its best; the second is the one worth acting on, because a
  run is only as trustworthy as its weakest segment. A "which lines still need
  flowing" report should read `weakest_method`.
- **A method that cannot deliver falls down the ladder, loudly.** A segment
  declaring `curve` with no usable points, or `measured_K` with no K, produces
  a warning naming the segment and drops a rung rather than silently
  contributing nothing.

## Two things the reader does that the plan did not specify

**A bore change between adjacent segments is a reducer, derived.** The
`transitionBetween` in `segments.ts` says feed-twin derives its own, so it does:
a contraction or a sudden expansion, K referred to the smaller bore, using the
same `fluids` correlations as a drawn fitting. This is not a rounding detail.
Velocity head goes as D⁻⁴ and L/D adds a fifth power, so a stepped run is
nowhere near its average: on bare tube it is 31% under, and on the one real
segmented line in `.userdata` — `FL-OX`, 540 mm of 1/2 in. × 0.035 with two
elbows and a tee, into 1200 mm of 3/8 in. × 0.035 with an elbow and a ball
valve — lumping it to the mean bore reads **375.8 psi as 134.3 psi**, 64% under,
at 1.95 kg/s of LOX. Always in the unsafe direction, because the fittings in
the tight half get priced at the wide half's velocity head.

That 375.8 psi is itself worth a look: it is 36 m/s of LOX through the 3/8 in.
half. Whatever the drawing was for, that line is not sized for this engine —
which is the sort of thing the itemised path exists to make visible before
somebody bends the tube.

**A measured curve is continued past its ends, not clamped or refused.**
`MeasuredElement` raises outside its range and for a whole component that is
right — the run *is* the measurement. A segment is different: it is one part of
a run whose other parts still have physics, and a Newton iterate overshoots by
its nature. Clamping is the worse of the two obvious options, and not
conservatively so: a flat Δp above the last point takes the flow dependence out
of the branch equation, which makes the Jacobian singular. So it is continued as
Δp ∝ ṁ², which is the turbulent law the curve is a measurement of rather than a
shape invented to fill a gap.

## The cut-list trap, measured

The plan's 1.6 m / three-elbow example, run through the reader: 72 mm of arc
removed, and **3.69% off Δp** — a little more than the ~2% estimate, because
friction is a larger share of that particular run than half. Confirmed against
Darcy–Weisbach worked by hand rather than against the other code path; a
one-segment run also reproduces the existing `darcy` pipe bit-for-bit.

## `union`, `cross`, `bulkhead` — not added, and why

`fluids` has no correlation for any of the three. Adding them means writing a
constant into `correlations.py`, and that module's whole discipline is that it
contributes adapters and deliberately nothing else — so the fault, when a number
disagrees with the book, is always in an adapter and never in a value somebody
typed. One invented constant costs that property permanently.

What is true instead:

- **A union's loss is its through-bore.** A JIC or AN union in a straight run
  with a full bore is hydraulically nothing (Crane treats couplings and unions
  as negligible); one with a restricted bore is a contraction and an expansion,
  which the segment reader **already prices** — either from the fitting's own
  `boreMm`, or from the bore step if the union is drawn as its own segment.
  Recording the bore is worth more here than adding the kind.
- **A cross is two tees.** Crane's own guidance is to treat it as a tee for the
  run and a tee for the branch, and both already exist as `tee_run` and
  `tee_branch`.
- **A bulkhead is a union that goes through a wall.** Same answer.

If, after that, the three kinds are still wanted as first-class rows — and there
is a good argument for it, since a row somebody can point at beats a bore they
have to remember to type — then say so and they go in with a cited constant and
a test. The **safe failure already exists** either way: an unrecognised fitting
kind is carried through and reported, never silently dropped, so a drawing that
adds them before feed-twin does produces a warning naming the kind rather than
a quietly cheap line.

## `fitting` in `LINE_SPECS`

Keep it. A line that is one fitting is a legitimate thing to draw, and feed-twin
still maps it to the `fitting` component; it costs nothing to keep and removing
it would break drawings that already use it.

## One thing going the other way

Four parameters in `untitled-2` are saved with `source: "verified"` and
`source: "estimate"` — the display *labels* from `PROVENANCE_LABELS`, not the
values from the `Provenance` type, which is `measured | manufacturer |
estimated | default` on both branches and matches feed-twin exactly. feed-twin
refuses them rather than defaulting, by design, so `current.json` will not load:

```
diagram:KB-1: parameter 'pressure' has source 'verified';
expected one of default, estimated, manufacturer, measured
```

No source file on either branch writes those strings today, so this looks like
data left by an older build rather than a live bug. It does block "open the same
diagram in both apps", which is the acceptance test for the canvas work, so it
is worth a migration on save — or a one-off fixup of the four values.
