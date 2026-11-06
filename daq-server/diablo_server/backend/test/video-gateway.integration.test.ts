/**
 * The video backend against the REAL gateway: the pinned MediaMTX with the repo's
 * daq-server/video/mediamtx.yml, an ffmpeg test-pattern "camera" that also sends G.711
 * audio (a codec WebRTC could carry, so dropping it is a choice, not an accident), and a
 * real Chromium doing WHEP through the backend's proxy.
 *
 * Proves what the fakes in src/__tests__/video.test.ts cannot:
 *   - reconcile's API calls are the ones this MediaMTX version accepts;
 *   - the proxied handshake yields decoded video in a browser;
 *   - the pane's video-only offer gets no audio, while an offer that asks for audio does
 *     (the control case: without it, "no audio" could just mean the camera had none);
 *   - a gateway that restarts is refilled by the next sync.
 *
 * Hermetic (no stand hardware) but needs the gateway binary, ffmpeg and Chromium, so it
 * runs only with VIDEO_GATEWAY_IT=1 -- and then *fails*, rather than skips, if one is missing:
 *   VIDEO_GATEWAY_IT=1 npx vitest run test/video-gateway.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as http from 'http';
import * as net from 'net';

const ENABLED = process.env.VIDEO_GATEWAY_IT === '1';
const HIDES_PORT = 5607;
const here = dirname(fileURLToPath(import.meta.url));
const DAQ = resolve(here, '..', '..', '..');

const dir = mkdtempSync(join(tmpdir(), 'daq-video-it-'));
process.env.VIDEO_CONFIG_PATH = join(dir, 'video.json');
process.env.VIDEO_SECRETS_PATH = join(dir, 'video.secrets.json');

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ''}`);
}

describe.skipIf(!ENABLED)('video gateway (real MediaMTX)', () => {
  let ports: { api: number; rtsp: number; webrtc: number; udp: number; backend: number };
  let gateway: ChildProcess | undefined;
  let camera: ChildProcess | undefined;
  let backend: http.Server;
  let svc: InstanceType<typeof import('../src/video/service.js').VideoService>;
  /** The service the test backend answers with (swapped for the password case). */
  let active: typeof svc;
  let bin = '';
  let gatewayLog = '';

  const startGateway = async (extraEnv: Record<string, string> = {}) => {
    gateway = spawn(bin, [join(DAQ, 'video', 'mediamtx.yml')], {
      cwd: dir,
      env: {
        ...process.env,
        ...extraEnv,
        MTX_APIADDRESS: `127.0.0.1:${ports.api}`,
        MTX_RTSPADDRESS: `127.0.0.1:${ports.rtsp}`,
        MTX_WEBRTCADDRESS: `127.0.0.1:${ports.webrtc}`,
        MTX_WEBRTCLOCALUDPADDRESS: `127.0.0.1:${ports.udp}`,
        // Only loopback candidates: CI runners have odd interfaces, and so does a laptop on VPN.
        MTX_WEBRTCIPSFROMINTERFACES: 'no',
        MTX_WEBRTCADDITIONALHOSTS: '127.0.0.1',
      },
    });
    gateway.stdout?.on('data', (d) => (gatewayLog += d));
    gateway.stderr?.on('data', (d) => (gatewayLog += d));
    // Any answer (401 included) means it is up.
    await waitFor('gateway API', async () => ((await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`)).status ? true : undefined))
      .catch((e) => { throw new Error(`${(e as Error).message}\n--- gateway log ---\n${gatewayLog.slice(-3000)}`); });
  };

  const startCamera = () => {
    camera = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:${ports.rtsp}/fake/cam1`,
    ], { stdio: 'ignore' });
  };

  const stopGateway = async () => {
    if (!gateway) return;
    const g = gateway;
    gateway = undefined;
    await new Promise<void>((r) => { g.once('exit', () => r()); g.kill('SIGTERM'); });
  };

  beforeAll(async () => {
    bin = execFileSync(join(DAQ, 'scripts', 'video-gateway.sh'), ['--print-bin'], { encoding: 'utf8' }).trim().split('\n').pop()!;
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); // fail loudly if missing
    ports = { api: await freePort(), rtsp: await freePort(), webrtc: await freePort(), udp: await freePort(), backend: await freePort() };

    writeFileSync(process.env.VIDEO_CONFIG_PATH!, JSON.stringify({
      version: 1,
      // The low-res URL is the same camera here; what matters is that raw/cam1/low is its own path.
      streams: [
        { id: 'cam1', label: 'Test pattern', kind: 'rtsp', url: `rtsp://127.0.0.1:${ports.rtsp}/fake/cam1`, lowResUrl: `rtsp://127.0.0.1:${ports.rtsp}/fake/cam1`, record: true },
        // The HiDes link: MPEG-TS pushed over UDP (a port in the video range, 5600-5609).
        { id: 'hides', label: 'HiDes', kind: 'udp', port: HIDES_PORT, record: true },
      ],
    }));

    await startGateway();
    startCamera();
    await waitFor('test camera', async () => {
      const r = await fetch(`http://127.0.0.1:${ports.api}/v3/paths/get/fake/cam1`);
      return r.ok && (await r.json()).ready ? true : undefined;
    });

    const { VideoService } = await import('../src/video/service.js');
    const { handleVideoRequest } = await import('../src/video/routes.js');
    svc = new VideoService({ apiUrl: `http://127.0.0.1:${ports.api}`, webrtcUrl: `http://127.0.0.1:${ports.webrtc}`, host: '127.0.0.1' });
    active = svc;

    // The backend, plus a page on the same origin to run the browser's side.
    backend = http.createServer(async (req, res) => {
      const path = new URL(req.url!, 'http://x').pathname;
      if (await handleVideoRequest(req, res, path, active)) return;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>probe</title>');
    });
    await new Promise<void>((r) => backend.listen(ports.backend, '127.0.0.1', r));
  }, 120_000);

  afterAll(async () => {
    camera?.kill('SIGKILL');
    await stopGateway();
    backend?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconcile pushes the stream onto the gateway, idempotently', async () => {
    await svc.sync();
    expect(svc.gatewayStatus()).toMatchObject({ reachable: true });
    const conf = await (await fetch(`http://127.0.0.1:${ports.api}/v3/config/paths/get/raw/cam1`)).json();
    expect(conf.source).toBe(`rtsp://127.0.0.1:${ports.rtsp}/fake/cam1`);
    const { reconcile, desiredPaths, HttpGatewayApi } = await import('../src/video/gateway.js');
    expect(await reconcile(new HttpGatewayApi(`http://127.0.0.1:${ports.api}`), desiredPaths(svc.current())))
      .toEqual({ added: [], replaced: [], deleted: [] });
  });

  it('a browser gets video and no audio through the proxy; asking for audio would get it', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${ports.backend}/`);
      const probe = (withAudio: boolean, route = '/api/video/streams/cam1/whep') => page.evaluate(async ([withAudio, route]) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTransceiver('video', { direction: 'recvonly' });
        if (withAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
        const v = document.createElement('video');
        v.muted = true; v.autoplay = true; document.body.append(v);
        pc.ontrack = (e) => { if (e.track.kind === 'video') v.srcObject = new MediaStream([e.track]); };
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>((r) => {
          if (pc.iceGatheringState === 'complete') return r();
          pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); };
          setTimeout(r, 2000);
        });
        const res = await fetch(route as string, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription!.sdp });
        const answer = await res.text();
        if (res.status !== 201) return { status: res.status, answer, frames: 0, audioPackets: 0, mlines: [] as string[], location: null };
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        let frames = 0;
        const tick = () => { frames++; (v as any).requestVideoFrameCallback(tick); };
        (v as any).requestVideoFrameCallback(tick);
        await new Promise((r) => setTimeout(r, 3000));
        let audioPackets = 0;
        (await pc.getStats()).forEach((s: any) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') audioPackets += s.packetsReceived; });
        const location = res.headers.get('Location');
        pc.close(); v.remove();
        if (location) await fetch(location, { method: 'DELETE' });
        return { status: res.status, frames, audioPackets, mlines: answer.split(/\r?\n/).filter((l) => l.startsWith('m=')).map((l) => l.split(' ')[0]), location };
      }, [withAudio, route] as const);

      const pane = await probe(false);
      expect(pane.status, gatewayLog.slice(-2000)).toBe(201);
      expect(pane.location).toMatch(/^\/api\/video\/streams\/cam1\/whep\/[0-9a-f-]+$/);
      expect(pane.mlines).toEqual(['m=video']);
      expect(pane.frames).toBeGreaterThan(10);
      expect(pane.audioPackets).toBe(0);

      const control = await probe(true);
      expect(control.mlines).toEqual(['m=video', 'm=audio']);
      expect(control.audioPackets).toBeGreaterThan(0);

      // The low-res path: its own gateway path (raw/cam1/low), same proxy, same video-only rule.
      const low = await probe(false, '/api/video/streams/cam1/low/whep');
      expect(low.status, gatewayLog.slice(-2000)).toBe(201);
      expect(low.location).toMatch(/^\/api\/video\/streams\/cam1\/low\/whep\/[0-9a-f-]+$/);
      expect(low.frames).toBeGreaterThan(10);
      expect(low.audioPackets).toBe(0);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('a HiDes-style UDP push plays as video only, and its check sees it arriving', async () => {
    const { chromium } = await import('playwright-core');
    expect(await svc.checkStream('hides')).toMatchObject({ ok: false, detail: expect.stringMatching(/nothing arriving on UDP 5607/) });
    // As HiDesViewer forwards the UT-130's TS: H.264 plus audio (Opus, which WebRTC could carry).
    const sender = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-re',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'libopus', '-f', 'mpegts', `udp://127.0.0.1:${HIDES_PORT}?pkt_size=1316`,
    ], { stdio: 'ignore' });
    const browser = await chromium.launch();
    try {
      // The check is cached for 5 s, so this can take one cache period to flip.
      await waitFor('TS arriving on the HiDes path', async () => ((await svc.checkStream('hides'))!.ok ? true : undefined), 20000);
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${ports.backend}/`);
      const probe = (withAudio: boolean) => page.evaluate(async (withAudio) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTransceiver('video', { direction: 'recvonly' });
        if (withAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
        const v = document.createElement('video'); v.muted = true; v.autoplay = true; document.body.append(v);
        pc.ontrack = (e) => { if (e.track.kind === 'video') v.srcObject = new MediaStream([e.track]); };
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((r) => setTimeout(r, 500));
        const res = await fetch('/api/video/streams/hides/whep', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription!.sdp });
        const answer = await res.text();
        if (res.status !== 201) return { status: res.status, answer, frames: 0, audioPackets: 0, mlines: [] as string[] };
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        let frames = 0;
        const tick = () => { frames++; (v as any).requestVideoFrameCallback(tick); };
        (v as any).requestVideoFrameCallback(tick);
        await new Promise((r) => setTimeout(r, 3000));
        let audioPackets = 0;
        (await pc.getStats()).forEach((s: any) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') audioPackets += s.packetsReceived; });
        const loc = res.headers.get('Location');
        pc.close(); v.remove();
        if (loc) await fetch(loc, { method: 'DELETE' });
        return { status: res.status, frames, audioPackets, mlines: answer.split(/\r?\n/).filter((l) => l.startsWith('m=')).map((l) => l.split(' ')[0]) };
      }, withAudio);
      const pane = await probe(false);
      expect(pane.status, gatewayLog.slice(-2000)).toBe(201);
      expect(pane.mlines).toEqual(['m=video']);
      expect(pane.frames).toBeGreaterThan(10);
      expect(pane.audioPackets).toBe(0);
      const control = await probe(true);
      expect(control.mlines).toEqual(['m=video', 'm=audio']);
      expect(control.audioPackets).toBeGreaterThan(0);
    } finally {
      sender.kill('SIGKILL');
      await browser.close();
    }
  }, 90_000);

  it('a gateway that restarts empty is refilled by the next sync', async () => {
    camera?.kill('SIGKILL');
    await stopGateway();
    await svc.sync();
    expect(svc.gatewayStatus().reachable).toBe(false);
    await startGateway();
    expect((await fetch(`http://127.0.0.1:${ports.api}/v3/config/paths/get/raw/cam1`)).status).toBe(404);
    await svc.sync();
    expect(svc.gatewayStatus().reachable).toBe(true);
    expect((await fetch(`http://127.0.0.1:${ports.api}/v3/config/paths/get/raw/cam1`)).status).toBe(200);
  }, 60_000);

  it('a gateway that only admits the password: the backend gets in with it, and not without', async () => {
    // As the media Mac in the desert: the launcher's user "daq", and this machine no longer
    // trusted (so loopback cannot stand in for the password).
    camera?.kill('SIGKILL');
    await stopGateway();
    await startGateway({
      MTX_AUTHINTERNALUSERS_0_IPS: '192.0.2.1/32',
      MTX_AUTHINTERNALUSERS_1_USER: 'daq',
      MTX_AUTHINTERNALUSERS_1_PASS: 'gw-pass',
      MTX_AUTHINTERNALUSERS_1_IPS: '',
      MTX_AUTHINTERNALUSERS_1_PERMISSIONS_0_ACTION: 'api',
      MTX_AUTHINTERNALUSERS_1_PERMISSIONS_1_ACTION: 'read',
      // The test camera publishes as user daq too, now that loopback is not trusted.
      MTX_AUTHINTERNALUSERS_1_PERMISSIONS_2_ACTION: 'publish',
      // OBS on a streaming laptop: RTSP reads only (scripts/video-gateway.sh --set-obs-password).
      MTX_AUTHINTERNALUSERS_2_USER: 'obs',
      MTX_AUTHINTERNALUSERS_2_PASS: 'obs-pass',
      MTX_AUTHINTERNALUSERS_2_IPS: '',
      MTX_AUTHINTERNALUSERS_2_PERMISSIONS_0_ACTION: 'read',
    });
    const { VideoService } = await import('../src/video/service.js');
    const { gatewayEndpoint } = await import('../src/video/gateway.js');
    const env = { VIDEO_GATEWAY_HOST: '127.0.0.1', VIDEO_GATEWAY_API_PORT: String(ports.api), VIDEO_GATEWAY_WEBRTC_PORT: String(ports.webrtc) };

    const wrong = new VideoService(gatewayEndpoint({ password: 'nope' }, env));
    await wrong.sync();
    expect(wrong.gatewayStatus(), JSON.stringify(wrong.gatewayStatus())).toMatchObject({ reachable: false, error: expect.stringMatching(/refused the password/) });

    const right = new VideoService(gatewayEndpoint({ password: 'gw-pass' }, env));
    await right.sync();
    expect(right.gatewayStatus().reachable).toBe(true);

    camera = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-pix_fmt', 'yuv420p',
      '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://daq:gw-pass@127.0.0.1:${ports.rtsp}/fake/cam1`,
    ], { stdio: 'ignore' });

    // The stream's own pull needs the password now too: give the camera URL's credentials.
    writeFileSync(process.env.VIDEO_SECRETS_PATH!, JSON.stringify({ streams: { cam1: { username: 'daq', password: 'gw-pass' } } }));
    await right.sync();

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${ports.backend}/`);
      const whep = () => page.evaluate(async () => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTransceiver('video', { direction: 'recvonly' });
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((r) => setTimeout(r, 500));
        const res = await fetch('/api/video/streams/cam1/whep', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription!.sdp });
        const loc = res.headers.get('Location');
        pc.close();
        if (loc) await fetch(loc, { method: 'DELETE' });
        return res.status;
      });
      active = wrong;
      expect(await whep()).not.toBe(201);
      active = right;
      expect(await waitFor('WHEP with the password', async () => ((await whep()) === 201 ? 201 : undefined))).toBe(201);

      // OBS: reads the same path over RTSP with its own read-only password, and nothing more.
      const rtsp = `127.0.0.1:${ports.rtsp}/raw/cam1`;
      const probe = (url: string) => {
        try {
          return execFileSync('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', url], { encoding: 'utf8', timeout: 15000 }).trim();
        } catch (e) {
          return `failed: ${String((e as any).stderr ?? e).trim().split('\n')[0]}`;
        }
      };
      expect(probe(`rtsp://obs:obs-pass@${rtsp}`)).toMatch(/^video/);
      expect(probe(`rtsp://${rtsp}`)).toMatch(/401/);
      expect(probe(`rtsp://obs:wrong@${rtsp}`)).toMatch(/401/);
      const obsApi = await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`, { headers: { Authorization: `Basic ${Buffer.from('obs:obs-pass').toString('base64')}` } });
      expect(obsApi.status).toBe(401);
    } finally {
      active = svc;
      await browser.close();
    }
  }, 90_000);
});
