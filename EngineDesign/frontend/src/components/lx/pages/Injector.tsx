import type { EngineConfig } from '../../../api/client';
import { Reconcile } from '../../layerx/Reconcile';
import type { LayerXJob } from '../useLayerXJob';
import { Legacy, type Theme } from './kit';
import { InjectorChanges } from './tools/InjectorChanges';

/**
 * The Injector tool: the holes solved against the whole system (layerx/Reconcile.tsx, which also
 * owns the one write to the design, gated in layerx/ReconcileWrite.tsx). Wrapped here until it is
 * rebuilt on the Layer X primitives.
 */
export function Injector({ job, theme, isVisible, onConfigUpdated }: {
  job: LayerXJob; theme: Theme; isVisible: boolean; onConfigUpdated?: (c: EngineConfig) => void;
}) {
  return (
    <div className="space-y-6">
    <div className="rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-surface)] px-6 py-6">
      <Legacy theme={theme}>
        <Reconcile payload={job.payload} ready={!!job.pf?.ok} isVisible={isVisible} busy={!!job.activeJob} onStarted={job.loadRuns}
                   onConfigUpdated={onConfigUpdated} focus={job.focusJob?.kind === 'reconcile' ? job.focusJob : null} onFocusUsed={job.clearFocusJob}
                   designHash={(job.pf?.derived?.config_sha256 as string | undefined) ?? null}
                   onOpenRun={(id) => { job.setTool('burn'); job.openRun(id); }} />
      </Legacy>
    </div>
    {/* The same answer in the change-list format the Optimize tool uses (DATA-CONTRACT 6). */}
    <InjectorChanges job={job} isVisible={isVisible} />
    </div>
  );
}
