import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute Twilio's X-Twilio-Signature for a request: HMAC-SHA1 over the full
 * request URL followed by the alphabetically sorted POST parameters
 * (key + value, no separators), base64-encoded.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const pairs = Object.keys(params)
    .sort()
    .map((key) => key + params[key])
    .join("");
  return createHmac("sha1", authToken)
    .update(url + pairs)
    .digest("base64");
}

/**
 * Validate an incoming X-Twilio-Signature header against the request URL and
 * form parameters. Uses a timing-safe comparison; returns false for missing or
 * malformed signatures.
 */
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  if (!signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
