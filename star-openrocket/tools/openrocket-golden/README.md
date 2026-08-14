# OpenRocket golden runs

`physics/openrocket.py` is a port of somebody else's model. The tests in
`tests/test_openrocket.py` are strong — they reproduce OpenRocket's own JUnit
values exactly, and they show the Euler stepper converging onto our RK45 with
the residual fully attributed to gravity and density. But every one of them
compares the port against *source I read*, not against *the program you run*.

This closes that gap: export a descent from the OpenRocket GUI, commit the CSV,
and `compare_golden.py` diffs the port against it.

## Why there is no Java here

The first design for this was a Gradle project and a Java driver that built a
rocket programmatically against OpenRocket as a git submodule. That was
scrapped, and the reasoning is worth keeping:

* OpenRocket **already exports simulation data to CSV** from the GUI
  (`File → Export`, or the Export tab of the simulation dialog). A driver would
  have reimplemented a feature that ships with the program.
* The driver's hard part was making a motorless rocket air-start at apogee
  without tripping the launch/liftoff logic. That is exactly the kind of code
  that looks finished and is wrong, and it would have sat between you and the
  answer.
* It would have put a JDK, Gradle and a 275 MB submodule into a Python/Node
  repo, for a file you regenerate about twice a year.

You build the vehicle in the GUI anyway to sanity-check it. This uses that.

## Pinned version

**`release-24.12`**, commit `133b558d` — the latest full release.

Do not compare against a build from the `unstable` branch. Its
`ExtendedISAModel` adds a geopotential-altitude conversion and a
humidity-dependent gas constant that no released OpenRocket has, so the density
differs and the golden run will disagree with the port for a reason that has
nothing to do with the port. `physics/openrocket.py` is written against 24.12
and says so at the top.

If you want the source to read alongside the port:

```bash
git clone --depth 1 --branch release-24.12 \
    https://github.com/openrocket/openrocket.git /tmp/openrocket
```

Deliberately **not** a submodule: 275 MB of Java that nothing in this repo
builds, imports or tests against is a checkout cost on every clone for no
return. The version is pinned in three places that CI can see —
`physics/openrocket.py`, `backend/routers/crosscheck.py` and this file — and
`tests/test_openrocket_golden.py` asserts the CSV header agrees.

## Producing a golden run

1. Build the vehicle in OpenRocket 24.12 so that it matches a config in
   `tests/fixtures/`. What has to match, and nothing else does:

   | Our config | OpenRocket |
   |---|---|
   | `vehicle.m` | total mass at apogee — use a component mass override |
   | `vehicle.h_a` | the AirStart extension's altitude, velocity 0 |
   | `site.z_site` | launch site altitude (630 m for FAR) |
   | `site.T_pad` / `p_pad` | launch conditions; **turn ISA off** |
   | `devices[].CdS` | the parachute's `Cd × Area`. Only the product matters — OpenRocket divides by the reference area and multiplies it straight back, so it cancels |
   | `devices[].trigger` ALTITUDE | deployment altitude, with our `delay` as the deploy delay |
   | `devices[].trigger` TIME | deploy at **apogee** with delay `trigger.value + delay` |

   Set latitude to 35.3533 (FAR) and leave wind at zero.

2. Add the **Air-start** simulation extension (Simulation → Edit → Extensions →
   Air-start) at `h_a` with velocity 0. This is a supported OpenRocket feature,
   not a workaround — it is why no custom driver is needed.

3. Run the simulation, then export to CSV with at least these columns:
   **Time**, **Altitude**, **Vertical velocity**, **Vertical acceleration**.
   Leave the comment character as `#` and the units as SI.

4. Save it as `tests/fixtures/openrocket/<config-name>.csv` next to the config
   it corresponds to.

## Checking the port against it

```bash
.venv/bin/python tools/openrocket-golden/compare_golden.py \
    tests/fixtures/worked_example.json \
    tests/fixtures/openrocket/worked_example.csv
```

It prints a per-channel deviation table and exits non-zero past tolerance.
`tests/test_openrocket_golden.py` runs the same comparison and **skips** when
no CSV is committed, so the suite stays green before anyone has produced one
and starts enforcing the moment somebody does.

## What a disagreement means

Read it in this order:

1. **The coast phase.** Between apogee and the first deployment OpenRocket uses
   RK4 with the full Barrowman aerodynamic model; the port substitutes our
   axial airframe area, because Barrowman needs nose shape, fin planform and
   surface roughness that our config does not carry. Expect the divergence to
   appear here first and to be small — the coast is short and slow. This is the
   one documented approximation in the port, and the whole reason to measure
   rather than assume.
2. **The vehicle does not match the config.** Mass overrides in OpenRocket are
   easy to apply to the wrong component, and ISA mode silently overrides the
   launch conditions you typed.
3. **Only then**, a bug in the port.
