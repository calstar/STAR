# Future improvements

Known approximations and deferred work, with enough context to pick each up later.
Keep entries concrete: what it does today, why that is a simplification, and the
path to a better version.

---

## 1. Rocket inertia is a rod/cylinder approximation

**Today.** The Onshape CAD pipeline extracts per-part mass and centroid, but **not
the inertia tensor**, so the RocketPy flight (`backend/onshape/aero/rocketpy_flight.py`)
approximates the dry rocket's moments of inertia from mass + length + radius:
longitudinal `I11 = I22 ≈ (1/12)·m·L²` (slender rod), roll `I33 ≈ (1/2)·m·r²`
(thin cylinder).

**Why it's a simplification.** Real mass is not uniformly distributed (dense motor
aft, avionics/payload concentrated), so the true longitudinal inertia differs from a
uniform rod — often substantially. Inertia does **not** affect the trajectory,
apogee, max-Q, or static/stability margin (those are force/CP/CG quantities). It
**does** drive the *rotational dynamics*: pitch/yaw angular rates, the oscillation
frequency and damping (`attitude_frequency_response`), and how fast the rocket
weathercocks / settles after a gust. So the AoA-vs-time and angular-rate panels are
qualitatively right but quantitatively approximate.

**Path to better.**
- Onshape's mass-properties API returns the inertia tensor per part; extend the
  build (`backend/onshape/mass.py` / `build.py`) to fetch and store it in the
  manifest, then sum part tensors (parallel-axis) about the rocket axis — same
  CAD-derived philosophy as the mass/CG and CP work.
- Interim without new API calls: integrate inertia from the tessellated geometry +
  per-part mass already in the manifest (mesh moment integrals), which needs no
  extra Onshape quota.
- Validate against a known CAD assembly whose inertia Onshape reports directly.

---

## 2. Airframe drag is a stub Cd(Mach) curve

**Today.** RocketPy is a trajectory solver, not a drag predictor — it requires a
supplied `power_off_drag` / `power_on_drag` as Cd(Mach). We currently feed a **stub
curve** (subsonic Cd0 ≈ 0.45 with a transonic bump), not a CAD-derived value.

**Why it's a simplification.** Drag dominates apogee and max-Q, so those performance
numbers carry real uncertainty until the curve is right. (Note: drag barely affects
the *stability* outputs — CP/margin/AoA depend on CP and CG, not Cd magnitude — so
the stability panels are trustworthy even with the stub; only the performance tiles
are approximate. The UI should say so.)

**Path to better (a CAD-derived drag buildup, mirroring the CP port).**
- **Skin friction** — from **wetted area measured off the tessellated mesh** (a real
  advantage over hand-entry tools) × turbulent Cf(Re) × form factor. Tractable.
- **Base drag** — from the aft/base area (empirical correlation, drops with a boattail).
- **Nose/body pressure (form) drag** — from fineness ratio; small subsonically.
- **Fin drag** — friction over fin wetted area + thickness/leading-edge pressure.
- **Interference** — fin-body junction (empirical).
- **Wave drag (transonic/supersonic)** — the hard, approximate part: drag-divergence
  Mach, transonic rise, nose + fin wave drag. Semi-empirical, as OpenRocket/RASAero do.
- Sequencing: subsonic buildup first (high value, tractable, uses the wetted-area
  edge), transonic wave drag second. Port OpenRocket's drag model for consistency
  with the Barrowman CP port, and cross-check against it.
- **Calibration/validation:** fit Cd from real coast-phase deceleration (altimeter),
  available once the recovery-calculator (flight data / atmosphere / wind) merges in.

---

## 3. CP injection driving the flight (vs. margin overlay)

**Today.** The RocketPy flight is integrated with **native** parametric fins (correct
6-DOF). The ours-vs-RocketPy CP comparison is a **margin overlay** on the same flight:
our `cp_axial_at_mach` over Mach(t) vs RocketPy's `stability_margin(t)`.

**Why not the full injection yet.** Feeding our Mach-dependent CP through a
`LinearGenericSurface` (via `rocketpy_adapter`) so it *drives* the trajectory needs
its coordinate/moment convention validated against a live run — RocketPy's reported
`stability_margin` reads a surface's geometric `cp`, not the cm-encoded CP, so the
injected flight needs care to trust. The overlay gives the comparison the user wanted
without that risk.

**Path to better.** Validate the injection by building a native-fin rocket and an
injected-surface rocket with the *same* CP(M) and asserting their trajectories/margins
agree; then offer an "our CP drives the flight" mode.

---

## 4. Static CP is axial-only (assumes an axisymmetric fin set)

**Today.** `stability.py` computes CP as a 1-D **axial** position -- a CNa-weighted
merge of the body (on-axis) and a fin set modelled as *symmetric* (one representative
fin's planform × the detected count). The CP therefore always sits on the centreline.

**Why it's a simplification.** Deselecting/removing one fin of N, or physically
uneven fins, makes the set asymmetric -- which produces a side force, a roll moment,
and an effective CP that moves *off* the axis. The current model cannot represent
that: an asymmetric selection only changes the axial CP position (via the fin count),
never its lateral position. So "CP stays on the body axis when I remove one fin" is
expected, not a bug -- but it also means the tool cannot flag the instability an
asymmetric fin set really causes.

**Path to better.** Compute per-fin CNa and CP at each fin's actual azimuth and sum
the lateral (side-force) contributions, yielding an off-axis CP / roll estimate for
asymmetric sets -- or at minimum warn when the selected fins are not azimuthally
symmetric.
