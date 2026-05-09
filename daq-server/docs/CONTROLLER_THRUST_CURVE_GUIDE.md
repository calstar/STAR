# Robust DDP Controller — Thrust Curve Matching

## Config: Ethanol/LOX

Yes — the LUT uses **Ethanol/LOX** via `engine_sim/configs/default.yaml`:
- `fuel_name: Ethanol`
- `ox_name: LOX`
- `cea_cache_LOX_Ethanol_3D.npz`

## How the Controller Works

1. **Inputs** (LUT lookup): `P_u_fuel`, `P_u_ox`, `thrust_desired`, `MR_ref`
2. **Outputs**: `u_safe_F`, `u_safe_O` (duty 0–1) → sent as PWM to Fuel Press and LOX Press actuators
3. **Thrust command**: `thrust_desired` must be set over time to follow your thrust curve

## Why Your Plot Shows 0–100% Duty

Your actuation plot shows Fuel/Ox duty reaching 70–100%. The current LUT has `u_safe` mostly in 0–10% because:

1. **Engine model**: At 2–8 MPa tank pressure, the model predicts high thrust with small valve opening (pressurization only needs to balance consumption).
2. **Hardware mismatch**: Your hardware may need higher duty to reach the same thrust (different valve Cv, line losses, or injector behavior).

## Making the Controller Match Your Thrust Curve

### 1. Feed the Thrust Curve

`thrust_desired` must follow your mission profile. Right now it defaults to 1000 N.

- **controller_main**: `--thrust N` sets a constant value.
- **Web backend**: Can forward thrust from a mission timeline.
- **TCP control**: ControllerService can receive `setCommand()` with time-varying thrust.

Add a thrust-curve source (e.g. piecewise table or trajectory) and call `setCommand()` with `thrust_desired(t)`.

### 2. Align Engine Config With Hardware

If your hardware needs higher duty for the same thrust:

- Tune `engine_sim/configs/default.yaml` (injector areas, pressure drops, etc.).
- Or scale LUT outputs in FSW (e.g. `duty_F = scale * u_safe_F`) — only if you have a known mapping.

### 3. Use `duty_F` / `duty_O` Instead of `u_safe`

The policy LUT outputs both `u_safe_F/O` and `duty_F/O`. The FSW prefers `u_safe_F/O` and falls back to `duty_F/O`. If the DDP/safety filter is too conservative, `duty_F/O` may be more representative. Check whether `duty_F/O` in the LUT better matches your hardware.

### 4. Regenerate LUT With Your Thrust Profile

Include your actual thrust curve in the LUT grid:

```yaml
# policy_lut_fsw.yaml — add thrust_desired points from your curve
axes:
  - name: thrust_desired
    values: [0, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000]  # Your curve points
```

Then run `./scripts/controller_lut/generate_engine_and_policy_lut.sh full`.

### 5. Run Without LUT (Online DDP)

For debugging, run the controller without the LUT so it uses online DDP:

```bash
./build/FSW/controller_service  # No --lut-path
```

This uses the full DDP solver and may behave differently from the LUT.

## Summary

| Item | Status |
|------|--------|
| Propellants | Ethanol/LOX ✓ |
| LUT axes | P_u_fuel, P_u_ox, thrust_desired, MR_ref ✓ |
| Duty range | 0–1 (FSW clamps u_safe to [0,1]) ✓ |
| Thrust command | Must be supplied; default 1000 N |
| Hardware match | May need engine config or output scaling |
