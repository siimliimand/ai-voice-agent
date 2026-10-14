/**
 * Unit tests for the Twilio REST transfer (design D7, task 5.2): the TwiML
 * builder's exact output and the REST call shape against a mocked fetch
 * (success, 4xx/5xx, network failure, timeout, unconfigured/pending guards).
 * Mirrors test/skills/http-executor.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { buildTransferTwiML } from "../../src/telephony/twilio/twiml.js";
import {
  createTwilioTransfer,
  TRANSFER_TIMEOUT_MS,
} from "../../src/telephony/twilio/transfer.js";

const ANNOUNCEMENT = "Hästi, ühendan teid nüüd kolleegiga. Palun oodake.";
const STAFF = "+372555111";
const EXPECTED_TWIML =
  `<Response>` +
  `<Say>${ANNOUNCEMENT}</Say>` +
  `<Dial><Number>${STAFF}</Number></Dial>` +
  `</Response>`;

/** Fully-parsed config with only the twilio section overridden. */
function twilioConfig(twilio: Record<string, unknown> = {}): AppConfig {
  return configSchema.parse({
    twilio: { accountSid: "ACTEST123", authToken: "authtok", ...twilio },
  });
}

const OPTS = { announcementText: ANNOUNCEMENT, staffNumber: STAFF };

/** A fetch that never resolves unless aborted (timeout path). */
function hangingFetch(): typeof fetch {
  return vi.fn(
    (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      }),
  ) as unknown as typeof fetch;
}

describe("transfer TwiML builder (task 5.2)", () => {
  it("builds the exact <Response><Say>…<Dial><Number> document", () => {
    expect(buildTransferTwiML({ announcementText: ANNOUNCEMENT, staffNumber: STAFF })).toBe(
      EXPECTED_TWIML,
    );
  });

  it("XML-escapes the announcement text and the staff number", () => {
    expect(
      buildTransferTwiML({
        announcementText: `Tom & "Jerry" <'boss'> ühendab`,
        staffNumber: "+372<555>&111",
      }),
    ).toBe(
      `<Response>` +
        `<Say>Tom &amp; &quot;Jerry&quot; &lt;&apos;boss&apos;&gt; ühendab</Say>` +
        `<Dial><Number>+372&lt;555&gt;&amp;111</Number></Dial>` +
        `</Response>`,
    );
  });

  it("carries no XML declaration (nested document)", () => {
    expect(buildTransferTwiML(OPTS).startsWith("<?xml")).toBe(false);
  });
});

describe("twilio REST transfer (mocked fetch)", () => {
  it("POSTs the escaped TwiML form-encoded with basic auth to the Calls endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const transfer = createTwilioTransfer({
      config: twilioConfig(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(transfer("CA123abc", OPTS)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACTEST123/Calls/CA123abc.json");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("ACTEST123:authtok", "utf8").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    });
    // The form body carries exactly the TwiML document as the Twiml parameter
    // (form-encoding: spaces become '+').
    expect(new URLSearchParams(String(init.body)).get("Twiml")).toBe(EXPECTED_TWIML);
    expect(String(init.body)).toBe(new URLSearchParams({ Twiml: EXPECTED_TWIML }).toString());
  });

  it("maps 4xx responses to { ok: false, status, error }", async () => {
    const transfer = createTwilioTransfer({
      config: twilioConfig(),
      fetch: vi
        .fn()
        .mockResolvedValue(new Response('{"code": 20404}', { status: 404, statusText: "Not Found" })),
    });

    const result = await transfer("CA123", OPTS);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(result.ok === false && result.error).toMatch(/HTTP 404 Not Found/);
  });

  it("maps 5xx responses to { ok: false, status, error }", async () => {
    const transfer = createTwilioTransfer({
      config: twilioConfig(),
      fetch: vi
        .fn()
        .mockResolvedValue(new Response("upstream exploded", { status: 500, statusText: "Oops" })),
    });

    const result = await transfer("CA123", OPTS);
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result.ok === false && result.error).toMatch(/HTTP 500 Oops — upstream exploded/);
  });

  it("maps network failures to { ok: false, error } without a status", async () => {
    const transfer = createTwilioTransfer({
      config: twilioConfig(),
      fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });

    await expect(transfer("CA123", OPTS)).resolves.toEqual({
      ok: false,
      error: "fetch failed",
    });
  });

  it("maps an aborted request (timeout) to a timeout error", async () => {
    const transfer = createTwilioTransfer({
      config: twilioConfig(),
      fetch: hangingFetch(),
      timeoutMs: 20,
    });

    const result = await transfer("CA123", OPTS);
    expect(result).toEqual({
      ok: false,
      error: `twilio transfer timed out after 20ms`,
    });
  });

  it("defaults the timeout to the module const", () => {
    expect(TRANSFER_TIMEOUT_MS).toBe(5_000);
    const transfer = createTwilioTransfer({ config: twilioConfig() });
    expect(transfer).toBeTypeOf("function"); // builds with the default timeout
  });

  it("fails without a REST call when twilio credentials are not configured", async () => {
    const fetchMock = vi.fn();
    const transfer = createTwilioTransfer({
      config: configSchema.parse({}),
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await transfer("CA123", OPTS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/accountSid\/authToken not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails without a REST call when the callSid is missing or still pending", async () => {
    const fetchMock = vi.fn();
    const transfer = createTwilioTransfer({
      config: twilioConfig(),
      fetch: fetchMock as unknown as typeof fetch,
    });

    for (const callSid of ["", "pending"]) {
      const result = await transfer(callSid, OPTS);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/no CallSid/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
