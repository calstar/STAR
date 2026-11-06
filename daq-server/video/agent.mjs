#!/usr/bin/env node
/**
 * The video agent: the gateway machine's own hands for recordings.
 *
 * Recordings always end up on the gateway machine -- star-rfs at the workspace, the media
 * Mac in the desert -- but the DAQ backend may run on another laptop and cannot touch these
 * files. So this process runs beside MediaMTX (it starts it, and exits when it exits, so a
 * supervisor restarts both) and does the file work the backend asks for:
 *
 *   GET  /status   buffer contents per stream, free disk, where recordings go
 *   POST /save     keep the last BUFFER_SECONDS of the given streams: { streams: [id] }
 *
 * How the buffer works: MediaMTX records every included stream (`raw/<id>`, record: true,
 * set by the backend) into short segments under buffer/, and deletes them after a while
 * (video/mediamtx.yml). Keeping is hard-linking the segments that cover the window out of
 * the buffer -- instant, and immune to MediaMTX deleting the originals -- then writing one
 * file per stream with ffmpeg: concat, video track only (`-map 0:v -c copy`, no re-encode),
 * because camera audio is not kept (VIDCOMM decision). The segment still being written is
 * copied, not linked, so the file is exactly what had arrived when Save was pressed.
 *
 * No dependencies beyond Node >= 18.15 and ffmpeg. Auth: this machine is trusted, as it is
 * by MediaMTX; anyone else needs user "daq" and the gateway password
 * (VIDEO_GATEWAY_PASSWORD, from scripts/video-gateway.sh).
 *
 *   node agent.mjs --mediamtx <bin> --config <mediamtx.yml>   (run from the video dir)
 *   node agent.mjs --no-mediamtx                              (tests: the agent alone)
 */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export const DEFAULT_PORT = 8886;
export const DEFAULT_BUFFER_SECONDS = 300;
/** MediaMTX's recordPath (video/mediamtx.yml) names a segment by its local start time. */
const SEGMENT_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.mp4$/;
const STREAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Start time (epoch ms) of a segment from its file name, or null if it is not one. */
export function segmentStart(name) {
  const m = name.match(SEGMENT_RE);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, us] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s, Math.floor(us / 1000)).getTime();
}

/**
 * The segments, oldest first, that together cover [now - windowMs, now]: every segment
 * starting inside the window, plus the one already running when the window opened.
 */
export function segmentsForWindow(names, now, windowMs) {
  const segs = names
    .map((name) => ({ name, start: segmentStart(name) }))
    .filter((s) => s.start !== null && s.start <= now)
    .sort((a, b) => a.start - b.start);
  const from = now - windowMs;
  let first = segs.findIndex((s) => s.start >= from);
  if (first === -1) first = segs.length; // nothing starts inside: only the running one
  if (first > 0 && (first === segs.length || segs[first].start > from)) first -= 1;
  return segs.slice(Math.max(0, first)).map((s) => s.name);
}

/**
 * Breaks in a run of segments, where the gateway or the camera was down: a jump between
 * segment starts well past the usual spacing (MediaMTX cuts every recordSegmentDuration, at
 * a keyframe). The kept file plays straight across a gap, so it has to be said out loud.
 */
export function countGaps(names) {
  const starts = names.map(segmentStart).filter((x) => x !== null).sort((a, b) => a - b);
  const diffs = starts.slice(1).map((t, i) => t - starts[i]);
  if (diffs.length < 2) return 0;
  const typical = [...diffs].sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
  return diffs.filter((d) => d > Math.max(2 * typical, typical + 5000)).length;
}

/** "2026-11-06_141503" in local time: a folder name that sorts. */
export function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, _out, stderr) => (err ? fail(new Error(`${cmd}: ${stderr.trim().split('\n').pop() || err.message}`)) : ok()));
  });
}

