import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeTwilioSignature,
  validateTwilioSignature,
} from "../../src/telephony/twilio/validate-signature.js";

const TOKEN = "turbo-villain-derive-cache-echo-mimic-forest";
const URL = "https://example.com/twiml";
const PARAMS = {
  CallSid: "CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  From: "+37251234567",
  To: "+37260000000",
};

/** Independent reference implementation (per Twilio docs). */
function referenceSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key]!;
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

describe("validateTwilioSignature", () => {
  it("accepts a correctly computed signature", () => {
    const sig = referenceSignature(TOKEN, URL, PARAMS);
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, sig)).toBe(true);
  });

  it("is order-insensitive: shuffled params validate the same", () => {
    const sig = referenceSignature(TOKEN, URL, PARAMS);
    const shuffled: Record<string, string> = {
      To: PARAMS.To,
      CallSid: PARAMS.CallSid,
      From: PARAMS.From,
    };
    expect(validateTwilioSignature(TOKEN, URL, shuffled, sig)).toBe(true);
    expect(computeTwilioSignature(TOKEN, URL, shuffled)).toBe(sig);
  });

  it("rejects a tampered signature", () => {
    const sig = referenceSignature(TOKEN, URL, PARAMS);
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, flipped)).toBe(false);
  });

  it("rejects the wrong token, url, or params", () => {
    const sig = referenceSignature(TOKEN, URL, PARAMS);
    expect(validateTwilioSignature("other-token", URL, PARAMS, sig)).toBe(false);
    expect(validateTwilioSignature(TOKEN, "https://example.com/other", PARAMS, sig)).toBe(false);
    expect(validateTwilioSignature(TOKEN, URL, { ...PARAMS, From: "+10000000000" }, sig)).toBe(
      false,
    );
  });

  it("rejects missing or malformed signatures", () => {
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, "")).toBe(false);
    expect(validateTwilioSignature(TOKEN, URL, PARAMS, "not base64 ===")).toBe(false);
  });
});
