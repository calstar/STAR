# Line walls: what the icicles were telling us

Every component in this model was adiabatic. The stand disproves that in the most
visible way available — run a blowdown and frost, then icicles, form on the fittings
downstream of the regulator.

The question that follows is not "is there heat transfer" but **"is it negligible"**,
and the answer turns out to be *no for the pressurant path, yes for everything else*.

## Two paths, one of them two orders of magnitude down

Icicles look like heat coming *in* from the room. Read the other way round, they are
better evidence for something else: frost on the outside proves the **metal got cold**,
and metal only gets cold by giving its heat to something. That something is the gas.

**Path B — room → frost → tube → gas.** Against the drawn 255 mm press path this is
6 W in still air, 32 W with a generously frosted coefficient. In a 150 g/s nitrogen
stream that is **0.04 to 0.18 K**. The frost cannot carry much latent heat either:
ambient at 50% RH holds about 4.3 g of water per cubic metre, so even 10 W of
condensation would need cubic metres per second of air stripped dry by natural
convection. Path B is not modelled.

**Path A — the line's own metal.** Nitrogen leaves the regulator at 251 K into metal
sitting at 293 K. On the drawn press path that is about 420 g of tube and fittings
holding 200 J/K, and worked as a heat exchanger it is **6.1 K at ignition, 4.4 K
averaged over the burn — 14% of the 30.3 K Joule–Thomson drop.** On a plausible real
stand, a metre of line with ten fittings, 11.3 K, or 37%. Path A is modelled.

Two orders of magnitude between them is what makes this a clean decision rather than a
judgement call.

## What it is worth on a whole stand

5.90 kg of metal across 20 lines, 14 s horizon (`docs/PHYSICS-BENCHMARK.md` 2.4):

| | ox at end | COPV left |
|---|---|---|
| GN2 walls off | 456.3 psig | 512 psig |
| GN2 walls on | **515.5** | **615** |
| He walls off | 551.0 | 559 |
| He walls on | 604.9 | **768** |

The two gases spend the same physics differently. **GN2 has lost regulator authority
by the end**, so tank pressure is set by what the bottle can still deliver and the heat
shows up there: +59.2 psi. **Helium is still in lockup**, so tank pressure cannot move
and the heat shows up entirely as bottle reserve: +209 psi.

Either way the mechanism is the same — warmer pressurant is less dense, so fewer
kilograms hold the same pressure. Neglecting it makes a nitrogen COPV look
substantially more undersized than it is.

## What is deliberately not modelled

**Soak.** No heat transfer with no flow, and no tracking of how a line drifts toward
ambient while a stand sits.

This was a scope decision, not an omission. Modelling it well needs an ambient
boundary, an insulation state, and an hours-long clock on every line. Modelling it
badly means inventing a starting temperature and dressing it as physics — and the
starting temperature is the *only* thing a soak model would produce here, because the
burn is five seconds and the room is Path B.

Instead the wall **starts at the temperature of the fluid its line holds at rest**,
which is where a soak model would converge anyway:

| a line holding | starts at |
|---|---|
| liquid | the liquid's temperature — 90 K for LOX |
| ullage vapour | the ullage gas temperature, *not* the liquid's |
| pressurant | ambient / bottle |

Three tiers, none assumed: each is just the line's own fluid, read off the network
once its temperatures have settled. Read off the network and **not off the drawing** —
at build time a tank node still carries what the drawing declared, which for a LOX tank
is liquid temperature, so seeding there would put a vent line's metal 200 K below the
vapour actually standing in it.

## Consequences worth knowing before you trust a run

**It is a first-run effect, correctly.** The wall holds a fixed number of joules. Fire
twice back to back and the second run sees metal already near the gas temperature —
under 2 K of warming instead of 6. The stand behaves that way too, because the only
thing that recharges the metal is Path B. **Do not benchmark a wall run on a session
that has already burned.**

## Where the numbers go in

On the line, in pid-designer's property panel — one row per run, because that is the
granularity the physics needs. The film coefficient is computed from the gas state at
*that* line's own node, so a fitting on the 4500 psi side of the regulator and one on
the 500 psi side are already different calculations; what the drawing has to supply is
where the metal is.

| field | what to put in it |
|---|---|
| **Fittings on this run** | the count. Turned into metal by the bore: `count × 113 g × (bore/10.92 mm)²`, anchored on a ½ in. tube union and fitted to the ¼–½ in. range, where a body goes as bore^1.82. |
| **Fitting mass (weighed)** | kilograms, and it wins when both are given. Somebody who went and weighed the run has better information than a bore-scaled estimate. |
| **Tube wall** | thickness, for the tube's own metal. 0.035 in. on ½ in. tube. |

**Count on the low-pressure side, weigh on the high side.** The bore-scaled default is a
*tube* fitting, and it is deliberately wrong in two places: a fitting rated for bottle
pressure carries far more metal for the same bore, and a valve body is several unions'
worth. Both are why the weighed override exists.

**`fitting_mass` is the answer, `wall_thickness` is the rounding.** 255 mm of ½ in.
tube is 67 g; the two unions holding it on are about 200 g. The shipped drawings
estimate one union at each end of a run plus one per 300 mm, at 100 g each. That
estimate is tagged `source: estimated` and is the first number to replace with a
measurement.

**Effectiveness must stay well below 1.** On the shipped stands it runs 0.03–0.25. If
it saturates, the answer stops depending on the heat-transfer correlation at all and
the model has quietly become "gas leaves at wall temperature".

## Where it lives

- `lib/feedtwin/feedtwin/comps/wall.py` — `stainless_capacity`, `LineWall`
- `feed-twin/backend/session.py` — `_build_line_walls`, and the exchange inside
  `_propagate_temperatures`
- `Setup.line_walls` / `StudyRequest.line_walls` — off by default
- Study tab → **Thermal** → *Line walls*
