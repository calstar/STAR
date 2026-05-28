# COPV Pressure Resupply Model — Physical Methodology

## 1. System Overview

The press system consists of the following series elements:

```
[COPV] → [Regulator (Aqua 1120)] → [Plumbing / Fittings] → [Solenoid Valve] → [Propellant Tank Ullage]
```

There are two distinct flow resistance elements in series:

- **Regulator**: Aqua Environment Model 1120, Cv = 0.06, unbalanced poppet with outlet pressure droop
- **Downstream line + solenoid**: lumped Cv to be characterized from test data (call it Cv_line)

The **effective combined Cv** when the solenoid is open is:

$$\frac{1}{C_{v,\text{eff}}^2} = \frac{1}{C_{v,\text{reg}}^2} + \frac{1}{C_{v,\text{line}}^2}$$

When the solenoid is **closed**, flow = 0 regardless of everything else.

---

## 2. Regulator Behavior

### 2.1 Nominal Set Pressure

The Aqua 1120 is a hand-load piston regulator. At a given inlet pressure it holds a quasi-steady outlet pressure P_set. This is a **manual set** — it does not change between tests unless physically adjusted.

### 2.2 Outlet Pressure Droop (Unbalanced Poppet Effect)

Because it uses an unbalanced poppet, the regulated outlet pressure rises slightly as inlet (COPV) pressure drops:

$$P_{\text{reg}}(t) = P_{\text{set,0}} + k_{\text{droop}} \cdot \left(P_{\text{COPV,0}} - P_{\text{COPV}}(t)\right)$$

Where:
- $P_{\text{set,0}}$ = regulator setpoint at the initial COPV pressure (psi)
- $k_{\text{droop}}$ = 0.070 psi/psi (from spec: 70 psi rise per 1000 psi inlet drop)
- $P_{\text{COPV,0}}$ = initial COPV pressure (psi)
- $P_{\text{COPV}}(t)$ = instantaneous COPV pressure (psi)

**Practical effect:** If the COPV bleeds from 4500 psi to 2000 psi over a run, the regulated outlet pressure drifts upward by ~175 psi. For a propellant tank targeted at 400–600 psi, this is a non-trivial drift and must be tracked.

### 2.3 Regulator as a Pressure Boundary Condition

For modeling purposes, the regulator sets the upstream pressure seen by the downstream Cv_line. Define:

$$P_{\text{upstream,line}} = \min\left(P_{\text{reg}}(t),\ P_{\text{COPV}}(t)\right)$$

This captures the regime where COPV pressure has decayed below the regulator setpoint (unregulated blowdown). Normally $P_{\text{COPV}} \gg P_{\text{reg}}$ and the regulator is the active element.

---

## 3. Gas Flow Model

### 3.1 Compressible Flow Through an Orifice (Cv-based)

For a gas flowing through a restriction with known Cv, the mass flow rate is:

**Choked flow** (when $P_{\text{tank}} / P_{\text{up}} \leq P^*$, where $P^* = (2/(γ+1))^{γ/(γ-1)} \approx 0.528$ for N2):

$$\dot{m} = C_{v,\text{eff}} \cdot P_{\text{up}} \cdot \sqrt{\frac{\gamma \cdot M}{R \cdot T_{\text{up}}}} \cdot \left(\frac{2}{\gamma+1}\right)^{\frac{\gamma+1}{2(\gamma-1)}} \cdot \rho_{\text{ref}} \cdot F_{\text{units}}$$

**Subsonic flow** (when $P_{\text{tank}} / P_{\text{up}} > 0.528$):

$$\dot{m} = C_{v,\text{eff}} \cdot \sqrt{\rho_{\text{up}} \cdot (P_{\text{up}} - P_{\text{tank}})}\ \cdot F_{\text{units}}$$

In practice for N2 at these pressures, a simpler dimensionally-consistent form using the standard ISA gas flow equation for Cv is:

$$\dot{m} = C_{v,\text{eff}} \cdot 63.3 \cdot \frac{P_{\text{up}}}{\sqrt{T_{\text{up}}}} \cdot Y \cdot \sqrt{\frac{1}{SG}}$$

