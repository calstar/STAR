/** The video pane's view of /api/video/streams. Streams carry no URL or credential. */
import { getApiBaseUrl } from '@/lib/websocket';

export interface VideoStreamInfo {
  id: string;
  label: string;
  kind: 'rtsp';
  hasLowRes: boolean;
  record: boolean;
}

export interface GatewayStatus {
  reachable: boolean;
  error?: string;
  lastSyncAt?: number;
}

export interface VideoStreamsResponse {
  streams: VideoStreamInfo[];
  errors: string[];
  gateway: GatewayStatus;
}

export async function fetchVideoStreams(signal?: AbortSignal): Promise<VideoStreamsResponse> {
  const res = await fetch(`${getApiBaseUrl()}/api/video/streams`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
