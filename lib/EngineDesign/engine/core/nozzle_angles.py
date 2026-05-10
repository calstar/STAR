"""
Nozzle angle lookup table for Rao nozzle design.

This table provides theta_n (nozzle entrance angle) and theta_e (nozzle exit angle)
as functions of:
- Nozzle expansion ratio (eps = area_exit / area_throat)
- Bell percentage (60%, 70%, 80%, 90%, 100%)

Data extracted from parabola angles graph.

Usage:
    from nozzle_angles import lookup_angles
    
    theta_n, theta_e = lookup_angles(expansion_ratio=10.0, bell_percent=0.8)
"""

import numpy as np
import matplotlib.pyplot as plt
from scipy.interpolate import interp1d

# Lookup table: [expansion_ratio, bell_percent] -> (theta_n, theta_e)
# Expansion ratios sampled at key points (log scale: 3, 4, 5, 10, 20, 100)
# Interpolation range: 3.0 to 100.0 (values outside this range are clamped)
# Bell percentages: 0.60, 0.70, 0.80, 0.90, 1.00

NOZZLE_ANGLES_TABLE = {
    # Format: expansion_ratio: {bell_percent: (theta_n_deg, theta_e_deg)}
    # Interpolation range: 3.0 to 100.0

    4.0: {
        0.60: (26.5, 20.8),
        0.70: (23.9, 17.1),
        0.80: (21.6, 13.95),
        0.90: (20.0, 11.2),
        1.00: (19.0, 9.1),
    },
    5.0: {
        0.60: (28.0, 19.1),
        0.70: (25.1, 15.95),
        0.80: (23.0, 12.95),
        0.90: (20.95, 10.5),
        1.00: (19.9, 8.1),
    },
    10.0: {
        0.60: (32.0, 16.05),
        0.70: (28.3, 13.2),
        0.80: (26.2, 10.15),
        0.90: (24.1, 8.0),
        1.00: (22.5, 6.05),
    },
    20.0: {
        0.60: (34.9, 14.5),
        0.70: (31.1, 12.0),
        0.80: (28.8, 9.0),
        0.90: (27.0, 7.0),
        1.00: (25.1, 5.1),
    },
    100.0: {
        0.60: (40.1, 12.1),
        0.70: (36.2, 9.5),
        0.80: (33.6, 6.95),
        0.90: (32.6, 6.0),
        1.00: (31.9, 4.1),
    },
}


def lookup_angles(expansion_ratio, bell_percent=0.8):
    """
    Look up nozzle angles for given expansion ratio and bell percentage.
    
    Parameters:
    -----------
    expansion_ratio : float
        Nozzle expansion ratio (eps = area_exit / area_throat)
    bell_percent : float
        Bell percentage (0.60, 0.70, 0.80, 0.90, or 1.00)
    
    Returns:
    --------
    theta_n_deg : float
        Nozzle entrance angle in degrees
    theta_e_deg : float
        Nozzle exit angle in degrees
    """
    # Clamp expansion ratio to valid interpolation range [3.0, 100.0]
    eps = max(3.0, min(100.0, expansion_ratio))
    
    # Round bell_percent to nearest valid value
    valid_percents = [0.60, 0.70, 0.80, 0.90, 1.00]
    bell_pct = min(valid_percents, key=lambda x: abs(x - bell_percent))
    
    # Get expansion ratio keys
    eps_keys = sorted(NOZZLE_ANGLES_TABLE.keys())
    
    # If exact match, return directly
    if eps in eps_keys:
        return NOZZLE_ANGLES_TABLE[eps][bell_pct]
    
    # Interpolate between expansion ratios
    if eps < eps_keys[0]:
        # Extrapolate below minimum
        eps1, eps2 = eps_keys[0], eps_keys[1]
        theta_n1, theta_e1 = NOZZLE_ANGLES_TABLE[eps1][bell_pct]
        theta_n2, theta_e2 = NOZZLE_ANGLES_TABLE[eps2][bell_pct]
        # Linear interpolation in log space
        log_eps = np.log(eps)
        log_eps1 = np.log(eps1)
        log_eps2 = np.log(eps2)
        t = (log_eps - log_eps1) / (log_eps2 - log_eps1)
        theta_n = theta_n1 + t * (theta_n2 - theta_n1)
        theta_e = theta_e1 + t * (theta_e2 - theta_e1)
        return theta_n, theta_e
    
    if eps > eps_keys[-1]:
        # Extrapolate above maximum
        eps1, eps2 = eps_keys[-2], eps_keys[-1]
        theta_n1, theta_e1 = NOZZLE_ANGLES_TABLE[eps1][bell_pct]
        theta_n2, theta_e2 = NOZZLE_ANGLES_TABLE[eps2][bell_pct]
        # Linear interpolation in log space
        log_eps = np.log(eps)
        log_eps1 = np.log(eps1)
        log_eps2 = np.log(eps2)
        t = (log_eps - log_eps1) / (log_eps2 - log_eps1)
        theta_n = theta_n1 + t * (theta_n2 - theta_n1)
        theta_e = theta_e1 + t * (theta_e2 - theta_e1)
        return theta_n, theta_e
    
    # Find bounding expansion ratios
    for i in range(len(eps_keys) - 1):
        if eps_keys[i] <= eps < eps_keys[i + 1]:
            eps1, eps2 = eps_keys[i], eps_keys[i + 1]
            theta_n1, theta_e1 = NOZZLE_ANGLES_TABLE[eps1][bell_pct]
            theta_n2, theta_e2 = NOZZLE_ANGLES_TABLE[eps2][bell_pct]
            # Linear interpolation in log space (since x-axis is logarithmic)
            log_eps = np.log(eps)
            log_eps1 = np.log(eps1)
            log_eps2 = np.log(eps2)
            t = (log_eps - log_eps1) / (log_eps2 - log_eps1)
            theta_n = theta_n1 + t * (theta_n2 - theta_n1)
            theta_e = theta_e1 + t * (theta_e2 - theta_e1)
            return theta_n, theta_e
    
    # Fallback (shouldn't reach here)
    return NOZZLE_ANGLES_TABLE[eps_keys[-1]][bell_pct]


