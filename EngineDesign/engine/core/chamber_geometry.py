import numpy as np
import matplotlib.pyplot as plt
import sys
from pathlib import Path

try:
    import ezdxf
    HAS_EZDXF = True
except ImportError:
    HAS_EZDXF = False

from engine.core.nozzle_solver import rao 

theta_default = np.pi/4
force_coeffcient_default = 1.4
diameter_exit_default = 4 / 39.37
l_star_default = 1.27
chamber_diameter_default = 3.4 / 39.37

def area_exit_calc(diameter_exit=diameter_exit_default):
    """
    Calculate the area of the exit of the chamber.
    Parameters:
    - diameter_exit: The diameter of the exit of the chamber.
    Calculate the area of the exit of the chamber.
    """
    return np.pi * (diameter_exit / 2) ** 2

def expansion_ratio_calc(area_exit, area_throat):
    """
    Calculate the expansion ratio of the chamber.
    Parameters:
    - area_exit: The area of the exit of the chamber.
    - area_throat: The area of the throat of the chamber.
    Calculate the expansion ratio of the chamber.
    """
    return area_exit / area_throat

def area_throat_calc(pc_design, thrust_design, force_coeffcient=force_coeffcient_default):
    """
    Calculate the area of the throat of the chamber.
    Parameters:
    - pc_design: The design chamber pressure.
    - thrust_design: The design thrust.
    - force_coeffcient: The force coeffcient.
    Calculate the area of the throat of the chamber.
    """
    return thrust_design / (pc_design * force_coeffcient)

def chamber_volume_calc(area_throat, l_star = l_star_default):
    """
    Parameters:
    - l_star: The characteristic length of the chamber. (Get from config)
    - area_throat: The area of the throat of the chamber.
    Calculate the volume of the chamber.
    """


    return l_star * area_throat




def contraction_ratio_calc(area_chamber, area_throat):
    """
    Calculate the contraction ratio of the chamber.
    Parameters:
    - area_chamber: The area of the chamber.
    - area_throat: The area of the throat of the chamber.
    Calculate the contraction ratio of the chamber.
    """
    return area_chamber / area_throat

def area_chamber_calc(diameter_inner=chamber_diameter_default):
    """
    Calculate the area of the chamber.
    Parameters:
    - diameter_inner: The inner diameter of the chamber. = 3.4"
    Calculate the area of the chamber.
    """
    return np.pi * (diameter_inner / 2) ** 2

def chamber_diameter_calc(area_chamber):
    """
    Calculate the diameter of the chamber.
    Parameters:
    - area_chamber: The area of the chamber.
    Calculate the diameter of the chamber.
    """
    return np.sqrt(4 * area_chamber / np.pi)

def entrance_arc_volume(R_t, theta=theta_default, steps=4000):
    """Solid-of-revolution volume of the 1.5*R_t nozzle entrance arc, face side of the throat.

    The arc is centred at (0, 2.5*R_t) with radius 1.5*R_t and is swept from
    t = -(pi/2 + theta) (tangent to the convergent cone) to t = -pi/2 (the throat), so

        x(t) = 1.5 R_t cos t,   y(t) = 1.5 R_t sin t + 2.5 R_t

    and V = integral of pi*y^2 dx over that sweep. Integrated numerically because the closed
    form is easy to get subtly wrong and this is called once per candidate, not per step.
    """
    t0 = -(np.pi / 2.0 + float(theta))
    t = np.linspace(t0, -np.pi / 2.0, int(steps))
    x = 1.5 * R_t * np.cos(t)
    y = 1.5 * R_t * np.sin(t) + 2.5 * R_t
    trapz = getattr(np, "trapezoid", None) or np.trapz
    return float(trapz(np.pi * y * y, x))


