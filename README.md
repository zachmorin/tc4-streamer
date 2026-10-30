# dj-stream

A minimal personal live-streaming site. One page to broadcast a DJ set from a
Mac's browser (`/go-live`), one page for everyone else to watch (`/`), black
background, green text, nothing else.

- Browser publishes with **WHIP** (WebRTC) straight to Cloudflare Stream.
- Viewers play with **WHEP** (WebRTC), sub-second latency, works in every
  modern browser including iOS Safari.
- Audio path is DJ grade: no echo cancellation, noise suppression or AGC,
  stereo Opus at 256 kbps constant bitrate, DTX off.
- Static site, zero runtime dependencies (Vite + TypeScript for the build
  only). Deploys to Cloudflare Pages or Vercel.
- The transport lives behind `src/providers/` so the service can be swapped.
  See [`docs/transport.md`](docs/transport.md) for why Cloudflare Stream, what
  it costs, and the LiveKit fallback.

## Layout

```
index.html            viewer page        ->  /
go-live.html          broadcaster page   ->  /go-live
src/viewer.ts         WHEP player, LIVE / OFFLINE polling
src/broadcaster.ts    device pickers, preview, stereo meter, WHIP publish
src/config.ts         constraints, bitrates, env parsing
src/providers/        cloudflare | generic | livekit adapters
src/lib/whip.ts       tiny WHIP/WHEP client (one POST, one DELETE)
src/lib/sdp.ts        Opus stereo/bitrate SDP tuning
src/lib/meter.ts      Web Audio stereo meter + monitor toggle
src/lib/seal.ts       passphrase-sealed secret (AES-GCM in the browser)
scripts/seal.mjs      seal a WHIP URL for the bundle
```

## Setup, step by step

### 0. Prerequisites

- Node 20+ on the machine you build from (`node -v`).
- A Cloudflare account (free to create). Stream needs a payment method; see
  costs in `docs/transport.md`.
- A domain. Easiest if its DNS is on Cloudflare, but not required.

### 1. Create the live input (the thing you stream to)

Dashboard route: Cloudflare dashboard -> **Stream** -> **Live Inputs** ->
**Create live input**. Name it anything ("dj-stream"). Leave recording off if
you do not want VOD copies (WebRTC inputs are not recorded anyway).

Open the new input and copy two URLs:

| Tab | Field | Looks like | Used for |
| --- | --- | --- | --- |
| Broadcast | WebRTC (WHIP) URL | `https://customer-XXXX.cloudflarestream.com/<SECRET>/webRTC/publish` | `/go-live`. **This is your stream key.** |
| Playback | WebRTC (WHEP) URL | `https://customer-XXXX.cloudflarestream.com/<INPUT_UID>/webRTC/play` | `/` viewer page. Public. |

Or with the API:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/stream/live_inputs" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"meta":{"name":"dj-stream"},"recording":{"mode":"off"}}'
# -> result.webRTC.url (WHIP)  and  result.webRTCPlayback.url (WHEP)
```

### 2. Seal the WHIP URL with a passphrase

Everything in a static site is public, so the WHIP URL must not be pasted into
the bundle as-is. Encrypt it with a passphrase; `/go-live` asks for the
passphrase and decrypts in the browser.

```bash
git clone <this repo> && cd dj-stream
npm install
npm run seal -- "https://customer-XXXX.cloudflarestream.com/<SECRET>/webRTC/publish" "a long passphrase you will remember"
# prints one base64 line -> this is VITE_WHIP_SEALED
```

### 3. Set the environment variables

Create `.env` locally (copy `.env.example`) and set the same values in your
host's build settings later:

```
VITE_STREAM_PROVIDER=cloudflare
VITE_SITE_TITLE=ZACH MORIN
VITE_WHEP_URL=https://customer-XXXX.cloudflarestream.com/<INPUT_UID>/webRTC/play
VITE_WHIP_SEALED=<output of npm run seal>
```

Run `npm run dev`, open `http://localhost:5173/go-live`, enter the passphrase,
grant camera and mic, check the meter moves, hit GO LIVE, then open
`http://localhost:5173/` in another tab. If it plays, you are done locally.

### 4. Deploy

Push the repo to GitHub, then pick one:

**Cloudflare Pages** (same account as Stream, simplest)

1. Dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git -> pick the repo.
2. Framework preset: *Vite*. Build command `npm run build`. Output directory `dist`.
3. Settings -> Environment variables -> add the four `VITE_*` variables above (Production).
4. Deploy. `/go-live` works automatically (Pages serves `go-live.html` at `/go-live`).

**Vercel**

1. vercel.com -> Add New Project -> import the repo. Framework: *Vite*.
2. Environment Variables: add the four `VITE_*` values.
3. Deploy. `vercel.json` already sets `cleanUrls` so `/go-live` resolves.

Either way, every change to the env vars needs a redeploy, because they are
compiled into the JS.

### 5. Point the domain

- **Cloudflare Pages**: project -> Custom domains -> Set up a custom domain ->
  enter `live.yourdomain.com` (or the apex). If the zone is on Cloudflare the
  CNAME is added for you; otherwise add `CNAME live -> <project>.pages.dev`
  at your registrar.
- **Vercel**: project -> Settings -> Domains -> add the domain, then create the
  CNAME / A records Vercel shows you.

HTTPS is automatic on both, and HTTPS is required for `getUserMedia`.

### 6. Going live, every time

1. On the Mac, plug in the audio interface or mixer. In **Audio MIDI Setup**
   set it to 48 kHz, 2 channels. If your mixer exposes separate L/R mono
   inputs, make an Aggregate Device so Chrome sees one stereo input.
2. Open `https://yourdomain/go-live` in Chrome (Safari works too). Enter the passphrase.
3. REQUEST DEVICE ACCESS, pick the camera and the interface in the two dropdowns.
4. Check the log says `ec=false ns=false agc=false ch=2`. If `ch=1`, fix the
   device in Audio MIDI Setup; Chrome will not fake stereo.
5. Watch the meter. Peaks around -6 dBFS, never hitting the red CLIP block.
   MONITOR plays the captured audio back locally (headphones only, it has
   latency); use it once to sanity check, then turn it off.
6. GO LIVE. The pill turns LIVE and shows audio/video bitrate and RTT.
7. Send people to `https://yourdomain/`. The page polls every 8 s and flips
   to LIVE on its own.
8. END STREAM when finished. Closing the tab also ends it.

## Security notes

- The WHIP URL is a credential. With `VITE_WHIP_SEALED` the bundle only ever
  contains AES-256-GCM ciphertext (PBKDF2, 310k iterations). Without the
  passphrase nobody can broadcast to your site.
- Rotate by creating a new live input (new secret), re-sealing, redeploying.
- `VITE_WHIP_URL` (plaintext) is for local development only. `/go-live` prints
  a warning if it sees one.
- Nothing is stored server-side. There is no server.

## Swapping the streaming service

Implement `StreamProvider` in `src/providers/<name>.ts`, register it in
`src/providers/index.ts`, set `VITE_STREAM_PROVIDER=<name>`. The pages only
ever call `provider.publish(secret)` and `provider.playback()`. `generic`
works with any WHIP/WHEP server out of the box; `livekit` covers LiveKit
Cloud's WHIP ingress for publishing and documents what the viewer side would
need.

## Scripts

| Command | What |
| --- | --- |
| `npm run dev` | Vite dev server on `http://localhost:5173` |
| `npm run build` | type-check + production build to `dist/` |
| `npm run preview` | serve `dist/` locally |
| `npm run seal -- <secret> <passphrase>` | produce `VITE_WHIP_SEALED` |
