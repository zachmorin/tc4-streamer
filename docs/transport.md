# Transport choice: Cloudflare Stream Live Inputs (WHIP in, WHEP out)

## Why

The goal is "browser on a Mac -> custom domain, with as little to run as
possible". That rules out anything needing an always-on server of our own
(nginx-rtmp, MediaMTX, SRS) and anything needing OBS as a middle step.

Cloudflare Stream Live Inputs fit because:

1. **Browser-native ingest.** Each live input exposes a WHIP URL. The
   broadcaster page POSTs one SDP offer and is streaming. No signaling server,
   no SDK, no OBS. WebRTC on Stream went GA on 2026-10-15.
2. **Browser-native playback.** The same input exposes a WHEP URL. The viewer
   page POSTs one SDP offer and receives the media with <500 ms latency.
   No hls.js, no player library. Works in Chrome, Firefox, Safari, iOS.
3. **One account for everything.** Stream, Pages (hosting), DNS and TLS all
   sit in the same Cloudflare dashboard. Fewer logins, one bill.
4. **Audio passes through.** WHIP/WHEP on Stream relays the Opus stream the
   browser encodes; our SDP tuning (stereo, 256 kbps CBR, no DTX) survives to
   the viewer rather than being re-encoded to a speech preset.
5. **Cheap at this scale** (below).

Caveats to know about:

- WHIP inputs on Stream **cannot be recorded and cannot be played via HLS**
  today. Viewers must use WHEP (which is what the site does). If a VOD copy or
  HLS fallback becomes a must-have, the OBS -> RTMPS path to the same live
  input gets both, at the cost of running OBS.
- No live viewer count from Cloudflare for WebRTC inputs.
- Cloudflare's "signed URLs" feature can gate playback later if the stream
  should be private; not wired in v1.

## What Zach must create

| Item | Where | Needed by |
| --- | --- | --- |
| Cloudflare account with Stream enabled | dash.cloudflare.com -> Stream | everything |
| One **Live Input** | Stream -> Live Inputs -> Create | gives the two URLs below |
| **WHIP URL** (`.../<SECRET>/webRTC/publish`) | live input -> Broadcast tab | `/go-live`, sealed into `VITE_WHIP_SEALED` with a passphrase of his choosing |
| **WHEP URL** (`.../<INPUT_UID>/webRTC/play`) | live input -> Playback tab | `/` viewer, `VITE_WHEP_URL` |
| Hosting project | Cloudflare Pages (or Vercel) connected to the GitHub repo | serving the static site |
| Domain / DNS record | Cloudflare DNS (or registrar) CNAME to the Pages project | custom domain |
| Optional: API token with `Stream:Edit` | My Profile -> API Tokens | only if he scripts live-input creation |

No OAuth apps, no server secrets, no database.

## Cost (Cloudflare list prices, checked 2026-10)

Stream bills on two meters only. Ingest and encoding are free.

- **Storage**: $5 per 1,000 minutes per month, prepaid. The minimum Stream
  subscription is therefore **$5/month**. WebRTC inputs are not recorded, so
  this site consumes essentially none of it.
- **Delivery**: $1 per 1,000 viewer-minutes, including WHEP playback.

Worked examples:

| Scenario | Viewer-minutes | Delivery cost |
| --- | --- | --- |
| 2 h set, 20 viewers the whole time | 2,400 | $2.40 |
| 2 h set, 100 viewers | 12,000 | $12.00 |
| 4 sets a month at 50 viewers, 2 h each | 24,000 | $24.00 |

So realistically **$5 to $30 per month**. Cloudflare Pages hosting is free
for this traffic. A domain is whatever the registrar charges.

## How the stream flows

```
 Mac (Chrome)                       Cloudflare edge                     Viewers
 ------------                       ---------------                     -------
 getUserMedia(camera, interface)
   | raw stereo PCM, no DSP
   v
 RTCPeerConnection
   Opus 48k stereo 256k CBR
   VP8/H264 <= 3.5 Mbps
   |  POST offer (WHIP) ---------->  Live Input  /<SECRET>/webRTC/publish
   |  <---------- SDP answer        (SFU, relays packets, no transcode)
   |  SRTP ====================>     |
                                     |  <------- POST offer (WHEP) ----  index.html on
                                     |  -------- SDP answer --------->   yourdomain
                                     |  =========== SRTP ============>   <video> element
```

The viewer page probes the WHEP URL every 8 s while offline (a 404 means no
publisher), flips to LIVE when media arrives, and drops back to OFFLINE when
the connection closes.

## Fallback: LiveKit Cloud

If Cloudflare ever becomes unsuitable, LiveKit Cloud is the next-simplest
managed option:

- Publish: LiveKit **WHIP ingress** (`https://<project>.whip.livekit.cloud/w`
  + stream key as Bearer token). The `livekit` provider adapter already does
  this.
- Playback: LiveKit has no WHEP endpoint. The viewer would use either the
  `livekit-client` SDK joining the room as a subscriber (adds ~100 kB dep and
  needs a token endpoint, i.e. a tiny Worker), or an **HLS egress** played
  with hls.js (adds 5 to 15 s latency).
- Cost (checked 2026-10): Build plan $0 with a hard cap of 50 GB downstream
  per month (about 60 viewer-hours at 2 Mbps, then it stops serving); Ship
  plan $50/month with 250 GB included, then $0.12/GB. WHIP ingress without
  transcoding is free. Bandwidth-based, so harder to predict than
  Cloudflare's per-minute meter.

Switching = write the viewer adapter, set `VITE_STREAM_PROVIDER=livekit`,
change three env vars.

## Alternatives considered and rejected

- **Mux / IVS / Wowza / Dolby.io**: all need RTMP (so OBS) or an SDK, and
  cost more.
- **Self-hosted MediaMTX / Broadcast Box**: the `generic` adapter supports
  them, but they need a VM with a public IP and TLS, which is the ops burden
  the brief wants to avoid.
- **YouTube / Twitch embed**: not "his own site", imposes ads and audio
  normalization.