def chamber_length_calc(chamber_volume, area_throat, contraction_ratio, theta = theta_default):
    """
    Calculate the length of the chamber.
    Parameters:
    - chamber_volume: The volume of the chamber.
    - area_throat: The area of the throat of the chamber.
    - contraction_ratio: The contraction ratio of the chamber.
    - theta: The angle of the chamber. = 45 degrees from -135deg nozzle entrance
    Calculate the length of the chamber.
    """
    # Exact conical-frustum volume between A_c and A_t at half-angle `theta`:
    #   h      = (R_c - R_t) * cot(theta)
    #   V_cone = (pi h / 3)(R_c^2 + R_c R_t + R_t^2)
    # and with R_c = R_t * sqrt(eps) this closes to
    #   V_cone = (A_t R_t cot(theta) / 3) * (eps^(3/2) - 1).
    #
    # This previously used (eps^(1/3) - 1), which at a typical eps = 6.76 credits the
    # convergent section with 13.6 cm^3 instead of 252.9 cm^3 -- 18.6x low. The generator
    # then made the missing volume up in barrel length, so a commanded L* = 1.30 was drawn
    # as a chamber whose integrated volume is L* = 1.43: 18.9 mm and 0.64 kg of barrel that
    # the design never asked for. Verified against direct numerical integration of the
    # generated contour (tests/test_chamber_geometry_volume.py).
    # SECOND correction (2026-09-14): the cone does not reach R_t. It runs to the tangency
    # radius of the 1.5*R_t entrance arc, r_tan = R_t*(1 + 1.5*(1 - cos(theta))), and the arc
    # carries the rest. Crediting a straight frustum all the way to R_t under-counts the
    # convergent volume by the arc's bulge, and the generator again made it up in barrel
    # length -- 0.9-2.1% of L* depending on theta. Now: exact frustum R_c -> r_tan, plus the
    # arc's own solid of revolution.
    R_t = np.sqrt(area_throat / np.pi)
    A_c = area_throat * contraction_ratio
    R_c = np.sqrt(A_c / np.pi)
    cot_theta = np.tan(np.pi / 2 - theta)

    r_tan = R_t * (1.0 + 1.5 * (1.0 - np.cos(theta)))
    if r_tan >= R_c:                      # arc alone spans the whole contraction
        V_cone = 0.0
    else:
        h_cone = (R_c - r_tan) * cot_theta
        V_cone = (np.pi * h_cone / 3.0) * (R_c ** 2 + R_c * r_tan + r_tan ** 2)

    V_cone += entrance_arc_volume(R_t, theta)
    return (chamber_volume - V_cone) / A_c


def contraction_length_horizontal_calc(area_chamber, entrance_arc_start_y, theta=theta_default):
  
    R_start = np.sqrt(area_chamber / np.pi)
    R_end = entrance_arc_start_y
    L_cone = (R_start - R_end) * np.tan(np.pi/2 - theta)
    return L_cone



def generate_nozzle(area_throat, area_exit, steps=200, theta=theta_default):
    return rao(area_throat, area_exit, method="top", do_plot=False, steps=steps,
               convergent_half_angle_rad=theta)


