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
