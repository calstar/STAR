"""
Robust DXF export utilities for chamber geometry.

This module provides functions to export chamber contours as CAD-compatible DXF files
with proper handling of:
- Coordinate quantization (consistent precision)
- Vertex deduplication (no overlapping points)
- Zero-length segment removal
- Endpoint continuity validation
- Single closed LWPOLYLINE output
"""

import numpy as np
from pathlib import Path
from typing import Optional, Tuple

try:
    import ezdxf
    HAS_EZDXF = True
except ImportError:
    HAS_EZDXF = False


# DXF coordinate precision - 6 decimal places gives ~1 micrometer precision for meter units
DXF_PRECISION = 6

# Epsilon for vertex comparison - vertices closer than this are considered duplicates
VERTEX_EPSILON = 1e-9


def quantize_coordinates(pts: np.ndarray, precision: int = DXF_PRECISION) -> np.ndarray:
    """
    Round coordinates to fixed decimal places for CAD compatibility.
    
    This ensures consistent coordinate representation and eliminates
    floating-point precision issues that cause gaps in CAD imports.
    
    Parameters:
    -----------
    pts : np.ndarray
        Array of (x, y) points, shape (N, 2)
    precision : int
        Number of decimal places to round to (default: 6)
        
    Returns:
    --------
    np.ndarray
        Quantized points array with same shape
    """
    return np.round(pts, decimals=precision)


def deduplicate_vertices(pts: np.ndarray, epsilon: float = VERTEX_EPSILON) -> np.ndarray:
    """
    Remove duplicate/near-duplicate consecutive vertices.
    
    This handles the case where segment boundaries have overlapping points,
    ensuring each vertex appears exactly once in the output polyline.
    
    Parameters:
    -----------
    pts : np.ndarray
        Array of (x, y) points, shape (N, 2)
    epsilon : float
        Distance threshold - points closer than this are considered duplicates
        
    Returns:
    --------
    np.ndarray
        Deduplicated points array
    """
    if len(pts) == 0:
        return pts
    
    # Always keep the first point
    keep_mask = np.ones(len(pts), dtype=bool)
    
    # Check each point against the previous one
    for i in range(1, len(pts)):
        dist = np.linalg.norm(pts[i] - pts[i-1])
        if dist < epsilon:
            keep_mask[i] = False
    
    return pts[keep_mask]


def remove_zero_length_segments(pts: np.ndarray, epsilon: float = VERTEX_EPSILON) -> np.ndarray:
    """
    Remove points that would create zero-length line segments.
    
    This is similar to deduplicate_vertices but specifically targets
    zero-length segments that cause CAD import errors.
    
    Parameters:
    -----------
    pts : np.ndarray
        Array of (x, y) points, shape (N, 2)
    epsilon : float
        Length threshold - segments shorter than this are removed
        
    Returns:
    --------
    np.ndarray
        Cleaned points array with no zero-length segments
    """
    # This is essentially the same as deduplicate_vertices
    # since zero-length segments come from duplicate/near-duplicate points
    return deduplicate_vertices(pts, epsilon)


def validate_continuity(pts: np.ndarray, max_gap: float = 1e-6) -> Tuple[bool, Optional[int], Optional[float]]:
    """
    Validate that the polyline forms a continuous path.
    
    Checks that there are no unexpected gaps between consecutive vertices.
    
    Parameters:
    -----------
    pts : np.ndarray
        Array of (x, y) points, shape (N, 2)
    max_gap : float
        Maximum allowed gap between consecutive points for typical geometry.
        Gaps larger than this trigger a warning.
        
    Returns:
    --------
    Tuple[bool, Optional[int], Optional[float]]
        (is_valid, gap_index, gap_distance)
        - is_valid: True if all consecutive points are reasonably close
        - gap_index: Index of first large gap (if any)
        - gap_distance: Distance of first large gap (if any)
    """
    if len(pts) < 2:
        return True, None, None
    
    # Calculate distances between consecutive points
    diffs = np.diff(pts, axis=0)
    distances = np.linalg.norm(diffs, axis=1)
    
    # Find typical segment length (median)
    median_dist = np.median(distances)
    
    # A gap is suspicious if it's more than 100x the median distance
    # This accounts for variable point density in different sections
    # (e.g., fine sampling in nozzle curves vs coarse in straight sections)
    suspicious_threshold = max(max_gap, median_dist * 100)
    
    for i, dist in enumerate(distances):
        if dist > suspicious_threshold:
            return False, i, dist
    
    return True, None, None


