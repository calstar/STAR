# Recovery Calculator

1-D vertical descent, canopy inflation, and recovery-system opening loads.
The model, its assumptions and every worked number are specified in
[`PLAN.md`](PLAN.md); this file is just how to run it.

## Why it exists

OpenRocket's descent model has three defects that matter for load-bearing
design work: deployment is a step function with no filling time, shock load is
never computed at all, and airframe drag is dropped after deployment. This
fixes those three and does not attempt anything OpenRocket already does well.

Those three used to be an assertion. They are now measured — the **Cross-check**
tab runs a port of OpenRocket 24.12's descent model and a port of the team's
recovery mastersheets against this one, on the same config:

| | measured on the §13 worked example |
|---|---|
| step deployment | peak deceleration **4.11×** ours, and the altitude trigger fires **7.1 m low** |
| no shock load | our 1613 N against an absence — rendered "not computed", never zero |
| airframe dropped | drogue descent rate 25.56 vs 25.19 m/s here; it grows as the drogue shrinks |

The mastersheets land within 3% of our peak load, by a completely different
route, which is evidence for both. Where they don't, PLAN.md §2.2 says why.

## Quick start

```bash
bash setup.sh                    # venv at .venv
.venv/bin/python -m pytest tests/ -q
.venv/bin/python -m physics tests/fixtures/worked_example.json
```

The CLI prints the descent, the per-device loads, the eq (36) design load and
the four off-nominal cases, at **both** airframe-drag bounds. `--sweep` adds the
16-corner uncertainty sweep; `--crosscheck` adds the three-model comparison;
`--json` emits machine-readable output.

For the GUI:

```bash
./dev.sh        # backend :8100 + frontend :5273, API docs at :8100/docs
```

The ports are load-bearing, not cosmetic (§11.1): `EngineDesign/dev.sh`
force-kills whatever holds 8000, so sharing one would let the apps kill each
other.

## Layout

```
physics/       physics core -- numpy/scipy/pydantic, never FastAPI
    constants.py     ISA constants and unit conversions        [stdlib]
    atmosphere.py    eqs (1)-(7a), the canonical ISA           [stdlib]
    pad_state.py     METAR decode, station pressure            [stdlib]
    schema.py        the Pydantic contract
    devices.py       eqs (8)-(15), the device table
    dynamics.py      eqs (16)-(18)
    solver.py        segmented RK45, the three-class event loop
    loads.py         eqs (19)-(37)
    cases.py         off-nominal set, corner sweep
    report.py        eqs (38)-(39)
    data/            parachutes.csv (121 devices) + raw/<sku>.json
    -- ports of OTHER people's models, for comparison only (§2) --
    openrocket.py    OpenRocket 24.12's descent model   [stdlib]
    mastersheet.py   the recovery mastersheets' model   [stdlib]
    crosscheck.py    all three on one config
backend/             FastAPI on :8100 -- imports physics, never the reverse
    main.py          app, CORS, health
    serialise.py     internal results -> the wire contract the frontend uses
    routers/         simulate, devices, atmosphere, climatology
frontend/            React + Vite + Recharts on :5273
tests/               the §12 validation suite -- the real deliverable
tools/               stdlib-only, no venv needed
    openrocket-golden/   diff the port against a run of the real program
reference/           source material, never read at runtime
    mastersheets/        the two .xlsx, and where their math lives
site-climatology/    stdlib-only, no venv needed
```

The backend is a thin translator: a browser cannot `import physics`, so it
receives JSON, validates it as a `Config`, calls the library, and returns JSON.
FastAPI is chosen because it is Pydantic-native — `schema.py` *is* the wire
contract, with no translation code, which is what §11.7 means by "one
serialiser, no translation layer".

### Two dependency tiers, on purpose

`atmosphere.py` and `pad_state.py` are **stdlib-only**: scalar ISA evaluation is
`exp`, `log` and `pow`, so it needs no numpy. That is what lets
`site-climatology/` import the one canonical copy of PLAN.md §5 rather than
keeping a second copy to get wrong, while staying dependency-free and offline.

The property holds only while `physics/__init__.py` stays empty — an
import there, even a convenience re-export, would pull scipy and pydantic into
every consumer. `tests/test_imports.py` asserts it, and CI asserts it again
from the site-climatology side.

## The validation suite is the point

`tests/` is not incidental coverage. PLAN.md §12 specifies assertions that
cross-check the model against closed forms derived from different assumptions:

| | |
|---|---|
| **eq (48)** | the numerical integrator vs Pflanz, per device. Pflanz has no gravity and no airframe drag, so agreement to ~10% is evidence rather than tautology. **The most valuable test in the suite.** |
| eq (43) | the analytic `X1` vs numerical integration of the reduced opening ODE |
| eqs (50)/(51) | the ballistic phase vs its `tanh` / `ln cosh` closed form |
| eqs (44)-(47) | the scaling laws, each isolating one exponent |
| eq (52) | ALTITUDE and TIME triggers must agree on the same crossing |
| eqs (57)/(58) | the §6.1.4 delay contract |

`tests/test_worked_example.py` runs PLAN.md §13 as a golden fixture: the
document's numbers are assertions against the library, so if the two disagree
CI says so. It has already caught one wrong number in the plan.

The two model ports carry their own suites, and both are validated against the
thing they are a port *of* rather than against this project's opinion of it:

| | |
|---|---|
| `test_mastersheet.py` | every expected value is a **workbook cell**, quoted with its address. The Named Functions survive the `.xlsx` export as `<definedName>` LAMBDAs, so this is transcription with no fitted constants. |
| `test_openrocket.py` | the ISA against **OpenRocket's own JUnit values**, to their own ±0.01 Pa tolerances; then the Euler stepper converging onto our RK45 with the residual attributed to gravity (−0.092%) and density (+0.027%), not to integration. That attribution is what separates "a coarsely integrated different model" from "a bug". |
| `test_openrocket_golden.py` | the port against a run of the actual program. Skips until someone exports one — see `tools/openrocket-golden/`. |

## What this does not do

Phase 1 is 1-D and windless. No drift, no dispersion, no canopy oscillation,
no reefing. §14 lists Phase 2 in priority order; the two that matter most are
an instrumented flight to measure `Cx` (the dominant uncertainty) and the
relative-airspeed fix for near-apogee drogue loads, which is the only item
that repairs a case Phase 1 gets structurally wrong rather than imprecisely.

Read §15 before trusting any number this produces. It lists every
approximation with its cost and its direction, and §15.8 names the five places
the model errs *unsafely*.
