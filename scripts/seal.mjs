#!/usr/bin/env node
// Seal a broadcaster secret (Cloudflare WHIP URL or LiveKit stream key) with a
// passphrase so it can live in the public JS bundle as ciphertext.
//
//   npm run seal -- "<secret>" "<passphrase>"
//   or:  SECRET=... PASSPHRASE=... npm run seal
//
// Paste the output into VITE_WHIP_SEALED (or VITE_LIVEKIT_STREAM_KEY_SEALED).
// Must stay in sync with src/lib/seal.ts.
import { webcrypto as crypto } from "node:crypto";

const ITERATIONS = 310_000;

const secret = process.argv[2] ?? process.env.SECRET;
const passphrase = process.argv[3] ?? process.env.PASSPHRASE;

if (!secret || !passphrase) {
  console.error('usage: npm run seal -- "<secret>" "<passphrase>"');
  process.exit(2);
}
if (passphrase.length < 8) {
  console.error("refusing: passphrase shorter than 8 characters");
  process.exit(2);
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
  "deriveKey",
]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
  base,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"],
);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret)));
const out = new Uint8Array(salt.length + iv.length + ct.length);
out.set(salt, 0);
out.set(iv, salt.length);
out.set(ct, salt.length + iv.length);

console.log(Buffer.from(out).toString("base64"));
