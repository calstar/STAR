import numpy as np
import matplotlib.pyplot as plt
from scipy.optimize import root
from engine.core.nozzle_angles import lookup_angles_interp_bell


# -----------------------------
# Rotated parabola (Garcia Eq. 7)
# -----------------------------
def rotated_parabola_xy(t, m, theta, h, k):
    """
    x(t) = t(-m sinθ t + cosθ) + h
    y(t) = t( m cosθ t + sinθ) + k
    """
    t = np.asarray(t)
    s = np.sin(theta)
    c = np.cos(theta)

    x = t * (-m * s * t + c) + h
    y = t * ( m * c * t + s) + k
    return x, y


def solve_rotated_parabola_params(Nx, Ny, Ex, Ey, theta_n, theta_e):
    """
    Solve for m, h, k, psi, t5, t6 such that the rotated parabola goes
    through N and E with the correct slopes at each end.
    """

    def equations(u):
        m, h, k, psi, t5, t6 = u
        s = np.sin(psi)
        c = np.cos(psi)

        def xy(t):
            x = -m * s * t**2 + c * t + h
            y =  m * c * t**2 + s * t + k
            return x, y

        def slope(t):
            dxdt = -2 * m * s * t + c
            dydt =  2 * m * c * t + s
            return dydt / dxdt

        x5, y5 = xy(t5)
        x6, y6 = xy(t6)

        eq1 = x5 - Nx
        eq2 = y5 - Ny
        eq3 = x6 - Ex
        eq4 = y6 - Ey
        eq5 = slope(t5) - np.tan(theta_n)
        eq6 = slope(t6) - np.tan(theta_e)
        return [eq1, eq2, eq3, eq4, eq5, eq6]

    # crude initial guess
    L = Ex - Nx if Ex != Nx else 1.0
    m0   = (Ey - Ny) / (L**2)
    h0   = Nx
    k0   = Ny
    psi0 = 0.5 * (theta_n + theta_e)
    t50  = 0.0
    t60  = L

    u0 = [m0, h0, k0, psi0, t50, t60]
    sol = root(equations, u0, method="hybr")

    if not sol.success:
        raise RuntimeError(f"Parabola solve failed: {sol.message}")

    return sol.x  # m, h, k, psi, t5, t6


# -----------------------------
# Placeholder for true Rao MoC nozzle
# -----------------------------
def generate_rao_moc_contour(Nx, Ny, Ex, Ey, theta_n, theta_e,
                             steps=200, gamma=1.23):
    """
    TRUE Rao Method-of-Characteristics nozzle contour placeholder.
    """
    raise NotImplementedError(
        "generate_rao_moc_contour is not implemented. "
        "Use method='top' for a standard Thrust-Optimized Parabolic "
        "approximation of Rao, or 'garcia' for the rotated-parabola form."
    )


