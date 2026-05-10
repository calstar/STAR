# Combustion Stability & Solver Diagnostics

This document outlines the root causes for the recent simulation failures and "500 Internal Server Error" observed during the iterative chamber pressure solve.

## 1. The "Mixing Efficiency" Bottleneck (Primary Physics Issue)
The current advanced physics model predicts a catastrophic mixing efficiency of **~2.6%**, which is the primary driver of solver instability.

### Root Cause
*   **Scale Mismatch**: In `calculate_mixing_efficiency`, the mixing time scale $\tau_{mix}$ is calculated using the macro-scale recirculation length ($L_{recirc} \approx 30\text{ mm}$). 
*   **The Physics Error**: In a pintle injector, propellants mix at the **impingement micro-scale** (sheet thickness, $\sim 0.5\text{--}1.0\text{ mm}$), not the chamber macro-scale. 
*   **The Math**: Since $\tau_{mix} \propto L^2$, using $30\text{ mm}$ instead of $1\text{ mm}$ makes the predicted mixing **900 times slower** than reality. 
*   **Result**: The model thinks the fuel and LOX never meet before leaving the throat, leading to the ~2% efficiency prediction.

---

## 2. The "1.0 MPa Cliff" (Solver Discontinuity)
The solver hits a "deadly feedback loop" because of the sharp transition between models at $1.0\text{ MPa}$ (`Pc_gate`).

### Logic Flow:
1.  **Pessimistic Demand**: At $3.5\text{ MPa}$, the Advanced Model says efficiency is $3\%$.
2.  **Insane Requirements**: To maintain $3.5\text{ MPa}$ with only $3\%$ efficiency, the solver calculates a "Demand" of **~100 kg/s** of propellant.
3.  **Solver Panic**: Since the tanks can only supply **~4 kg/s**, the solver aggressively dumps $P_c$ to reduce demand.
4.  **The Cliff**: When $P_c$ crosses below $1.0\text{ MPa}$, the code switches from the **Advanced Model (~1.4% efficiency)** to the **Simple Model (~95% efficiency)**.
5.  **The Stall**: At $1.01\text{ MPa}$, demand is $80\text{ kg/s}$. At $0.99\text{ MPa}$, demand is $1.5\text{ kg/s}$. The solver cannot find a stable root because it "jumps" over the solution space every time it crosses the gate.

---

## 3. Vapor Pressure & Boiling Warnings
The recurring `RuntimeWarning` regarding vapor pressure is a result of the pressure sweep entering a specific physical regime.

*   **Regime**: The fuel surrogate (n-Dodecane) has a critical pressure of **~1.82 MPa**. 
*   **Trigger**: When the solver tests guesses below $1.8\text{ MPa}$, the droplet surface temperature approaches the boiling point. 
*   **Model Behavior**: The Spalding model caps the temperature at the critical point, resulting in a predicted vapor pressure higher than the chamber pressure. 
*   **Status**: This is a physical reality for low-pressure operation (possible fuel boiling), but it exacerbates the solver's difficulty in finding a stable $P_c$ when the efficiency model is already struggling.

---

## 4. Current Fixes & Next Steps

### Fixed:
*   [x] **Injection Velocity Bug**: The solver was previously "blind" to injection velocities during the residual loop, defaulting them to bulk flow ($\sim 1\text{ m/s}$). This has been fixed to pass the actual `u_F` and `u_O` (~30-60 m/s).

### Required Changes:
1.  **Mixing Length Scaling**: Update `combustion_physics.py` to use a micro-scale mixing length (e.g., $0.05 \times D_{chamber}$) or increase the mixing intensity factor `beta` from $8.0$ to $\sim 50.0$.
2.  **Smooth Transition**: Lower the `Pc_gate` or implement a linear blend between the Simple and Advanced models to avoid the "Cliff" effect at $1.0\text{ MPa}$.

