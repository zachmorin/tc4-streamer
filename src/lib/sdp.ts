import { OPUS } from "../config";

/**
 * Force Opus into DJ mode in an SDP: stereo, high constant bitrate, no DTX.
 *
 * WebRTC reads `stereo=1` / `maxaveragebitrate` from the *remote* description
 * to decide what the local encoder may send, so this must be applied to the
 * answer we receive as well as the offer we send (`sprop-stereo=1` tells the
 * other side we will send stereo).
 */
export function tuneOpus(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const opusPts = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000\/2/i.exec(line);
    if (m) opusPts.add(m[1]);
  }
  if (opusPts.size === 0) return sdp;

  const params: Record<string, string> = {
    stereo: OPUS.stereo ? "1" : "0",
    "sprop-stereo": OPUS.stereo ? "1" : "0",
    maxaveragebitrate: String(OPUS.maxAverageBitrate),
    maxplaybackrate: "48000",
    "sprop-maxcapturerate": "48000",
    cbr: OPUS.cbr ? "1" : "0",
    usedtx: OPUS.dtx ? "1" : "0",
    useinbandfec: OPUS.fec ? "1" : "0",
  };

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (m && opusPts.has(m[1])) {
      seen.add(m[1]);
      const existing = new Map<string, string>();
      for (const kv of m[2].split(";")) {
        const [k, v] = kv.trim().split("=");
        if (k) existing.set(k, v ?? "");
      }
      for (const [k, v] of Object.entries(params)) existing.set(k, v);
      out.push(`a=fmtp:${m[1]} ${[...existing].map(([k, v]) => `${k}=${v}`).join(";")}`);
      continue;
    }
    out.push(line);
    // Insert an fmtp line right after the rtpmap if none exists for this PT.
    const r = /^a=rtpmap:(\d+) opus\/48000\/2/i.exec(line);
    if (r && !sdp.includes(`a=fmtp:${r[1]} `)) {
      seen.add(r[1]);
      out.push(`a=fmtp:${r[1]} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(";")}`);
    }
  }
  return out.join("\r\n");
}
