#!/usr/bin/env node
/**
 * The video agent: the gateway machine's own hands for recordings.
 *
 * Recordings always end up on the gateway machine -- star-rfs at the workspace, the media
 * Mac in the desert -- but the DAQ backend may run on another laptop and cannot touch these
 * files. So this process runs beside MediaMTX (it starts it, and exits when it exits, so a
 * supervisor restarts both) and does the file work the backend asks for:
 *
 *   GET  /status        buffer contents per stream, free disk, the recording (if any)
 *   POST /save          keep the last BUFFER_SECONDS of the given streams: { streams: [id] }
 *   POST /record/start  record the given streams from now: { streams, refuseBelowBytes, stopBelowBytes }
 *   POST /record/stop   end it: one file per stream
 *   GET  /recordings    the kept recordings, newest first: folder, kind, when, files
 *   POST /open          open the recordings folder (or one recording: { name }) in this
 *                       machine's file manager -- Finder, or xdg-open on Linux
 *
 * Recording: from the press until Stop, each finished segment is linked into the
 * recording's folder as it completes (so a long recording outlives the buffer's cleanup),
 * and the first is trimmed to the press. The disk guard is enforced here, on the machine
 * whose disk it is: Record is refused below refuseBelowBytes free, and a recording stops
 * cleanly at stopBelowBytes -- whether or not the DAQ laptop is still there. A recording
 * interrupted by a restart of this process is finished from what was linked, at startup.
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

/** A recording folder's name: stamp(), then "_save" / "_record" (or another label). */
export const RECORDING_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})_([a-z0-9-]{1,32})$/i;

