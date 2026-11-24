/**
 * C5-2: in mock mode no elodin-db is started for a run, so nothing created the run directory, and
 * POST /api/feed-char/results (which appends into it) answered 500 ENOENT. ServiceController now
 * creates it at mock-mode start. Then the feed-char route, given that directory as the session's
 * dbDir, records a result.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const root = mkdtempSync(join(tmpdir(), 'mock-run-dir-'));
process.env.DAQ_CALIBRATIONS_DIR = join(root, 'calibrations'); // clearTareFile's target
const dbDir = join(root, 'elodin', '2026-01-01_00-00-00');

let status: { dbDir: string | null } = { dbDir: null };
vi.mock('../session-manager.js', () => ({ sessionManager: { getStatus: () => status } }));

const { ServiceController } = await import('../service-controller.js');
const { handleFeedCharRequest } = await import('../api/feed-char.js');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('mock-mode run directory', () => {
  it('ServiceController(mock).start creates dbDir', async () => {
    expect(existsSync(dbDir)).toBe(false);
    await new ServiceController('mock').start(dbDir, false);
    expect(existsSync(dbDir)).toBe(true);
  });

  it('POST /api/feed-char/results then writes into it (200, not 500 ENOENT)', async () => {
    status = { dbDir };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      try {
        if (!(await handleFeedCharRequest(req, res, url, {}))) { res.writeHead(404); res.end(); }
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/feed-char/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cda: 1.23 }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const line = readFileSync(join(dbDir, 'feed_characterization.jsonl'), 'utf-8').trim();
      expect(JSON.parse(line)).toMatchObject({ cda: 1.23 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
