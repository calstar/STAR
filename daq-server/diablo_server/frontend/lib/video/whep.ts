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

export type WhepState =
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'failed'; reason: string };

const GATHER_TIMEOUT_MS = 2000;

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

/**
 * Play `streamId` into `video`. Returns a stop function; `onState` reports progress.
 * One attempt: the caller decides when to retry.
 */
export function playWhep(streamId: string, video: HTMLVideoElement, onState: (s: WhepState) => void): () => void {
  const base = getApiBaseUrl();
  const pc = buildOfferPeer();
  let sessionUrl: string | null = null;
  let stopped = false;

  const fail = (reason: string) => {
    if (!stopped) onState({ kind: 'failed', reason });
  };

  pc.ontrack = (e) => {
    if (e.track.kind !== 'video') return;
    video.srcObject = new MediaStream([e.track]);
    void video.play().catch(() => { /* muted autoplay is allowed; a blocked play retries on next frame */ });
  };
  pc.onconnectionstatechange = () => {
    if (stopped) return;
    if (pc.connectionState === 'connected') onState({ kind: 'live' });
    else if (pc.connectionState === 'failed') fail('no media path to the gateway (are you on the stand network?)');
    else if (pc.connectionState === 'disconnected') fail('connection lost');
  };

  onState({ kind: 'connecting' });
  void (async () => {
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gatheringComplete(pc);
      if (stopped) return;
      const res = await fetch(`${base}/api/video/streams/${encodeURIComponent(streamId)}/whep`, {
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
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  })();

  return () => {
    stopped = true;
    pc.close();
    video.srcObject = null;
    if (sessionUrl) void fetch(sessionUrl, { method: 'DELETE' }).catch(() => {});
  };
}
