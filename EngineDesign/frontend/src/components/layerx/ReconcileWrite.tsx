import { useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import type { EngineConfig } from '../../api/client';
import { updateConfig } from '../../api/client';
import { Hint } from '../Hint';

/**
 * Writes the reconciled injector into the design (engine/layerx/reconcile.py design_update): hole
 * diameters, jet angles, passage L/d, and the drawing's fitted feed. Gated on the checkout; kept
 * apart from the reconciler's form, which edits nothing.
 */
export function WriteReconciled({ update, runId, onConfigUpdated, stale = null, designSha = null }: {
  update: Record<string, unknown>; runId: string; onConfigUpdated?: (config: EngineConfig) => void; stale?: string | null;
  /** The design the holes were solved on: the server refuses the write if it has moved. */
  designSha?: string | null;
}) {
  const readOnly = useReadOnly();
  const [state, setState] = useState<'idle' | 'writing' | 'written'>('idle');
  const [error, setError] = useState<string | null>(null);
  const write = async () => {
    setState('writing');
    setError(null);
    const body = JSON.parse(JSON.stringify(update)) as { feed_system?: Record<string, { derived_from: Record<string, unknown> }> };
    for (const side of Object.values(body.feed_system ?? {})) side.derived_from.run = runId;
    const r = await updateConfig(body as unknown as Partial<EngineConfig>, designSha);
    if (r.error) { setError(r.error); setState('idle'); return; }
    if (r.data?.config) onConfigUpdated?.(r.data.config);
    setState('written');
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" onClick={write} disabled={readOnly || !!stale || state !== 'idle'}
              title={readOnly ? 'Check the design out to change it.' : stale ?? undefined}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
        {state === 'written' ? 'Written' : state === 'writing' ? 'Writing…' : 'Write the reconciled injector into the design'}
      </button>
      <Hint text="Writes the hole diameters, jet angles and passage L/d, and the drawing's fitted feed (K0 per side) so Forward mode agrees with the burn.">
        <span className="text-[12px] text-[var(--color-text-muted)]">{state === 'written' ? 'Forward mode now uses the drawing’s feed.' : 'holes, angles, L/d and fitted feed'}</span>
      </Hint>
      {stale && state === 'idle' && <span className="text-[12px] text-[var(--color-warning)]">{stale}</span>}
      {error && <span className="text-[12px] text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}
