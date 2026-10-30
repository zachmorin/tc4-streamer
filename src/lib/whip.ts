import type { Endpoint } from "../providers/types";

/**
 * Minimal WHIP (publish) / WHEP (play) client. Both protocols are the same
 * three steps: create an SDP offer, POST it as application/sdp, apply the
 * answer. The Location header is the session resource; DELETE it to hang up.
 */
export interface SignalOptions {
  /** Mutate the local offer SDP before sending (e.g. Opus tuning). */
  mungeOffer?: (sdp: string) => string;
  /** Mutate the remote answer SDP before applying. */
  mungeAnswer?: (sdp: string) => string;
  /** Max time to wait for ICE gathering before sending the offer. */
  gatherTimeoutMs?: number;
  signal?: AbortSignal;
}

export class SignalError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SignalError";
  }
}

export async function negotiate(
  pc: RTCPeerConnection,
  endpoint: Endpoint,
  opts: SignalOptions = {},
): Promise<string | null> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc, opts.gatherTimeoutMs ?? 1200);

  let sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
  if (opts.mungeOffer) sdp = opts.mungeOffer(sdp);

  const headers: Record<string, string> = { "Content-Type": "application/sdp" };
  if (endpoint.bearerToken) headers.Authorization = `Bearer ${endpoint.bearerToken}`;

  let res: Response;
  try {
    res = await fetch(endpoint.url, { method: "POST", headers, body: sdp, signal: opts.signal });
  } catch (e) {
    throw new SignalError(`network error contacting ${safeHost(endpoint.url)}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new SignalError(`${res.status} ${res.statusText || ""}`.trim(), res.status);
  }

  let answer = await res.text();
  if (opts.mungeAnswer) answer = opts.mungeAnswer(answer);
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  const loc = res.headers.get("Location");
  return loc ? new URL(loc, endpoint.url).toString() : null;
}

export async function hangup(sessionUrl: string | null, endpoint: Endpoint): Promise<void> {
  if (!sessionUrl) return;
  const headers: Record<string, string> = {};
  if (endpoint.bearerToken) headers.Authorization = `Bearer ${endpoint.bearerToken}`;
  try {
    await fetch(sessionUrl, { method: "DELETE", headers, keepalive: true });
  } catch {
    // Best effort; the server times the session out anyway.
  }
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      clearTimeout(t);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

/** Mask the secret path segment of a WHIP URL for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const masked = parts.map((p) => (p.length > 12 ? `${p.slice(0, 4)}...${p.slice(-4)}` : p));
    return `${u.origin}/${masked.join("/")}`;
  } catch {
    return "(invalid url)";
  }
}
