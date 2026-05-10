# ============================
# LQR Motor Position Control Simulation
# ============================

import numpy as np
import matplotlib.pyplot as plt
from scipy.linalg import solve_continuous_are

# ----------------------------
# 1. Define Motor Parameters
# ----------------------------
R = 1.0     # Ohm
L = 0.5     # Henry
Ke = 0.01   # V·s/rad
Kt = 0.01   # N·m/A
J = 0.01    # kg·m²
B = 0.1     # N·m·s/rad

# ----------------------------
# 2. Build State-Space Model
# ----------------------------
A = np.array([
    [-R/L,   -Ke/L,   0],
    [Kt/J,   -B/J,    0],
    [0,       1,      0]
])
B = np.array([[1/L], [0], [0]])
C = np.array([[0, 0, 1]])   # output = position θ

# ----------------------------
# 3. Design LQR Controller
# ----------------------------
Q = np.diag([10, 1, 100])   # penalize current, speed, position error
R_mat = np.array([[0.01]])  # penalize control effort

P = solve_continuous_are(A, B, Q, R_mat)
K = np.linalg.inv(R_mat) @ B.T @ P
print("LQR Gain K =", K)

# ----------------------------
# 4. Simulate Closed-Loop System
# ----------------------------
dt = 0.001   # 1 ms
T = 5.0      # 5 seconds
N = int(T / dt)
t = np.linspace(0, T, N)

x = np.zeros((3, 1))  # [i, ω, θ]
r = 1.0               # reference position (1 rad)

x_hist, u_hist = [], []

for _ in range(N):
    # control law: u = -Kx + feedforward term
    u = -K @ x + K[0,2] * r
    dx = A @ x + B * u
    x += dx * dt

    x_hist.append(x.flatten())
    u_hist.append(u.item())

x_hist = np.array(x_hist)
u_hist = np.array(u_hist)

# ----------------------------
# 5. Plot Results
# ----------------------------
plt.figure(figsize=(10,6))

plt.subplot(3,1,1)
plt.plot(t, x_hist[:,2], label='θ (position)')
plt.axhline(r, color='r', linestyle='--', label='reference')
plt.ylabel('Position [rad]')
plt.legend()

plt.subplot(3,1,2)
plt.plot(t, x_hist[:,1])
plt.ylabel('Angular Velocity [rad/s]')

plt.subplot(3,1,3)
plt.plot(t, u_hist)
plt.ylabel('Control Voltage [V]')
plt.xlabel('Time [s]')

plt.tight_layout()
plt.show()
