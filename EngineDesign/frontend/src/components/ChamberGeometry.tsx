import { useState, useEffect, useMemo, useCallback } from 'react';
import { getChamberGeometry, getInjectorLayout } from '../api/client';
import type { ChamberGeometryResponse, EngineConfig, InjectorLayout } from '../api/client';
import { ChamberContourPlot } from './ChamberContourPlot';
import { InjectorPatternPlot } from './InjectorPatternPlot';
import { ChamberThermalGraphic } from './ChamberThermalGraphic';
import { InjectorHardware } from './InjectorHardware';
import { SprayMixing } from './SprayMixing';
import { useViewState } from '../lib/viewState';

interface ChamberGeometryProps {
  config: EngineConfig | null;
  /** Hardware edits made here go back to App so every tab sees the same engine. */
  onConfigUpdated?: (config: EngineConfig) => void;
}

// Convert m to mm for display
const M_TO_MM = 1000;

/** One dimension: the number on the page, what it means in the hover. */
function DimTile({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint?: string }) {
  return (
    <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]" title={hint}>
      <p className="text-xs text-[var(--color-text-secondary)]">{label}</p>
      <p className="text-lg font-semibold text-[var(--color-text-primary)] tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-[var(--color-text-muted)]">{sub}</p>}
    </div>
  );
}



