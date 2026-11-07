# Video (VIDCOMM)

The DAQ GUI's **Video** view shows every camera and the HiDes link live, records them, and
feeds OBS. This folder is the gateway side: `mediamtx.yml` (MediaMTX's config) and
`agent.mjs` (the video agent that keeps recordings). The DAQ backend's half is
`diablo_server/backend/src/video/`, the page is `diablo_server/frontend/app/video/`.

```
cameras ──RTSP pull──┐                                  ┌─ WebRTC (UDP 8189) ─▶ Video view, any LAN browser
                     ├─▶ MediaMTX + video agent ────────┤
HiDes Viewer ─UDP────┘   (the gateway machine)          └─ RTSP (8554, user obs) ─▶ OBS
        ▲                     ▲
        │                     └── DAQ backend: stream list, WHEP proxy, Save/Record (API 8887, agent 8886)
   UT-130 receiver
```

## Where it runs

| | DAQ backend | Gateway (+ agent) | Recordings |
|---|---|---|---|
| Workspace | `star-rfs` | `star-rfs`, `sensor-video` (starts with the stack) | `star-rfs:daq-server/video/recordings/` |
| Desert | someone's laptop | the media Mac: `scripts/media-laptop.sh` | the media Mac |

On the DAQ laptop in the desert: **Video > Edit > Gateway** = the media Mac's `.local` name
(the script prints it) and the gateway password. That setting is per machine and never
committed.

## Sources

- **Camera (RTSP)**: the gateway pulls it. Main URL, optional low-res URL (small tiles play
  it; the large slot and focus play main), username, password (write-only).
- **HiDes link (UDP)**: HiDes Viewer's *Send to UDP*, MPEG-TS, to `localhost:5600` on the
  gateway machine (or `<gateway>.local:5600` from elsewhere). Ports 5600-5609, clear of the
  DAQ's own UDP. An existing HiDes Viewer install may still remember `127.0.0.1:5000`: change it.

Camera audio never reaches the Video view (it asks for video only) or recordings (the agent
drops it). OBS does get it: mute it there, or turn audio off on the cameras.

## What a tile says

**LIVE** (green) while frames arrive, **STALE** (amber) when the picture has frozen, and
otherwise **NO SIGNAL** with one code:

| Code | Means |
|---|---|
| `UNREACH` | no answer from the camera's address (unplugged, wrong IP, other network) |
| `REFUSED` | the camera answered but nothing listens on that port |
| `AUTH` | username/password rejected, or the camera wants one and none is set |
| `PATH` | the camera has no stream at that URL path |
| `NO DATA` | nothing arriving on the HiDes UDP port |
| `NET` | no media path to this browser (off the stand network) |
| `GW` | the camera answers, but the gateway has no video from it |
| `ERR` | anything else |

Each stream can also be set to **Zoom to fill** (Edit): its tiles fill the slot and crop what
overhangs, for cameras whose shape wastes the slot. Off by default: letterboxing never crops.

## Files and passwords

| File | Tracked | What |
|---|---|---|
| `config/video.json` | yes | streams, labels, URLs, layout, disk guard (`recording.refuseBelowGB` 20, `stopBelowGB` 5) |
| `config/video.secrets.json` | no | camera credentials; this machine's gateway host and password |
| `video/gateway.password` | no | set with `scripts/video-gateway.sh --set-password`; lets a remote DAQ backend in |
| `video/obs.password` | no | set with `--set-obs-password`; read-only RTSP for OBS |

## Recording

- Streams marked **include in recording** are buffered continuously (10 s segments, 5 min).
- **Save last 5 min** keeps the buffer. **Record** keeps from the press until **Stop**.
- Output: `video/recordings/<time>_save|record/<stream>.mp4`, video only, no re-encode. The
  **Recordings** view (`/recordings`) lists them and opens a folder in the gateway machine's
  file manager (Finder; xdg-open on Linux) -- useful when you are at that machine. The
  note after a save names gaps (gateway or camera down) and streams that were missing.
- The disk guard runs on the gateway machine: Record is refused below 20 GB free, and stops
  cleanly at 5 GB. A recording interrupted by a restart is finished when the gateway starts.

Storage: about 37.5 MB per Mbit/s per 5 minutes per stream. Four 1080p cameras at 4 Mbit/s:
~650 MB of buffer, ~7 GB per hour of recording. The Recording controls panel shows disk left
at the current rate.

## OBS

One **Media Source** per stream: Edit shows each URL (`rtsp://<gateway>:8554/raw/<id>`, user
`obs`). For low latency: network buffering 0, hardware decoding on, RTSP over TCP. A VLC
source needs its network caching lowered from 1000 ms to about 200.

## Ports

| Port | What | Open to the LAN |
|---|---|---|
| 8189/udp | WebRTC media to browsers | yes |
| 8554/tcp | RTSP (OBS, user obs) | yes |
| 5600-5609/udp | pushed MPEG-TS (HiDes) | yes |
| 8887/tcp | MediaMTX API (user daq) | only for a remote DAQ backend |
| 8886/tcp | video agent (user daq) | only for a remote DAQ backend |
| 8889/tcp | WHEP (the backend proxies it) | only for a remote DAQ backend |

## Testing

```bash
cd diablo_server/backend && npm test                 # unit tests (fakes)
cd diablo_server/backend && npm run test:video-gateway  # the real MediaMTX + ffmpeg + Chromium
cd diablo_server/frontend && npm test
```

Not yet checked on hardware: real cameras, the UT-130 end to end through the gateway, OBS,
and latency (`live-video`'s `hides-latency` can measure it). Do a bench check before the
first desert trip.
