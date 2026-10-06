import { useEffect, useState } from 'react';
import { layerx, type ChangeList, type RunView } from '../../../../api/layerx';
import { NotComputed, Panel } from '../../ui';
import type { LayerXJob } from '../../useLayerXJob';
import { ChangeListView } from './ChangeList';

/**
 * The Injector tool's answer in the change-list format (engine/layerx/reconcile.py
 * `result.change_list`, engine/layerx/diff.py), beside the solver's own view: the holes it would
 * drill, their P&ID and design paths, before -> after, the effect and the CAD impact. The write is
 * the solver view's (layerx/ReconcileWrite.tsx, gated), which also carries the fitted feed, so this
 * one only shows and exports.
 */
export function InjectorChanges({ job, isVisible }: { job: LayerXJob; isVisible: boolean }) {
  const solves = job.runs.filter((r) => r.kind === 'reconcile' && r.status === 'done').sort((a, b) => b.started - a.started);
  const focus = job.focusJob?.kind === 'reconcile' ? job.focusJob.id : null;
  const id = focus ?? solves[0]?.id ?? null;
  const [run, setRun] = useState<RunView | null>(null);
  useEffect(() => {
    if (!isVisible || !id || run?.id === id) return;
    let live = true;
    layerx.run(id).then((r) => { if (live && r.data?.id === id) setRun(r.data); });
    return () => { live = false; };
  }, [isVisible, id, run?.id]);
  if (!id) return null;
  const shown = run?.id === id ? run : null;
  const cl = (shown?.result as { change_list?: ChangeList } | null | undefined)?.change_list ?? null;
  const when = shown ? new Date(shown.started * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  if (!shown) return <Panel title="The injector solve as changes"><NotComputed height={60}>Loading…</NotComputed></Panel>;
  if (!cl) {
    return (
      <Panel title="The injector solve as changes" right={<span>{when}</span>}>
        <NotComputed height={60}>Not computed for this solve: it ran before the change-list format. Solve again to see it here.</NotComputed>
      </Panel>
    );
  }
  return (
    <ChangeListView cl={cl} runId={shown.id} tool="injector" designName={shown.design} drawingName={shown.drawing?.name}
                    title={`The injector solve as changes · ${when}`}
                    writeNote="Write the holes into the design with the solver's own button above: it writes the fitted feed with them." />
  );
}
