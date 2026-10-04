import type { Dispatch, SetStateAction } from 'react';
import { layerx, type RunView } from '../../api/layerx';

/**
 * Poll one job by id until it finishes. A response for a job that is no longer the one shown is
 * dropped; a job the backend no longer has (it restarted) is marked lost rather than polled for
 * ever. Returns the cleanup.
 */
export function pollJob(id: string, everyMs: number, set: Dispatch<SetStateAction<RunView | null>>, onDone: () => void): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    const r = await layerx.run(id);
    inFlight = false;
    if (stopped) return;
    if (r.status === 404) {
      stopped = true;
      set((p) => (p && p.id === id ? { ...p, status: 'failed', error: 'The backend no longer has this job: it restarted while the job was running. Start it again.' } : p));
      onDone();
      return;
    }
    if (r.data) {
      const v = r.data;
      set((p) => (p && p.id === id ? v : p));
      if (v.status !== 'queued' && v.status !== 'running') { stopped = true; onDone(); }
    }
  };
  const handle = setInterval(tick, everyMs);
  return () => { stopped = true; clearInterval(handle); };
}

