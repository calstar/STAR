import { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

export type LayerStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface ObjectiveHistoryPoint {
  iteration: number;
  objective: number;
  best_objective: number;
}

interface DemoLayerCardProps {
  layerNumber: number;
  title: string;
  description: string;
  status: LayerStatus;
  progress?: number; // 0-100
  message?: string;
  children?: React.ReactNode;
  metrics?: Array<{
    label: string;
    value: string | number;
    unit?: string;
    color?: 'green' | 'red' | 'blue' | 'purple' | 'orange' | 'cyan' | 'yellow' | 'pink' | 'indigo';
  }>;
  validationPassed?: boolean;
  defaultExpanded?: boolean;
  objectiveHistory?: ObjectiveHistoryPoint[];
}

// Status badge component
function StatusBadge({ status }: { status: LayerStatus }) {
  const configs: Record<LayerStatus, { bg: string; text: string; label: string; icon: string }> = {
    pending: {
      bg: 'bg-gray-500/20',
      text: 'text-gray-400',
      label: 'Pending',
      icon: '○',
    },
    running: {
      bg: 'bg-blue-500/20',
      text: 'text-blue-400',
      label: 'Running',
      icon: '◐',
    },
    complete: {
      bg: 'bg-green-500/20',
      text: 'text-green-400',
      label: 'Complete',
      icon: '●',
    },
    failed: {
      bg: 'bg-red-500/20',
      text: 'text-red-400',
      label: 'Failed',
      icon: '✗',
    },
  };

  const config = configs[status];

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${config.bg} ${config.text} flex items-center gap-1.5`}>
      <span className={status === 'running' ? 'animate-spin' : ''}>{config.icon}</span>
      {config.label}
    </span>
  );
}

// Mini metric display for collapsed state
function MiniMetric({ 
  label, 
  value, 
  unit, 
  color = 'blue' 
}: { 
  label: string; 
  value: string | number; 
  unit?: string; 
  color?: string;
}) {
  const textColors: Record<string, string> = {
    green: 'text-green-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
    purple: 'text-purple-400',
    orange: 'text-orange-400',
    cyan: 'text-cyan-400',
    yellow: 'text-yellow-400',
    pink: 'text-pink-400',
    indigo: 'text-indigo-400',
  };

  return (
    <div className="flex items-baseline gap-1">
      <span className="text-xs text-[var(--color-text-tertiary)]">{label}:</span>
      <span className={`text-sm font-semibold ${textColors[color] || textColors.blue}`}>
        {typeof value === 'number' ? value.toFixed(2) : value}
        {unit && <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-0.5">{unit}</span>}
      </span>
    </div>
  );
}

// Result card for expanded details
function ResultCard({
  label,
  value,
  unit,
  decimals = 2,
  color = 'blue',
}: {
  label: string;
  value: number | string | undefined;
  unit?: string;
  decimals?: number;
  color?: string;
}) {
  const colorClasses: Record<string, string> = {
    blue: 'bg-blue-500/10 border-blue-500/30',
    green: 'bg-green-500/10 border-green-500/30',
    yellow: 'bg-yellow-500/10 border-yellow-500/30',
    red: 'bg-red-500/10 border-red-500/30',
    purple: 'bg-purple-500/10 border-purple-500/30',
    orange: 'bg-orange-500/10 border-orange-500/30',
    cyan: 'bg-cyan-500/10 border-cyan-500/30',
    pink: 'bg-pink-500/10 border-pink-500/30',
    indigo: 'bg-indigo-500/10 border-indigo-500/30',
  };

  const textColorClasses: Record<string, string> = {
    blue: 'text-blue-400',
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    red: 'text-red-400',
    purple: 'text-purple-400',
    orange: 'text-orange-400',
    cyan: 'text-cyan-400',
    pink: 'text-pink-400',
    indigo: 'text-indigo-400',
  };

  const displayValue = typeof value === 'number'
    ? value.toFixed(decimals)
    : value !== undefined && value !== null
      ? String(value)
      : '-';

  return (
    <div className={`rounded-lg p-3 border ${colorClasses[color] || colorClasses.blue}`}>
      <p className="text-xs text-[var(--color-text-secondary)] mb-1">{label}</p>
      <p className={`text-lg font-bold ${textColorClasses[color] || textColorClasses.blue}`}>
        {displayValue}
        {unit && <span className="text-sm font-normal text-[var(--color-text-secondary)] ml-1">{unit}</span>}
      </p>
    </div>
  );
}

export function DemoLayerCard({
  layerNumber,
  title,
  description,
  status,
  progress = 0,
  message,
  children,
  metrics,
  validationPassed,
  defaultExpanded = false,
  objectiveHistory = [],
}: DemoLayerCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || status === 'running' || status === 'complete');

  // Compute min/max for dot sizing in the convergence chart
  const { minObj, maxObj } = useMemo(() => {
    if (!objectiveHistory || objectiveHistory.length === 0) {
      return { minObj: 1, maxObj: 1 };
    }
    const objectives = objectiveHistory.map(h => h.objective).filter(o => o > 0);
    if (objectives.length === 0) return { minObj: 1, maxObj: 1 };
    return {
      minObj: Math.min(...objectives),
      maxObj: Math.max(...objectives),
    };
  }, [objectiveHistory]);

  // Custom dot renderer for convergence chart
  const renderDot = useMemo(() => {
    const logMinObj = minObj > 0 ? Math.log(minObj) : 0;
    const logMaxObj = maxObj > 0 ? Math.log(maxObj) : 0;
    const logRange = logMaxObj - logMinObj || 1;
    const minSize = 3;
    const maxSize = 8;

    return (props: any) => {
      const { cx, cy, payload } = props;
      if (!payload || typeof payload.objective !== 'number' || payload.objective <= 0) {
        return <circle cx={cx} cy={cy} r={0} fill="transparent" />;
      }

      const logValue = Math.log(payload.objective);
      const normalized = (logMaxObj - logValue) / logRange;
      const radius = maxSize + (minSize - maxSize) * normalized;

      const isBest = payload.best_objective !== undefined &&
        typeof payload.best_objective === 'number' &&
        Math.abs(payload.objective - payload.best_objective) < 1e-10;
      const fillColor = isBest ? "#ef4444" : "#3b82f6";

      return <circle cx={cx} cy={cy} r={radius} fill={fillColor} />;
    };
  }, [minObj, maxObj]);

  // Auto-expand when status changes to running or complete
  const shouldAutoExpand = status === 'running' || (status === 'complete' && !isExpanded);
  if (shouldAutoExpand && !isExpanded) {
    setIsExpanded(true);
  }

  const layerColors: Record<number, string> = {
    1: 'from-purple-500 to-purple-600',
    2: 'from-pink-500 to-pink-600',
    3: 'from-orange-500 to-orange-600',
    4: 'from-cyan-500 to-cyan-600',
  };

  return (
    <div className={`border rounded-xl overflow-hidden transition-all duration-300 ${
      status === 'running' 
        ? 'border-blue-500/50 shadow-lg shadow-blue-500/10' 
        : status === 'complete'
          ? 'border-green-500/30'
          : status === 'failed'
            ? 'border-red-500/30'
            : 'border-[var(--color-border)]'
    }`}>
      {/* Header - always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-4 flex items-center gap-4 bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        {/* Layer number badge */}
        <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${layerColors[layerNumber] || 'from-gray-500 to-gray-600'} flex items-center justify-center flex-shrink-0`}>
          <span className="text-white font-bold">{layerNumber}</span>
        </div>

        {/* Title and description */}
        <div className="flex-1 text-left">
          <h3 className="font-semibold text-[var(--color-text-primary)]">{title}</h3>
          <p className="text-xs text-[var(--color-text-secondary)]">{description}</p>
        </div>

        {/* Mini metrics (shown when complete and collapsed) */}
        {status === 'complete' && !isExpanded && metrics && metrics.length > 0 && (
          <div className="hidden md:flex items-center gap-4">
            {metrics.slice(0, 3).map((metric, i) => (
              <MiniMetric key={i} {...metric} />
            ))}
          </div>
        )}

        {/* Validation indicator */}
        {status === 'complete' && validationPassed !== undefined && (
          <div className={`px-2 py-1 rounded text-xs font-medium ${
            validationPassed 
              ? 'bg-green-500/20 text-green-400' 
              : 'bg-yellow-500/20 text-yellow-400'
          }`}>
            {validationPassed ? 'PASS' : 'WARN'}
          </div>
        )}

        {/* Status badge */}
        <StatusBadge status={status} />

        {/* Expand/collapse icon */}
        <svg
          className={`w-5 h-5 text-[var(--color-text-secondary)] transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Progress bar (shown when running) */}
      {status === 'running' && (
        <div className="h-1 bg-[var(--color-bg-tertiary)]">
          <div 
            className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-4 py-4 bg-[var(--color-bg-primary)] border-t border-[var(--color-border)]">
          {/* Running state - show message, progress, and convergence chart */}
          {status === 'running' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-[var(--color-text-secondary)]">
                  {message || 'Optimizing...'}
                </p>
                <span className="text-sm font-mono text-blue-400">{progress.toFixed(0)}%</span>
              </div>
              
              {/* Convergence Chart */}
              {objectiveHistory.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
                    Objective Convergence
                    <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-2">
                      ({objectiveHistory.length} iterations)
                    </span>
                  </h4>
                  <div className="h-72 bg-[var(--color-bg-secondary)] rounded-lg p-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={objectiveHistory} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
                        <XAxis
                          dataKey="iteration"
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 10 }}
                        />
                        <YAxis
                          scale="log"
                          domain={['auto', 'auto']}
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 10 }}
                          width={50}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--color-bg-secondary)',
                            border: '1px solid var(--color-border)',
                            borderRadius: '0.5rem',
                            color: 'var(--color-text-primary)',
                            fontSize: '12px',
                          }}
                          formatter={(value: number) => value.toExponential(3)}
                        />
                        <Legend wrapperStyle={{ fontSize: '11px' }} />
                        <Line
                          type="monotone"
                          dataKey="objective"
                          name="Objective"
                          stroke="#3b82f6"
                          strokeWidth={0}
                          dot={renderDot}
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="best_objective"
                          name="Best"
                          stroke="#f97316"
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Complete state - show metrics, convergence chart, and children */}
          {(status === 'complete' || status === 'failed') && (
            <div className="space-y-4">
              {/* Metrics grid */}
              {metrics && metrics.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {metrics.map((metric, i) => (
                    <ResultCard
                      key={i}
                      label={metric.label}
                      value={metric.value}
                      unit={metric.unit}
                      color={metric.color}
                    />
                  ))}
                </div>
              )}

              {/* Convergence Chart (for complete state) */}
              {objectiveHistory.length > 0 && (
                <div className="mt-4">
                  <h4 className="text-md font-semibold text-[var(--color-text-primary)] mb-3">
                    Objective Convergence
                    <span className="text-sm font-normal text-[var(--color-text-secondary)] ml-2">
                      ({objectiveHistory.length} iterations)
                    </span>
                  </h4>
                  <div className="h-72 bg-[var(--color-bg-secondary)] rounded-lg p-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={objectiveHistory} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
                        <XAxis
                          dataKey="iteration"
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 10 }}
                        />
                        <YAxis
                          scale="log"
                          domain={['auto', 'auto']}
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 10 }}
                          width={50}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--color-bg-secondary)',
                            border: '1px solid var(--color-border)',
                            borderRadius: '0.5rem',
                            color: 'var(--color-text-primary)',
                            fontSize: '12px',
                          }}
                          formatter={(value: number) => value.toExponential(3)}
                        />
                        <Legend wrapperStyle={{ fontSize: '11px' }} />
                        <Line
                          type="monotone"
                          dataKey="objective"
                          name="Objective"
                          stroke="#3b82f6"
                          strokeWidth={0}
                          dot={renderDot}
                          isAnimationActive={false}
                        />
                        <Line
                          type="monotone"
                          dataKey="best_objective"
                          name="Best"
                          stroke="#f97316"
                          strokeWidth={2}
                          strokeDasharray="5 5"
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Custom children content */}
              {children}
            </div>
          )}

          {/* Pending state */}
          {status === 'pending' && (
            <p className="text-sm text-[var(--color-text-tertiary)] italic">
              Waiting for previous layer to complete...
            </p>
          )}
        </div>
      )}
    </div>
  );
}
