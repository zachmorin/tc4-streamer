/**
 * A StreamProvider describes where the browser publishes (WHIP) and where
 * viewers play from (WHEP). Swapping services means adding one small adapter
 * in this folder and setting VITE_STREAM_PROVIDER.
 */
export interface Endpoint {
  url: string;
  /** Optional Authorization: Bearer token (LiveKit style). Cloudflare puts the secret in the URL. */
  bearerToken?: string;
}

export type PlaybackKind = "whep" | "unsupported";

export interface StreamProvider {
  id: string;
  label: string;
  /**
   * Resolve the publish endpoint. `secret` is whatever the broadcaster page
   * unlocked: for Cloudflare it is the full WHIP URL, for LiveKit it is the
   * ingress stream key.
   */
  publish(secret: string): Endpoint;
  /** Playback endpoint for viewers. Public. */
  playback(): { kind: PlaybackKind; endpoint?: Endpoint; reason?: string };
  /** Human hint shown on /go-live for what the secret is. */
  secretLabel: string;
  /** Short validation of a pasted / unsealed secret. */
  validateSecret(secret: string): string | null;
}
