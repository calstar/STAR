import { useEffect, useState } from 'react';
import { getSwitchOptions, switchConfig, type SwitchOptions, type EngineConfig } from '../api/client';
import { emitConfigChanged } from '../lib/configBus';
import { useReadOnly } from '@stardesign-ui';

/**
 * First-class injector + propellant selectors (UNIFICATION P6).
 *
 * These are the toggles that used to be buried in YAML. Changing either calls POST /api/config/switch,
 * which auto-reconciles the config to the right physics (geometry template, SMD model, geometry-Cd,
 * fluids + CEA identity) and returns the new config so the rest of the app re-renders with it.
 */

const PRETTY: Record<string, string> = {
  pintle: 'Pintle',
  impinging: 'Doublet (unlike-impinging)',
  coaxial: 'Coaxial',
  methalox: 'Methalox (LOX / CH₄)',
  ethalox: 'Ethalox (LOX / Ethanol)',
  kerolox: 'Kerolox (LOX / RP-1)',
  custom: 'Custom (no preset)',
};
const pretty = (k: string | null) => (k ? PRETTY[k] ?? k : '—');

interface Props {
  onConfigChange: (config: EngineConfig) => void;
}

export default function ConfigurationSelector({ onConfigChange }: Props) {
  // A switch replaces the config wholesale (POST /api/config/switch), so these
  // two dropdowns edit the design as surely as any field does.
  const readOnly = useReadOnly();
  const [opts, setOpts] = useState<SwitchOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [designWarning, setDesignWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadOptions = async () => {
    const res = await getSwitchOptions();
    if (res.data) {
      setOpts(res.data);
      setError(null);
    } else {
      setError(res.error ?? 'backend unavailable');
    }
  };

  useEffect(() => { loadOptions(); }, []);

  const doSwitch = async (body: { injector_type?: string; propellant_preset?: string }) => {
    setBusy(true);
    setError(null);
    const res = await switchConfig(body);
    setBusy(false);
    if (res.error || !res.data) {
      setError(res.error ?? 'Switch failed');
      return;
    }
    setWarnings(res.data.binding_warnings ?? []);
    setDesignWarning(res.data.design_warning ?? null);
    // Optimistically move the dropdowns to the switch we just made. The <select>s
    // are driven by opts.current, which otherwise only updates when the trailing
    // loadOptions() round-trip lands -- so without this the controlled value snaps
    // back to the PREVIOUS selection for the duration of the request, reading as a
    // spooky flicker to a "default". The switch response already carries the new
    // config; loadOptions() below still runs to reconcile against the backend.
    const cfg = res.data.config;
    setOpts((prev) =>
      prev
        ? {
            ...prev,
            current: {
              injector: (cfg.injector?.type as string | undefined) ?? prev.current.injector,
              propellant: (cfg.propellant_preset as string | undefined) ?? prev.current.propellant,
            },
          }
        : prev,
    );
    onConfigChange(res.data.config);
    emitConfigChanged(res.data.config); // tell injector-dependent UI (frozen params, etc.) to re-fetch
    await loadOptions(); // refresh "current"
  };

  // Don't silently vanish when options haven't loaded — show a visible hint so the selector's
  // absence isn't mistaken for "the feature isn't there" (it usually means the backend is down).
  if (!opts) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
        <span>Propellant / Injector</span>
        <span className="text-amber-500" title={error ?? ''}>
          {error ? '(start backend on :8000)' : 'loading…'}
        </span>
      </div>
    );
  }

  const selectCls =
    'rounded-md bg-[var(--color-bg-primary)] border border-[var(--color-border)] ' +
    'text-sm text-[var(--color-text-primary)] px-2 py-1 focus:outline-none focus:ring-1 ' +
    'focus:ring-blue-500 disabled:opacity-50';

  return (
    <div className="flex items-center gap-4">
      <label className="flex items-center gap-1.5">
        <span className="text-xs text-[var(--color-text-secondary)]">Propellant</span>
        <select
          className={selectCls}
          disabled={busy || readOnly}
          value={opts.current.propellant ?? 'custom'}
          onChange={(e) => doSwitch({ propellant_preset: e.target.value })}
        >
          {opts.propellants.map((p) => (
            <option key={p} value={p}>{pretty(p)}</option>
          ))}
          {!opts.propellants.includes('custom') && <option value="custom">{pretty('custom')}</option>}
        </select>
      </label>

      <label className="flex items-center gap-1.5">
        <span className="text-xs text-[var(--color-text-secondary)]">Injector</span>
        <select
          className={selectCls}
          disabled={busy || readOnly}
          value={opts.current.injector ?? ''}
          onChange={(e) => doSwitch({ injector_type: e.target.value })}
        >
          {opts.injectors.map((i) => (
            <option key={i} value={i}>{pretty(i)}</option>
          ))}
        </select>
      </label>

      {busy && <span className="text-xs text-[var(--color-text-secondary)] animate-pulse">switching…</span>}
      {readOnly && !busy && (
        <span className="text-xs text-[var(--color-text-muted)]" title="Take the design to change the propellant or injector">
          read only
        </span>
      )}
      {error && <span className="text-xs text-red-500" title={error}>switch failed</span>}
      {warnings.length > 0 && (
        <span className="text-xs text-amber-500" title={warnings.join('\n')}>
          ⚠ {warnings.length} binding warning{warnings.length > 1 ? 's' : ''}
        </span>
      )}
      {designWarning && (
        <span className="text-xs text-amber-500" title={designWarning}>
          ⚠ needs re-optimization
        </span>
      )}
    </div>
  );
}
