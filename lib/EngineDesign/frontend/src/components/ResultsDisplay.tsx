import type { RunnerResults } from '../api/client';

interface ResultsDisplayProps {
  results: RunnerResults | null;
  isLoading?: boolean;
  targetExitPressure?: number | null;  // Ambient pressure (target for nozzle exit)
}

// Unit conversion constants
const PA_TO_PSI = 1.0 / 6894.76;

interface MetricCardProps {
  label: string;
  value: string;
  unit: string;
  color?: 'blue' | 'green' | 'yellow' | 'purple' | 'cyan' | 'orange' | 'red';
}

function MetricCard({ label, value, unit, color = 'blue' }: MetricCardProps) {
  const colorClasses = {
    blue: 'border-blue-500/30 bg-blue-500/5',
    green: 'border-green-500/30 bg-green-500/5',
    yellow: 'border-yellow-500/30 bg-yellow-500/5',
    purple: 'border-purple-500/30 bg-purple-500/5',
    cyan: 'border-cyan-500/30 bg-cyan-500/5',
    orange: 'border-orange-500/30 bg-orange-500/5',
    red: 'border-red-500/30 bg-red-500/5',
  };

  const valueColorClasses = {
    blue: 'text-blue-400',
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    purple: 'text-purple-400',
    cyan: 'text-cyan-400',
    orange: 'text-orange-400',
    red: 'text-red-400',
  };

  return (
    <div className={`p-4 rounded-xl border ${colorClasses[color]} transition-all hover:scale-[1.02]`}>
      <div className="text-sm text-[var(--color-text-secondary)] mb-1">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className={`text-2xl font-bold ${valueColorClasses[color]}`}>{value}</span>
        {unit && <span className="text-sm text-[var(--color-text-secondary)]">{unit}</span>}
      </div>
    </div>
  );
}

interface SmallMetricProps {
  label: string;
  value: string;
  unit: string;
  colorClass?: string;
}

