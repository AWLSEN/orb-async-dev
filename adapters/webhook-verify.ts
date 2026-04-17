// GitHub webhook signature verification (HMAC-SHA256 via X-Hub-Signature-256).
// Constant-time comparison, no external deps — uses Web Crypto (available in Bun).

export interface VerifyResult {
  ok: boolean;
  reason?: "missing_header" | "bad_prefix" | "length_mismatch" | "signature_mismatch";
}

const SIG_HEADER = "x-hub-signature-256";

/** Verify that `body` was signed by `secret`; compares header `sha256=<hex>` in constant time. */
export async function verifyWebhook(input: {
  header: string | null | undefined;
  body: string | Uint8Array;
  secret: string;
}): Promise<VerifyResult> {
  if (!input.header) return { ok: false, reason: "missing_header" };
  if (!input.header.startsWith("sha256=")) return { ok: false, reason: "bad_prefix" };
  const expected = input.header.slice("sha256=".length).trim().toLowerCase();

  const sigBytes = await hmacSha256(input.secret, input.body);
  const computed = bytesToHex(sigBytes);

  if (expected.length !== computed.length) return { ok: false, reason: "length_mismatch" };
  if (!constantTimeEqual(expected, computed)) return { ok: false, reason: "signature_mismatch" };
  return { ok: true };
}

/** Convenience: compute the HMAC-SHA256 hex digest of `body` with `secret`. */
export async function computeSignature(body: string | Uint8Array, secret: string): Promise<string> {
  const sigBytes = await hmacSha256(secret, body);
  return `sha256=${bytesToHex(sigBytes)}`;
}

async function hmacSha256(secret: string, body: string | Uint8Array): Promise<Uint8Array> {
  // Re-copy into fresh ArrayBuffers so BufferSource typing matches under strict TS.
  const bodyAb = new Uint8Array(typeof body === "string" ? new TextEncoder().encode(body) : body).buffer;
  const keyAb = new Uint8Array(new TextEncoder().encode(secret)).buffer;
  const key = await crypto.subtle.importKey("raw", keyAb, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bodyAb));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const WEBHOOK_SIGNATURE_HEADER = SIG_HEADER;
