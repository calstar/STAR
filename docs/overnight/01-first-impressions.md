# Running the whole pipeline as a user — first impressions

Written before any fixing, from one pass through EngineDesign → pid-designer →
feed-twin, designing a 7200 N ethalox engine and a helium-pressurised stand from
scratch. Everything below was reproduced by hand; where an audit claimed something I
could not confirm myself, it is marked as such.

**One assumption, flagged loudly.** The brief says "7200kn". 7200 kN is F-1 class.
Everything in this project is a 7000 N ethalox doublet, and EngineDesign's own stored
Design Requirements already read **Target Peak Thrust 7200 N**, Pc 420 psi, O/F 1.65.
I read it as 7200 N. If kN was meant, nothing downstream survives.

## Did the pipeline work end to end?

Yes, and that is worth saying first.

| Leg | Result |
|---|---|
| EngineDesign Layer 1 | converged: 7200.0 N (ΔF/F 4.4e-7), O/F 1.67, Pc 423.5 psi, Isp 236.1 s, ṁ 3.109 kg/s, stability 0.66 "stable" |
| EngineDesign → feed-twin | live pull works; artifact `aeb1418`, **zero warnings**, provenance `engine-design:local/ethalox-7200n-doublet@working copy` |
| pid-designer → feed-twin | live pull works; 24 symbols, 19 lines, including 3 VENT nodes |
| feed-twin build | 25 branches, 2 tanks, 8 actuators, 1 informational warning |

The document model across both design tools — checkout with a 10-second lock
heartbeat, immutable named releases, version history, share — is genuinely good
infrastructure, and the provenance discipline (every number carries a source and a
reference) is the best thing in this codebase.

## The five that would stop me shipping

### 1. `POST /flush {}` destroys a document — CRITICAL, fixed
Proven on my own drawing: 23 nodes → `POST /flush {}` → `{"ok":true}` → 0 nodes, and
the empty state committed to version history. `DiagramPayload` defaults `nodes` and
`edges` to `[]`, so an empty body validates. The endpoint's own docstring says it is
"the target of the on-close sendBeacon" — the single request most likely to arrive
truncated. Shared `lib/stardesign` code, so **EngineDesign designs are destroyable the
same way**. Fixed: the body is now an override, and an empty one falls back to the
working copy. 3 regression tests, verified to fail on revert.

### 2. The state machine fails OPEN — Idle → Fire in two clicks
10 of 20 rows in `diablo_transitions.csv` carry 20 cells against a 21-column header.
Malformed rows are dropped, and `can_go` treats a state with no row as *unconstrained*.
Verified live on my stand: `Idle → Fire` is correctly refused, then `Idle → Armed →
Fire` is accepted. The module docstring says the twin "refuses the same sequences the
stand refuses". It does the opposite, silently, and the warning renders in a Console
tab rather than on the control that would act on it.

### 3. No gas vent can ever choke — measured 2.5×–5.5× over
`BRANCH_KINDS` maps every valve symbol to `("valve","cv")`, whose `choked_dp` is the
IEC 60534 *liquid* flashing model and returns None for any gas. A correct `GasOrifice`
with real isentropic choking exists in `comps/gas.py` and **no symbol type maps to it**.
Measured at 550 → 14.7 psi on helium:

| bore | Cv | choked kg/s | model kg/s | ratio |
|---|---|---|---|---|
| 9.53 mm | 3.8 | 0.1762 | 0.4376 | **2.48×** |
| 12.70 mm | 15 | 0.3130 | 1.7273 | **5.52×** |
| 25.40 mm | 60 | 1.2518 | 6.9094 | **5.52×** |

`is_choked()` returns False and `flow_ceiling()` returns None in every case. On my
actual stand the solved flow landed at 0.87× the choked value — close by luck, because
the network's other resistances happened to limit it. The component is unbounded.

### 4. You cannot draw a vent
feed-twin treats atmosphere as a first-class boundary (`BOUNDARY_TYPES = {ENGINE,
INJECTOR, VENT}`). **pid-designer has no VENT** — the string does not occur anywhere
in its frontend, and the 22-item palette has no vent symbol. Every vent in the existing
library was hand-written JSON. A user laying out a stand cannot express "this line goes
to atmosphere", so every vent solenoid they draw is a dead end. Imported VENT nodes do
render, as an unlabelled fallback box with handle id `null`.

