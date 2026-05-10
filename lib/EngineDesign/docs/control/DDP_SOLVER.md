# DDP Solver Documentation

## Overview

The DDP (Differential Dynamic Programming) solver implements an iLQR-style finite-horizon optimal control algorithm for the robust DDP controller. It solves for an optimal control sequence that minimizes a cost function while respecting constraints and handling model uncertainty.

## Algorithm

The solver implements the following iterative procedure:

1. **Forward Rollout**: Compute nominal trajectory with current control sequence
2. **Backward Pass**: Compute gradients and feedback/feedforward gains
3. **Forward Line Search**: Find best step size and apply control updates
4. **Convergence Check**: Stop if converged or max iterations reached

### Forward Rollout

For each time step `k = 0, ..., N-1`:
- Estimate engine performance from feed pressures: `eng_est = engine_wrapper.estimate_from_pressures(P_d_F, P_d_O)`
- Compute running cost: `l_k = qF*(F - F_ref)^2 + qMR*(MR - MR_ref)^2 + qGas*(P_copv_drop) + constraint_penalties`
- Step dynamics: `x[k+1] = step(x[k], u[k], dt, params, mdot_F, mdot_O)`

### Backward Pass

Starting from terminal state, for each `k = N-1, ..., 0`:
- Linearize dynamics: `A_k, B_k = linearize(x[k], u[k], dt, params, mdot_F, mdot_O)`
- Compute cost derivatives: `lx, lu, lxx, luu, lux = cost_derivatives(...)`
- Compute Q-function derivatives:
  - `Qx = lx + A_k^T @ Vx`
  - `Qu = lu + B_k^T @ Vx`
  - `Qxx = lxx + A_k^T @ Vxx @ A_k`
  - `Quu = luu + B_k^T @ Vxx @ B_k`
  - `Qux = lux + B_k^T @ Vxx @ A_k`
- Add robustification: `Qxx += gamma * diag(w_bar^2)`
- Add Levenberg-Marquardt regularization: `Quu_reg = Quu + reg * I`
- Compute gains:
  - `k_k = -Quu_reg^{-1} @ Qu` (feedforward)
  - `K_k = -Quu_reg^{-1} @ Qux` (feedback)
- Update value function: `Vx = Qx + K_k^T @ Quu_reg @ k_k + ...`, `Vxx = Qxx + K_k^T @ Quu_reg @ K_k + ...`

### Forward Line Search

For step sizes `alpha = alpha_init, alpha_init/2, ...`:
- Compute new control: `u_new = clip(u + alpha*k + K*(x_new - x_nom), [0, 1])`
- Forward rollout with new control sequence
- Accept if cost decreases

## Cost Function

The running cost at each time step is:

```
l = qF * (F - F_ref)^2           # Thrust tracking
  + qMR * (MR - MR_ref)^2        # Mixture ratio tracking
  + qGas * P_copv_drop           # Gas consumption
  + constraint_penalties          # Soft constraint violations
```

Where:
- `F`: Current thrust [N]
- `F_ref`: Reference thrust [N]
- `MR`: Current mixture ratio (O/F)
- `MR_ref`: Reference mixture ratio
- `P_copv_drop`: COPV pressure drop per time step [Pa]
- `constraint_penalties`: Large penalties for hard constraint violations

## Constraint Handling

### Soft Constraints (Penalties)

Constraint violations are added to the cost function with large penalty weights:
- COPV minimum pressure
- Ullage maximum pressure
- Mixture ratio bounds
- Injector stiffness (minimum pressure drop)

### Hard Constraints (Violations)

Hard constraint violations are recorded in `DDPSolution.constraint_violations` for monitoring, but the solver attempts to minimize them via soft penalties.

## Robustification

The solver supports robustification via uncertainty inflation:

1. **Residual Bounds**: Uses `w_bar` (per-state-component residual bounds) to inflate the value function Hessian:
   ```
   Qxx += gamma * diag(w_bar^2)
   ```

2. **Risk-Sensitive Term**: Alternatively, can add risk-sensitive term to value function.

This makes the controller more conservative in the presence of model uncertainty.

## Control Bounds

Controls are constrained to `[0, 1]`:
- `u_F, u_O ∈ [0, 1]` (normalized solenoid commands)
- Clipping is applied after each control update: `u_new = clip(u + du, [0, 1])`

## Regularization

Levenberg-Marquardt regularization is used to ensure `Quu` is positive definite:
- Initial regularization: `reg_init = 1e-3`
- Adaptive: increases if cost doesn't decrease, decreases if it does
- Maximum regularization: `1e6` (stops if exceeded)

## Convergence

The solver stops when:
1. **Convergence**: `|cost_new - cost_prev| < convergence_tol`
2. **Max Iterations**: `iterations >= max_iterations`
3. **Regularization Too High**: `reg > 1e6`

## Usage

```python
from engine.control.robust_ddp import solve_ddp, DynamicsParams
from engine.control.robust_ddp.data_models import ControllerConfig
from engine.control.robust_ddp.engine_wrapper import EngineWrapper

# Setup
cfg = ControllerConfig(...)
params = DynamicsParams.from_config(cfg)
engine_wrapper = EngineWrapper(...)

# Initial state and control
x0 = np.array([P_copv, P_reg, P_u_F, P_u_O, P_d_F, P_d_O, V_u_F, V_u_O])
u_seq_init = np.zeros((cfg.N, 2))  # or from previous tick
F_ref = np.ones(cfg.N) * 5000.0
MR_ref = np.ones(cfg.N) * 2.4

# Solve
solution = solve_ddp(
    x0=x0,
    u_seq_init=u_seq_init,
    F_ref=F_ref,
    MR_ref=MR_ref,
    cfg=cfg,
    dynamics_params=params,
    engine_wrapper=engine_wrapper,
    w_bar=np.zeros(8),  # or from ControllerState
)

# Use solution
u_optimal = solution.u_seq[0]  # First control action
```

## Output

The solver returns a `DDPSolution` object containing:
- `u_seq`: Optimal control sequence `(N, N_CONTROL)`
- `x_seq`: State trajectory `(N+1, N_STATE)`
- `eng_estimates`: Engine estimates per step
- `objective`: Final objective value
- `iterations`: Number of iterations
- `converged`: Whether converged
- `constraint_violations`: Hard constraint violations per step
- `diagnostics`: Additional diagnostics (regularization, step size, etc.)

## Performance Considerations

1. **Caching**: The `EngineWrapper` uses LRU caching to avoid redundant engine evaluations during rollouts
2. **Finite Differences**: Cost derivatives use finite differences (can be expensive for large state spaces)
3. **Diagonal Hessian Approximation**: `lxx` and `luu` use diagonal approximations for efficiency
4. **Line Search**: Forward line search may require multiple rollouts per iteration

## Limitations

1. **Non-Convexity**: The optimization problem is non-convex, so the solver may find local minima
2. **Computational Cost**: DDP requires multiple forward/backward passes, which can be expensive for long horizons
3. **Model Accuracy**: Performance depends on accuracy of dynamics model and engine estimates
4. **Constraint Satisfaction**: Soft constraints may not guarantee hard constraint satisfaction (monitor `constraint_violations`)

## Future Improvements

1. **Warm Start**: Use previous solution as initial guess (shift by one step)
2. **Parallel Rollouts**: Parallelize forward rollouts for line search
3. **Analytical Derivatives**: Replace finite differences with analytical derivatives where possible
4. **Tube-Based Robustification**: Use tube propagation for worst-case cost evaluation
5. **Constraint Tightening**: Progressively tighten constraints during optimization

