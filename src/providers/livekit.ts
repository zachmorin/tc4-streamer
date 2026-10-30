import type { StreamProvider } from "./types";

/**
 * LiveKit Cloud fallback.
 *  - Publish: WHIP ingress. URL from the project (https://<project>.whip.livekit.cloud/w),
 *    the ingress "stream key" goes in the Authorization: Bearer header.
 *  - Playback: LiveKit has no WHEP endpoint. Viewers need either the
 *    livekit-client SDK (join the room as a subscriber) or an HLS egress
 *    played with hls.js. Neither is wired in v1; this adapter exists so the
 *    broadcaster side works and the viewer page states clearly what is missing.
 */
export const livekit: StreamProvider = {
  id: "livekit",
  label: "LiveKit Cloud (WHIP ingress)",
  secretLabel: "Ingress stream key",
  publish(secret) {
    const url = (import.meta.env.VITE_LIVEKIT_WHIP_URL ?? "").trim();
    if (!url) throw new Error("VITE_LIVEKIT_WHIP_URL is not set");
    return { url, bearerToken: secret.trim() };
  },
  playback() {
    return {
      kind: "unsupported",
      reason:
        "LiveKit playback needs livekit-client or an HLS egress; add a viewer adapter before using this provider in production",
    };
  },
  validateSecret(secret) {
    return secret.trim().length > 8 ? null : "Stream key looks too short";
  },
};
