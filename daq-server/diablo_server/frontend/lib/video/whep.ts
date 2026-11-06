/**
 * WHEP playback of one gateway stream, through the backend's /api/video proxy.
 *
 * The offer carries a single *video* transceiver and nothing else. That is how camera audio
 * is stripped from the live view: the gateway can only send what the offer negotiated, so
 * there is no audio m-line for it to use, and nothing is inserted in the video path to do
 * the stripping. Do not add an audio transceiver here (VIDCOMM decision: no camera sound).
 *
 * Non-trickle: on the LAN the host candidates are gathered in a few milliseconds, so the
 * offer waits for gathering to finish and is sent whole -- one POST, no PATCH round-trips.
 */
import { getApiBaseUrl } from '@/lib/websocket';

/**
 * `live` here means the WebRTC connection is up; whether frames are arriving is the tile's
 * business (lib/video/tile-state). A failure says where: `gateway` -- the handshake was
 * refused, so ask the camera why (GET .../check); `network` -- the handshake worked but no
 * media path did, which is what a browser off the stand LAN sees.
 */
export type WhepState =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'failed'; reason: string; where: 'gateway' | 'network' };

const GATHER_TIMEOUT_MS = 2000;
/** On the LAN media connects in well under a second; the browser's own ICE failure takes ~30 s. */
const MEDIA_TIMEOUT_MS = 8000;
export const OFF_LAN_REASON = 'video is only available on the stand network';

function gatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    // A host with a dead interface can stall gathering; the candidates found so far are enough.
    setTimeout(resolve, GATHER_TIMEOUT_MS);
  });
}

export function buildOfferPeer(): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  return pc;
}

/** WHEP endpoints the backend proxies: a saved stream, or an editor's preview. */
export const streamEndpoint = (id: string, low = false) => `/api/video/streams/${encodeURIComponent(id)}${low ? '/low' : ''}`;
export const previewEndpoint = (id: string) => `/api/video/previews/${encodeURIComponent(id)}`;

/**
 * Play the stream at `endpoint` (streamEndpoint / previewEndpoint) into `video`. Returns a
 * stop function; `onState` reports progress. One attempt: the caller decides when to retry.
 */
export function playWhep(endpoint: string, video: HTMLVideoElement, onState: (s: WhepState) => void): () => void {
  const base = getApiBaseUrl();
  const pc = buildOfferPeer();
  let sessionUrl: string | null = null;
  let stopped = false;

  let mediaTimer: ReturnType<typeof setTimeout> | undefined;
  const fail = (reason: string, where: 'gateway' | 'network' = 'gateway') => {
    clearTimeout(mediaTimer);
    if (!stopped) onState({ kind: 'failed', reason, where });
    stopped = true; // one report per attempt; the caller retries with a fresh peer
  };

  pc.ontrack = (e) => {
    if (e.track.kind !== 'video') return;
    video.srcObject = new MediaStream([e.track]);
    void video.play().catch(() => { /* muted autoplay is allowed; a blocked play retries on next frame */ });
  };
  pc.onconnectionstatechange = () => {
    if (stopped) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(mediaTimer);
      onState({ kind: 'live' });
    } else if (pc.connectionState === 'failed') fail(OFF_LAN_REASON, 'network');
    else if (pc.connectionState === 'disconnected') fail('connection to the gateway lost', 'network');
  };

  onState({ kind: 'connecting' });
  void (async () => {
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gatheringComplete(pc);
      if (stopped) return;
      const res = await fetch(`${base}${endpoint}/whep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription?.sdp ?? '',
      });
      if (res.status !== 201) {
        let reason = `HTTP ${res.status}`;
        try { reason = (await res.json()).error ?? reason; } catch { /* not JSON */ }
        fail(reason);
        return;
      }
      const loc = res.headers.get('Location');
      if (loc) sessionUrl = `${base}${loc}`;
      const answer = await res.text();
      if (stopped) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      mediaTimer = setTimeout(() => { if (pc.connectionState !== 'connected') fail(OFF_LAN_REASON, 'network'); }, MEDIA_TIMEOUT_MS);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  })();

  return () => {
    stopped = true;
    clearTimeout(mediaTimer);
    pc.close();
    video.srcObject = null;
    if (sessionUrl) void fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
  };
}