def ensure_shared_vertices(pts: np.ndarray, precision: int = DXF_PRECISION) -> np.ndarray:
    """
    Ensure vertices at segment boundaries are properly shared.
    
    After quantization, this ensures that connecting points between
    segments (cylindrical->contraction->nozzle) are exactly the same.
    
    Parameters:
    -----------
    pts : np.ndarray
        Array of (x, y) points, shape (N, 2)
    precision : int
        Number of decimal places for coordinate quantization
        
    Returns:
    --------
    np.ndarray
        Points array with shared vertices at boundaries
    """
    # Quantize first to ensure consistent representation
    pts = quantize_coordinates(pts, precision)
    
    # Then deduplicate to merge any coincident points
    pts = deduplicate_vertices(pts)
    
    return pts


def prepare_polyline_points(pts: np.ndarray, 
                            precision: int = DXF_PRECISION,
                            epsilon: float = VERTEX_EPSILON) -> np.ndarray:
    """
    Full preparation pipeline for polyline points.
    
    Applies all cleaning steps in the correct order:
    1. Quantize coordinates
    2. Deduplicate vertices
    3. Remove zero-length segments
    4. Validate continuity
    
    Parameters:
    -----------
    pts : np.ndarray
        Raw array of (x, y) points, shape (N, 2)
    precision : int
        Decimal places for coordinate quantization
    epsilon : float
        Threshold for vertex deduplication
        
    Returns:
    --------
    np.ndarray
        Cleaned, validated points ready for DXF export
    """
    # Step 1: Quantize coordinates
    cleaned = quantize_coordinates(pts, precision)
    
    # Step 2: Deduplicate vertices
    cleaned = deduplicate_vertices(cleaned, epsilon)
    
    # Step 3: Remove any remaining zero-length segments
    cleaned = remove_zero_length_segments(cleaned, epsilon)
    
    # Step 4: Validate continuity (warning only, don't fail)
    is_valid, gap_idx, gap_dist = validate_continuity(cleaned)
    if not is_valid:
        import warnings
        warnings.warn(
            f"Large gap detected in geometry at index {gap_idx}: {gap_dist:.6e} m. "
            f"This may indicate a geometry generation issue."
        )
    
    return cleaned


def export_chamber_dxf(chamber_pts: np.ndarray, 
                       export_path: str,
                       add_centerline: bool = True,
                       add_mirrored: bool = False,
                       layer_name: str = "CONTOUR",
                       centerline_layer: str = "CENTERLINE",
                       precision: int = DXF_PRECISION) -> None:
    """
    Export chamber contour to a CAD-compatible DXF file.
    
    Creates a single LWPOLYLINE with properly shared vertices,
    quantized coordinates, and no duplicate or zero-length entities.
    
    Parameters:
    -----------
    chamber_pts : np.ndarray
        Array of (x, y) points representing the chamber contour
    export_path : str
        Path to save the DXF file
    add_centerline : bool
        If True, adds a centerline (y=0) as a reference line
    add_mirrored : bool
        If True, also adds the mirrored (lower half) contour
    layer_name : str
        DXF layer name for the contour
    centerline_layer : str
        DXF layer name for the centerline
    precision : int
        Decimal places for coordinate quantization
    """
    if not HAS_EZDXF:
        raise ImportError(
            "ezdxf library is required for DXF export. "
            "Install it with: pip install ezdxf"
        )
    
    # Ensure directory exists
    dxf_path = Path(export_path)
    dxf_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Prepare points (quantize, deduplicate, validate)
    cleaned_pts = prepare_polyline_points(chamber_pts, precision=precision)
    
    # Create DXF document - use R2010 format for broad compatibility
    doc = ezdxf.new('R2010')
    msp = doc.modelspace()
    
    # Create layers
    doc.layers.add(layer_name, color=7)  # White/default color
    if add_centerline:
        doc.layers.add(centerline_layer, color=1)  # Red
    
    # Convert to list of tuples for ezdxf
    points = [(float(pt[0]), float(pt[1])) for pt in cleaned_pts]
    
    # Create the main contour as a single LWPOLYLINE
    # This is the critical fix - one continuous polyline, not multiple lines
    polyline = msp.add_lwpolyline(
        points,
        dxfattribs={'layer': layer_name}
    )
    
    # Add mirrored contour if requested (for full cross-section)
    if add_mirrored:
        # Mirror points about x-axis (negate y)
        mirrored_points = [(float(pt[0]), -float(pt[1])) for pt in reversed(cleaned_pts)]
        msp.add_lwpolyline(
            mirrored_points,
            dxfattribs={'layer': layer_name}
        )
    
    # Add centerline as reference
    if add_centerline:
        x_min = cleaned_pts[:, 0].min()
        x_max = cleaned_pts[:, 0].max()
        # Extend centerline slightly beyond geometry
        margin = (x_max - x_min) * 0.05
        msp.add_line(
            (float(x_min - margin), 0.0),
            (float(x_max + margin), 0.0),
            dxfattribs={'layer': centerline_layer}
        )
    
    # Save the DXF file
    doc.saveas(str(dxf_path))
    print(f"Chamber contour exported to {export_path}")
    print(f"  - Points: {len(cleaned_pts)} (after deduplication)")
    print(f"  - Precision: {precision} decimal places")


