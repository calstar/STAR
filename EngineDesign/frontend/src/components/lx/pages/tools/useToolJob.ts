import { useCallback, useEffect, useRef, useState } from 'react';
import { layerx, type RunView } from '../../../../api/layerx';
import { useViewState } from '../../../../lib/viewState';
import { pollJob } from '../../../layerx/jobs';
import type { LayerXJob } from '../../useLayerXJob';

/**
 * One tool's job (a set point or a hardware search): the one it shows (remembered per browser),
 * starting one, polling it while it runs, and its past runs. The backend runs one job per person at
 * a time, whatever started it: `job.activeJob` says which.
 */
export function useToolJob(kind: 'setpoint' | 'hardware', job: LayerXJob, isVisible: boolean) {
  const [openId, setOpenId] = useViewState<string>(`lx.tool.${kind}`, '');
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const wanted = useRef(openId);
  useEffect(() => { wanted.current = openId; }, [openId]);

  // The run this tool shows, fetched when it is not the one in hand.
  useEffect(() => {
    if (!isVisible || !openId || run?.id === openId) return;
    const id = openId;
    layerx.run(id).then((r) => {
      if (wanted.current !== id) return;
      if (r.data && r.data.id === id) setRun(r.data);
      else if (r.status === 404) setOpenId('');
    });
  }, [isVisible, openId, run?.id, setOpenId]);

  const live = !!run && (run.status === 'queued' || run.status === 'running');
  const liveId = live && run ? run.id : null;
  const { loadRuns } = job;
  useEffect(() => {
    if (!liveId) return;
    return pollJob(liveId, 1500, setRun, loadRuns);
  }, [liveId, loadRuns]);

  const start = useCallback(async (post: () => Promise<{ data?: { id: string; status: RunView['status'] }; error?: string }>) => {
    if (!job.payload || starting) return;
    setError(null);
    setStarting(true);
    const r = await post().finally(() => setStarting(false));
    if (r.error || !r.data) { setError(r.error ?? 'Could not start it.'); return; }
    setOpenId(r.data.id);
    setRun({ id: r.data.id, kind, status: r.data.status, stage: 'Starting', progress: 0, error: null, started: Date.now() / 1000,
             finished: null, design: '', settings: job.payload });
    job.loadRuns();
  }, [job, kind, setOpenId, starting]);

  const past = job.runs.filter((r) => r.kind === kind).sort((a, b) => b.started - a.started);
  return {
    run: run && run.id === openId ? run : null,
    open: (id: string) => { setRun(null); setOpenId(id); },
    close: () => { setRun(null); setOpenId(''); },
    live, starting, error, start, past,
    cancel: () => { if (run) void layerx.cancel(run.id); },
    /** Another job of this person's is going: the backend runs one at a time. */
    busy: !!job.activeJob && job.activeJob.id !== run?.id,
  };
}

export type ToolJob = ReturnType<typeof useToolJob>;
