/**
 * Twilio REST transfer (design D7, task 5.2): re-route a live media-stream
 * call by updating it via the REST API — POST …/Calls/{CallSid}.json with
 * <Response><Say>announcement</Say><Dial><Number>staff</Number></Dial></Response>
 * TwiML, basic-authed with the existing twilio.accountSid/authToken config.
 * This is the only way to leave a media-stream call: Twilio plays the
 * announcement and bridges the caller to staff, after which our media
 * websocket is torn down.
 *
 * Plain fetch, no SDK (one REST call does not justify the dependency — D7);
 * tests inject `fetch`. Like the skills HTTP executor, the request is
 * bounded by an AbortController timeout.
 *
 * Never throws: every failure resolves to `{ ok: false, … }` so the
 * escalation handler can fall back to announce + end call unconditionally.
 */
import type { AppConfig } from "../../config/schema.js";
import type { Logger } from "../../logging.js";
import { PENDING_CALL_SID } from "./media-stream.js";
import { buildTransferTwiML } from "./twiml.js";

/** Default REST timeout for the transfer request (overridable in deps). */
export const TRANSFER_TIMEOUT_MS = 5_000;

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

export interface TwilioTransferDeps {
  config: AppConfig;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  logger?: Logger;
  /** Timeout override for tests; defaults to TRANSFER_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface TwilioTransferOptions {
  /** Spoken to the caller by <Say> before the <Dial> bridges the call. */
  announcementText: string;
  /** <Dial><Number> target (config.escalation.staffNumber). */
  staffNumber: string;
}

export type TwilioTransferResult =
  | { ok: true }
  | { ok: false; /** HTTP status when the REST call got a response. */ status?: number; error?: string };

export type TwilioTransfer = (
  callSid: string,
  opts: TwilioTransferOptions,
) => Promise<TwilioTransferResult>;

/** Build the transfer function wired into the escalation handler (task 5.2). */
export function createTwilioTransfer(deps: TwilioTransferDeps): TwilioTransfer {
  const doFetch = deps.fetch ?? fetch.bind(globalThis);
  const timeoutMs = deps.timeoutMs ?? TRANSFER_TIMEOUT_MS;

  const fail = (status: number | undefined, error: string): TwilioTransferResult => {
    deps.logger?.warn({ status, error }, "twilio transfer failed");
    return status === undefined ? { ok: false, error } : { ok: false, status, error };
  };

  return async (callSid, opts) => {
    const { accountSid, authToken } = deps.config.twilio;
    if (!accountSid || !authToken) {
      return fail(undefined, "twilio transfer unavailable: accountSid/authToken not configured");
    }
    // No real identity yet (the media stream's placeholder) → nothing to
    // update; the caller falls back to announce + end call.
    if (callSid === "" || callSid === PENDING_CALL_SID) {
      return fail(undefined, `twilio transfer unavailable: no CallSid (got '${callSid}')`);
    }

    const url = `${TWILIO_API_BASE}/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`, "utf8").toString("base64");
    const body = new URLSearchParams({
      Twiml: buildTransferTwiML(opts),
    }).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const snippet = (await safeText(response)).slice(0, 300);
        return fail(
          response.status,
          `HTTP ${response.status} ${response.statusText}${snippet ? ` — ${snippet}` : ""}`,
        );
      }
      return { ok: true };
    } catch (err) {
      if (controller.signal.aborted) {
        return fail(undefined, `twilio transfer timed out after ${timeoutMs}ms`);
      }
      return fail(undefined, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
