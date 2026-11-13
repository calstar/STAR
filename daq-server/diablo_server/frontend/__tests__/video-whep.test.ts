/**
 * The live view strips camera audio by asking for video only (lib/video/whep.ts). If an
 * audio transceiver ever creeps into the offer, the gateway will happily send camera sound
 * -- test/video-gateway.integration.test.ts in the backend shows it does -- so this pins
 * the offer's shape.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildOfferPeer, playWhep, streamEndpoint, previewEndpoint } from '@/lib/video/whep';

class FakePeer {
  static last: FakePeer;
  transceivers: { kind: string; init?: RTCRtpTransceiverInit }[] = [];
  iceGatheringState = 'complete';
  connectionState = 'new';
  localDescription: { sdp: string } | null = null;
  ontrack: ((e: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  constructor(public config?: RTCConfiguration) { FakePeer.last = this; }
  addTransceiver(kind: string, init?: RTCRtpTransceiverInit) { this.transceivers.push({ kind, init }); }
  async createOffer() { return { type: 'offer', sdp: `v=0 ${this.transceivers.map((t) => `m=${t.kind}`).join(' ')}` }; }
  async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
  async setRemoteDescription() {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; }
}

afterEach(() => vi.unstubAllGlobals());

describe('WHEP offer', () => {
  it('asks for exactly one receive-only video track and no audio', () => {
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    buildOfferPeer();
    expect(FakePeer.last.transceivers).toEqual([{ kind: 'video', init: { direction: 'recvonly' } }]);
  });

  it('posts the offer to the backend proxy and deletes the session on stop', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response('v=0 answer', { status: 201, headers: { Location: '/api/video/streams/pad/whep/abc-123' } });
      }
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const states: string[] = [];
    const stop = playWhep(streamEndpoint('pad'), document.createElement('video'), (s) => states.push(s.kind));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/video\/streams\/pad\/whep$/);
    expect(init?.body).toBe('v=0 m=video');
    await new Promise((r) => setTimeout(r, 0));
    stop();
    expect(FakePeer.last.closed).toBe(true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/video\/streams\/pad\/whep\/abc-123$/);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    expect(states[0]).toBe('connecting');
  });

  it('reports a gateway refusal as GW, never the gateway\'s own words', async () => {
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'gateway: no stream is available' }), { status: 404 })));
    const states: any[] = [];
    playWhep(previewEndpoint('0a1b2c3d4e5f'), document.createElement('video'), (s) => states.push(s));
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ kind: 'failed', code: 'GW', where: 'gateway' }));
  });
});

describe('off the stand network', () => {
  it('a handshake that works but media that never connects says so, without waiting for ICE', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('RTCPeerConnection', FakePeer);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('v=0 answer', { status: 201, headers: { Location: '/api/video/streams/pad/whep/s1' } })));
      const states: any[] = [];
      playWhep(streamEndpoint('pad'), document.createElement('video'), (s) => states.push(s));
      await vi.advanceTimersByTimeAsync(7000);
      expect(states.at(-1)).toEqual({ kind: 'connecting' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(states.at(-1)).toEqual({ kind: 'failed', code: 'NET', where: 'network' });
    } finally {
      vi.useRealTimers();
    }
  });
});