function SmallMetric({ label, value, unit, colorClass = 'text-[var(--color-text-primary)]' }: SmallMetricProps) {
  return (
    <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
      <div className="text-xs text-[var(--color-text-secondary)] mb-1">{label}</div>
      <div className={`text-lg font-semibold ${colorClass}`}>
        {value} {unit && <span className="text-sm font-normal text-[var(--color-text-secondary)]">{unit}</span>}
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
}

function Section({ title, children, icon }: SectionProps) {
  return (
    <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)] flex items-center gap-2">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

export function ResultsDisplay({ results, isLoading, targetExitPressure }: ResultsDisplayProps) {
  if (isLoading) {
    return (
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center justify-center h-48">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[var(--color-text-secondary)]">Running simulation...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!results) {
    return (
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h3 className="text-lg font-semibold mb-4 text-[var(--color-text-primary)]">Performance Results</h3>
        <div className="flex items-center justify-center h-48 text-[var(--color-text-secondary)]">
          <div className="text-center">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <p>No results yet</p>
            <p className="text-sm mt-1">Enter tank pressures and click Evaluate</p>
          </div>
        </div>
      </div>
    );
  }

  const formatNumber = (n: number | null | undefined, decimals: number = 2): string => {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  const formatSci = (n: number | null | undefined, decimals: number = 2): string => {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (Math.abs(n) >= 1e6 || (Math.abs(n) < 0.01 && n !== 0)) {
      return n.toExponential(decimals);
    }
    return formatNumber(n, decimals);
  };

  // Extract nested objects with null safety
  const chamber = results.chamber_intrinsics;
  const injector = results.injector_pressure;
  const cooling = results.cooling;
  const stability = results.stability;

  return (
    <div className="space-y-6">
      {/* Primary Performance Metrics */}
      <Section 
        title="Performance Summary"
        icon={<svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <MetricCard
            label="Thrust"
            value={formatNumber(results.F / 1000, 2)}
            unit="kN"
            color="green"
          />
          <MetricCard
            label="Specific Impulse"
            value={formatNumber(results.Isp, 1)}
            unit="s"
            color="blue"
          />
          <MetricCard
            label="Chamber Pressure"
            value={formatNumber(results.Pc * PA_TO_PSI, 1)}
            unit="psi"
            color="yellow"
          />
          <MetricCard
            label="Mixture Ratio (O/F)"
            value={formatNumber(results.MR, 3)}
            unit=""
            color="purple"
          />
        </div>

        {/* Mass flow section */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <SmallMetric label="Total Mass Flow" value={formatNumber(results.mdot_total, 3)} unit="kg/s" />
          <SmallMetric label="Oxidizer Flow" value={formatNumber(results.mdot_O, 3)} unit="kg/s" colorClass="text-cyan-400" />
          <SmallMetric label="Fuel Flow" value={formatNumber(results.mdot_F, 3)} unit="kg/s" colorClass="text-orange-400" />
          {/* c* with ideal display */}
          <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
            <div className="text-xs text-[var(--color-text-secondary)] mb-1">c* (Actual)</div>
            <div className="text-lg font-semibold text-[var(--color-text-primary)]">
              {formatNumber(results.cstar_actual, 1)} <span className="text-sm font-normal text-[var(--color-text-secondary)]">m/s</span>
              {results.cstar_ideal && (
                <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">
                  (Ideal: {formatNumber(results.cstar_ideal, 1)})
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Nozzle/exit metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SmallMetric label="Exit Velocity" value={formatNumber(results.v_exit, 1)} unit="m/s" />
          <SmallMetric label="Exit Mach Number" value={formatNumber(results.M_exit, 2)} unit="" colorClass="text-purple-400" />
          {/* Exit Pressure with target display */}
          <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
            <div className="text-xs text-[var(--color-text-secondary)] mb-1">Exit Pressure</div>
            <div className="text-lg font-semibold text-[var(--color-text-primary)]">
              {formatNumber(results.P_exit * PA_TO_PSI, 2)} <span className="text-sm font-normal text-[var(--color-text-secondary)]">psi</span>
              {targetExitPressure && (
                <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">
                  (Target: {formatNumber(targetExitPressure * PA_TO_PSI, 2)} psi)
                </span>
              )}
            </div>
          </div>
          {/* Cf with ideal display */}
          <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
            <div className="text-xs text-[var(--color-text-secondary)] mb-1">Cf (Actual)</div>
            <div className="text-lg font-semibold text-green-400">
              {formatNumber(results.Cf_actual, 4)}
              {results.Cf_ideal && (
                <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-1">
                  (Ideal: {formatNumber(results.Cf_ideal, 4)})
                </span>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* Temperatures */}
      <Section
        title="Temperatures"
        icon={<svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" /></svg>}
      >
        <div className="grid grid-cols-3 gap-4">
          <div className="p-4 rounded-xl border border-red-500/30 bg-red-500/5 text-center">
            <div className="text-sm text-[var(--color-text-secondary)] mb-1">Chamber Temp</div>
            <div className="text-2xl font-bold text-red-400">{formatNumber(results.Tc, 0)}</div>
            <div className="text-xs text-[var(--color-text-secondary)]">K</div>
          </div>
          <div className="p-4 rounded-xl border border-orange-500/30 bg-orange-500/5 text-center">
            <div className="text-sm text-[var(--color-text-secondary)] mb-1">Throat Temp</div>
            <div className="text-2xl font-bold text-orange-400">{formatNumber(results.T_throat, 0)}</div>
            <div className="text-xs text-[var(--color-text-secondary)]">K</div>
          </div>
          <div className="p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/5 text-center">
            <div className="text-sm text-[var(--color-text-secondary)] mb-1">Exit Temp</div>
            <div className="text-2xl font-bold text-yellow-400">{formatNumber(results.T_exit, 0)}</div>
            <div className="text-xs text-[var(--color-text-secondary)]">K</div>
          </div>
        </div>
      </Section>

      {/* Injector Pressure Drops */}
      {injector && (injector.delta_p_injector_O || injector.delta_p_injector_F) && (
        <Section
          title="Injector Pressure Drops"
          icon={<svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>}
        >
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-3">
              <div className="text-sm font-medium text-cyan-400 mb-2">Oxidizer Side</div>
              <SmallMetric 
                label="P_injector (LOX)" 
                value={formatNumber(injector.P_injector_O ? injector.P_injector_O * PA_TO_PSI : null, 1)} 
                unit="psi" 
                colorClass="text-cyan-400"
              />
              <SmallMetric 
                label="ΔP Injector (LOX)" 
                value={formatNumber(injector.delta_p_injector_O ? injector.delta_p_injector_O * PA_TO_PSI : null, 1)} 
                unit="psi" 
              />
              <SmallMetric 
                label="ΔP Feed (LOX)" 
                value={formatNumber(injector.delta_p_feed_O ? injector.delta_p_feed_O * PA_TO_PSI : null, 1)} 
                unit="psi" 
              />
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium text-orange-400 mb-2">Fuel Side</div>
              <SmallMetric 
                label="P_injector (Fuel)" 
                value={formatNumber(injector.P_injector_F ? injector.P_injector_F * PA_TO_PSI : null, 1)} 
                unit="psi" 
                colorClass="text-orange-400"
              />
              <SmallMetric 
                label="ΔP Injector (Fuel)" 
                value={formatNumber(injector.delta_p_injector_F ? injector.delta_p_injector_F * PA_TO_PSI : null, 1)} 
                unit="psi" 
              />
              <SmallMetric 
                label="ΔP Feed (Fuel)" 
                value={formatNumber(injector.delta_p_feed_F ? injector.delta_p_feed_F * PA_TO_PSI : null, 1)} 
                unit="psi" 
              />
            </div>
            <div className="space-y-3">
              <div className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">Efficiency</div>
              <SmallMetric 
                label="η c*" 
                value={formatNumber(results.eta_cstar, 3)} 
                unit="" 
                colorClass="text-green-400"
              />
            </div>
          </div>
        </Section>
      )}

      {/* Chamber Intrinsics */}
      <Section
        title="Chamber Intrinsics"
        icon={<svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <SmallMetric 
            label="L*" 
            value={formatNumber(chamber?.Lstar ? chamber.Lstar * 1000 : null, 1)} 
            unit="mm" 
            colorClass="text-purple-400"
          />
          <SmallMetric 
            label="Residence Time" 
            value={formatNumber(chamber?.residence_time ? chamber.residence_time * 1000 : null, 2)} 
            unit="ms" 
          />
          <SmallMetric 
            label="Throat Velocity" 
            value={formatNumber(chamber?.velocity_throat, 0)} 
            unit="m/s" 
          />
          <SmallMetric 
            label="Throat Mach" 
            value={formatNumber(chamber?.mach_number_throat ?? null, 3)} 
            unit="" 
          />
          <SmallMetric 
            label="Choked Flow Verified?" 
            value={chamber?.is_choked === true ? 'Yes' : chamber?.is_choked === false ? 'No' : '—'} 
            unit="" 
            colorClass={chamber?.is_choked === true ? 'text-green-400' : chamber?.is_choked === false ? 'text-red-400' : ''}
          />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SmallMetric 
            label="Reynolds Number" 
            value={formatSci(chamber?.reynolds_number, 0)} 
            unit="" 
          />
          <SmallMetric 
            label="Gas Density" 
            value={formatNumber(chamber?.density, 2)} 
            unit="kg/m³" 
          />
          <SmallMetric 
            label="Sound Speed" 
            value={formatNumber(chamber?.sound_speed, 0)} 
            unit="m/s" 
          />
          <SmallMetric 
            label="Expansion Ratio" 
            value={formatNumber(results.eps, 2)} 
            unit="" 
          />
        </div>
      </Section>

      {/* Cooling Summary */}
      {cooling && (cooling.regen?.enabled || cooling.film?.enabled || cooling.ablative?.enabled) && (
        <Section
          title="Cooling Summary"
          icon={<svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>}
        >
          <div className="space-y-4">
            {/* Regenerative Cooling */}
            {cooling.regen?.enabled && (
              <div className="p-4 rounded-lg bg-[var(--color-bg-primary)] border border-blue-500/30">
                <div className="text-sm font-medium text-blue-400 mb-3">Regenerative Cooling</div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <SmallMetric 
                    label="Coolant Outlet Temp" 
                    value={formatNumber(cooling.regen.coolant_outlet_temperature, 1)} 
                    unit="K" 
                  />
                  <SmallMetric 
                    label="Heat Removed" 
                    value={formatNumber(cooling.regen.heat_removed ? cooling.regen.heat_removed / 1000 : null, 1)} 
                    unit="kW" 
                  />
                  <SmallMetric 
                    label="Heat Flux" 
                    value={formatNumber(cooling.regen.overall_heat_flux ? cooling.regen.overall_heat_flux / 1000 : null, 1)} 
                    unit="kW/m²" 
                  />
                  <SmallMetric 
                    label="Coolant Flow" 
                    value={formatNumber(cooling.regen.mdot_coolant, 3)} 
                    unit="kg/s" 
                  />
                </div>
              </div>
            )}

            {/* Film Cooling */}
            {cooling.film?.enabled && (
              <div className="p-4 rounded-lg bg-[var(--color-bg-primary)] border border-green-500/30">
                <div className="text-sm font-medium text-green-400 mb-3">Film Cooling</div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <SmallMetric 
                    label="Effectiveness" 
                    value={formatNumber(cooling.film.effectiveness, 2)} 
                    unit="" 
                  />
                  <SmallMetric 
                    label="Mass Fraction" 
                    value={formatNumber(cooling.film.mass_fraction, 3)} 
                    unit="" 
                  />
                  <SmallMetric 
                    label="Film Flow" 
                    value={formatNumber(cooling.film.mdot_film, 3)} 
                    unit="kg/s" 
                  />
                  <SmallMetric 
                    label="Heat Flux Factor" 
                    value={formatNumber(cooling.film.heat_flux_factor, 2)} 
                    unit="" 
                  />
                </div>
              </div>
            )}

            {/* Ablative Cooling */}
            {cooling.ablative?.enabled && (
              <div className="p-4 rounded-lg bg-[var(--color-bg-primary)] border border-orange-500/30">
                <div className="text-sm font-medium text-orange-400 mb-3">
                  Ablative Cooling
                  {cooling.ablative.below_pyrolysis && (
                    <span className="ml-2 text-xs text-yellow-400">(Below pyrolysis - no ablation)</span>
                  )}
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <SmallMetric 
                    label="Recession Rate" 
                    value={formatNumber(cooling.ablative.recession_rate ? cooling.ablative.recession_rate * 1e6 : null, 3)} 
                    unit="µm/s" 
                  />
                  <SmallMetric 
                    label="Effective Heat Flux" 
                    value={formatNumber(cooling.ablative.effective_heat_flux ? cooling.ablative.effective_heat_flux / 1000 : null, 1)} 
                    unit="kW/m²" 
                  />
                  <SmallMetric 
                    label="Cooling Power" 
                    value={formatNumber((cooling.ablative.cooling_power || cooling.ablative.heat_removed) ? (cooling.ablative.cooling_power || cooling.ablative.heat_removed)! / 1000 : null, 1)} 
                    unit="kW" 
                  />
                  <SmallMetric 
                    label="Incident Heat Flux" 
                    value={formatNumber(cooling.ablative.incident_heat_flux ? cooling.ablative.incident_heat_flux / 1000 : null, 1)} 
                    unit="kW/m²" 
                  />
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Stability Analysis */}
      {stability && (
        <Section
          title="Stability Analysis"
          icon={
            stability.is_stable 
              ? <span className="text-green-400">🟢</span>
              : <span className="text-red-400">🔴</span>
          }
        >
          <div className="space-y-4">
            {/* Overall status */}
            <div className={`p-3 rounded-lg ${stability.is_stable ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
              <div className={`font-semibold ${stability.is_stable ? 'text-green-400' : 'text-red-400'}`}>
                {stability.is_stable ? 'STABLE' : 'INSTABILITY RISK'}
              </div>
              {stability.stability_score !== undefined && stability.stability_score > 0 && (
                <div className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Stability Score: {formatNumber(stability.stability_score, 2)}
                </div>
              )}
            </div>

            {/* Chugging Analysis */}
            {stability.chugging && Object.keys(stability.chugging).length > 0 && (
              <div className="p-4 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                <div className="text-sm font-medium text-yellow-400 mb-3">Combustion Stability - Chugging</div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {stability.chugging.frequency !== undefined && (
                    <SmallMetric label="Frequency" value={formatNumber(stability.chugging.frequency, 1)} unit="Hz" />
                  )}
                  {stability.chugging.stability_margin !== undefined && (
                    <SmallMetric 
                      label="Stability Margin" 
                      value={formatNumber(stability.chugging.stability_margin, 3)} 
                      unit="" 
                      colorClass={stability.chugging.stability_margin > 0 ? 'text-green-400' : 'text-red-400'}
                    />
                  )}
                  {stability.chugging.tau_residence !== undefined && (
                    <SmallMetric label="τ Residence" value={formatNumber(stability.chugging.tau_residence * 1000, 2)} unit="ms" />
                  )}
                  {stability.chugging.Lstar !== undefined && (
                    <SmallMetric label="L*" value={formatNumber(stability.chugging.Lstar * 1000, 1)} unit="mm" />
                  )}
                </div>
              </div>
            )}

            {/* Acoustic Modes */}
            {stability.acoustic && Object.keys(stability.acoustic).length > 0 && (
              <div className="p-4 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                <div className="text-sm font-medium text-purple-400 mb-3">Acoustic Modes</div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {stability.acoustic.longitudinal_modes && stability.acoustic.longitudinal_modes.length > 0 && (
                    <div>
                      <div className="text-xs text-[var(--color-text-secondary)] mb-1">Longitudinal Modes</div>
                      <div className="text-sm text-[var(--color-text-primary)]">
                        {stability.acoustic.longitudinal_modes.slice(0, 5).map((f: number) => `${f.toFixed(0)} Hz`).join(', ')}
                      </div>
                    </div>
                  )}
                  {stability.acoustic.transverse_modes && stability.acoustic.transverse_modes.length > 0 && (
                    <div>
                      <div className="text-xs text-[var(--color-text-secondary)] mb-1">Transverse Modes</div>
                      <div className="text-sm text-[var(--color-text-primary)]">
                        {stability.acoustic.transverse_modes.slice(0, 5).map((f: number) => `${f.toFixed(0)} Hz`).join(', ')}
                      </div>
                    </div>
                  )}
                  {stability.acoustic.sound_speed !== undefined && (
                    <SmallMetric label="Sound Speed" value={formatNumber(stability.acoustic.sound_speed, 0)} unit="m/s" />
                  )}
                </div>
              </div>
            )}

            {/* Feed System Stability */}
            {stability.feed_system && Object.keys(stability.feed_system).length > 0 && (
              <div className="p-4 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                <div className="text-sm font-medium text-cyan-400 mb-3">Feed System Stability</div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {stability.feed_system.pogo_frequency !== undefined && (
                    <SmallMetric label="POGO Frequency" value={formatNumber(stability.feed_system.pogo_frequency, 1)} unit="Hz" />
                  )}
                  {stability.feed_system.surge_frequency !== undefined && (
                    <SmallMetric label="Surge Frequency" value={formatNumber(stability.feed_system.surge_frequency, 1)} unit="Hz" />
                  )}
                  {stability.feed_system.water_hammer_margin !== undefined && (
                    <SmallMetric label="Water Hammer Margin" value={formatNumber(stability.feed_system.water_hammer_margin, 2)} unit="" />
                  )}
                  {stability.feed_system.stability_margin !== undefined && (
                    <SmallMetric 
                      label="Feed Margin" 
                      value={formatNumber(stability.feed_system.stability_margin, 2)} 
                      unit="" 
                      colorClass={stability.feed_system.stability_margin > 1.0 ? 'text-green-400' : 'text-red-400'}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Issues */}
            {stability.issues && stability.issues.length > 0 && (
              <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                <div className="text-sm font-medium text-yellow-400 mb-2">Potential Issues</div>
                <ul className="list-disc list-inside space-y-1">
                  {stability.issues.map((issue: string, idx: number) => (
                    <li key={idx} className="text-sm text-[var(--color-text-secondary)]">{issue}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommendations */}
            {stability.recommendations && stability.recommendations.length > 0 && (
              <div className="p-4 rounded-lg bg-blue-500/10 border border-blue-500/30">
                <div className="text-sm font-medium text-blue-400 mb-2">Recommendations</div>
                <ul className="list-disc list-inside space-y-1">
                  {stability.recommendations.map((rec: string, idx: number) => (
                    <li key={idx} className="text-sm text-[var(--color-text-secondary)]">{rec}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Additional Thermodynamic Properties */}
      <Section
        title="Thermodynamic Properties"
        icon={<svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SmallMetric label="γ (Chamber)" value={formatNumber(results.gamma, 4)} unit="" />
          <SmallMetric label="γ (Exit)" value={formatNumber(results.gamma_exit, 4)} unit="" />
          <SmallMetric label="R (Chamber)" value={formatNumber(results.R, 2)} unit="J/(kg·K)" />
          <SmallMetric label="R (Exit)" value={formatNumber(results.R_exit, 2)} unit="J/(kg·K)" />
          <SmallMetric label="A_throat" value={formatSci(results.A_throat, 4)} unit="m²" />
          <SmallMetric label="A_exit" value={formatSci(results.A_exit, 4)} unit="m²" />
          <SmallMetric label="Cf Ideal" value={formatNumber(results.Cf_ideal, 4)} unit="" />
          <SmallMetric label="Cf Theoretical" value={formatNumber(results.Cf_theoretical, 4)} unit="" />
        </div>
      </Section>
    </div>
  );
}
