# feedtwin

The propellant feed system physics core: real-gas properties, a component
library, a network solver, and the transient response of the whole system from
COPV to injector face.

This is a **library, not a service**. It has two callers with incompatible
needs — the `feed-twin` web app, and EngineDesign's optimizer calling it
in-process thousands of times per run — and only a plain importable package
serves both. Nothing here imports a web framework, and a test enforces that.
See [ADR-0001](../../docs/adr/0001-feed-system-physics-is-a-library.md).

## Status

**Phase 04 — the steady network solver is in.** Pressure at every node, flow in
every branch — the question this project started from.

```python
from feedtwin.solve import Network, solve_steady, pressure_ladder

net = Network()
net.add_node("tank", "LOX", 90.0, pressure=30e5)
net.add_node("n1",   "LOX", 90.0)
net.add_node("inj",  "LOX", 90.0, pressure=20e5)
net.add_branch("FL-01",  line,  "tank", "n1")
net.add_branch("SOL-01", valve, "n1",   "inj")

print(pressure_ladder(net, solve_steady(net)))
```

```
Steady solve: converged in 7 iterations (0.9 ms)

branch         from       to               mdot         dp      p_out
                                           kg/s        bar        bar
--------------------------------------------------------------------
FL-01          tank       n1             1.0237     5.8746    24.1254
SOL-01         n1         n2             1.0237     0.9897    23.1357
FL-02          n2         inj            1.0237     3.1357    20.0000

mass conservation: worst node imbalance 0.000e+00 kg/s
resting on library defaults: FL, K_minor, elevation_change, roughness
```

Unknowns are one pressure per free node and one flow per branch; equations are
one mass balance per free node and one pressure relation per branch. Almost all
of the Jacobian is the constant incidence matrix — only one scalar per branch is
nonlinear, so a new component needs no derivative to work with the solver.

**Mass residuals are reported on every run, never sampled.** A Newton solve will
happily converge on a system that does not conserve mass, and that failure looks
exactly like success.

Steady, isothermal, single-phase. Node temperatures are given rather than
solved. Phase 05 adds the gas side, Phase 07 the transient.

**Phase 03 — the liquid-side component library.** Pipes, fittings,
orifices, valves and check valves, every correlation from `fluids`.

```python
from feedtwin.comps import build_component, conditions_from_fluid
from feedtwin.model import ComponentInstance, Param, Provenance
from feedtwin.props import Fluid

line = build_component(ComponentInstance.build("FL-01", "pipe", {
    "length": Param(2.0, "m", Provenance.MEASURED, "drawing"),
    "bore":   Param(7.75, "mm", Provenance.MANUFACTURER, "3/8 x 0.035 tube"),
}))
lox = conditions_from_fluid(Fluid("LOX"), p=3.0e6, T=90.0)
line.pressure_drop(0.5, lox)          # Pa
line.diagnostics(0.5, lox)            # velocity, Re, friction factor, regime
```

Validated against things outside this codebase — a laminar pipe against
Hagen–Poiseuille exactly, a fitting against the definition of *K*, and a valve
against the definition of **Cv** itself (one US gpm of water, one psi), which it
reproduces to 0.07% independently of bore.

Each component exposes its physics twice: `pressure_drop(mdot, flow)` is the
causal form that the validation tests call directly, and `residuals(ctx)` is the
acausal form the Phase 04 solver will consume. That interface is still
provisional — keeping the physics in `pressure_drop` is what makes reshaping it
cheap.

Every type also carries a `measured` model that reads a flow-against-drop curve
and supersedes the correlation outright. Unlike the property layer, it does
*not* fall through outside its range: a property has a defensible fallback in an
equation of state, a component does not, and switching to a correlation halfway
up a flow sweep would put a kink in the result nobody would see.

**Phase 02 — the parameter and component model.** Every number describing
hardware carries where it came from, component schemas are data, and a part
number resolves into a configured component.

```python
from feedtwin.model import Param, Provenance, ComponentInstance

line = ComponentInstance.build("FL-01", "pipe", {
    "length": Param(18.0, "in", Provenance.MEASURED, "tape, 2026-09-08"),
    "bore":   Param(0.305, "in", Provenance.MANUFACTURER, "3/8 x 0.035 tube"),
})
line.si("length")      # 0.4572 — SI, converted once at the boundary
line.assumptions()     # ['elevation_change', 'roughness'] — nobody set these
line.provenance()      # {'measured': 1, 'manufacturer': 1, ..., 'default': 2}
```

There is **no default for `source`**. A number with no provenance is a
validation error, because "nobody remembers where this came from" is the state
this layer exists to make impossible — and it is the state most of a propulsion
team's numbers are in by the second year.

Three things follow from the schema being data:

- **Units are checked by dimension.** A pressure written where a length belongs
  fails at load with both dimensions named. `psig` is deliberately *not* a
  registered unit — gauge is a reference, not a unit, and accepting the spelling
  would put every gauge-authored pressure one atmosphere low.
- **Component types are declared in
  [`model/components.toml`](feedtwin/model/components.toml)**, so adding one is
  a data edit and Phase 03 supplies only physics.
- **Datasheet and measured values are kept apart.** A measurement overrides a
  claim without erasing it, so "this valve flows 5% under its rating" stays a
  question anyone can ask later.

**Phase 01 — the property layer.** Real-gas properties for LOX, ethanol,
nitrogen and helium, sub-microsecond, with measured data able to override the
equation of state.