/** The command that opens a folder in this machine's file manager. */
export function openerFor(platform) {
  return platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
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
  /** Opens a path in the file manager; resolves, or rejects with why. Injected by tests. */
  openPath = (path) => new Promise((ok, fail) => {
    execFile(openerFor(process.platform), [path], { timeout: 10_000 }, (err, _o, stderr) => (err
      ? fail(new Error(String(stderr).trim().split('\n').pop() || err.message))
      : ok()));
  }),
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
    const recording = rec
      ? { active: true, stopping: !!rec.stopping, folder: rec.folder, startedAt: rec.startedAt, streams: rec.streams, elapsedSeconds: Math.round((t - rec.startedAt) / 1000) }
      : { active: false };
    return { bufferSeconds, buffered, disk: disk(), bytesPerSecond: await bufferRate(ids), recordingsDir, recording, lastRecording };
  }

  /**
   * One video-only file per stream from segments already in `work` (oldest first):
   * concat, `-map 0:v -c copy`. `inpointMs` trims the first segment (to a keyframe).
   */
  async function writeKept(work, names, out, inpointMs = 0) {
    const list = join(work, 'list.txt');
    const lines = names.map((n, i) => {
      const f = `file '${join(work, n).replace(/'/g, "'\\''")}'`;
      return i === 0 && inpointMs > 0 ? `${f}\ninpoint ${(inpointMs / 1000).toFixed(3)}` : f;
    });
    await fs.writeFile(list, lines.join('\n') + '\n');
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-map', '0:v', '-c', 'copy', '-movflags', '+faststart', '-y', out]);
    return (await fs.stat(out)).size;
  }

  /** Link a finished segment into `work` (instant; immune to MediaMTX deleting it). */
  const linkInto = (id, name, work) => fs.link(join(bufferDir, id, name), join(work, name))
    .catch((e) => (e.code === 'EEXIST' ? undefined : fs.copyFile(join(bufferDir, id, name), join(work, name))));

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
        const out = join(folder, `${id}.mp4`);
        const size = await writeKept(work, names, out);
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

  // ── Recording ─────────────────────────────────────────────────────────────────

  /** The recording in progress: { folder, startedAt, streams, stopBelowBytes, timer, linked } */
  let rec = null;
  /** How the last recording ended: what Stop (or the disk guard, or a restart) produced. */
  let lastRecording = null;
  const META = '.recording.json';

  class Refused extends Error {}

  /** Link every finished segment since the press; on the final pass, copy the running one too. */
  async function collect(r, final) {
    const t = now();
    for (const id of r.streams) {
      const names = segmentsForWindow(await listSegments(id), t, t - r.startedAt);
      const work = join(r.folder, `.${id}`);
      for (const [i, name] of names.entries()) {
        const running = i === names.length - 1;
        if (running && !final) continue; // still being written: wait for it to finish
        if (r.linked[id].has(name) && !running) continue;
        if (running) await fs.copyFile(join(bufferDir, id, name), join(work, name)).catch(() => {});
        else await linkInto(id, name, work);
        r.linked[id].add(name);
      }
    }
  }

  /** One file per stream from a recording folder's work dirs; removes them. */
  async function finish(folder, streams, startedAt, stoppedAt, reason) {
    const results = await Promise.all(streams.map(async (id) => {
      const work = join(folder, `.${id}`);
      try {
        const names = (await fs.readdir(work).catch(() => [])).filter((n) => SEGMENT_RE.test(n))
          .sort((a, b) => segmentStart(a) - segmentStart(b));
        if (!names.length) return { stream: id, error: 'nothing arrived from this stream while recording' };
        const first = segmentStart(names[0]);
        const out = join(folder, `${id}.mp4`);
        const bytes = await writeKept(work, names, out, Math.max(0, startedAt - first));
        return { stream: id, file: out, bytes, seconds: Math.round((stoppedAt - startedAt) / 1000), gaps: countGaps(names) };
      } catch (e) {
        return { stream: id, error: e.message };
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
    }));
    await fs.rm(join(folder, META), { force: true });
    return { folder, startedAt, stoppedAt, reason, streams: results };
  }

  async function startRecording({ streams, refuseBelowBytes = 0, stopBelowBytes = 0 }) {
    if (rec) throw new Refused(`already recording since ${new Date(rec.startedAt).toLocaleTimeString()}`);
    const d = disk();
    if (d && d.freeBytes < refuseBelowBytes) {
      throw new Refused(`only ${(d.freeBytes / 1e9).toFixed(1)} GB free on the gateway machine; recording needs ${(refuseBelowBytes / 1e9).toFixed(0)} GB`);
    }
    const startedAt = now();
    const folder = join(recordingsDir, `${stamp(new Date(startedAt))}_record`);
    for (const id of streams) await fs.mkdir(join(folder, `.${id}`), { recursive: true });
    await fs.writeFile(join(folder, META), JSON.stringify({ startedAt, streams }));
    const r = { folder, startedAt, streams, stopBelowBytes, linked: Object.fromEntries(streams.map((id) => [id, new Set()])) };
    rec = r;
    r.timer = setInterval(() => void tick(r), 2000);
    r.timer.unref?.();
    return { folder, startedAt, streams };
  }

  async function tick(r) {
    if (rec !== r || r.busy || r.stopping) return;
    r.busy = true;
    try {
      await collect(r, false);
      const d = disk();
      if (d && d.freeBytes < r.stopBelowBytes && rec === r && !r.stopping) {
        console.error(`video-agent: ${(d.freeBytes / 1e9).toFixed(1)} GB free -- stopping the recording before the disk fills`);
        r.busy = false;
        await stopRecording('disk nearly full');
      }
    } finally {
      r.busy = false;
    }
  }

  async function stopRecording(reason = 'stopped') {
    const r = rec;
    if (!r || r.stopping) throw new Refused(r ? 'already stopping' : 'not recording');
    // Still "the recording" (stopping) until its files exist: a status read in between must
    // not say "not recording" while lastRecording still describes the one before.
    r.stopping = true;
    clearInterval(r.timer);
    try {
      while (r.busy) await new Promise((ok) => setTimeout(ok, 50));
      const stoppedAt = now();
      await collect(r, true);
      lastRecording = await finish(r.folder, r.streams, r.startedAt, stoppedAt, reason);
      return lastRecording;
    } finally {
      rec = null;
    }
  }

  /** A recording cut short by a restart of this process: finish what was linked. */
  async function recover() {
    let folders = [];
    try { folders = await fs.readdir(recordingsDir); } catch { return; }
    for (const f of folders) {
      const folder = join(recordingsDir, f);
      const meta = await fs.readFile(join(folder, META), 'utf8').then(JSON.parse).catch(() => null);
      if (!meta) continue;
      const st = await fs.stat(join(folder, META));
      lastRecording = await finish(folder, meta.streams, meta.startedAt, Math.max(st.mtimeMs, meta.startedAt), 'interrupted (the gateway restarted)');
      console.error(`video-agent: finished an interrupted recording in ${folder}`);
    }
  }

  /**
   * Bytes per second the buffer is writing now, all streams together: for "hours left".
   * Per stream, from its finished segments of the last few minutes -- each one's size over
   * the time it covers (the gap to the next one's start) -- skipping spans that are outages,
   * so a restart or a camera dropout does not dilute it.
   */
  async function bufferRate(ids) {
    const t = now();
    let total = 0;
    for (const id of ids) {
      const segs = (await listSegments(id))
        .map((name) => ({ name, start: segmentStart(name) }))
        .filter((x) => x.start !== null && t - x.start <= 180_000)
        .sort((a, b) => a.start - b.start);
      const spans = segs.slice(0, -1).map((x, i) => ({ name: x.name, ms: segs[i + 1].start - x.start }));
      if (!spans.length) continue;
      const typical = [...spans].sort((a, b) => a.ms - b.ms)[Math.floor(spans.length / 2)].ms;
      let bytes = 0;
      let ms = 0;
      for (const sp of spans) {
        if (sp.ms > Math.max(2 * typical, typical + 5000)) continue; // an outage, not a segment
        bytes += (await fs.stat(join(bufferDir, id, sp.name)).catch(() => ({ size: 0 }))).size;
        ms += sp.ms;
      }
      if (ms > 0) total += bytes / (ms / 1000);
    }
    return Math.round(total);
  }

  // ── Recordings on disk ──────────────────────────────────────────────────────

  /** The kept recordings, newest first. A recording still in progress is marked active. */
  async function listRecordings() {
    let names = [];
    try { names = await fs.readdir(recordingsDir); } catch { return { dir: recordingsDir, recordings: [] }; }
    const out = [];
    for (const name of names) {
      const m = name.match(RECORDING_NAME_RE);
      if (!m) continue;
      const [, y, mo, d, h, mi, sec, label] = m;
      const folder = join(recordingsDir, name);
      const entries = await fs.readdir(folder).catch(() => []);
      const files = [];
      for (const f of entries.filter((e) => e.endsWith('.mp4')).sort()) {
        const st = await fs.stat(join(folder, f)).catch(() => null);
        if (st) files.push({ stream: f.slice(0, -4), bytes: st.size });
      }
      out.push({
        name,
        kind: label,
        startedAt: new Date(+y, +mo - 1, +d, +h, +mi, +sec).getTime(),
        active: !!rec && rec.folder === folder,
        files,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
      });
    }
    out.sort((a, b) => b.startedAt - a.startedAt || b.name.localeCompare(a.name));
    return { dir: recordingsDir, recordings: out };
  }

  /** Open the recordings folder, or one recording in it, in this machine's file manager. */
  async function openFolder(name) {
    let target = recordingsDir;
    if (name !== undefined && name !== null && name !== '') {
      // Only a name this agent would list: never a path from the request.
      if (typeof name !== 'string' || !RECORDING_NAME_RE.test(name)) throw new Refused('not a recording');
      target = join(recordingsDir, name);
    }
    await fs.mkdir(recordingsDir, { recursive: true });
    if (!(await fs.stat(target).then((st) => st.isDirectory()).catch(() => false))) throw new Refused('no such recording');
    try {
      await openPath(target);
    } catch (e) {
      throw new Refused(`could not open a file manager on this machine (${e.message})`);
    }
    return { opened: target };
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
      if (req.method === 'GET' && req.url === '/recordings') return send(200, await listRecordings());
      if (req.method === 'POST' && ['/save', '/record/start', '/record/stop', '/open'].includes(req.url)) {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 65536) return send(413, { error: 'body too large' }); }
        let input;
        try { input = JSON.parse(body || '{}'); } catch { return send(400, { error: 'body is not JSON' }); }
        if (req.url === '/open') return send(200, await openFolder(input.name));
        if (req.url === '/record/stop') return send(200, await stopRecording());
        const streams = Array.isArray(input.streams) ? input.streams.filter((s) => typeof s === 'string' && STREAM_ID_RE.test(s)) : [];
        if (!streams.length) return send(400, { error: 'no streams given' });
        if (req.url === '/save') return send(200, await save({ streams, label: input.label }));
        const bytes = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
        return send(200, await startRecording({ streams, refuseBelowBytes: bytes(input.refuseBelowBytes), stopBelowBytes: bytes(input.stopBelowBytes) }));
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(e instanceof Refused ? 409 : 500, { error: e.message });
    }
  });

  return { server, status, save, startRecording, stopRecording, recover, listRecordings, openFolder };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const port = Number(process.env.VIDEO_AGENT_PORT) || DEFAULT_PORT;
  const agent = createAgent();
  await agent.recover();
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
