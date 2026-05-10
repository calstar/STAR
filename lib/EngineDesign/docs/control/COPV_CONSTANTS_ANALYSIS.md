# COPV Constants Analysis

## Your System

- **COPV Volume**: 6L (0.006 m³)
- **COPV Pressure**: 2750 psi (18.96 MPa)
- **Regulated Pressure**: 1000 psi (6.89 MPa)
- **Gas**: GN2 (Gaseous Nitrogen)
- **Feeds**: 2 tanks (fuel and oxidizer)

## Current Default Constants

From `configs/robust_ddp_default.yaml`:
- `copv_cF = 100,000 Pa/s` = **14.5 psi/s per unit u_F**
- `copv_cO = 100,000 Pa/s` = **14.5 psi/s per unit u_O**
- `copv_loss = 1,000 Pa/s` = **0.145 psi/s** (leakage)
- `reg_ratio = 0.8` = **80% of COPV pressure**

## Issues Identified

### 1. Regulator Ratio is Wrong

**Current**: `reg_ratio = 0.8` → Would give 2200 psi regulator pressure  
**Your System**: 1000 psi / 2750 psi = **0.364** (36.4%)

**Fix**: Set `reg_ratio = 0.364` or use `reg_setpoint = 1000 * 6894.76 = 6,894,760 Pa`

### 2. Consumption Coefficients Need Verification

The current values (14.5 psi/s per unit control) are reasonable **starting points** but should be:

1. **Identified online** using the `ParameterIdentifier` module
2. **Calculated from first principles** based on:
   - COPV volume (6L)
   - Flow rates through regulator and valves
   - Gas properties (N2)

## Physics-Based Calculation

For a 6L COPV with GN2:

**Ideal Gas Law**: `P = (m * R * T) / V`

**Pressure Drop Rate**: `dP/dt = -(R*T/V) * (dm/dt)`

Where:
- `R = 296.8 J/(kg·K)` (gas constant for N2)
- `T ≈ 293 K` (typical N2 temperature)
- `V = 0.006 m³` (6L)
- `dm/dt` = mass flow rate out [kg/s]

**Example Calculation**:
- If mass flow = 0.2 kg/s (typical for small system)
- `dP/dt = -(296.8 * 293 / 0.006) * 0.2 = -2.9 MPa/s = -420 psi/s`

This is **much higher** than the current 14.5 psi/s!

However, the model uses **normalized control** `u ∈ [0,1]`, so:
- `copv_cF = 14.5 psi/s` means: when `u_F = 1.0`, pressure drops at 14.5 psi/s
- This corresponds to a **much smaller** actual flow rate

**Actual Flow Rate** (for 14.5 psi/s drop):
- `dP/dt = -14.5 psi/s = -100,000 Pa/s`
- `dm/dt = -(dP/dt) * V / (R*T) = 100000 * 0.006 / (296.8 * 293) = 0.0069 kg/s`

So the current constants assume **~7 g/s** flow per valve when fully open, which is reasonable for a small system.

## Recommendations

### 1. Fix Regulator Ratio

Update your config:
```yaml
reg_setpoint: 6894760.0  # 1000 psi in Pa
# OR
reg_ratio: 0.364  # 1000/2750
```

### 2. Verify Consumption Coefficients

**Option A: Use Online Identification** (Recommended)
```python
from engine.control.robust_ddp import ParameterIdentifier

identifier = ParameterIdentifier(cfg, forgetting_factor=0.99)
# Run controller, identifier will adapt coefficients
```

**Option B: Calculate from Flow Rates**
If you know your actual flow rates:
- Measure or estimate max flow rate from COPV [kg/s]
- Calculate: `copv_c = (R*T/V) * mdot_max`
- Split between fuel/oxidizer: `copv_cF = copv_cO = copv_c / 2`

**Option C: Use Test Data**
- Run a test with known valve positions
- Measure COPV pressure drop rate
- Fit coefficients: `copv_c = dP/dt / u`

### 3. Typical Values for 6L COPV

For a **6L COPV at 2750 psi** feeding a **1000 psi regulator**:

| Flow Rate [kg/s] | Pressure Drop [psi/s] | copv_c [Pa/s] |
|------------------|----------------------|---------------|
| 0.01 (10 g/s)    | 2.1                  | 14,500        |
| 0.05 (50 g/s)    | 10.5                 | 72,500        |
| 0.1 (100 g/s)    | 21                   | 145,000       |
| 0.2 (200 g/s)    | 42                   | 290,000       |

**Current default (100,000 Pa/s = 14.5 psi/s)** corresponds to **~69 g/s** flow, which is reasonable for a small system.

## Model Limitations

The current model is **simplified**:
- Assumes linear relationship: `dP/dt = -c*u`
- Actual physics: Polytropic blowdown (P*V^n = constant)
- More accurate: Use `copv.copv_solve_both` for detailed analysis

However, for **control purposes**, the linear model is acceptable if:
1. Coefficients are identified online (adapts to actual behavior)
2. Operating range is limited (small pressure changes)
3. Model is updated periodically

## Action Items

1. ✅ **Fix `reg_ratio`**: Set to 0.364 (or use `reg_setpoint = 6.89 MPa`)
2. ✅ **Enable online identification**: Use `ParameterIdentifier` to adapt coefficients
3. ✅ **Monitor**: Check if identified values match expected flow rates
4. ✅ **Validate**: Compare controller predictions to actual COPV behavior

## Example Config Update

```yaml
# For 6L COPV @ 2750 psi, regged to 1000 psi
reg_setpoint: 6894760.0  # 1000 psi [Pa]
# OR
reg_ratio: 0.364  # 1000/2750

# Initial estimates (will be refined by online identification)
copv_cF: 100000.0  # [Pa/s per unit u_F] - reasonable starting point
copv_cO: 100000.0  # [Pa/s per unit u_O]
copv_loss: 1000.0  # [Pa/s] - leakage/heat loss
```

The **online identification** module will refine these values automatically during operation.