```python
from feedtwin.props import Fluid

n2 = Fluid("nitrogen")
n2.get("rho", p=3.1e7, T=293.0)     # 309.9 kg/m3 — a COPV at 4500 psi
n2.get("Z",   p=3.1e7, T=293.0)     # 1.150 — 15% off ideal
n2.state(p=5e5, q=0.5).phase        # Phase.TWO_PHASE

rho = n2.accessor("rho", "p", "T")  # bound getter for solve loops
rho(3.1e7, 293.0)                   # 0.63 us
```

| Module | Phase | What lands there |
|---|---|---|
| `feedtwin.props` | 01 | Real-gas properties, tabulated — **done** |
| `feedtwin.model` | 02 | `Param`, `ComponentSpec`, the part catalog — **done** |
| `feedtwin.comps` | 03 | Pipes, fittings, valves, orifices — **done** |
| `feedtwin.solve` | 04 / 07 | Steady network — **done** — then the transient DAE |
| `feedtwin.io` | 11 | The P&ID reader, DAQ readers |
| `feedtwin.fit` | 12 | Parameter identification from test data |

### How the property layer is put together

**A chain, not a branch.** A fluid holds an ordered list of backends. Tabulated
interpolation answers ordinary states in ~0.13 µs; the Helmholtz equation of
state behind it answers whatever the tables refuse. Put measured data at the
front and it wins wherever it has coverage:

```python
tab = TabulatedProperties(p, T, {"rho": measured}, source="CF-2026-03")
n2  = Fluid("nitrogen", chain=[tab, "bicubic", "heos"])
```

Nobody writes the routing. That is the Phase 12 principle — anything modelled
can be replaced by something measured — working from day one, because a seam
added later is a seam every existing call site has to be re-audited against.

**Refuse, never extrapolate.** Outside its envelope a backend raises
`OutOfRange` and the chain moves on. No backend here will return a plausible
number for a state point it cannot actually reach, and physically impossible
inputs (negative pressure, NaN) are rejected before any backend is touched —
otherwise CoolProp reports a failed Brent bracket, which is true and useless.

**Fluids are data.** Species live in [`props/species.toml`](feedtwin/props/species.toml).
Adding a propellant is a data edit; `register_species()` adds one at runtime
without touching the package at all. Same for backends
(`register_backend`) and properties (`register_property`) — each has a test in
`tests/test_props_modularity.py` that extends the package *from outside*, so
the seams cannot rot silently.

### Two APIs, two budgets

| | per call | use |
|---|---|---|
| `fluid.accessor(prop, "p", "T")` | ~0.63 µs | inside a solve loop |
| `fluid.get(prop, p=…, T=…)` | ~0.96 µs | one-off queries |
| `fluid.state(p=…, T=…)` | ~5 µs | reports, frames, diagnostics (12 reads) |

The accessor resolves once what `get` re-derives per call — which state pair the
keywords form, which backends support the property. Both are far under the
184 µs that motivated this layer.

### Tables

CoolProp builds interpolation tables on first use: **2–3 s and ~17 MB per
fluid**, cached in `~/.CoolProp/Tables`. Call `feedtwin.props.warmup()` when a
worker process starts so the cost does not land inside the first solve someone
is timing — the same reason EngineDesign's accelerator front-loads its JIT.

## Install

From a path, like `lib/stardesign` — repo-internal, versioned with the repo,
never published:

```bash
pip install -e lib/feedtwin
```

## The physics stack

Almost none of this physics should be written here. Each dependency carries a
body of validated correlations that would take years to reproduce and would be
worse:

| Package | Carries | Used from |
|---|---|---|
| **CoolProp** | Helmholtz-energy equations of state, 122 fluids, tabular backends | Phase 01 |
| **fluids** | 40+ friction correlations, 244 fittings (Crane TP-410, Hooper 2K, Darby 3K), IEC 60534 valve sizing, ISO 5167 meters, two-phase | Phase 03 |
| **ht** | Convection, boiling, condensation, insulation resistance | Phase 05, 14 |
| **SciPy** | Radau/BDF integrators, sparse LU, least-squares | Phase 04, 07, 12 |

Library calls are **wrapped, never made raw from solver code**. Two reasons:
the choice of correlation becomes a parameter like anything else (Decision 02
in the plan — nothing hardcoded), and the untyped third-party surface stays
small enough for `mypy --strict` to be worth running.

## The one rule

**Never call `PropsSI`.** Measured on the development host, nitrogen density at
one state point:

| Call path | Per call | Throughput |
|---|---|---|
| `PropsSI('D', 'T', t, 'P', p, 'Nitrogen')` | 184.5 µs | 5.4 k/s |
| `AbstractState('HEOS', ...)`, reused | 3.18 µs | 315 k/s |
| `AbstractState('BICUBIC&HEOS', ...)` | **0.14 µs** | **7.1 M/s** |

A 1300× spread across three spellings of one line. `PropsSI` re-parses the
fluid name and rebuilds its backend on every call; the low-level interface does
that once. A stiff transient evaluates properties millions of times over
Jacobian assembly, so this is the difference between a run that finishes in
seconds and one that finishes overnight.

`tests/test_property_call_discipline.py` fails the build on any `PropsSI`,
`Props1SI`, `HAPropsSI` or `PhaseSI` call under `feedtwin/`. Tests are exempt —
comparing the two paths is how the numbers above were obtained, and Phase 01's
regression suite needs the reference implementation to check the tabulated one
against.

## Tests

```bash
pip install -e "lib/feedtwin[dev]" && python -m pytest lib/feedtwin/tests -q
```