Where:
- $P_{\text{up}}$ = upstream absolute pressure (psia)
- $T_{\text{up}}$ = upstream temperature (°R = °F + 460)
- $Y$ = expansion factor (≈ 0.67 at choked, 1.0 at low ΔP — can be tabulated or interpolated)
- $SG$ = specific gravity of N2 relative to air = 0.967
- Result is in scfh; divide by 26.36 to get lbm/min for N2

**For code implementation**, it's cleaner to use the orifice-equivalent area directly. The Cv-to-area conversion for the Aqua 1120 is given in spec as:

$$C_v = 0.06 \implies d_{\text{eff}} \approx 0.070\ \text{inches orifice equivalent}$$

Then use the standard isentropic nozzle equations with $A_{\text{eff}} = \pi d_{\text{eff}}^2 / 4$:

$$\dot{m} = C_d \cdot A_{\text{eff}} \cdot P_{\text{up}} \cdot \sqrt{\frac{\gamma}{R \cdot T_{\text{up}}}} \cdot \left(\frac{2}{\gamma+1}\right)^{\frac{\gamma+1}{2(\gamma-1)}}\ \quad \text{(choked)}$$

$$\dot{m} = C_d \cdot A_{\text{eff}} \cdot \sqrt{2 \rho_{\text{up}} \cdot (P_{\text{up}} - P_{\text{tank}})}\ \quad \text{(subsonic, incompressible approx)}$$

For the combined line, replace $A_{\text{eff}}$ with the series-combined effective area derived from the two Cv values.

**N2 Properties:**
- γ = 1.40
- M = 28.014 g/mol
- R = 296.8 J/(kg·K)
- Critical pressure ratio: 0.528

---

## 4. The ODE System

### 4.1 State Variables

| Variable | Description |
|---|---|
| $P_{\text{COPV}}(t)$ | COPV pressure (psia) |
| $P_{\text{tank}}(t)$ | Propellant tank pressure (psia) |
| $V_{\text{ull}}(t)$ | Tank ullage volume (in³ or m³) |
| $m_{\text{prop}}(t)$ | Propellant mass in tank (kg or lbm) — only relevant in Case 2 |

### 4.2 Case 1: Static Resupply (No Propellant Flow)

Ullage volume is constant: $V_{\text{ull}} = V_{\text{ull},0}$

**COPV blowdown:**
$$\frac{dP_{\text{COPV}}}{dt} = -\frac{\dot{m}(t) \cdot R \cdot T_{\text{COPV}}}{V_{\text{COPV}}}$$

**Tank pressure rise:**
$$\frac{dP_{\text{tank}}}{dt} = \frac{\dot{m}(t) \cdot R \cdot T_{\text{ull}}}{V_{\text{ull},0}}$$

**Solenoid gate:**
$$\dot{m}(t) = \begin{cases} \dot{m}_{\text{orifice}}(P_{\text{up}}, P_{\text{tank}}, T_{\text{up}}) & \text{if solenoid open} \\ 0 & \text{if solenoid closed} \end{cases}$$

Where $P_{\text{up}} = P_{\text{reg}}(t)$ while $P_{\text{COPV}} > P_{\text{reg}}$, else $P_{\text{up}} = P_{\text{COPV}}$.

**Termination condition:** $P_{\text{tank}} \rightarrow P_{\text{reg}}(t)$ asymptotically. Flow stops when $P_{\text{tank}} \geq P_{\text{up}}$.

### 4.3 Case 2: Dynamic Resupply During Propellant Flow

Ullage volume changes as propellant drains from the tank:

$$V_{\text{ull}}(t) = V_{\text{ull},0} + \frac{m_{\text{prop},0} - m_{\text{prop}}(t)}{\rho_{\text{prop}}}$$

Where $\rho_{\text{prop}}$ is the liquid propellant density (treated as constant for incompressible liquids).

The propellant mass drain rate $\dot{m}_{\text{prop}}$ comes from your existing blowdown / feed system model. Treat it as an input to this system.

**COPV blowdown:** Same as Case 1.

