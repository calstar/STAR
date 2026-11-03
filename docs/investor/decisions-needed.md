# Decisions the team needs to make

Written 2026-10-17, after the investor dry runs (`dry-run-2026-10-17.md`). Each item
below is something the software cannot decide for the team: fixing it in code would
mean inventing a number or a name. Until each is decided, the demo works around it
and says so (`demo-runbook.md`). Pressures are psia; differences are plain psi.

## 1. What is the engine called, and what thrust does it promise? (D-21)

One engine carries five thrust figures, depending on where you look.

| Where | What it says | Where it comes from |
|---|---|---|
| Hotbench Engine, design picker | **Ethalox 7200N Doublet** | the design document's name (`ethalox-7200n-doublet`); 7.2 kN is the LE4 constant-thrust goal |
| Hotbench Twin, Library and top bar | **ethalox 6800N doublet 578psia 2026-10-05 drilled** (artifact `d8d0f8b3073b`) | the name the engine was pulled under on 2026-10-05 |
| The engine's config | `design_thrust` **6,500 N** at 377.7 psia chamber, tanks 578 psia | the Optimizer's target (Min L* = Max L* there) |
| Hotbench Engine, Forward Mode | **6.87 kN** | the design evaluated at 578 psia tanks |
| Burns on LE4 (6), helium | **6,779 N** (Layer X) and **6,249 N** (the console) | the drawn stand; the two differ by T-0, not by solver (D-20) |

None of these is wrong on its own terms: a goal, a pull name, an optimizer target, an
ideal evaluation and two stand burns. Shown together under three names, they read as
three engines.

**Decide:**

1. One name for the design and for the library engine that states what it delivers
   on the stand (for example "LE4 ethalox doublet, 6.8 kN"), and whether 7.2 kN stays
   the stated goal.
2. Whether `design_thrust` should be raised from 6,500 N to the thrust the hardware
   was drilled for, so the Optimizer's target matches the name.

**Then:** rename the design in Hotbench Engine, pull the engine into the twin again
(so its card and its name come from the design, and `/api/library/{id}/freshness`
says it is current), and re-run the demo's numbers. Nothing was renamed tonight: the
names are the team's, and the demo data is a copy of the team's own.

## 2. Which regulator droop do the burns assume? (D-22)

The helium-versus-nitrogen result rests on a number that is not on the drawing.

The LE4 (6) drawing gives the press regulator (the 1092-50) no flow droop, so every
burn uses the library default: **20 psi at a rated 0.05 kg/s**. At the press-gas flow
each burn draws, that default implies:

| Pressurant | Mean press-gas flow | Droop implied by the default | Mean thrust |
|---|---|---|---|
| Helium (run `20261017T090456-0f02a8`) | 18.8 g/s | 7.5 psi | 6,249 N |
| GN2 (run `20261017T090530-254ed7`) | 132.4 g/s | 53 psi | 5,732 N |

Most of the 517 N gap between the two is that droop: nitrogen needs seven times the
mass flow to fill the same ullage, so on a linear droop it sags seven times as far.

The team's September water flows (DAQ Run Viewer, regulated flow tests of 7, 8 and
13 September 2026, bottle 1,475–2,915 psia, lockup about 515–565 psia) measured far
more. The tanks sagged 110–200 psi (fuel) and 190–250 psi (LOX) within half a second
at about 45–150 g/s of nitrogen, an effective droop of **37–230 psi per 0.05 kg/s**,
against the default's 20. With the bottle down near 515 psia the path was wide open
and still dropped 100–200 psi from bottle to tank at 20–35 g/s (an effective press-leg
Cv of about 0.25). No regulated test above 2,915 psia exists. Run with press behaviour
like those tests, Layer X gives LE4 4.7–5.7 kN on GN2 and 5.3–6.5 kN on helium at the
drawn dome.

So the twin's nitrogen burn is optimistic, and its helium advantage is computed on a
droop the stand has never shown.

**Decide:**

1. Whether to fit the regulator's droop, its supply effect and the press-leg Cv from
   the September water-flow runs and put them on the LE4 drawing, with the run ids as
   their provenance (the twin reads them from there; it never invents them).
2. Until that is done, whether the default should stay at 20 psi per 0.05 kg/s, or
   move to a value inside the measured 37–230 psi band and be marked an estimate.
3. Whether to run a regulated flow above 2,915 psia bottle pressure, which is where
   a hot fire starts and where no data exists.

**Until then:** do not put a helium-versus-GN2 figure on a slide without the caveat
that it rests on an assumed droop the water flows contradict.

## 3. Which LE4 drawing is current? (D-82)

Two LE4 drawings are in use.

- **LE4 (6)** (`a22f706b60be`), imported 2026-10-07. The demo runs on it, and so do
  the dry-run numbers above. The demo's "LE4" stand document pairs it with the engine,
  with the console's seat model off, a dewar fill Cv of 0.013 and a COPV fill of
  4,014.7 psia.
- **LE4 (1)** (`450004ef65c2`), under the stand **LE4(real)** saved on 2026-10-10.
  Against LE4 (6) it adds a relief valve, two rotary valves and a solenoid, pairs the
  LOX-vent disconnects, and drops one motorised valve.

**Decide:** which drawing is the stand. If it is LE4 (1), add `450004ef65c2` to
`FEEDTWIN_KEEP` at the top of `scripts/demo.sh`, run `scripts/demo.sh --reset`, and
re-rehearse; the numbers in the runbook were measured on LE4 (6).

## 4. What the drawing still needs (D-28, D-29)

The checks now list these as "The drawing needs", not as faults, and the twin stands a
stated default in for each until the drawing gives it. They are the team's to fill in;
nothing here was filled in by software.

- **Vessels:** no MAWP on Eth-Tank, LOX-Tank or the COPV. The tanks are drawn at
  8.19 L, where the engine config carries 6.44 L and 6.20 L. The COPV wall is
  modelled as a 6.4 kg steel K-bottle, not the composite bottle it is.
- **Relief valves:** no set pressure.
- **Lines:** 99 with no length or bore; the LOX line has no height.
- **Fluids:** 28 components with no fluid reaching them.
- **The GSE page does not join where it looks joined:** the OX fill lines stop on
  open ends beside OF-QDA, so OF-QDA has no line on it; the fuel-fill manifold stops
  one grid step from FF-QD-Pressure; OV-QD-A and QD-OV-B are unpaired; HP-QD-B names
  HP-QD-A as its mate, and HP-QD-A names nobody (that still reads as a pair, but say
  it on both halves). The checks flag each of these now; the drawing itself was not
  edited.