### 5. An imported diagram silently loses lines
My 23-node / 17-edge stand imported as **23 nodes and 1 edge**. No error, no console
warning, nothing in the checks panel — which cheerfully reported "2 things to look at"
while 16 of 17 lines were missing. Cause: nodes expose type-specific handle ids
(`KBOTTLE` has `t`,`r` and no `b`; valves have only `l`,`r`; `MANIFOLD` has
`in`,`p`..`p4`; `ENGINE` has `fuel`,`ox`) and React Flow drops an edge whose handle
does not resolve. For a tool whose output drives a simulation, a silently disconnected
line means the twin solves a system that is not the one drawn.

## What the vent tests actually showed

The brief asked: pressurise a tank and vent it — does it work, does the vent drain the
whole connected node, and what does the curve look like?

**It works, and the answer is more interesting than a yes.**

- The fuel tank primes correctly to 550.0 psi, 293.2 K, **2.65 g of helium in 0.426 L**
  of ullage.
- Opening the 3/8" vent takes it to 25 psi in **30 ms**. Hand-integrating a choked
  isentropic blowdown of that same ullage gives **39 ms**. So the duration is right,
  and it is short because a 5% ullage on an 8.67 L tank is only 2.65 g of gas.
- **Lines have no gas volume.** `Node` carries no capacitance and `Branch` no
  inventory; only tank ullages and bottles hold mass. So a vent curve here is pure
  ullage blowdown — no line pack-out, no dead-leg tail. That is the model's ceiling and
  it should be stated rather than inferred from a plot that looks clean.
- **Isolation held** on the path I could test: with MV-OX shut, `MVO.out` sat at
  14.7 psi and did not follow the tank down.
- **The LOX tank is the one to worry about.** It primed to 446 psi (not 550) with the
  ullage at 235 K, and vented to 20 psi in 40 ms. There is **no liquid evaporation
  model**, so a cryogen vent shows the ullage emptying in milliseconds where a real LOX
  tank vents for many seconds while boiling and self-sustaining near saturation. For
  planning a real vent operation that is qualitatively wrong, not just imprecise.

## Cross-app integrity

- **Same file, two apps, 2× the fuel flow.** EngineDesign rewrites `discharge.*` Cd on
  every load from `INJECTOR_DISCHARGE_BASELINES`; feed-twin reads the raw YAML and
  defaults `use_geometry_cd` to **False** where EngineDesign's schema defaults to
  **True**. Measured: ox Cd 0.5997 vs 0.4000, fuel 0.5997 vs 0.3000.
- **Thrust imports with no intent fallback.** feed-twin resolves O/F and Pc via
  "intent wins" but reads `chamber_geometry.design_thrust` bare — 7000 N against a
  delivered 7200 N, silently.
- **design_MR vs optimal_of_ratio is staleness, not schema.** A freshly optimized
  design stores `design_MR = 1.6742` and `design_pressure = 423.5 psi`, both consistent.
  They drift only when a target is edited without re-running Layer 1. Nothing stamps a
  config as stale — `design_valid_for` is null in all 17 configs, so the guard that
  exists is unarmed everywhere.
- **The state machine is GN2-only.** Binding it to my helium stand left `PR-CTRL` and
  `SV-HE-VENT` **uncommanded** — no state can operate them, because the shipped machine
  calls that valve "GN2 Vent".

## Config hygiene

Confirmed dead but live-looking: `max_P_tank_O`/`max_P_tank_F` (described as
"auto-converted from psi"; no conversion code exists), `mixing_model`, `Pc_gate`,
`use_spray_correction`, `spray_penalty_factor`. `copv_free_volume_L` is read only by
the frontend while the backend reads a key that is null everywhere → assertion →
swallowed by a bare `except` → a **fabricated COPV curve** returned with
`success: False` and nothing surfaced. `pressure_curves` is byte-identical across six
configs spanning two propellant pairs, and a live route simulates from it. Two
checked-in configs fail validation outright. Nested config models use pydantic's
default `extra="ignore"`, so an unknown key under `design_requirements` **vanishes** —
and 19 keys the optimizer actually reads are undeclared, including
`max_chamber_length_m`, which gates the design and silently falls back to 0.50 m.
`U_SLIP_CAP = 50 m/s` is uncited and binds at 2× on the live design; the project's own
`assume()` registry, built for exactly this, is called at three sites and none of them
is a clamp.

## What I am fixing next, in order

1. State machine transition table + fail-closed on a malformed row.
2. Choked flow on gas paths through valves.
3. A VENT symbol in pid-designer, with the handles wired.
4. Import validation that refuses to silently drop lines.
5. Thrust intent fallback; Cd default reconciliation.
6. `extra="forbid"` on the nested config models, with the orphan keys declared.
7. The dead "Thrust Tolerance" field and the confirmed dead config keys.
