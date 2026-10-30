import { cloudflare } from "./cloudflare";
import { generic } from "./generic";
import { livekit } from "./livekit";
import type { StreamProvider } from "./types";

const registry: Record<string, StreamProvider> = { cloudflare, generic, livekit };

export function getProvider(): StreamProvider {
  const id = (import.meta.env.VITE_STREAM_PROVIDER ?? "cloudflare").trim().toLowerCase();
  const p = registry[id];
  if (!p) {
    throw new Error(`Unknown VITE_STREAM_PROVIDER "${id}". Known: ${Object.keys(registry).join(", ")}`);
  }
  return p;
}

export type { StreamProvider, Endpoint } from "./types";
