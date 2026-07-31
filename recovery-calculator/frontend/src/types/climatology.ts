/**
 * Shape of `fixtures/climatology.json`, written by
 * `site-climatology/export_json.py`.
 *
 * This is climatology, not simulation output -- it does not change when the
 * user edits a vehicle -- so it ships as a static bundle and the Atmospheric
 * Data tab works with no backend at all. When `GET /api/climatology` exists it
 * serves this identical shape and the components do not change.
 */

export interface SurfaceStation {
  /** ICAO, e.g. KNID. */
  id: string
  name: string
  elev_m: number
  /** Station elevation minus pad elevation. This is what sizes the eq (7b)
   *  lapse-transfer error, and it is why the stations disagree. */
  gap_m: number
  distance_km: number
  primary: boolean
  note: string
}

export interface SurfaceMonth {
  month: number
  n: number
  /** Pad station pressure, Pa -- eq (7b) applied to this station's altimeter
   *  setting, NOT the altimeter setting itself. */
  p_mean: number
  p_sd: number
  p_p05: number
  p_p95: number
  p_min: number
  p_max: number
  t_mean: number | null
  t_p05: number | null
  t_p95: number | null
  rho_mean: number | null
  rho_p05: number | null
  rho_p95: number | null
  /** Launch window only: 15-23Z, roughly 8am-4pm local. */
  lw_n: number
  lw_t_mean: number | null
  lw_rho_mean: number | null
}

export interface UpperDataset {
  /** Tag matching data/<id>-*.csv, e.g. 'edw-nid'. */
  id: string
  label: string
  stations: string[]
  /** True when this dataset pools more than one station. */
  pooled: boolean
  /** Total soundings across all months. */
  n: number
}

/** One calendar month, as parallel arrays down the shared height grid. */
export interface UpperMonth {
  month: number
  n: number
  mean: number[]
  sd: number[]
  p05: number[]
  p50: number[]
  p95: number[]
  /** eq (7) prediction minus measured mean, K. Zero at the anchor by
   *  construction -- that is the point of the anchor. */
  eq7_err: number[]
}

export interface LapseMonth {
  month: number
  n: number
  /** Least squares on each sounding, then averaged. K/km, negative = cooling. */
  L_mean: number
  L_sd: number
  L_p05: number
  L_p95: number
  /** What eq (7) infers from the same soundings' surface temperature. */
  L_eq7: number
  L_isa: number
}

/** One real ascent, interpolated onto the shared grid. */
export interface Sounding {
  id: string
  station: string
  year: number
  month: number
  day: number
  hour: number
  label: string
  /** Temperature at each grid height, K. */
  t: number[]
  L_fit: number
  L_eq7: number
}

/**
 * The ISA standard column, for the "what would ISA have predicted" overlay
 * every chart offers.
 *
 * Computed in `export_json.py` with `physics.atmosphere`, not in the
 * browser, so the baseline drawn here is the same standard atmosphere the
 * solver integrates. ISA has no seasonality — a flat line against a monthly
 * curve is the comparison.
 */
export interface Isa {
  pad: { H: number; T: number; p: number; rho: number }
  /** ISA temperature at each height in `upper.grid_m`, K. */
  T: number[]
  /** ISA pressure at each height in `upper.grid_m`, Pa. */
  p: number[]
  lapse_k_per_km: number
}

export interface Climatology {
  meta: {
    generated: string
    source: string
    pad: {
      name: string
      lat: number
      lon: number
      elev_m: number
      elev_is_estimate: boolean
    }
    ceiling_agl_ft: number
    ceiling_msl_m: number
    isa_lapse_k_per_km: number
  }
  isa: Isa
  surface: {
    stations: SurfaceStation[]
    monthly: Record<string, SurfaceMonth[]>
  }
  upper: {
    /** Shared by every dataset -- geopotential metres MSL. */
    grid_m: number[]
    datasets: UpperDataset[]
    profile: Record<string, UpperMonth[]>
    lapse: Record<string, LapseMonth[]>
  }
  soundings: Record<string, Sounding[]>
}