export function ChamberGeometry({ config, onConfigUpdated }: ChamberGeometryProps) {
  const [geometry, setGeometry] = useState<ChamberGeometryResponse | null>(null);
  // The injector layout (engine/core/injectors/layout.py), fetched alongside the geometry from
  // the SAME backend session. The `config` PROP is App-level state that does not track the
  // backend: after a Layer 1 run the chamber showed the optimised engine while the injector
  // beside it was the pre-run ring. Both now come from one request batch.
  const [injector, setInjector] = useState<InjectorLayout | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLowerHalf, setShowLowerHalf] = useViewState('chamberGeometry.fullSection', false);

  // Fetch geometry when component mounts or config changes
  const fetchGeometry = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    // Both in flight together: the contour and the config it was drawn from must be the
    // same engine, or the panels disagree (see liveConfig above).
    const [result, layoutResult] = await Promise.all([getChamberGeometry(), getInjectorLayout()]);

    setIsLoading(false);

    // A 404 here just means the injector is not an impinging doublet: no drawing.
    setInjector(layoutResult.data ?? null);

    if (result.error) {
      setError(result.error);
      setGeometry(null);
    } else if (result.data) {
      setGeometry(result.data);
    }
  }, []);

  useEffect(() => {
    if (config) {
      fetchGeometry();
    }
  }, [config, fetchGeometry]);

  // Calculate dimensions for display
  const dimensions = useMemo(() => {
    if (!geometry) return null;
    // The solved contour is drawn with the throat at x = 0, so its first point is the face.
    const cx = geometry.chamber_contour_x ?? [];
    const faceToThroat = cx.length > 1 ? -Math.min(...cx) : null;

    return {
      L_chamber_mm: geometry.L_chamber * M_TO_MM,
      L_nozzle_mm: geometry.L_nozzle * M_TO_MM,
      L_total_mm: (geometry.L_chamber + geometry.L_nozzle) * M_TO_MM,
      D_chamber_mm: geometry.D_chamber * M_TO_MM,
      D_throat_mm: geometry.D_throat * M_TO_MM,
      D_exit_mm: geometry.D_exit * M_TO_MM,
      throat_position_mm: geometry.throat_position * M_TO_MM,
      face_to_throat_mm: faceToThroat != null && faceToThroat > 0 ? faceToThroat * M_TO_MM : null,
    };
  }, [geometry]);

  // How the chamber length splits, when the design carries it (config.chamber_geometry).
  const cg = (config?.chamber_geometry ?? null) as Record<string, unknown> | null;
  const lCyl = typeof cg?.length_cylindrical === 'number' ? cg.length_cylindrical * M_TO_MM : null;
  const lCon = typeof cg?.length_contraction === 'number' ? cg.length_contraction * M_TO_MM : null;

  // Empty state - no config
  if (!config) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--color-text-secondary)]">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p>No config loaded</p>
          <p className="text-sm mt-1">Upload a YAML config file first</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-rose-500 to-orange-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Chamber Geometry</h2>
              <p className="text-sm text-[var(--color-text-secondary)]">
                The thrust chamber, nozzle and injector of the open design
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={fetchGeometry}
              disabled={isLoading}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-rose-600 to-orange-600 hover:from-rose-700 hover:to-orange-700 text-white text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh
                </>
              )}
            </button>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* The cross-section: solved gas-side contour with liner, graphite and case, to scale. */}
      <ChamberThermalGraphic
        geometry={geometry}
        showLowerHalf={showLowerHalf}
        onShowLowerHalfChange={setShowLowerHalf}
      />

      {/* CEA-Solved Chamber Contour, on the same full-section switch as the cross-section above */}
      <ChamberContourPlot geometry={geometry} showLowerHalf={showLowerHalf} />

      {/* Injector pattern: face, back face and half section, from /api/geometry/injector. */}
      {injector && (
        <div className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)]">
          <h3 className="text-base font-bold text-[var(--color-text-primary)] mb-3">Injector Pattern</h3>
          <InjectorPatternPlot layout={injector} />
          <div className="mt-3">
            <InjectorHardware reloadKey={injector} onSaved={(c) => { onConfigUpdated?.(c); void fetchGeometry(); }} />
          </div>
          <div className="mt-3">
            <SprayMixing />
          </div>
        </div>
      )}

      {/* Dimensions Table */}
      {geometry && dimensions && (
        <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-4">
            Chamber Dimensions
          </h4>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <DimTile
              label="Chamber length"
              value={`${dimensions.L_chamber_mm.toFixed(1)} mm`}
              sub={lCyl != null && lCon != null ? `cylinder ${lCyl.toFixed(1)} + convergence ${lCon.toFixed(1)}` : 'cylinder and convergence'}
              hint="The sized chamber: the cylinder and the convergent cone. The drawn contour adds the blend into the throat (face to throat, next). The spray march uses a third length, the volume-equivalent cylinder L*·At/Ac."
            />
            {dimensions.face_to_throat_mm != null && (
              <DimTile
                label="Face to throat"
                value={`${dimensions.face_to_throat_mm.toFixed(1)} mm`}
                sub="along the drawn contour"
                hint="Injector face to throat on the gas-side contour above, the throat's upstream blend included."
              />
            )}
            <DimTile label="Nozzle length" value={`${dimensions.L_nozzle_mm.toFixed(1)} mm`} sub="throat to exit" />
            <DimTile label="Chamber diameter" value={`${dimensions.D_chamber_mm.toFixed(1)} mm`} sub="gas side" />
            <DimTile label="Throat diameter" value={`${dimensions.D_throat_mm.toFixed(1)} mm`} />
            <DimTile label="Exit diameter" value={`${dimensions.D_exit_mm.toFixed(1)} mm`} />
            <DimTile label="Expansion ratio" value={geometry.expansion_ratio.toFixed(2)} />
            <DimTile label="Nozzle" value={geometry.nozzle_method.includes('rao') ? 'Rao bell, 80 %' : 'Conical'} />
            <DimTile label="Ablative liner" value={geometry.ablative_enabled ? 'Yes' : 'No'} />
            <DimTile label="Graphite insert" value={geometry.graphite_enabled ? 'Yes' : 'No'} />
            {geometry.Cf !== null && (
              <DimTile
                label="Cf at the sizing point"
                value={geometry.Cf.toFixed(4)}
                hint="The thrust coefficient the nozzle was sized at. Forward Mode reports Cf at the tank pressures you evaluate, so the two differ."
              />
            )}
            {geometry.Cf_ideal !== null && (
              <DimTile label="Ideal Cf (CEA)" value={geometry.Cf_ideal.toFixed(4)} hint="At the sizing point, before nozzle losses." />
            )}
            {geometry.A_throat_solved !== null && (
              <DimTile label="Throat area" value={`${(geometry.A_throat_solved * 1e6).toFixed(1)} mm²`} />
            )}
          </div>
        </div>
      )}


      {/* Loading state */}
      {isLoading && !geometry && (
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-rose-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-[var(--color-text-secondary)]">Loading chamber geometry...</p>
          </div>
        </div>
      )}
    </div>
  );
}

