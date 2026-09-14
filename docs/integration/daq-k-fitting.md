# Fitting line K from DAQ cold-flow data

**Nothing here is built.** This is the note for when it is, and it records a
decision: **the reader belongs inside the DAQ, not in feed-twin.**

## Why it lives in the DAQ

feed-twin does not read DAQ files today and should not learn to. The DAQ owns the
recording — sample rates, transducer calibration, run segmentation, which channel
is which — and every one of those is a moving target that has nothing to do with
feed-system physics. A reader here would be a second, always-stale copy of the
DAQ's own understanding of its own data.

What crosses the boundary should be the *answer*, not the recording: a fitted K
with its provenance, in the shape `feedtwin.model.Param` already has.

## What the DAQ would send

One object per line, per cold-flow run:

```json
{
  "line": "l_ox1",
  "method": "measured_K",
  "K": { "value": 4.8, "unit": "-", "source": "measured",
         "reference": "cold flow 2026-03-14 run 7, 12 points, R^2 0.997" },
  "uncertainty": { "value": 0.4, "kind": "standard_error" }
}
```

or, when a single K does not fit the whole range, the curve itself:

```json
{
  "line": "l_fu1",
  "method": "curve",
  "curve": { "mdot": [...], "mdotUnit": "kg/s", "dp": [...], "dpUnit": "psi",
             "reference": "cold flow 2026-03-14 run 9" }
}
```

**Both shapes already exist and are already read.** `feedtwin.pid.segments`
parses `measured_K` and `curve` on any line segment, and the loss-method ladder
already ranks them above `itemised` and `lumped_K`, so a fitted number wins over
a correlation automatically. `feedtwin.model.Param` carries the provenance and
`Uncertainty` is on the dataclass. Nothing new is needed on the receiving end —
which is the point of writing this down now rather than later.

## How the fit itself works

The physics is not the hard part:

1. Hold the stand at a steady flow with the mains open and the engine replaced by
   an orifice or a dump line. Record upstream and downstream pressure across the
   line, plus mass flow.
2. For each point, `K = dp / (rho v^2 / 2)` with `v` from the measured flow and
   the line's own bore. Everything but `K` is measured or catalogue.
3. Fit `K` across the points. If `K` is flat against Reynolds number, one number
   is the honest answer and it goes back as `measured_K`. If it trends, the line
   is not a single resistance and the curve goes back instead.
4. **Subtract nothing.** Fit the line as drawn, including its fittings. The whole
   value of a measured K is that it does not depend on the fitting-K bookkeeping
   being right — see the double-count trap in `docs/integration/line-loss-plan.md`.

The one real subtlety: the DAQ's transducers are calibrated in
`daq-server/calibration/*.json` as ADC→PSI polynomials. Those are transducer
calibrations, **not** line coefficients, and the two should never be conflated.
A K fit consumes the calibrated pressures, it does not produce a calibration.

## Where it would arrive

`POST /api/library/fits` on feed-twin, or the same live-source mechanism the
engine and drawing already use (`/api/sources/{key}/import`) with `daq` as a
third source. The latter is the better fit: the DAQ is a design tool like the
other two, the artifact is content-addressed like the other two, and the
provenance string comes out in the same shape.

## What this closes

The stand's line losses are currently dominated by `K_minor` values whose
provenance is `estimated` — literally "fitting tally". Sweeping the two biggest
by ±50% moves predicted thrust from 4969 N to 5897 N. Every other number in the
twin is measured or catalogue; these are the guess, and this is how they stop
being one.
