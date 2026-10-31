export const SITE_TITLE = (import.meta.env.VITE_SITE_TITLE ?? "SHRIMPIE LIVE FROM TAU CETI IV").trim();

/** How the broadcaster page obtains the publish secret. */
export type SecretSource =
  | { mode: "sealed"; sealed: string }
  | { mode: "plain"; secret: string }
  | { mode: "paste" };

export function secretSource(providerId: string): SecretSource {
  const env = import.meta.env;
  if (providerId === "livekit") {
    const sealed = (env.VITE_LIVEKIT_STREAM_KEY_SEALED ?? "").trim();
    if (sealed) return { mode: "sealed", sealed };
    return { mode: "paste" };
  }
  const sealed = (env.VITE_WHIP_SEALED ?? "").trim();
  if (sealed) return { mode: "sealed", sealed };
  const plain = (env.VITE_WHIP_URL ?? "").trim();
  if (plain) return { mode: "plain", secret: plain };
  return { mode: "paste" };
}

/** Audio capture constraints: no processing, stereo, let the device run at its native rate. */
export const AUDIO_CONSTRAINTS_BASE: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: { ideal: 2 },
  sampleSize: { ideal: 24 },
  // "ideal" never fails the request; we bump to the device max after capture.
  sampleRate: { ideal: 48000 },
};

export const VIDEO_CONSTRAINTS_BASE: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

/** Opus settings pushed into the SDP for DJ-quality audio. */
export const OPUS = {
  stereo: true,
  maxAverageBitrate: 256_000, // bps, Opus max is 510k; 256k fullband stereo is transparent
  cbr: true,
  dtx: false,
  fec: true,
};

export const VIDEO_MAX_BITRATE = 3_500_000; // bps

/** Viewer: how often to probe for a live signal while offline. */
export const VIEWER_PROBE_INTERVAL_MS = 8_000;