def lookup_angles_interp_bell(area_throat, area_exit, bell_percent=0.8):
    """
    Look up nozzle angles with interpolation in both expansion ratio and bell percentage.
    
    Parameters:
    -----------
    expansion_ratio : float
        Nozzle expansion ratio (eps = area_exit / area_throat)
    bell_percent : float
        Bell percentage (0.60 to 1.00)
    
    Returns:
    --------
    theta_n_deg : float
        Nozzle entrance angle in degrees
    theta_e_deg : float
        Nozzle exit angle in degrees
    """
    expansion_ratio = area_exit / area_throat

    # Clamp bell_percent to valid range
    bell_pct = max(0.60, min(1.00, bell_percent))
    
    # Get expansion ratio keys
    eps_keys = sorted(NOZZLE_ANGLES_TABLE.keys())
    valid_percents = [0.60, 0.70, 0.80, 0.90, 1.00]
    
    # Clamp expansion ratio to valid interpolation range [3.0, 100.0]
    eps = max(3.0, min(100.0, expansion_ratio))
    
    # Find bounding bell percentages
    if bell_pct in valid_percents:
        # Exact match, use simple lookup
        return lookup_angles(eps, bell_pct)
    
    # Find bounding bell percentages
    bell_low = None
    bell_high = None
    for i in range(len(valid_percents) - 1):
        if valid_percents[i] <= bell_pct < valid_percents[i + 1]:
            bell_low = valid_percents[i]
            bell_high = valid_percents[i + 1]
            break
    
    if bell_low is None:
        # At boundary
        if bell_pct <= valid_percents[0]:
            bell_low = bell_high = valid_percents[0]
        else:
            bell_low = bell_high = valid_percents[-1]
    
    # Get angles at both bell percentages
    theta_n_low, theta_e_low = lookup_angles(eps, bell_low)
    theta_n_high, theta_e_high = lookup_angles(eps, bell_high)
    
    # Interpolate in bell percentage
    if bell_low == bell_high:
        return theta_n_low, theta_e_low
    
    t = (bell_pct - bell_low) / (bell_high - bell_low)
    theta_n = theta_n_low + t * (theta_n_high - theta_n_low)
    theta_e = theta_e_low + t * (theta_e_high - theta_e_low)
    
    return theta_n, theta_e


