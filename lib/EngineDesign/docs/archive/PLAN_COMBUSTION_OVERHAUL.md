# INSTRUCTION: Combustion Physics & Solver Stability Implementation

You are an expert Propulsion & Numerical Methods Engineer. Your task is to overhaul the combustion efficiency and chamber pressure solver logic to fix catastrophic mixing collapse and numerical discontinuities.

## 1. CONTEXT
The current iterative solver fails because the "Advanced Efficiency" model predicts non-physical efficiency (~3%) due to scale mismatches and double-counting of penalties. This causes the mass demand to explode, forcing the solver to jump to low pressures where it hits a hard-gated model discontinuity.

## 2. CORE ARCHITECTURAL PRINCIPLES
*   **Partitioning**: Strictly isolate sub-models. $\eta_{Lstar}$ = Droplets only. $\eta_{mix}$ = Stirring only. $\eta_{kin}$ = Chemistry only.
*   **Geometric Residence Time**: $\tau_{res}$ is purely geometric ($V\rho/\dot{m}$). **NEVER** "correct" it with process efficiency.
*   **Micro-Scale Mixing**: Mixing time must be driven by near-field thickness scales ($L_{mix} \sim 1\text{ mm}$), not chamber macro-scales ($L_{recirc} \sim 30\text{ mm}$).
*   **Numerical Continuity**: No hard `if Pc < 1.0 MPa` switches. Use smooth sigmoid blending.

## 3. IMPLEMENTATION STEPS

### STEP 1: The Unified State Helper (in `engine/pipeline/combustion_physics.py`)
Create an internal helper to compute a consistent state for all sub-models:
*   Compute $\rho_{ch} = P_c / (R \cdot T_c)$
*   Compute $U_{bulk} = \dot{m}_{total} / (\rho_{ch} \cdot A_c)$
*   Compute $G_{throat} = \dot{m}_{total} / A_t$
*   Compute $\tau_{res} = (L^* \cdot \rho_{ch}) / G_{throat}$
*   Compute $L_{mix} = C_L \cdot D_{inj}$ (use $C_L = 0.1$ as default).
*   Define $U_{rms} = \sqrt{(u_F^2 + u_O^2) / 2}$ (root-mean-square of injection velocities).
*   Compute $U_{mix} = \sqrt{(u_F - u_O)^2 + C_u \cdot U_{rms}^2}$ (use $C_u = 0.5$).

### STEP 2: Near-Field Mixing Overhaul (`calculate_mixing_efficiency` in `engine/pipeline/combustion_physics.py`)
*   **Remove**: All evaporation ($x^*$, SMD) and residence-time corrections.
*   **Implement**:
    1.  Convective time: $\tau_{conv} = L_{mix} / U_{mix}$
    2.  Diffusive time: $\tau_{diff} = L_{mix}^2 / D_t$, where $D_t = \mu_t / \rho_{ch}$ is derived from existing k–ε turbulent viscosity logic.
    3.  Harmonic blend: $\tau_{mix} = 1.0 / (1.0/\tau_{conv} + 1.0/\tau_{diff})$
    4.  Mixing Damköhler: $Da_{mix} = \tau_{res} / \tau_{mix}$
    5.  Efficiency: $\eta_{mix} = 1 - \exp(-Da_{mix})$

### STEP 3: Evaporation Overhaul (`calculate_eta_Lstar` in `engine/pipeline/combustion_physics.py`)
*   **Fix**: Map `fuel_props` keys correctly ("molecular_weight" vs "W").
*   **Slip Velocity**: Use $U_{drop} = \max(U_{bulk}, U_{mix})$ for $Re/Sh$ correlations.
*   **Clean**: Ensure this function only models droplet lifetime vs $\tau_{res}$.
*   **Equations**: $Da_{evap} = \tau_{res} / \tau_{evap}$, $\eta_{Lstar} = 1 - \exp(-Da_{evap})$.

### STEP 4: Kinetics Overhaul (`calculate_reaction_time_scale` in `engine/pipeline/combustion_physics.py`)
*   **Magnitude**: Correct `tau_ref` from $5\times10^{-5}$ to $5\times10^{-3}$ ($5\text{ ms}$).
*   **Sensitivity**: Set pressure exponent $n = 0.8$ in the $(P_{ref}/P)^n$ term.
*   **Softening**: Replace the hard Arrhenius exponential with a softened form (clamping the exponent argument to $\pm 20$) or a power-law $(T/T_{ref})^m$ to prevent "cliffs" during solver iterations.
*   **Efficiency**: $\eta_{kin} = 1 - \exp(-(\tau_{res}/\tau_{chem})^{0.5})$.

### STEP 5: Aggregator Logic (`calculate_combustion_efficiency_advanced` in `engine/pipeline/combustion_physics.py`)
*   Compute $\eta_{total} = \eta_{Lstar} \cdot \eta_{mix} \cdot \eta_{kin} \cdot \eta_{turb}$.
*   **Sanity Check**: If $\eta_{mix} < 0.2$ at $P_c > 2\text{ MPa}$ with injection speeds $> 10\text{ m/s}$, log a high-priority warning: "Absurdly low mixing detected—check length scale $L_{mix}$."

### STEP 6: Solver Blending (in `engine/core/chamber_solver.py`)
*   Remove the hard `if Pc < Pc_gate` logic in `residual()`.
*   Implement a sigmoid weight $w(P_c)$:
    $w(P_c) = 1.0 / (1.0 + \exp(-k \cdot (\log_{10}(P_c) - \log_{10}(P_{gate}))))$
    (Use $P_{gate} = 1.0\text{ MPa}$ and $k \approx 10$ for a smooth transition over $0.8 \to 1.2\text{ MPa}$).
*   Return blended efficiency: $\eta_{blended} = w \cdot \eta_{advanced} + (1-w) \cdot \eta_{simple}$.

## 4. DEFINITION OF DONE
*   [ ] `u_F` and `u_O` are correctly propagated through the `residual` loop.
*   [ ] $\eta_{mix}$ at nominal $3.5\text{ MPa}$ is in a physically plausible range ($0.85 \text{--} 0.98$).
*   [ ] The solver successfully converges without hitting 500 errors at the $1.0\text{ MPa}$ boundary.
*   [ ] All Damköhler numbers use the same reference $\tau_{res}$.
