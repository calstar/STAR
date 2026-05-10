# Pintle Injector Geometry Constraints (Derived from TRW Pintle Engine Heritage Paper)

This document summarizes the **geometry constraints implied by the TRW pintle injector paper** (Dressler & Bauer, AIAA 2000-3871) and explains **how the bounds are justified physically**, not as arbitrary rules of thumb.

The goal is **design analysis**, not subscale testing.

---

## 1. Pintle-to-Chamber Diameter Ratio

### Constraint
```
0.15 ≤ D_p / D_c ≤ 0.35
```

### How this bound is obtained

**Lower bound (~0.15):**
- Radial jet momentum scales with pintle diameter
- Below ~15% of chamber diameter:
  - Radial penetration weakens
  - Toroidal recirculation collapses
  - Flow becomes quasi-axial (behaves like a poor coaxial injector)

**Upper bound (~0.35):**
- Pintle begins to block the core
- Excess pressure drop across injector
- Recirculation zones merge or stagnate

### Evidence from paper
- Visual inspection of LEMDE, TR201, URSA, LOX/LH2 engines
- Consistent toroidal flowfield descriptions
- No engines shown outside this ratio band

---

## 2. Skip Distance (Axial Impingement Location)

### Constraint
```
0.2 ≤ L_skip / D_c ≤ 0.6
```

### Physical reasoning

**Too short:**
- Impingement occurs at injector face
- Planar energy release
- Increased acoustic coupling risk

**Too long:**
- Droplets free-stream before collision
- Reduced secondary breakup
- Lower effective residence time

### Paper basis
- Figure 4: Recirculation zones depend on off-face impingement
- Repeated emphasis on toroidal (not planar) mixing

---

## 3. Radial-to-Axial Momentum Ratio

### Constraint
```
0.5 ≤ (ṁ_r v_r) / (ṁ_a v_a) ≤ 2
```

### Why this matters

Radial momentum must:
- Reach chamber wall (film cooling)
- Drive recirculation zones

But must not:
- Fully penetrate annular jet
- Create stagnation planes

### How bounds are inferred
- Paper reports both fuel-centered and oxidizer-centered pintles working
- Implies near-unity momentum balance
- Extreme dominance of either stream would break symmetry

---

## 4. Chamber Mach Number During Combustion

### Constraint
```
M < 0.1 until ≥70% heat release completed
```

### Justification

- High Mach number:
  - Shortens residence time
  - Suppresses droplet recycling
  - Destabilizes recirculation

### Evidence
- Explicit warnings about convergence profile sensitivity
- Figures comparing Mach profiles (short vs long L_b)
- Pintle chambers are consistently longer than conventional chambers

---

## 5. Chamber Length vs Droplet Lifetime

### Constraint
```
τ_res ≥ 2–3 × τ_vap
```

### Reasoning

- Pintle injectors rely on:
  - Secondary breakup
  - Droplet interception
  - Recirculation-driven vaporization

If residence time is marginal:
- c* drops
- heat flux spikes
- efficiency becomes geometry-sensitive

### Implied by:
- High L* values used historically
- Performance consistency across throttle range

---

## 6. Chamber Contraction Ratio

### Constraint
```
4 ≤ A_c / A* ≤ 8
```

### Lower bound
- Prevents early axial acceleration
- Preserves recirculation

### Upper bound
- Avoids dead zones
- Limits excessive chamber volume

### Source
- Table 1 comparison vs conventional engines
- All documented TRW pintle engines fall in this band

---

## 7. Slot / Gap Geometry Constraints

### Minimum feature size
```
Slot width ≥ 0.5 mm (except microthrusters)
```

Reason:
- Contamination tolerance
- Manufacturing robustness
- Injector insensitivity (explicit design goal)

### Slot count
- Small engines: continuous gap or many slots
- Large engines: 6–12 slots

Based on:
- Water flow images (spoke persistence)
- Discussion of secondary breakup via wall impingement

---

## 8. Throttling-Specific Constraint (If Applicable)

### Requirement
- Injection velocity must remain approximately constant under throttling

### Geometry implication
- Variable-area injector (movable sleeve)
- Throttling by ΔP alone is unacceptable

### Evidence
- Apollo LEMDE
- SENTRY and ERIS thrusters
- Repeated emphasis on sleeve-controlled throttling

---

## 9. What Is Explicitly NOT Required

The paper does **not** require:
- Reynolds number similarity
- Weber number matching
- Damköhler number tuning
- Maximized shear

These belong to distributed-element injector theory.

---

## 10. One-Line Design Test

If your geometry ensures:
- Off-face impingement
- Sustained recirculation
- Low Mach during heat release
- Balanced radial/axial momentum

then **mixing efficiency becomes a consequence, not a parameter**.

---

## Summary

This paper does not provide equations.
It provides **geometric invariants**.

Designing within these bounds reproduces the behavior that made pintle engines:
- stable
- throttleable
- scalable
- inexpensive

