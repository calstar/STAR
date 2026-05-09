## Controller LUT tooling (engine\_sim-backed)

This package provides a high-dimensional lookup-table (LUT) generator and
interpolator for the controller, built on top of the `engine_sim` submodule.
It **does not modify** any files inside `engine_sim`; it only imports and uses
its public APIs.

### Axes and outputs

The LUT is defined over a configurable set of axes that correspond to
controller and vehicle state variables:

- **Recommended axis names** (up to 11–12D)
  - Pressures (Pa): `P_copv`, `P_reg`, `P_u_fuel`, `P_u_ox`, `P_d_fuel`, `P_d_ox`
  - Navigation: `h` (altitude [m]), `vz` (vertical velocity [m/s]),
    `theta` (tilt [rad]), `mass_estimate` [kg]
  - Commands: `thrust_desired` [N], `altitude_goal` [m]

The **outputs** are engine/controller prediction quantities drawn from
`EngineEstimate` and diagnostics, e.g.:

- `F`, `MR`, `P_ch`
- `mdot_F`, `mdot_O`
- `injector_dp_F`, `injector_dp_O`
- `stability_score`, `injector_stiffness_ok`

The schema is encoded in `ControllerLUTConfig` and `LUTAxisConfig`
(`config.py`), and an example 4D configuration lives in
`example_lut_config.yaml`. Extending to 11–12D is done by adding more axes to
that file.

### Generating a LUT

From the project root (`sensor_system`), run:

```bash
python -m scripts.controller_lut.generate_controller_lut \
  --lut-config scripts/controller_lut/example_lut_config.yaml \
  --output output/lut/controller_lut_example.npz
```

This will:

- Load the engine configuration from `engine_config_path` in the YAML.
- Sweep over all combinations of axis values (including higher-dimensional
  extensions if configured).
- Call `EngineWrapper.estimate_from_pressures(P_u_fuel, P_u_ox)` for each
  point to populate engine performance and stability-related fields.
- Save a compressed `.npz` file containing:
  - `axes/<axis_name>` arrays
  - `data/<output_name>` arrays
  - A JSON `meta` blob with axis/output metadata and config paths

### Lookup architecture: engine config + tank pressure range

The lookup **stems downstream** from engine config (`engine_sim/configs/*.yaml`) and
a tank pressure range. This produces a multi-dimensional LUT with everything the
robust DDP needs: F, MR, P_ch, mdot_F, mdot_O, injector_dp, stability.

### Pipeline: engine LUT → policy LUT

```bash
# Full pipeline (~15 s small, ~2 hr full)
./scripts/controller_lut/generate_engine_and_policy_lut.sh small
```

1. **Engine LUT** — from engine config + tank pressure range (no DDP, fast)
2. **Policy LUT** — DDP uses engine LUT for fast lookups
3. **Export** — FSW binary

Outputs: `output/lut/engine_performance.npz`, `output/lut/controller_policy_fsw.bin`

### FSW controller

Run the FSW controller with:

```bash
./build/FSW/controller_service --lut-path output/lut/controller_policy_fsw.bin --relay-host 127.0.0.1
```

The FSW ControllerService passes `P_u_fuel`, `P_u_ox`, `thrust_desired`, `MR_ref`
to the LUT and uses continuous duty (0–1) for PWM output.

**Python controller:** Set `engine_lut_path` in `robust_ddp_default.yaml` to use
the engine LUT for fast DDP (instead of physics).

### Using a LUT at runtime

The `EngineLUT` class (`engine_lut.py`) loads a `.npz` file and provides
multilinear interpolation over all axes:

```python
from scripts.controller_lut.engine_lut import EngineLUT

lut = EngineLUT("output/lut/controller_lut_example.npz")
prediction = lut.evaluate({
    "P_u_fuel": 3.5e6,
    "P_u_ox": 4.2e6,
    "h": 100.0,
    "vz": 25.0,
})
F_est = prediction["F"]
MR_est = prediction["MR"]
```

This interface is designed to be thin enough that a C++ side wrapper can load
the same `.npz` file (or a derived binary form) and expose a similar
`evaluate` function inside the FSW controller.
