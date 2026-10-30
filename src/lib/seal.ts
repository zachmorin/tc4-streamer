/**
 * Passphrase-sealed secrets. The build embeds only ciphertext; /go-live
 * derives the key from the passphrase in the browser with Web Crypto.
 * Format (base64): salt[16] | iv[12] | AES-256-GCM ciphertext.
 * Mirror of scripts/seal.mjs.
 */
export const PBKDF2_ITERATIONS = 310_000;

export async function unseal(sealedB64: string, passphrase: string): Promise<string> {
  const raw = b64decode(sealedB64.trim());
  if (raw.length < 16 + 12 + 16) throw new Error("sealed value is too short");
  const salt = raw.slice(0, 16);
  const iv = raw.slice(16, 28);
  const ct = raw.slice(28);
  const key = await deriveKey(passphrase, salt);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("wrong passphrase");
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
