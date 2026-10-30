import type { StreamProvider } from "./types";

/**
 * Cloudflare Stream Live Inputs.
 *  - Publish:  webRTC.url          https://customer-<CODE>.cloudflarestream.com/<SECRET>/webRTC/publish
 *  - Playback: webRTCPlayback.url  https://customer-<CODE>.cloudflarestream.com/<INPUT_UID>/webRTC/play
 * Both come from the live input's Broadcast / Playback tabs in the dashboard.
 */
export const cloudflare: StreamProvider = {
  id: "cloudflare",
  label: "Cloudflare Stream (WHIP/WHEP)",
  secretLabel: "WHIP URL",
  publish(secret) {
    return { url: secret.trim() };
  },
  playback() {
    const url = (import.meta.env.VITE_WHEP_URL ?? "").trim();
    if (!url) {
      return { kind: "unsupported", reason: "VITE_WHEP_URL is not set" };
    }
    return { kind: "whep", endpoint: { url } };
  },
  validateSecret(secret) {
    const s = secret.trim();
    if (!/^https:\/\//.test(s)) return "WHIP URL must start with https://";
    if (!/\/webRTC\/publish\/?$/.test(s)) {
      return "Expected a Cloudflare WHIP URL ending in /webRTC/publish";
    }
    return null;
  },
};