# -----------------------------
# Main Rao-style nozzle generator
# -----------------------------
def rao(area_throat,
        area_exit,
        bell_percent=0.8,
        steps=200,
        do_plot=True,
        color_segments=False,
        method="garcia",
        gamma=1.23):
    """
    method:
      - "top"     : Thrust-Optimized Parabolic (quadratic Bézier N-Q-E)
      - "garcia"  : rotated/canted parabola (RRS Garcia 2023)
      - "rao_moc" : placeholder hook for a true Rao MoC solver
    """

    eps = area_exit / area_throat
    deg2rad = lambda d: d * np.pi / 180.0

    # Look up angles using interpolation
    theta_n_degree, theta_e_degree = lookup_angles_interp_bell(
        area_throat, area_exit, bell_percent
    )
    theta_n = deg2rad(theta_n_degree)
    theta_e = deg2rad(theta_e_degree)

    r_t = np.sqrt(area_throat / np.pi)
    r_e = np.sqrt(area_exit / np.pi)

    # ----- Entrance arc: 1.5 Rt
    theta1 = np.linspace(deg2rad(-135), deg2rad(-90), steps)
    x1 = 1.5 * r_t * np.cos(theta1)
    y1 = 1.5 * r_t * np.sin(theta1) + 1.5 * r_t + r_t

    # ----- Throat arc: 0.382 Rt
    theta2 = np.linspace(deg2rad(-90), theta_n - deg2rad(90), steps)
    x2 = 0.382 * r_t * np.cos(theta2)
    y2 = 0.382 * r_t * np.sin(theta2) + 0.382 * r_t + r_t

    # Start of bell (point N)
    Nx, Ny = x2[-1], y2[-1]

    # End of bell (point E)
    L_noz = bell_percent * ((np.sqrt(eps) - 1.0) * r_t / np.tan(deg2rad(15.0)))
    Ex = L_noz
    Ey = r_e

    method = method.lower()
    param_text = ""

    # -----------------------
    # Bell section by method
    # -----------------------
    if method == "top":
        # Classic Thrust-Optimized Parabolic (quadratic Bézier)
        m1 = np.tan(theta_n)
        m2 = np.tan(theta_e)
        c1 = Ny - m1 * Nx
        c2 = Ey - m2 * Ex

        Qx = (c2 - c1) / (m1 - m2)
        Qy = (m1 * c2 - m2 * c1) / (m1 - m2)

        t = np.linspace(0.0, 1.0, steps)
        x3 = (1 - t)**2 * Nx + 2*(1 - t)*t*Qx + t**2 * Ex
        y3 = (1 - t)**2 * Ny + 2*(1 - t)*t*Qy + t**2 * Ey

        param_text = (
            "TOP Bézier bell\n"
            f"N = ({Nx:.4g}, {Ny:.4g})\n"
            f"Q = ({Qx:.4g}, {Qy:.4g})\n"
            f"E = ({Ex:.4g}, {Ey:.4g})\n"
            f"θ_n = {theta_n_degree:.2f}°, θ_e = {theta_e_degree:.2f}°\n"
            f"ε = {eps:.4g}, L_noz = {L_noz:.4g}"
        )

    elif method == "garcia":
        # Garcia canted, rotated parabola
        m, h, k, psi, t5, t6 = solve_rotated_parabola_params(
            Nx, Ny, Ex, Ey, theta_n, theta_e
        )
        t_vals = np.linspace(t5, t6, steps)
        x3, y3 = rotated_parabola_xy(t_vals, m=m, theta=psi, h=h, k=k)

        param_text = (
            "Garcia rotated parabola\n"
            f"N = ({Nx:.4g}, {Ny:.4g})\n"
            f"E = ({Ex:.4g}, {Ey:.4g})\n"
            f"θ_n = {theta_n_degree:.2f}°, θ_e = {theta_e_degree:.2f}°\n"
            f"m = {m:.4g}, h = {h:.4g}, k = {k:.4g}\n"
            f"ψ = {np.degrees(psi):.2f}°\n"
            f"t5 = {t5:.4g}, t6 = {t6:.4g}"
        )

    elif method == "rao_moc":
        # True Rao MoC (not implemented – placeholder)
        x3, y3 = generate_rao_moc_contour(
            Nx, Ny, Ex, Ey, theta_n, theta_e,
            steps=steps, gamma=gamma
        )
        param_text = (
            "Rao MoC (placeholder)\n"
            f"N = ({Nx:.4g}, {Ny:.4g})\n"
            f"E = ({Ex:.4g}, {Ey:.4g})\n"
            f"θ_n = {theta_n_degree:.2f}°, θ_e = {theta_e_degree:.2f}°\n"
            f"ε = {eps:.4g}, L_noz = {L_noz:.4g}\n"
            "MoC contour not yet implemented"
        )
    else:
        raise ValueError(f"Unknown method '{method}'. "
                         "Use 'top', 'garcia', or 'rao_moc'.")

    # ---- Combine all pieces
    pts = np.vstack([
        np.column_stack((x1, y1)),
        np.column_stack((x2[1:], y2[1:])),
        np.column_stack((x3[1:], y3[1:]))
    ])

    # ---- Plot
    if do_plot:
        plt.figure(figsize=(8, 4))

        if color_segments:
            plt.plot(x1, y1, label='Entrance arc', color='red')
            plt.plot(x2, y2, label='Throat arc',   color='green')
            plt.plot(x3, y3, label=f'Bell ({method})', color='blue')
            plt.legend()
        else:
            plt.plot(pts[:, 0], pts[:, 1], 'k-', linewidth=2)

        plt.gca().set_aspect('equal', 'box')
        plt.xlabel("Axial distance x")
        plt.ylabel("Radius y")
        plt.grid(True, alpha=0.3)
        plt.title(f"Rao nozzle – {method.upper()}")

        # Add parameter text box on the figure
        plt.gcf().text(
            0.02, 0.02, param_text,
            fontsize=8,
            va="bottom", ha="left",
            bbox=dict(boxstyle="round", facecolor="white", alpha=0.8)
        )

      

        # NEW:
        plt.savefig('nozzle_models/rao/rao_nozzle.png', dpi=150, bbox_inches='tight')
        plt.close()  

    # Get x value of first point
    x_first = pts[0, 0]
    y_first = pts[0, 1]
    
    return pts, x_first, y_first


# Example usage (commented out to avoid running on import)
# pts, x_first = rao(0.00156235266901, 0.00831498636119,
#     method="top", do_plot=True, color_segments=True)
# print(f"First point x value: {x_first}")