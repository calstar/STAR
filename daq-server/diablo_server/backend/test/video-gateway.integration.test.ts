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
  let bin = '';
  let gatewayLog = '';

  const startGateway = async () => {
    gateway = spawn(bin, [join(DAQ, 'video', 'mediamtx.yml')], {
      cwd: dir,
      env: {
        ...process.env,
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
    await waitFor('gateway API', async () => ((await fetch(`http://127.0.0.1:${ports.api}/v3/paths/list`)).ok ? true : undefined));
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
      streams: [{ id: 'cam1', label: 'Test pattern', kind: 'rtsp', url: `rtsp://127.0.0.1:${ports.rtsp}/fake/cam1`, lowResUrl: `rtsp://127.0.0.1:${ports.rtsp}/fake/cam1`, record: true }],
    }));

    await startGateway();
    startCamera();
    await waitFor('test camera', async () => {
      const r = await fetch(`http://127.0.0.1:${ports.api}/v3/paths/get/fake/cam1`);
      return r.ok && (await r.json()).ready ? true : undefined;
    });

    const { VideoService } = await import('../src/video/service.js');
    const { handleVideoRequest } = await import('../src/video/routes.js');
    svc = new VideoService({ apiUrl: `http://127.0.0.1:${ports.api}`, webrtcUrl: `http://127.0.0.1:${ports.webrtc}` });

    // The backend, plus a page on the same origin to run the browser's side.
    backend = http.createServer(async (req, res) => {
      const path = new URL(req.url!, 'http://x').pathname;
      if (await handleVideoRequest(req, res, path, svc)) return;
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
});