**Tank pressure:** Now has two competing effects — gas addition from press line raises pressure, ullage expansion from propellant drain reduces it:

$$\frac{dP_{\text{tank}}}{dt} = \frac{\dot{m}_{\text{press}} \cdot R \cdot T_{\text{ull}}}{V_{\text{ull}}(t)} - \frac{P_{\text{tank}} \cdot \dot{V}_{\text{ull}}}{V_{\text{ull}}(t)}$$

Where:

$$\dot{V}_{\text{ull}} = \frac{\dot{m}_{\text{prop}}}{\rho_{\text{prop}}}$$

This is derived from the ideal gas law applied to a control volume with both mass flux and volume change:

$$\frac{d}{dt}(P \cdot V) = \dot{m}_{\text{press}} \cdot R \cdot T_{\text{ull}}$$

$$P \dot{V} + V \dot{P} = \dot{m}_{\text{press}} \cdot R \cdot T_{\text{ull}}$$

$$\dot{P} = \frac{\dot{m}_{\text{press}} \cdot R \cdot T_{\text{ull}} - P_{\text{tank}} \cdot \dot{V}_{\text{ull}}}{V_{\text{ull}}(t)}$$

**Regulator pressure correction:** Same droop model as before.

**Solenoid control modes:**

- **Open loop:** Solenoid open for $t_{\text{open}}$ seconds, then closed — specify duration as input
- **Bang-bang closed loop:** Solenoid opens when $P_{\text{tank}} < P_{\text{set}} - \Delta P_{\text{low}}$, closes when $P_{\text{tank}} > P_{\text{set}} + \Delta P_{\text{high}}$ (pressure band control)
- **Duty cycle:** Fixed on/off period ratio

---

## 5. Thermodynamic Assumptions

| Assumption | Justification |
|---|---|
| Ideal gas for N2 | Valid at these pressures / temperatures for N2 |
| Isothermal COPV blowdown | Conservative; real blowdown cools gas, slightly underestimates flow. Acceptable for slow blowdowns. |
| Isothermal ullage | Gas entering tank heats ullage slightly; isothermal is a reasonable first-order assumption |
| Incompressible propellant | Valid for liquid ethanol and LOX at operating conditions |
| Quasi-steady regulator | Regulator responds fast relative to system dynamics — treat outlet pressure as instantaneous function of COPV pressure |

**Higher fidelity option:** Use adiabatic relations for COPV blowdown:

$$T_{\text{COPV}}(t) = T_0 \cdot \left(\frac{P_{\text{COPV}}(t)}{P_{\text{COPV},0}}\right)^{\frac{\gamma-1}{\gamma}}$$

Then update density accordingly. This is recommended if COPV blows down more than ~30% in pressure during a single run.

---

## 6. Required Inputs

### 6.1 Fixed System Parameters

| Parameter | Symbol | Source |
|---|---|---|
| COPV volume | $V_{\text{COPV}}$ | Tank datasheet |
| Regulator Cv | $C_{v,\text{reg}} = 0.06$ | Aqua 1120 spec |
| Line + solenoid Cv | $C_{v,\text{line}}$ | Fit from test data |
| Regulator droop coefficient | $k_{\text{droop}} = 0.070$ | Aqua 1120 spec |
| Propellant density | $\rho_{\text{prop}}$ | Fluid properties |

### 6.2 Initial Conditions (Per Run)

| Parameter | Symbol |
|---|---|
| Initial COPV pressure | $P_{\text{COPV},0}$ |
| Initial tank pressure | $P_{\text{tank},0}$ |
| Regulator set pressure at $P_{\text{COPV},0}$ | $P_{\text{set},0}$ |
| Tank ullage volume | $V_{\text{ull},0}$ |
| Tank fill level / propellant mass | $m_{\text{prop},0}$ (Case 2 only) |
| Gas temperature (COPV, ullage) | $T_{\text{COPV}},\ T_{\text{ull}}$ |

### 6.3 Solenoid Schedule Input

- Solenoid open duration $t_{\text{open}}$ (seconds), or
- Bang-bang pressure band [$P_{\text{low}}$, $P_{\text{high}}$], or
- Arbitrary on/off schedule array