def chamber_geometry_calc(pc_design, 
    thrust_design, force_coeffcient=force_coeffcient_default, 
    diameter_inner=chamber_diameter_default, 
    diameter_exit=diameter_exit_default, 
    l_star = l_star_default, 
    do_plot=False, 
    color_segments=False, 
    steps=200, 
    export_dxf=None,
    theta=theta_default):
    """
    Calculate the full chamber geometry including cylindrical section, contraction, and nozzle.
    
    Parameters:
    -----------
    export_dxf : str or None
        If provided, exports the contour to a DXF file at the specified path.
        Example: 'chamber/chamber_contour.dxf'
    
    Returns:
    --------
    pts : numpy array
        Array of (x, y) points representing the full chamber contour
    data : list of lists
        Table data with metric and imperial units. First row contains headers:
        ['Parameter', 'Metric Value', 'Metric Units', 'Imperial Value', 'Imperial Units']
        Subsequent rows contain parameter data.
    """
    area_throat = area_throat_calc(pc_design, thrust_design, force_coeffcient)
    area_exit = area_exit_calc(diameter_exit)
    volume_chamber = chamber_volume_calc(area_throat, l_star)
    area_chamber = area_chamber_calc(diameter_inner)
    contraction_ratio = contraction_ratio_calc(area_chamber, area_throat)
    nozzle_pts, nozzle_x_first, nozzle_y_first = generate_nozzle(area_throat, area_exit, steps=steps, theta=theta)
    cylindrical_length = chamber_length_calc(volume_chamber, area_throat, contraction_ratio, theta)
    contraction_length_horizontal = contraction_length_horizontal_calc(area_chamber, nozzle_y_first, theta)
    
    # Calculate total chamber length (cylindrical + contraction) from injector face to throat
    total_chamber_length = cylindrical_length + contraction_length_horizontal
    
    # Calculate chamber radius
    r_c = np.sqrt(area_chamber / np.pi)
    
    # Calculate where cylindrical section starts
    # The 45° contraction line connects (x_cyl_start, r_c) to (nozzle_x_first, nozzle_y_first)
    # For 45° line: y = r_c - (x - x_cyl_start) = r_c - x + x_cyl_start
    # At connection: nozzle_y_first = r_c - nozzle_x_first + x_cyl_start
    # General half-angle: the convergent runs from (x_cyl_start, r_c) down to
    # (nozzle_x_first, nozzle_y_first) over a horizontal run of (r_c - y_first)*cot(theta).
    # At theta = 45 deg this reduces to the old x_first + y_first - r_c.
    _cot = np.tan(np.pi/2 - theta)
    contraction_run = (r_c - nozzle_y_first) * _cot
    x_cyl_start = nozzle_x_first - contraction_run
    
    # Generate cylindrical section (constant radius)
    x_cyl_end = x_cyl_start - cylindrical_length
    x_cyl = np.linspace(x_cyl_end, x_cyl_start, steps)
    y_cyl = np.full_like(x_cyl, r_c)
    
    # Generate contraction section (45° line)
    x_contraction = np.linspace(x_cyl_start, nozzle_x_first, steps)
    # Straight convergent at half-angle theta: y = r_c - (x - x_cyl_start)*tan(theta)
    y_contraction = r_c - (x_contraction - x_cyl_start) * np.tan(theta)
    
    # Combine all sections: cylindrical -> contraction -> nozzle
    # Note: nozzle_pts already includes all nozzle segments
    chamber_pts = np.vstack([
        np.column_stack((x_cyl, y_cyl)),
        np.column_stack((x_contraction[1:], y_contraction[1:])),  # Skip first point to avoid duplicate
        nozzle_pts  # Nozzle already starts at the connection point
    ])
    
    # Calculate additional diameters for table data
    diameter_chamber = chamber_diameter_calc(area_chamber)
    diameter_throat = np.sqrt(4 * area_throat / np.pi)
    diameter_exit_calc = np.sqrt(4 * area_exit / np.pi)
    expansion_ratio = expansion_ratio_calc(area_exit, area_throat)
    
    # Conversion factors
    m_to_in = 39.37
    m2_to_in2 = 1550.0031
    m3_to_in3 = 61023.7441
    pa_to_psi = 0.000145038  # 1 Pa = 0.000145038 PSI
    n_to_lbf = 0.224809  # 1 N = 0.224809 lbf
    
    # Convert to imperial
    volume_chamber_in3 = volume_chamber * m3_to_in3
    area_chamber_in2 = area_chamber * m2_to_in2
    diameter_chamber_in = diameter_chamber * m_to_in
    area_throat_in2 = area_throat * m2_to_in2
    diameter_throat_in = diameter_throat * m_to_in
    area_exit_in2 = area_exit * m2_to_in2
    diameter_exit_in = diameter_exit_calc * m_to_in
    l_star_in = l_star * m_to_in
    cylindrical_length_in = cylindrical_length * m_to_in
    contraction_length_horizontal_in = contraction_length_horizontal * m_to_in
    total_chamber_length_in = total_chamber_length * m_to_in
    pc_design_psi = pc_design * pa_to_psi
    thrust_design_lbf = thrust_design * n_to_lbf
    
    # Create table data with metric and imperial units
    table_data = [
        ['Parameter', 'Metric Value', 'Metric Units', 'Imperial Value', 'Imperial Units'],
        ['Design Pressure', f'{pc_design:.2e}', 'Pa', f'{pc_design_psi:.2f}', 'PSI'],
        ['Design Thrust', f'{thrust_design:.2f}', 'N', f'{thrust_design_lbf:.2f}', 'lbf'],
        ['Chamber Volume', f'{volume_chamber:.6e}', 'm³', f'{volume_chamber_in3:.4f}', 'in³'],
        ['Chamber Area', f'{area_chamber:.6e}', 'm²', f'{area_chamber_in2:.4f}', 'in²'],
        ['Chamber Diameter', f'{diameter_chamber:.6e}', 'm', f'{diameter_chamber_in:.4f}', 'in'],
        ['Throat Area', f'{area_throat:.6e}', 'm²', f'{area_throat_in2:.6f}', 'in²'],
        ['Throat Diameter', f'{diameter_throat:.6e}', 'm', f'{diameter_throat_in:.6f}', 'in'],
        ['Exit Area', f'{area_exit:.6e}', 'm²', f'{area_exit_in2:.4f}', 'in²'],
        ['Exit Diameter', f'{diameter_exit_calc:.6e}', 'm', f'{diameter_exit_in:.4f}', 'in'],
        ['Expansion Ratio', f'{expansion_ratio:.4f}', '', f'{expansion_ratio:.4f}', ''],
        ['Contraction Ratio', f'{contraction_ratio:.4f}', '', f'{contraction_ratio:.4f}', ''],
        ['L*', f'{l_star:.4f}', 'm', f'{l_star_in:.4f}', 'in'],
        ['Cylindrical Length', f'{cylindrical_length:.6e}', 'm', f'{cylindrical_length_in:.4f}', 'in'],
        ['Contraction Length', f'{contraction_length_horizontal:.6e}', 'm', f'{contraction_length_horizontal_in:.4f}', 'in'],
        ['Total Chamber Length', f'{total_chamber_length:.6e}', 'm', f'{total_chamber_length_in:.4f}', 'in'],
    ]
    
    # Plot if requested
    if do_plot:
        # Create figure with two subplots: contour on top, table below
        fig = plt.figure(figsize=(16, 14))
        gs = fig.add_gridspec(2, 1, height_ratios=[2, 1], hspace=0.15)
        
        # Top subplot for contour
        ax = fig.add_subplot(gs[0])
        
        if color_segments:
            ax.plot(x_cyl, y_cyl, label='Cylindrical section', color='blue', linewidth=2)
            ax.plot(x_contraction, y_contraction, label='Contraction (45°)', color='green', linewidth=2)
            ax.plot(nozzle_pts[:, 0], nozzle_pts[:, 1], label='Nozzle', color='red', linewidth=2)
            ax.legend()
        else:
            ax.plot(chamber_pts[:, 0], chamber_pts[:, 1], 'k-', linewidth=2)
        
        # Stretch the plot vertically to show more detail in radius direction
        # Get the data range to calculate aspect ratio (after plotting)
        ax.relim()
        ax.autoscale()
        x_min, x_max = ax.get_xlim()
        y_min, y_max = ax.get_ylim()
        x_range = x_max - x_min
        y_range = y_max - y_min
        
        # Set aspect ratio to stretch y-direction (make it taller)
        # A smaller aspect value stretches the y-axis
        aspect_ratio = (x_range / y_range) * 0.2  # 0.3 factor stretches y-direction
        ax.set_aspect(aspect_ratio, 'box')
        
        # Add small padding to y-axis
        ax.set_ylim(y_min - 0.05 * y_range, y_max + 0.05 * y_range)
        
        ax.set_xlabel("Axial distance x (m)", fontsize=12)
        ax.set_ylabel("Radius y (m)", fontsize=12)
        ax.grid(True, alpha=0.3)
        ax.set_title("Full Chamber Contour", fontsize=14, fontweight='bold')
        
        # Bottom subplot for table
        ax_table = fig.add_subplot(gs[1])
        ax_table.axis('off')
        
        # Create table
        table = ax_table.table(cellText=table_data[1:], colLabels=table_data[0],
                              cellLoc='left', loc='center',
                              bbox=[0, 0, 1, 1])
        table.auto_set_font_size(False)
        table.set_fontsize(18)
        table.scale(1.5, 4.5)  # Much larger scale for better spacing
        
        # Set column widths for better readability
        col_widths = [0.22, 0.22, 0.12, 0.22, 0.12]  # Wider columns
        for i in range(5):
            for j in range(len(table_data)):
                table[(j, i)].set_width(col_widths[i])
        
        # Style the header row
        for i in range(5):
            table[(0, i)].set_facecolor('#40466e')
            table[(0, i)].set_text_props(weight='bold', color='white', size=20)
            table[(0, i)].set_height(0.35)  # Much taller header row
        
        # Alternate row colors and style cells
        for i in range(1, len(table_data)):
            for j in range(5):
                if i % 2 == 0:
                    table[(i, j)].set_facecolor('#f1f1f2')
                else:
                    table[(i, j)].set_facecolor('white')
                table[(i, j)].set_text_props(size=18)
                table[(i, j)].set_height(0.30)  # Much taller data rows
        
        # Ensure directory exists before saving
        output_path = Path('chamber/chamber_full_contour.png')
        output_path.parent.mkdir(parents=True, exist_ok=True)
        plt.savefig(str(output_path), dpi=150, bbox_inches='tight')
        plt.close()
    
    # Export to DXF if requested
    if export_dxf is not None:
        from engine.core.dxf_export import export_chamber_dxf
        export_chamber_dxf(chamber_pts, export_dxf)
    
    # Also return the lengths as a separate dictionary for easy access
    lengths = {
        'cylindrical': cylindrical_length,
        'contraction': contraction_length_horizontal,
        'total': total_chamber_length
    }
    
    return chamber_pts, table_data, lengths

# Only run example if script is executed directly (not when imported)
if __name__ == "__main__":
    pts, data, lengths = chamber_geometry_calc(pc_design=2.068e6, thrust_design=6000, do_plot=True, color_segments=True, export_dxf='chamber/chamber_contour.dxf')
 