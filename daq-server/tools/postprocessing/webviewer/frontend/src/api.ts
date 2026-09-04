import type { Run, RunIndex, SeriesResponse, TimeSource } from './types';

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

/** The config snapshot taken beside a run's DB, as TOML text. `null` when the run
 *  has none: recorded before the backend started snapshotting it. */
async function getConfig(runId: string): Promise<string | null> {
  const r = await fetch(configUrl(runId));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.text();
}

const configUrl = (runId: string) => `/api/runs/${runId}/config`;

/** Set (or clear, with '') this run's shared description. Returns what was stored:
 *  the server normalises to one line and truncates, so echo that back into the box. */
async function setDescription(runId: string, text: string): Promise<string> {
  const r = await fetch(`/api/runs/${runId}/description`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).description as string;
}

export const api = {
  runs: () => getJSON<Run[]>('/api/runs'),

  components: (runId: string) =>
    getJSON<RunIndex>(`/api/runs/${runId}/components`),

  config: getConfig,

  setDescription,

  // Same URL, used as an <a download> href for "save the .toml".
  configUrl,

  series: (
    runId: string,
    components: string[],
    start: number | null,
    end: number | null,
    maxPoints = 4000,
    timeSource: TimeSource = 'sensor',
  ) => {
    const p = new URLSearchParams({
      components: components.join(','),
      max_points: String(maxPoints),
      time_source: timeSource,
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
    timeSource: TimeSource = 'sensor',
  ) => {
    const p = new URLSearchParams({ time_source: timeSource });
    if (components.length) p.set('components', components.join(','));
    if (start != null) p.set('start', String(start));
    if (end != null) p.set('end', String(end));
    const q = p.toString();
    return `/api/runs/${runId}/download${q ? `?${q}` : ''}`;
  },
};
