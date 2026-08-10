import type { Run, RunIndex, SeriesResponse } from './types';

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

export const api = {
  runs: () => getJSON<Run[]>('/api/runs'),

  components: (runId: string) =>
    getJSON<RunIndex>(`/api/runs/${runId}/components`),

  series: (
    runId: string,
    components: string[],
    start: number | null,
    end: number | null,
    maxPoints = 4000,
  ) => {
    const p = new URLSearchParams({
      components: components.join(','),
      max_points: String(maxPoints),
    });
    if (start != null) p.set('start', String(start));
    if (end != null) p.set('end', String(end));
    return getJSON<SeriesResponse>(`/api/runs/${runId}/series?${p}`);
  },

  // URL for a CSV download (used as an <a href>). No components → whole run.
  downloadUrl: (
    runId: string,
    components: string[],
    start: number | null,
    end: number | null,
  ) => {
    const p = new URLSearchParams();
    if (components.length) p.set('components', components.join(','));
    if (start != null) p.set('start', String(start));
    if (end != null) p.set('end', String(end));
    const q = p.toString();
    return `/api/runs/${runId}/download${q ? `?${q}` : ''}`;
  },
};
