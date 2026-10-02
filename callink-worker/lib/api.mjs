// STARProject's worker API (starproject/src/app/api/worker). On the apps box the
// worker reaches it over the compose network at http://starproject:3000.
import { readEnv } from './env.mjs';

export const SCRAPE_BATCH = 50;

export function starproject() {
  const { STARPROJECT_URL, WORKER_TOKEN } = readEnv(['STARPROJECT_URL', 'WORKER_TOKEN']);
  const base = STARPROJECT_URL.replace(/\/$/, '');

  async function call(method, path, body) {
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${WORKER_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (r.status === 204) return null;
    const text = await r.text();
    let out;
    try { out = JSON.parse(text); } catch { out = { error: text.slice(0, 200) }; }
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} -> ${r.status}: ${out.error ?? text.slice(0, 200)}`), { status: r.status });
    return out;
  }

  return {
    /** null when there's nothing to do. */
    claim: () => call('POST', '/api/worker/jobs/claim'),
    result: (id, body) => call('POST', `/api/worker/jobs/${id}/result`, body),
    release: id => call('POST', `/api/worker/jobs/${id}/release`),
    heartbeat: body => call('POST', '/api/worker/heartbeat', body),
    async receipt(url) {
      const r = await fetch(base + url, { headers: { authorization: `Bearer ${WORKER_TOKEN}` }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    /** Push a scrape in batches. `listedIds` (a full scrape only) goes with the last batch. */
    async pushScrape(records, listedIds) {
      const total = { created: 0, updated: 0, linked: 0, deleted: 0, failed: [] };
      // Oldest first, so the first import numbers requests in the order they were filed.
      const sorted = [...records].sort((a, b) => a.list.submittedOn.localeCompare(b.list.submittedOn));
      for (let i = 0; i < sorted.length || (i === 0 && listedIds); i += SCRAPE_BATCH) {
        const last = i + SCRAPE_BATCH >= sorted.length;
        const out = await call('POST', '/api/worker/scrape', {
          records: sorted.slice(i, i + SCRAPE_BATCH),
          ...(last && listedIds ? { listedIds } : {}),
        });
        for (const k of ['created', 'updated', 'linked', 'deleted']) total[k] += out[k];
        total.failed.push(...out.failed);
        if (out.deleteSkipped) total.deleteSkipped = out.deleteSkipped;
        if (last) break;
      }
      return total;
    },
  };
}