def export_closed_contour_dxf(chamber_pts: np.ndarray,
                               export_path: str,
                               layer_name: str = "CONTOUR",
                               precision: int = DXF_PRECISION) -> None:
    """
    Export chamber contour as a closed LWPOLYLINE (full cross-section).
    
    Creates a single closed polyline representing the full chamber
    cross-section by mirroring the upper half contour.
    
    Parameters:
    -----------
    chamber_pts : np.ndarray
        Array of (x, y) points representing the upper half contour
    export_path : str
        Path to save the DXF file
    layer_name : str
        DXF layer name for the contour
    precision : int
        Decimal places for coordinate quantization
    """
    if not HAS_EZDXF:
        raise ImportError(
            "ezdxf library is required for DXF export. "
            "Install it with: pip install ezdxf"
        )
    
    # Prepare upper half points
    upper_pts = prepare_polyline_points(chamber_pts, precision=precision)
    
    # Create mirrored lower half (reverse order, negate y)
    lower_pts = upper_pts[::-1].copy()
    lower_pts[:, 1] = -lower_pts[:, 1]
    
    # Combine to form closed contour
    # Skip the first point of lower half (same as last point of upper half at y=0)
    # Skip the last point of lower half (same as first point of upper half at y=0)
    
    # Actually, the contour doesn't necessarily start/end at y=0
    # So we need to connect them properly
    
    # The full closed contour is: upper + reversed(lower)
    # where they share the first and last points
    full_pts = np.vstack([upper_pts, lower_pts[1:-1]])
    
    # Final cleanup
    full_pts = prepare_polyline_points(full_pts, precision=precision)
    
    # Ensure directory exists
    dxf_path = Path(export_path)
    dxf_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Create DXF document
    doc = ezdxf.new('R2010')
    msp = doc.modelspace()
    
    # Create layer
    doc.layers.add(layer_name, color=7)
    
    # Convert to list of tuples
    points = [(float(pt[0]), float(pt[1])) for pt in full_pts]
    
    # Create closed LWPOLYLINE
    polyline = msp.add_lwpolyline(
        points,
        close=True,  # Explicitly close the polyline
        dxfattribs={'layer': layer_name}
    )
    
    # Save
    doc.saveas(str(dxf_path))
    print(f"Closed chamber contour exported to {export_path}")
    print(f"  - Points: {len(full_pts)}")


# For backwards compatibility and testing
if __name__ == "__main__":
    # Test with sample data
    import numpy as np
    
    # Create sample chamber geometry
    x = np.linspace(-0.1, 0.2, 100)
    y = np.where(x < 0, 0.05, 0.05 - x * 0.1)  # Simple cone
    pts = np.column_stack([x, y])
    
    # Add some intentional duplicates to test deduplication
    pts = np.vstack([pts[:50], pts[49:51], pts[50:]])  # Duplicate point 49-50
    
    print("Testing DXF export utilities...")
    print(f"Original points: {len(pts)}")
    
    cleaned = prepare_polyline_points(pts)
    print(f"Cleaned points: {len(cleaned)}")
    
    # Export test file
    export_chamber_dxf(pts, "test_dxf_export.dxf")
    print("Test complete!")