def plot_nozzle_angles(save_path=None, show_plot=True):
    """
    Plot the nozzle angle lookup table to match the original graph format.
    
    Parameters:
    -----------
    save_path : str, optional
        Path to save the plot (e.g., 'nozzle_angles_plot.png')
    show_plot : bool
        Whether to display the plot (default: True)
    
    Returns:
    --------
    fig, ax : matplotlib figure and axes objects
    """
    # Define bell percentages and their colors
    bell_percents = [0.60, 0.70, 0.80, 0.90, 1.00]
    colors = {
        0.60: '#FFD700',  # Yellow/Gold
        0.70: '#00FF00',  # Green
        0.80: '#87CEEB',  # Light Blue/Sky Blue
        0.90: '#000000',  # Black
        1.00: '#800080',  # Purple
    }
    
    # Create expansion ratio array (log scale, dense for smooth curves)
    # Interpolation range: 3.0 to 100.0
    eps_min = 3.0
    eps_max = 100.0
    eps_plot = np.logspace(np.log10(eps_min), np.log10(eps_max), 200)
    
    # Create figure
    fig, ax = plt.subplots(figsize=(10, 6))
    
    # Plot theta_n curves (upper group)
    for bell_pct in bell_percents:
        theta_n_values = [lookup_angles(eps, bell_pct)[0] for eps in eps_plot]
        label = f'{int(bell_pct * 100)}%'
        ax.semilogx(eps_plot, theta_n_values, color=colors[bell_pct], 
                   linewidth=2, label=label)
    
    # Plot theta_e curves (lower group)
    for bell_pct in bell_percents:
        theta_e_values = [lookup_angles(eps, bell_pct)[1] for eps in eps_plot]
        label = f'{int(bell_pct * 100)}%'
        ax.semilogx(eps_plot, theta_e_values, color=colors[bell_pct], 
                   linewidth=2, label=label)
    
    # Add labels and brackets for theta_n and theta_e groups
    # Find approximate positions for labels
    eps_label = 80.0
    theta_n_mid = (lookup_angles(eps_label, 0.60)[0] + lookup_angles(eps_label, 1.00)[0]) / 2
    theta_e_mid = (lookup_angles(eps_label, 0.60)[1] + lookup_angles(eps_label, 1.00)[1]) / 2
    
    # Add vertical bracket and label for theta_n
    ax.annotate('', xy=(eps_max * 1.15, theta_n_mid + 5), 
                xytext=(eps_max * 1.15, theta_n_mid - 5),
                arrowprops=dict(arrowstyle='<->', lw=1.5, color='black'))
    ax.text(eps_max * 1.2, theta_n_mid, r'$\theta_n$', 
            fontsize=14, va='center', ha='left')
    
    # Add vertical bracket and label for theta_e
    ax.annotate('', xy=(eps_max * 1.15, theta_e_mid + 3), 
                xytext=(eps_max * 1.15, theta_e_mid - 3),
                arrowprops=dict(arrowstyle='<->', lw=1.5, color='black'))
    ax.text(eps_max * 1.2, theta_e_mid, r'$\theta_e$', 
            fontsize=14, va='center', ha='left')
    
    # Formatting
    ax.set_xlabel('Nozzle expansion ratio', fontsize=12)
    ax.set_ylabel('Parabola angles, degs', fontsize=12)
    ax.set_xlim(eps_min, eps_max * 1.3)  # Interpolation range: 3.0 to 100.0
    ax.set_ylim(0, 45)
    ax.grid(True, alpha=0.3, which='both')
    ax.set_title('Parabola angles vs Nozzle expansion ratio', fontsize=14, fontweight='bold')
    
    # Add legend (optional, but might be cluttered)
    # ax.legend(title='Bell %', loc='upper left', ncol=5, fontsize=8)
    
    # Add percentage labels near the curves (at expansion ratio ~50)
    eps_label_pos = 50.0
    for bell_pct in bell_percents:
        theta_n_val = lookup_angles(eps_label_pos, bell_pct)[0]
        theta_e_val = lookup_angles(eps_label_pos, bell_pct)[1]
        label_text = f'{int(bell_pct * 100)}%'
        ax.text(eps_label_pos, theta_n_val, label_text, 
               fontsize=8, ha='left', va='center', color=colors[bell_pct])
        ax.text(eps_label_pos, theta_e_val, label_text, 
               fontsize=8, ha='left', va='center', color=colors[bell_pct])
    
    plt.tight_layout()
    
    if save_path:
        plt.savefig(save_path, dpi=150, bbox_inches='tight')
        print(f"Plot saved to {save_path}")
    
    if show_plot:
        plt.show()
    else:
        plt.close()
    
    return fig, ax