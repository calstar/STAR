# Future improvements

Known approximations and deferred work, with enough context to pick each up later.
Keep entries concrete: what it does today, why that is a simplification, and the
path to a better version.

---

## 1. ~~The 6-DOF uses a rod/cylinder inertia estimate~~ (done)

**Was.** `rocketpy_flight.py` gave RocketPy `I = m L^2 / 12` for the dry rocket: a
uniform rod. On LE4 SD that is 160 kg m^2 against a real 74 -- a ballasted rocket has
its mass near the middle -- so the 6-DOF's pitch frequency was ~30 % low.

**Now.** The build stores every part's inertia per kg (`inertiaPerKgWorld`, from
Onshape where the part has a material, from the closed mesh otherwise), and
`stability.rigid_body_inertia` sums them with the parallel-axis term -- reproducing
Onshape's own assembly inertia on LE4 SD to the fourth digit. The rod survives only as
the fallback for a model whose parts carry no tensors, and the result says so.

The same change made the 6-DOF fly the stability panel's Barrowman components (body
split at its radius changes, plus the fins) instead of RocketPy's own nose and fins --
which had no boattail -- and placed the motor by its nozzle so jet damping has its real
arm. See the module docstring.

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

## 3. ~~CP injection driving the flight (vs. margin overlay)~~ (done)

**Was.** RocketPy flew its own parametric nose and fins, and our CP was only a margin
overlay -- so the 6-DOF had no boattail and the two margins disagreed by ~1 calibre on
LE4 SD.

**Now.** Each of our Barrowman components is a subclass of RocketPy's own
`AeroSurface` (`rocketpy_flight._barrowman_surface`), not a `LinearGenericSurface`:
RocketPy then computes its lift from the local airflow at the surface, rotation
included, exactly as for its native nose and fins -- which sidesteps the cm-encoding
question that kept the injection back. The validation asked for here is
`test_injected_surfaces_fly_exactly_like_rocketpys_own`: a native-surface rocket and
the same rocket rebuilt from our surfaces with the native CNa(M)/CP fly the same
trajectory and pitch response. RocketPy's margin and ours now agree to 0.02 cal along
a flight (`test_imported_rocket_6dof_margin_tracks_the_stability_panel`).

**Left.** The fin CP is held at its Mach 0.3 position in the 6-DOF (RocketPy fixes a
surface's CP); its CNa follows Mach. That matters only transonic and up.

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

## Recovery: descent-model refinements (lateral velocity is now done)

The descent is now a **wind-aware coupled point mass**: wind lives on the config,
the horizontal ground track is integrated (`Vehicle.v_lat`/`v_lat_dir` seed it),
the deployment airspeed the loads use is the resultant air-relative speed, and the
Drift tab reads the coupled track. Apogee, mass and lateral velocity all pull from
the ascent via the "from design" toggles. Remaining refinements:

- **Snatch load and wind.** The opening/inflation load couples to the resultant
  airspeed, but the snatch load (eq 34) still uses the separate `device.v_rel`
  input, not the resultant deployment airspeed. Fold the lateral/wind component in.
- **Wind-shear lag in the loads.** Shear lag is modeled in the coupled descent for
  the track; its effect on the deployment airspeed is captured too (same state), so
  this is largely covered -- confirm it against a strong-shear case.
- **Resultant impact velocity.** `v_impact` is still the vertical descent rate; a
  vehicle landing with horizontal speed (~wind) has extra KE the impact metric
  ignores. Consider reporting the resultant landing speed.
