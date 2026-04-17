import { describe, expect, it } from "bun:test";
import { computeSignature, verifyWebhook } from "../adapters/webhook-verify.ts";

const SECRET = "s3cr3t-hunter2";

describe("verifyWebhook", () => {
  it("accepts a valid signature", async () => {
    const body = '{"action":"created"}';
    const header = await computeSignature(body, SECRET);
    const res = await verifyWebhook({ header, body, secret: SECRET });
    expect(res.ok).toBe(true);
  });

  it("rejects missing header", async () => {
    const res = await verifyWebhook({ header: null, body: "x", secret: SECRET });
    expect(res).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects bad prefix", async () => {
    const res = await verifyWebhook({ header: "md5=deadbeef", body: "x", secret: SECRET });
    expect(res).toEqual({ ok: false, reason: "bad_prefix" });
  });

  it("rejects length mismatch", async () => {
    const res = await verifyWebhook({ header: "sha256=abcd", body: "x", secret: SECRET });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("length_mismatch");
  });

  it("rejects wrong secret", async () => {
    const body = "{}";
    const header = await computeSignature(body, "other");
    const res = await verifyWebhook({ header, body, secret: SECRET });
    expect(res).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects tampered body (same length, different content)", async () => {
    const body = "hello";
    const header = await computeSignature(body, SECRET);
    const res = await verifyWebhook({ header, body: "hellO", secret: SECRET });
    expect(res.reason).toBe("signature_mismatch");
  });

  it("accepts raw Uint8Array body", async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    const header = await computeSignature(bytes, SECRET);
    const res = await verifyWebhook({ header, body: bytes, secret: SECRET });
    expect(res.ok).toBe(true);
  });

  it("is case-insensitive for the hex digest (prefix stays lowercase)", async () => {
    const body = "abc";
    const sig = await computeSignature(body, SECRET);
    // Uppercase only the hex portion; GitHub always sends "sha256=" lowercase.
    const header = "sha256=" + sig.slice("sha256=".length).toUpperCase();
    const res = await verifyWebhook({ header, body, secret: SECRET });
    expect(res.ok).toBe(true);
  });
});
