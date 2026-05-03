import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify a Svix-style webhook signature (used by Resend).
 *
 * Headers:
 *   svix-id, svix-timestamp, svix-signature ("v1,<base64-hmac>"  — possibly space-separated list)
 *
 * Signature payload is `${id}.${timestamp}.${rawBody}` HMAC-SHA256'd with the
 * raw secret. The secret is delivered as `whsec_xxx` (base64 after the prefix).
 *
 * Returns true on match. Throws on missing headers or malformed secret.
 */
export function verifySvixSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): boolean {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signature = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return false;

  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");

  const toSign = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(toSign).digest("base64");

  // signature header may contain multiple "v1,sig" entries space-separated
  for (const part of signature.split(" ")) {
    const [, sig] = part.split(",", 2);
    if (!sig) continue;
    try {
      const sigBuf = Buffer.from(sig, "base64");
      const expBuf = Buffer.from(expected, "base64");
      if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) {
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}