---

## 7. Characterizing Cv_line from Test Data

From your static press test (solenoid open/close, no propellant flow):

1. Identify the time window where solenoid is open
2. Compute $\dot{m}$ from COPV side: $\dot{m} = -\frac{V_{\text{COPV}}}{R \cdot T_{\text{COPV}}} \cdot \frac{dP_{\text{COPV}}}{dt}$
3. Compute upstream pressure $P_{\text{up}} = P_{\text{reg}}(t)$ at each timestep using the droop model
4. Solve for $C_{v,\text{eff}}$ from the orifice equation at each timestep
5. Then back-calculate $C_{v,\text{line}}$ from the series combination:

$$\frac{1}{C_{v,\text{line}}^2} = \frac{1}{C_{v,\text{eff}}^2} - \frac{1}{C_{v,\text{reg}}^2}$$

Cross-check against the tank-side: $\dot{m}_{\text{check}} = \frac{V_{\text{ull},0}}{R \cdot T_{\text{ull}}} \cdot \frac{dP_{\text{tank}}}{dt}$. Agreement within ~10% is good. Systematic offset suggests a temperature assumption error.

---

## 8. Numerical Integration

Use a standard ODE integrator (e.g., RK4 or scipy `solve_ivp` with `RK45`). Recommended timestep: 1–5 ms for accuracy; the dynamics are not stiff unless the line Cv is very high.

**State vector:**

$$\mathbf{x} = \begin{bmatrix} P_{\text{COPV}} \\ P_{\text{tank}} \\ m_{\text{prop}} \end{bmatrix}$$

At each step:
1. Compute $P_{\text{reg}}(t)$ from droop model
2. Determine $P_{\text{up}} = \min(P_{\text{reg}}, P_{\text{COPV}})$
3. Check solenoid state → compute $\dot{m}_{\text{press}}$ (choked or subsonic)
4. Compute $\dot{V}_{\text{ull}}$ from propellant drain model (Case 2)
5. Evaluate ODEs and advance state

**Flow regime switch:** Implement a smooth transition between choked and subsonic using the pressure ratio $r = P_{\text{tank}} / P_{\text{up}}$. Hard-switch at $r = 0.528$ is fine for N2; add a small interpolation band (e.g., 0.50–0.55) to avoid numerical discontinuity if needed.

---

## 9. Summary of ODEs (Complete System)

$$\boxed{
\begin{aligned}
P_{\text{reg}}(t) &= P_{\text{set},0} + 0.070 \cdot (P_{\text{COPV},0} - P_{\text{COPV}}) \\
P_{\text{up}}(t) &= \min(P_{\text{reg}},\ P_{\text{COPV}}) \\
\dot{m}_{\text{press}} &= \dot{m}_{\text{orifice}}(C_{v,\text{eff}},\ P_{\text{up}},\ P_{\text{tank}},\ T_{\text{up}}) \cdot \mathbb{1}_{\text{sol open}} \\
\dot{P}_{\text{COPV}} &= -\frac{\dot{m}_{\text{press}} \cdot R \cdot T_{\text{COPV}}}{V_{\text{COPV}}} \\
V_{\text{ull}}(t) &= V_{\text{ull},0} + \frac{m_{\text{prop},0} - m_{\text{prop}}(t)}{\rho_{\text{prop}}} \\
\dot{P}_{\text{tank}} &= \frac{\dot{m}_{\text{press}} \cdot R \cdot T_{\text{ull}} - P_{\text{tank}} \cdot \dot{V}_{\text{ull}}}{V_{\text{ull}}(t)} \\
\dot{m}_{\text{prop}} &= -\dot{m}_{\text{engine}}(t) \quad \text{(from feed system model)}
\end{aligned}
}$$

For Case 1 (static resupply): set $\dot{m}_{\text{prop}} = 0$ and $\dot{V}_{\text{ull}} = 0$.

For Case 2 (dynamic resupply during flow): couple $\dot{m}_{\text{engine}}$ from your existing blowdown ODE.
