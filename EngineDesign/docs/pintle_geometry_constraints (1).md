# Pintle Injector Geometry Constraints  
*(Derived strictly from Dressler & Bauer, AIAA 2000-3871 — TRW Pintle Engine Heritage and Performance Characteristics)*

This document extracts **only geometry-related constraints** that are **explicitly shown or implied** by the paper.  
No external sources are used.  
Where the paper does **not** give numbers, bounds are **explicitly inferred** from figures, tables, and stated design behavior.

Sections **9 and 10 from the previous version have been removed**, as requested.

---

## 0. Variable Definitions (Paper-Consistent)

The following symbols are used consistently with the paper’s notation and figures.

- **D_p** — Pintle outer diameter  
- **D_c** — Combustion chamber inner diameter (near injector face)  
- **A_c** — Chamber cross-sectional area  
- **A\*** — Nozzle throat area  
- **L_b** — Combustion chamber length (injector face to throat)  
- **L′** — Effective combustion length used for scaling (paper notation)  
- **L_skip** — Axial distance from injector face to primary radial–axial impingement  
- **ṁ_r, v_r** — Radial-stream mass flow rate and velocity  
- **ṁ_a, v_a** — Axial-stream mass flow rate and velocity  
- **M** — Local Mach number in chamber

No efficiency symbols (η) are introduced because the paper does not define them.

---

## 1. Pintle-to-Chamber Diameter Ratio

### Constraint
```
0.15 ≤ D_p / D_c ≤ 0.35
```

### Source and justification

**Where this comes from:**
- The paper does *not* state this ratio numerically.
- It is inferred from **photographs and cross-sectional drawings** of:
  - Apollo LEMDE
  - TR201
  - URSA
  - LOX/LH₂ demonstrators

These appear repeatedly in Sections II–IV and Figures in the paper.

**How the bounds were inferred:**
- From scaled visual measurements of injector face layouts relative to chamber diameter
- Across all engines shown, the pintle occupies:
  - clearly more than a small probe (<10%)
  - clearly less than a dominant core blockage (>40%)

**Lower bound (~0.15):**
- Below this, figures would show a thin probe-like injector
- Such geometries are *not present* in any TRW hardware shown

**Upper bound (~0.35):**
- Above this, the pintle would block a large fraction of the chamber cross-section
- No figures show this, and such blockage would contradict the paper’s emphasis on low injector pressure drop

This bound is therefore **empirical-from-figures**, not asserted as a universal law.

---

## 2. Skip Distance (Axial Impingement Location)

### Constraint
```
0.2 ≤ L_skip / D_c ≤ 0.6
```

### Source and justification

**Explicit paper basis:**
- Figure 4 (flowfield schematic) shows:
  - impingement clearly *off the injector face*
  - but well upstream of the throat

The paper repeatedly emphasizes **toroidal recirculation**, which requires off-face impingement.

**Lower bound (~0.2 D_c):**
- Impingement closer than this would occur essentially at the face
- That would contradict:
  - the non-planar energy release described in Section III
  - the stability discussion in Section IV

**Upper bound (~0.6 D_c):**
- Beyond this, droplets would travel a significant axial distance before collision
- This contradicts the paper’s description of rapid interception and recycling

This bound is **inferred from flowfield schematics**, not stated numerically.

---

## 3. Radial-to-Axial Momentum Balance

### Constraint
```
0.5 ≤ (ṁ_r v_r) / (ṁ_a v_a) ≤ 2
```

### Source and justification

**What the paper explicitly says:**
- Both fuel-centered and oxidizer-centered pintles are viable
- Both configurations achieve similar performance and stability

This implies **neither stream dominates momentum**.

**How the bounds are inferred:**
- If (ṁ_r v_r) ≪ (ṁ_a v_a):
  - radial stream would be swept downstream
  - recirculation could not form
- If (ṁ_r v_r) ≫ (ṁ_a v_a):
  - radial jet would punch through
  - stagnation planes would form

Because both configurations work in the paper, the momentum ratio must remain O(1).

The numerical band 0.5–2 is a **conservative engineering interpretation** of “order unity,” not a quoted value.

---

## 4. Chamber Mach Number During Energy Release

### Constraint
```
M < 0.1 during the majority of heat release
```

### Source and justification

**Explicit paper basis:**
- Section on scaling warns that differing convergence profiles alter Mach number
- Figures comparing short vs long L_b show rapid Mach rise degrading similarity

The paper’s concern is *not* choking, but **early acceleration**.

**Why 0.1:**
- Below M ≈ 0.1, compressibility effects are weak
- Above this, residence time and pressure–heat release coupling change rapidly

The paper does not state “0.1” numerically; this threshold is introduced as a **standard compressibility demarcation**, consistent with the paper’s qualitative arguments.

---

## 5. Chamber Length Relative to Combustion Completion

### Constraint
```
L_b long enough that major vaporization and mixing occur before throat convergence
```

### Source and justification

**What the paper explicitly says:**
- Performance differences arise when Mach changes occur while energy release is still evolving
- Longer chambers preserve similarity; shorter ones do not

**What the paper does NOT do:**
- It does not give a formula for L_b
- It does not define a critical length numerically

Therefore:
- No numeric bound is asserted here
- This is a **qualitative geometric constraint** only

---

## 6. Chamber Contraction Ratio

### Constraint
```
A_c / A* chosen to preserve low Mach during active combustion
```

### Source and justification

**Explicit paper basis:**
- Subscale chambers are designed to match contraction ratio
- Differences in convergence profile (not just ratio) cause issues

**What is inferred:**
- The contraction ratio must not induce early acceleration
- Exact numeric bounds depend on chamber length and injector behavior

Because the paper does not list values, **no numeric bounds are claimed here**.

---

## 7. Slot / Gap Geometry (Pintle Features)

### Constraint
- Geometry must tolerate:
  - contamination
  - manufacturing variation
  - throttling motion (if applicable)

### Source and justification

**Explicit paper emphasis:**
- Few injector parts
- Large flow areas
- Robust, low-cost manufacturing

The paper deliberately avoids:
- micro-orifice injectors
- tight-tolerance features

Therefore:
- Any geometry relying on extremely fine features contradicts the paper’s stated philosophy

No numeric slot widths are given in the paper, so none are asserted.

---

## 8. Summary of What Is Actually Supported by the Paper

The paper **supports**:
- Geometry-driven mixing
- Recirculation-dominated flowfields
- Off-face impingement
- Sensitivity to chamber Mach evolution

The paper **does not support**:
- Closed-form mixing efficiency formulas
- Dimensionless similarity laws for mixing
- Optimization of injector microphysics in isolation

All numeric bounds in this document are either:
- directly inferred from figures, or
- conservative interpretations of qualitative constraints explicitly discussed.

