"""Chamber geometry visualization endpoint."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import numpy as np

from backend.state import app_state
from engine.pipeline.chamber_geometry_fixed import calculate_chamber_geometry_fixed
from engine.pipeline.config_schemas import AblativeCoolingConfig, GraphiteInsertConfig
from engine.core.nozzle_solver import rao
from engine.core.chamber_geometry_solver import solve_chamber_geometry_with_cea
from engine.pipeline.cea_cache import CEACache

router = APIRouter(prefix="/api/geometry", tags=["geometry"])


class GeometryResponse(BaseModel):
    """Chamber geometry data for visualization."""
    positions: list[float]
    R_gas: list[float]
    R_ablative_outer: list[float]
    R_graphite_outer: list[float]
    R_stainless: list[float]
    throat_position: float
    graphite_start: float
    graphite_end: float
    D_chamber: float
    D_throat: float
    D_exit: float
    # Metadata
    L_chamber: float
    L_nozzle: float
    expansion_ratio: float
    ablative_enabled: bool
    graphite_enabled: bool
    # Rao nozzle contour (x, y points)
    nozzle_x: list[float]
    nozzle_y: list[float]
    nozzle_method: str
    # Chamber contour from CEA solver (x, y points)
    chamber_contour_x: list[float]
    chamber_contour_y: list[float]
    # Solver info
    Cf: Optional[float] = None
    Cf_ideal: Optional[float] = None
    A_throat_solved: Optional[float] = None
    chamber_contour_method: Optional[str] = None  # "solved" or "cea_iterative"
    # Optimized thicknesses from Layer 3 (if available)
    t_abl_opt_mm: Optional[float] = None
    t_gra_opt_mm: Optional[float] = None
    # Baseline (config) thicknesses from ablative_cooling / graphite_insert
    t_abl_config_mm: Optional[float] = None
    t_gra_config_mm: Optional[float] = None


@router.get("", response_model=GeometryResponse)
async def get_chamber_geometry():
    """Get chamber geometry for visualization.
    
    Returns the geometry arrays needed to render the chamber cross-section:
    - Gas boundary (inner surface)
    - Ablative liner (chamber region)
    - Graphite insert (throat region)
    - Stainless steel case (outer)
    """
    if not app_state.has_config():
        raise HTTPException(
            status_code=400,
            detail="No config loaded. Upload a config file first."
        )
    
    config = app_state.config
    
    try:
        # =====================================================================
        # Extract parameters - prefer chamber_geometry, fallback to legacy
        # =====================================================================
        chamber_geom = getattr(config, 'chamber_geometry', None)
        chamber = getattr(config, 'chamber', None)
        nozzle = getattr(config, 'nozzle', None)
        
        # Require either chamber_geometry OR (chamber AND nozzle)
        if chamber_geom is None and (chamber is None or nozzle is None):
            raise HTTPException(
                status_code=400,
                detail="Must provide either 'chamber_geometry' section or both 'chamber' and 'nozzle' sections"
            )
        
        # Use chamber_geometry if available, otherwise use legacy sections
        if chamber_geom is not None:
            # New unified chamber_geometry section
            D_chamber = getattr(chamber_geom, 'chamber_diameter', 0.08)
            D_exit = getattr(chamber_geom, 'exit_diameter', 0.1)
            expansion_ratio = getattr(chamber_geom, 'expansion_ratio', 8.0)
            A_throat = getattr(chamber_geom, 'A_throat', None)
            L_chamber = getattr(chamber_geom, 'length', None)
        else:
            # Legacy chamber/nozzle sections
            D_chamber = getattr(chamber, 'chamber_inner_diameter', 0.08) if chamber else 0.08
            D_exit = (getattr(chamber, 'exit_diameter', None) if chamber else None) or (getattr(nozzle, 'exit_diameter', 0.1) if nozzle else 0.1)
            expansion_ratio = getattr(nozzle, 'expansion_ratio', 8.0) if nozzle else 8.0
            A_throat = (getattr(chamber, 'A_throat', None) if chamber else None) or (getattr(nozzle, 'A_throat', 1e-4) if nozzle else 1e-4)
            L_chamber = getattr(chamber, 'length', 0.15) if chamber else 0.15
        
        # Compute derived values if not provided
        if A_throat is None:
            # Compute from exit area and expansion ratio
            A_exit = np.pi * (D_exit / 2.0) ** 2
            A_throat = A_exit / expansion_ratio
        
        D_throat = np.sqrt(4 * A_throat / np.pi)
        A_exit = A_throat * expansion_ratio
        
        if L_chamber is None:
            L_chamber = 0.15  # Default
        
        # Estimate nozzle length from exit diameter
        L_nozzle = getattr(nozzle, 'length', None) if nozzle else None
        if L_nozzle is None:
            # Estimate: ~15 degree half-angle conical nozzle
            L_nozzle = (D_exit - D_throat) / (2 * np.tan(np.radians(15)))
        
        # Ablative config
        ablative_cfg: AblativeCoolingConfig | None = None
        ablative_enabled = False
        if hasattr(config, 'ablative_cooling') and config.ablative_cooling:
            ablative_cfg = config.ablative_cooling
            ablative_enabled = getattr(ablative_cfg, 'enabled', False)
        
        # Graphite config
        graphite_cfg: GraphiteInsertConfig | None = None
        graphite_enabled = False
        if hasattr(config, 'graphite_insert') and config.graphite_insert:
            graphite_cfg = config.graphite_insert
            graphite_enabled = getattr(graphite_cfg, 'enabled', False)
        
        # Calculate chamber geometry (chamber + simple nozzle for layers)
        geometry = calculate_chamber_geometry_fixed(
            L_chamber=L_chamber,
            D_chamber=D_chamber,
            D_throat=D_throat,
            L_nozzle=L_nozzle,
            expansion_ratio=expansion_ratio,
            ablative_config=ablative_cfg if ablative_enabled else None,
            graphite_config=graphite_cfg if graphite_enabled else None,
            recession_chamber=0.0,  # Fresh geometry, no recession
            recession_graphite=0.0,
            n_points=200,
        )
        
        # Generate chamber contour using solved_chamber_plot or solve_chamber_geometry_with_cea
        # Prefer solved_chamber_plot if all geometry parameters are available (fast, no iteration)
        # Otherwise fallback to CEA solver (iterative, finds throat area)
        chamber_contour_x = []
        chamber_contour_y = []
        Cf_solved = None
        Cf_ideal_solved = None
        A_throat_solved = None
        chamber_contour_method = None
        
        try:
            # Check if we have all parameters for solved_chamber_plot (from optimizer output)
            use_solved_plot = False
            if chamber_geom is not None:
                required_attrs = ['A_throat', 'A_exit', 'volume', 'Lstar', 'chamber_diameter', 'length']
                has_all = all(
                    hasattr(chamber_geom, attr) and getattr(chamber_geom, attr) is not None 
                    for attr in required_attrs
                )
                if has_all:
                    use_solved_plot = True
            
            if use_solved_plot:
                # Fast path: Use solved_chamber_plot (no CEA iteration needed)
                from engine.core.chamber_geometry_solver import solved_chamber_plot
                
                chamber_pts, table_data, lengths = solved_chamber_plot(
                    area_throat=chamber_geom.A_throat,
                    area_exit=chamber_geom.A_exit,
                    volume_chamber=chamber_geom.volume,
                    lstar=chamber_geom.Lstar,
                    chamber_diameter=chamber_geom.chamber_diameter,
                    length=chamber_geom.length,
                    do_plot=False,
                    steps=200,
                )
                
                # Extract contour points (x, y)
                chamber_contour_x = chamber_pts[:, 0].tolist()
                chamber_contour_y = chamber_pts[:, 1].tolist()
                
                # Get Cf from config if available (optimizer sets this)
                Cf_solved = getattr(chamber_geom, 'Cf', None)
                Cf_ideal_solved = getattr(chamber_geom, 'Cf_ideal', None)
                A_throat_solved = chamber_geom.A_throat
                chamber_contour_method = "solved"
                
            else:
                # Fallback path: Use CEA solver (iterative)
                # =====================================================================
                # Get ALL design parameters from config.chamber_geometry (preferred)
                # or fallback to legacy config.chamber + config.nozzle
                # These are the inputs to solve_chamber_geometry_with_cea
                # =====================================================================
                if chamber_geom is not None:
                    # New unified chamber_geometry section
                    Pc_design = getattr(chamber_geom, 'design_pressure', 2.0e6)
                    F_design = getattr(chamber_geom, 'design_thrust', 5000.0)
                    MR = getattr(chamber_geom, 'design_MR', 2.55)
                    Lstar = getattr(chamber_geom, 'Lstar', 1.0)
                    D_chamber_design = getattr(chamber_geom, 'chamber_diameter', D_chamber)
                    D_exit_design = getattr(chamber_geom, 'exit_diameter', D_exit)
                    nozzle_eff = getattr(chamber_geom, 'nozzle_efficiency', 0.95)
                else:
                    # Legacy sections (chamber and nozzle should exist if we get here due to check above)
                    Pc_design = getattr(chamber, 'design_pressure', 2.0e6) if chamber else 2.0e6
                    F_design = getattr(chamber, 'design_thrust', 5000.0) if chamber else 5000.0
                    MR = getattr(chamber, 'design_MR', 2.55) if chamber else 2.55
                    Lstar = getattr(chamber, 'Lstar', 1.0) if chamber else 1.0
                    D_chamber_design = getattr(chamber, 'chamber_inner_diameter', D_chamber) if chamber else D_chamber
                    D_exit_design = getattr(chamber, 'exit_diameter', D_exit) if chamber else (getattr(nozzle, 'exit_diameter', D_exit) if nozzle else D_exit)
                    nozzle_eff = getattr(nozzle, 'efficiency', 0.95) if nozzle else 0.95
                
                # Get ambient pressure from environment.elevation
                Pa = 101325.0  # Default sea level
                if hasattr(config, 'environment') and config.environment:
                    elevation = getattr(config.environment, 'elevation', 0.0)
                    # Barometric formula: P = P0 * (1 - 2.25577e-5 * h)^5.25588
                    if elevation > 0:
                        Pa = 101325.0 * (1.0 - 2.25577e-5 * elevation) ** 5.25588
                
                # Get CEA config and create cache
                cea_config = config.combustion.cea if hasattr(config, 'combustion') and hasattr(config.combustion, 'cea') else None
                
                if cea_config is not None:
                    cea_cache = CEACache(cea_config)
                    
                    # Solve chamber geometry with CEA - ALL inputs from config
                    chamber_pts, table_data, total_length, solver_info = solve_chamber_geometry_with_cea(
                        pc_design=Pc_design,
                        thrust_design=F_design,
                        cea_cache=cea_cache,
                        MR=MR,
                        diameter_inner=D_chamber_design,
                        diameter_exit=D_exit_design,
                        l_star=Lstar,
                        Pa=Pa,
                        nozzle_efficiency=nozzle_eff,
                        do_plot=False,
                        verbose=False,
                    )
                    
                    # Extract contour points (x, y)
                    chamber_contour_x = chamber_pts[:, 0].tolist()
                    chamber_contour_y = chamber_pts[:, 1].tolist()
                    
                    # Extract solver results
                    Cf_solved = solver_info.get('final_Cf')
                    Cf_ideal_solved = solver_info.get('final_Cf_ideal')
                    A_throat_solved = solver_info.get('final_A_throat')
                    chamber_contour_method = "cea_iterative"
                
        except Exception as e:
            # If both solvers fail, chamber_contour remains empty
            # This is not critical - we still have layer geometry
            import warnings
            warnings.warn(f"Chamber contour solver failed: {e}")
            chamber_contour_method = "failed"
        
        # Generate Rao bell nozzle contour
        # The rao() function returns contour starting from upstream of throat
        try:
            nozzle_pts, x_first, y_first = rao(
                area_throat=A_throat,
                area_exit=A_exit,
                bell_percent=0.8,  # 80% bell is standard
                steps=100,
                do_plot=False,
                method="garcia",
            )
            # Shift nozzle contour so throat (x=0 in nozzle coords) aligns with L_chamber
            # The nozzle contour x=0 is at the throat
            nozzle_x = (nozzle_pts[:, 0] + L_chamber).tolist()
            nozzle_y = nozzle_pts[:, 1].tolist()
            nozzle_method = "rao_garcia"
        except Exception as e:
            # Fallback to simple conical if Rao fails
            nozzle_x = []
            nozzle_y = []
            nozzle_method = f"fallback_conical (rao failed: {str(e)[:50]})"
        
        # Get Layer 3 optimized thicknesses if available
        t_abl_opt_mm: float | None = None
        t_gra_opt_mm: float | None = None
        
        # Try to get results from optimizer router (which stores them in its global state)
        from backend.routers.optimizer import _layer3_status
        if _layer3_status.get("results") is not None:
            l3_results = _layer3_status["results"]
            summary = l3_results.get("summary", {})
            t_abl_opt_mm = summary.get("optimized_ablative_thickness")
            if t_abl_opt_mm is not None:
                t_abl_opt_mm *= 1000.0  # Convert to mm
            t_gra_opt_mm = summary.get("optimized_graphite_thickness")
            if t_gra_opt_mm is not None:
                t_gra_opt_mm *= 1000.0  # Convert to mm

        # Baseline (config) thicknesses in mm, if available
        t_abl_config_mm: float | None = None
        t_gra_config_mm: float | None = None
        if ablative_cfg is not None:
            try:
                t_abl_config_mm = float(getattr(ablative_cfg, "initial_thickness", 0.0)) * 1000.0
            except Exception:
                t_abl_config_mm = None
        if graphite_cfg is not None:
            try:
                t_gra_config_mm = float(getattr(graphite_cfg, "initial_thickness", 0.0)) * 1000.0
            except Exception:
                t_gra_config_mm = None

        return GeometryResponse(
            positions=geometry["positions"].tolist(),
            R_gas=geometry["R_gas"].tolist(),
            R_ablative_outer=geometry["R_ablative_outer"].tolist(),
            R_graphite_outer=geometry["R_graphite_outer"].tolist(),
            R_stainless=geometry["R_stainless"].tolist(),
            throat_position=float(geometry["throat_position"]),
            graphite_start=float(geometry["graphite_start"]),
            graphite_end=float(geometry["graphite_end"]),
            D_chamber=float(geometry["D_chamber"]),
            D_throat=float(geometry["D_throat"]),
            D_exit=float(geometry["D_exit"]),
            L_chamber=L_chamber,
            L_nozzle=L_nozzle,
            expansion_ratio=expansion_ratio,
            ablative_enabled=ablative_enabled,
            graphite_enabled=graphite_enabled,
            nozzle_x=nozzle_x,
            nozzle_y=nozzle_y,
            nozzle_method=nozzle_method,
            chamber_contour_x=chamber_contour_x,
            chamber_contour_y=chamber_contour_y,
            Cf=Cf_solved,
            Cf_ideal=Cf_ideal_solved,
            A_throat_solved=A_throat_solved,
            chamber_contour_method=chamber_contour_method,
            t_abl_opt_mm=t_abl_opt_mm,
            t_gra_opt_mm=t_gra_opt_mm,
            t_abl_config_mm=t_abl_config_mm,
            t_gra_config_mm=t_gra_config_mm,
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to calculate geometry: {str(e)}"
        )

