# Notes for whoever is working on pid-designer

Written from the feed-twin side, September 2026, after Phases 01–09 of the
physics core. This is what the Phase-11 reader will need from a drawing, what
you have already got right, and three things worth changing while you are in
there.

**None of this is urgent.** feed-twin does not import P&ID documents yet — that
is Phase 11. The point of writing it now is that the cheapest time to align a
schema is before either side has data in it.

## What you have already got right

Genuinely — this took no coordination and it lines up:

- **`ParamValue` mirrors `feedtwin.model.Param`** exactly: value, unit, source,
  reference. The Phase-11 reader will be a field copy, not a translation.
- **Unit spellings match `feedtwin.model.units`.** `psi`, `mm`, `Cv`, `K`, `L`.
  Anything else is rejected at load in the physics core, so offering it in the
  dialog would only move the failure somewhere less helpful.
- **No `psig`.** Correct, and worth defending if anyone asks for it. A pressure
  typed as psig and stored as psi is one atmosphere low, silently, everywhere
  downstream.
- **Species ids match `feedtwin/props/species.toml`** — `oxygen`, `ethanol`,
  `nitrogen`, `helium`, `methane`. The reader resolves them directly.
- **`source` has no default.** Right. feed-twin's run report counts every
  assumed parameter and shows them in the app; a drawing that quietly defaulted
  provenance would make that count a lie.
- **Fluid declared at sources and inherited, with conflicts reported rather
  than blended.** This is exactly what the physics core wants, and the conflict
  case is a real check rather than a nicety.

## Three things worth changing

### 1. Orange and red are too close to plot together

`ROLE_COLORS` gives fuel `#f97316` and pressurant `#ef4444`. On a schematic that
is fine — position and labels separate them. On a **chart** it is not: those two
are ΔE 10.4 apart in *normal* vision, below the 15 threshold at which people
reliably tell two lines apart, and worse under deuteranopia.

feed-twin therefore uses a second, validated palette for traces and keeps your
role colours for the station ladder, where each row is labelled. Nothing for you
to change *unless* pid-designer grows plots of its own — if it does, don't reuse
the role colours for series. The validated four are
`#426dd7 #be8700 #b83251 #32a88e`.

If you want to make the schematic itself more robust, moving pressurant toward
`#e0457b` (rose) would separate it from fuel at a glance without touching the
"pressurant reads as warning-coloured" instinct.

### 2. A line needs a bore and a length, and a fitting tally

This is the big one for Phase 11, and it is worth knowing before you shape the
edge data model.

A drawn line is not a pipe. To price it, feed-twin needs, per segment:

| field | why |
|---|---|
| `bore` | the **flow diameter**, not the thread size. A 3/8 in. NPT fitting does not have a 3/8 in. bore, and using the thread size under-predicts loss by several times. |
| `length` | developed length along the centreline. |
| `roughness` | material, effectively. Drawn stainless is ~0.0015 mm; the Crane tables assume commercial steel, which is 30× rougher and doubles every fitting's K. |
| `K_minor` **or** a fitting tally | fittings are ~50% of a line's resistance. Ignoring them halves the answer. |
| `elevation_change` | signed. A metre of LOX is 1.6 psi and it does not reverse when the flow does. |

On the tally: we measured this. **Fittings at the same bore are order-free**
(0.003% effect), so a tally is enough and nobody should be made to place them.
**Bore changes are not** — 1/4→3/8→1/2 costs 4.56 bar where 1/2→1/4→3/8 costs
9.72 bar, a 2.1× difference. So the shape that works is *ordered segments, each
holding an unordered tally*:

```
Line FL-01
  ├ Segment  1/4 x 0.035 tube · 0.30 m   { elbow_90: 2, tee_run: 1 }
  ├ Segment  3/8 x 0.035 tube · 1.20 m   { elbow_90: 3, union: 2 }
  └ Segment  1/2 x 0.049 tube · 0.40 m   { elbow_90: 1 }
```

The transitions between segments are *derived* from the bores — nobody types a
contraction. Segments are ordered because their bores are.

**This lives in feed-twin for now.** ISA-5.1 omits routine fittings deliberately
and a P&ID should stay a P&ID; parity is worth doing later and is deferred, not
dropped. But if you are reshaping edge data anyway, leaving room for an ordered
list of segments on an edge would save a migration.

### 3. Manifold ports carry the fitting, not a thread

If you model manifolds: every port on the team's blocks is female, so the port
itself carries no information — **the fitting screwed into it is the whole
story**. What feed-twin needs per port is a bore, a K for whatever is in it, and
which of three kinds it is:

- `flow` — carries mass.
- `instrument` — a PT tap. No flow ever; it reads plenum pressure exactly.
- `conditional` — a relief or burst disc: shut now, a flow path when it opens.

The last distinction is why the kind is declared rather than inferred. A shut
relief and a capped port are topologically identical and physically nothing
alike, and only one of them belongs in a burst analysis.

## Two findings from the physics side you may care about

**A perfect regulator has no answer.** A regulator modelled with zero flow droop
holds its setpoint at any flow, which makes its branch equation satisfied for
*every* mass flow — the flow is genuinely indeterminate. If pid-designer's
regulator spec offers `setpoint` and `Cv`, it should also offer **droop at rated
flow** and **rated flow**, or a drawing will produce a model that cannot be
solved transiently. The supply-pressure coefficient (outlet rise per unit of
inlet decay — ours is 14.7 psi per 1000 psi) is the other datasheet number worth
a field.

**A chamber cannot be a vacuum.** Not your problem, but it explains why the
engine symbol will eventually need an ambient pressure: chamber pressure is
`ṁ c*/A_t` only once that exceeds ambient, because the nozzle is open to
atmosphere.

## Where the contract lives

- `feedtwin/model/components.toml` — what each component type *has*: params,
  their dimensions, options, and which fidelity models use them. The names to
  match are here.
- `feedtwin/model/units.py` — the registered unit spellings.
- `feedtwin/props/species.toml` — the species ids.
- `feedtwin/comps/manifold.py` — the port taxonomy above, with the reasoning.

If a name has to differ, say so in a comment on both sides rather than adding a
mapping table — a mapping table is where these drift.
