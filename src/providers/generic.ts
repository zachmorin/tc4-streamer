import type { StreamProvider } from "./types";

/**
 * Any standards-compliant WHIP/WHEP server (Broadcast Box, MediaMTX,
 * Cloudflare Realtime SFU behind your own worker, etc.).
 * Publish secret = full WHIP URL. Playback = VITE_WHEP_URL.
 */
export const generic: StreamProvider = {
  id: "generic",
  label: "Generic WHIP/WHEP server",
  secretLabel: "WHIP URL",
  publish(secret) {
    return { url: secret.trim() };
  },
  playback() {
    const url = (import.meta.env.VITE_WHEP_URL ?? "").trim();
    if (!url) return { kind: "unsupported", reason: "VITE_WHEP_URL is not set" };
    return { kind: "whep", endpoint: { url } };
  },
  validateSecret(secret) {
    return /^https?:\/\//.test(secret.trim()) ? null : "WHIP URL must be an http(s) URL";
  },
};
