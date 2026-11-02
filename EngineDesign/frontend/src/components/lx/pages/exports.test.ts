import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadExport } from './exports';

describe('a run export the server cannot write', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says what the server lacks, in its own words', async () => {
    // A server without pyarrow answers 501 with why; the page showed only "PARQUET export failed (HTTP 501)".
    const detail = "Parquet export needs pyarrow on the server (No module named 'pyarrow')";
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail }), {
      status: 501, headers: { 'Content-Type': 'application/json' },
    })));
    expect(await downloadExport('r1', 'parquet')).toBe(detail);
  });

  it('still says something when the 501 carries no words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 501 })));
    expect(await downloadExport('r1', 'parquet')).toBe('PARQUET export is not available on this server');
  });
});