export function createAgent({
  videoDir = process.cwd(),
  bufferSeconds = Number(process.env.VIDEO_BUFFER_SECONDS) || DEFAULT_BUFFER_SECONDS,
  password = process.env.VIDEO_GATEWAY_PASSWORD || '',
  ffmpeg = process.env.FFMPEG || 'ffmpeg',
  now = () => Date.now(),
} = {}) {
  const bufferDir = resolve(videoDir, 'buffer', 'raw');
  const recordingsDir = resolve(videoDir, 'recordings');

  async function listSegments(id) {
    try {
      return (await fs.readdir(join(bufferDir, id))).filter((n) => SEGMENT_RE.test(n));
    } catch {
      return [];
    }
  }

  function disk() {
    try {
      const s = statfsSync(videoDir);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      return null;
    }
  }

  async function status() {
    const t = now();
    const buffered = {};
    let ids = [];
    try { ids = (await fs.readdir(bufferDir)).filter((n) => STREAM_ID_RE.test(n)); } catch { /* nothing yet */ }
    for (const id of ids) {
      const starts = (await listSegments(id)).map(segmentStart).filter((x) => x !== null && x <= t);
      if (starts.length) buffered[id] = Math.min(bufferSeconds, Math.round((t - Math.min(...starts)) / 1000));
    }
    return { bufferSeconds, buffered, disk: disk(), recordingsDir };
  }

  /** Keep the last bufferSeconds of each stream: one video-only file per stream. */
  async function save({ streams, label = 'save' }) {
    const t = now();
    const folder = join(recordingsDir, `${stamp(new Date(t))}_${String(label).replace(/[^a-z0-9-]+/gi, '-').slice(0, 32) || 'save'}`);
    await fs.mkdir(folder, { recursive: true });
    const results = await Promise.all(streams.map(async (id) => {
      const names = segmentsForWindow(await listSegments(id), t, bufferSeconds * 1000);
      if (!names.length) return { stream: id, error: 'nothing buffered for this stream' };
      const work = join(folder, `.${id}`);
      await fs.mkdir(work, { recursive: true });
      try {
        // Link the finished segments (instant; survives MediaMTX deleting them); copy the
        // one still being written, so later writes do not change what was saved.
        for (const [i, name] of names.entries()) {
          const src = join(bufferDir, id, name);
          const dst = join(work, name);
          if (i === names.length - 1) await fs.copyFile(src, dst);
          else await fs.link(src, dst).catch(() => fs.copyFile(src, dst));
        }
        const list = join(work, 'list.txt');
        await fs.writeFile(list, names.map((n) => `file '${join(work, n).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
        const out = join(folder, `${id}.mp4`);
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
          '-map', '0:v', '-c', 'copy', '-movflags', '+faststart', '-y', out]);
        const { size } = await fs.stat(out);
        // How much it really covers: the window, or less if the buffer is younger than that.
        const seconds = Math.round(Math.min(bufferSeconds * 1000, t - segmentStart(names[0])) / 1000);
        return { stream: id, file: out, bytes: size, seconds, gaps: countGaps(names) };
      } catch (e) {
        return { stream: id, error: e.message };
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
    }));
    return { folder, seconds: bufferSeconds, streams: results };
  }

  function authorized(req) {
    const ip = req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
    if (!password) return false;
    const want = Buffer.from(`Basic ${Buffer.from(`daq:${password}`).toString('base64')}`);
    const got = Buffer.from(req.headers.authorization || '');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  const server = createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!authorized(req)) return send(401, { error: 'the video agent needs the gateway password' });
    try {
      if (req.method === 'GET' && req.url === '/status') return send(200, await status());
      if (req.method === 'POST' && req.url === '/save') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 65536) return send(413, { error: 'body too large' }); }
        let input;
        try { input = JSON.parse(body || '{}'); } catch { return send(400, { error: 'body is not JSON' }); }
        const streams = Array.isArray(input.streams) ? input.streams.filter((s) => typeof s === 'string' && STREAM_ID_RE.test(s)) : [];
        if (!streams.length) return send(400, { error: 'no streams to save' });
        return send(200, await save({ streams, label: input.label }));
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: e.message });
    }
  });

  return { server, status, save };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const port = Number(process.env.VIDEO_AGENT_PORT) || DEFAULT_PORT;
  const agent = createAgent();
  const { bufferSeconds } = await agent.status();
  agent.server.listen(port, () => console.error(`video-agent: listening on :${port}, buffer ${bufferSeconds} s, recordings in ${resolve('recordings')}`));

  let child;
  if (!process.argv.includes('--no-mediamtx')) {
    const bin = arg('--mediamtx');
    const config = arg('--config');
    if (!bin || !config) {
      console.error('usage: node agent.mjs --mediamtx <bin> --config <mediamtx.yml> | --no-mediamtx');
      process.exit(2);
    }
    child = spawn(bin, [config], { stdio: 'inherit' });
    // MediaMTX gone: so are we, and the supervisor (sensor-video, the launcher) restarts both.
    child.on('exit', (code, signal) => {
      console.error(`video-agent: MediaMTX exited (${signal ?? code}); stopping`);
      process.exit(code ?? 1);
    });
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (child && child.exitCode === null) child.kill(sig);
      agent.server.close();
      setTimeout(() => process.exit(0), child ? 3000 : 0).unref();
    });
  }
}
