/**
 * Unit tests for the escalation handler's Twilio transfer step (design D7,
 * task 5.2): REST success closes the media session without speaking; any
 * REST failure falls back to announce + end call with the escalated flag
 * still recorded and the failure audited. No staff number / non-Twilio
 * transport goes straight to the base behavior without a REST call.
 */
import { describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/schema.js";
import {
  createEscalationHandler,
  ESCALATED_HANGUP_REASON,
  ESCALATION_TRANSFER_FAILED_EVENT,
  SESSION_ESCALATED_KEY,
} from "../../src/agent/escalation.js";
import { ESCALATION_ANNOUNCEMENTS } from "../../src/agent/prompts/index.js";
import { CallSession } from "../../src/session/call-session.js";
import type { CallTransport } from "../../src/telephony/transport.js";
import type { TwilioTransferResult } from "../../src/telephony/twilio/transfer.js";

/** Minimal Kysely fake covering insertCallEvent + setCallEscalated. */
function fakeEscalationDb(): {
  db: Kysely<Database>;
  events: Array<{ call_id: number; type: string; detail?: unknown }>;
  updates: Array<Record<string, unknown>>;
} {
  const events: Array<{ call_id: number; type: string; detail?: unknown }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    insertInto(_table: string) {
      return {
        values(values: { call_id: number; type: string; detail?: unknown }) {
          return {
            returning() {
              return {
                async executeTakeFirstOrThrow() {
                  events.push(values);
                  return { id: 101 };
                },
              };
            },
          };
        },
      };
    },
    updateTable(_table: string) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              return {
                async execute() {
                  updates.push(values);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Kysely<Database>;
  return { db, events, updates };
}

interface Harness {
  transport: CallTransport;
  session: CallSession;
  speak: ReturnType<typeof vi.fn<() => Promise<void>>>;
  transfer: ReturnType<
    typeof vi.fn<
      (callSid: string, opts: { announcementText: string; staffNumber: string }) => Promise<TwilioTransferResult>
    >
  >;
  hangup: ReturnType<typeof vi.fn<(reason: string) => Promise<void>>>;
}

function makeTransport(provider: "twilio" | "browser", callSid: string): CallTransport {
  return {
    info: { callSid, from: "+37200000000", provider },
    hangup: vi.fn().mockResolvedValue(undefined),
  } as unknown as CallTransport;
}

function harness(opts: {
  provider?: "twilio" | "browser";
  callSid?: string;
  staffNumber?: string;
  transferResult?: TwilioTransferResult;
}): Harness {
  const transport = makeTransport(opts.provider ?? "twilio", opts.callSid ?? "CA123abc");
  const session = new CallSession(transport.info);
  session.language = "et";
  const transfer = vi.fn().mockResolvedValue(opts.transferResult ?? { ok: true });
  return { transport, session, speak: vi.fn().mockResolvedValue(undefined), transfer, hangup: transport.hangup as Harness["hangup"] };
}

function buildHandler(
  h: Harness,
  extra: { db?: Kysely<Database> } = {},
): (reason?: string) => Promise<void> {
  const escalate = createEscalationHandler({
    ...extra,
    getCallId: () => 42,
    session: h.session,
    transport: h.transport,
    speak: h.speak,
    transfer: h.transfer,
    staffNumber: "+372555111",
    logger: undefined,
  });
  return (reason?: string) => escalate({ reason });
}

/** Let the fire-and-forget persistence chains settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("escalation handler Twilio transfer (task 5.2)", () => {
  it("REST success: transfers, closes the media session, never speaks", async () => {
    const h = harness({});
    const handler = buildHandler(h);
    await handler("caller asked");
    await flush();

    expect(h.transfer).toHaveBeenCalledTimes(1);
    expect(h.transfer).toHaveBeenCalledWith("CA123abc", {
      announcementText: ESCALATION_ANNOUNCEMENTS.et,
      staffNumber: "+372555111",
    });
    expect(h.speak).not.toHaveBeenCalled();
    expect(h.hangup).toHaveBeenCalledWith(ESCALATED_HANGUP_REASON);
  });

  it("REST success still records the escalated flag + event in both paths", async () => {
    const h = harness({});
    const { db, events, updates } = fakeEscalationDb();
    await buildHandler(h, { db })("caller asked");
    await flush();

    expect(updates).toEqual([{ escalated: true }]);
    expect(events).toEqual([
      { call_id: 42, type: "escalation_triggered", detail: { reason: "caller asked" } },
    ]);
    expect(h.session.meta[SESSION_ESCALATED_KEY]).toBe(true);
  });

  it("REST 4xx: falls back to announce + end, audits the failure, still escalates", async () => {
    const h = harness({ transferResult: { ok: false, status: 404, error: "HTTP 404 Not Found" } });
    const { db, events, updates } = fakeEscalationDb();
    await buildHandler(h, { db })("caller asked");
    await flush();

    expect(h.transfer).toHaveBeenCalledTimes(1);
    expect(h.speak).toHaveBeenCalledWith(ESCALATION_ANNOUNCEMENTS.et);
    expect(h.hangup).toHaveBeenCalledWith(ESCALATED_HANGUP_REASON);
    expect(updates).toEqual([{ escalated: true }]);
    // The two audit writes are independent fire-and-forget chains; only the
    // set of events is contractual, not their row order.
    expect(events.map((e) => e.type).sort()).toEqual(
      ["escalation_triggered", ESCALATION_TRANSFER_FAILED_EVENT].sort(),
    );
    const failed = events.find((e) => e.type === ESCALATION_TRANSFER_FAILED_EVENT);
    expect(failed?.detail).toEqual({ error: "HTTP 404 Not Found", status: 404 });
    expect(h.session.meta[SESSION_ESCALATED_KEY]).toBe(true);
  });

  it("REST network failure: same fallback + audited error without a status", async () => {
    const h = harness({ transferResult: { ok: false, error: "fetch failed" } });
    const { db, events, updates } = fakeEscalationDb();
    await buildHandler(h, { db })(undefined);
    await flush();

    expect(h.speak).toHaveBeenCalledWith(ESCALATION_ANNOUNCEMENTS.et);
    expect(h.hangup).toHaveBeenCalledWith(ESCALATED_HANGUP_REASON);
    expect(updates).toEqual([{ escalated: true }]);
    const failed = events.find((e) => e.type === ESCALATION_TRANSFER_FAILED_EVENT);
    expect(failed?.detail).toEqual({ error: "fetch failed" });
    expect(h.session.meta[SESSION_ESCALATED_KEY]).toBe(true);
  });

  it("empty staffNumber: straight to the base behavior, no REST call, no failure audit", async () => {
    const h = harness({});
    const escalate = createEscalationHandler({
      getCallId: () => 42,
      session: h.session,
      transport: h.transport,
      speak: h.speak,
      transfer: h.transfer,
      staffNumber: "   ",
    });
    await escalate({ reason: "caller asked" });
    await flush();

    expect(h.transfer).not.toHaveBeenCalled();
    expect(h.speak).toHaveBeenCalledWith(ESCALATION_ANNOUNCEMENTS.et);
    expect(h.hangup).toHaveBeenCalledWith(ESCALATED_HANGUP_REASON);
    expect(h.session.meta[SESSION_ESCALATED_KEY]).toBe(true);
  });

  it("unset staffNumber: base behavior even without a transfer dep (browser parity)", async () => {
    const h = harness({ provider: "browser" });
    const escalate = createEscalationHandler({
      session: h.session,
      transport: h.transport,
      speak: h.speak,
    });
    await escalate({});
    await flush();

    expect(h.transfer).not.toHaveBeenCalled();
    expect(h.speak).toHaveBeenCalledWith(ESCALATION_ANNOUNCEMENTS.et);
    expect(h.hangup).toHaveBeenCalledWith(ESCALATED_HANGUP_REASON);
  });

  it("non-Twilio transport: no REST call even when transfer + staff number are wired", async () => {
    const h = harness({ provider: "browser" });
    await buildHandler(h)();
    await flush();

    expect(h.transfer).not.toHaveBeenCalled();
    expect(h.speak).toHaveBeenCalledWith(ESCALATION_ANNOUNCEMENTS.et);
    expect(h.hangup).toHaveBeenCalledWith(ESCALATED_HANGUP_REASON);
  });

  it("no callSid (pending placeholder): the REST attempt fails → fallback is taken", async () => {
    // The real transfer module refuses pending/empty sids (see
    // test/telephony/transfer.test.ts); the handler treats that { ok: false }
    // exactly like any REST failure.
    const h = harness({ callSid: "pending", transferResult: { ok: false, error: "no CallSid" } });
    const { db, events } = fakeEscalationDb();
    await buildHandler(h, { db })();
    await flush();

    expect(h.transfer).toHaveBeenCalledWith("pending", expect.anything());
    expect(h.speak).toHaveBeenCalledWith(ESCALATION_ANNOUNCEMENTS.et);
    expect(h.hangup).toHaveBeenCalledWith(ESCALATED_HANGUP_REASON);
    expect(events.map((e) => e.type)).toContain(ESCALATION_TRANSFER_FAILED_EVENT);
    expect(h.session.meta[SESSION_ESCALATED_KEY]).toBe(true);
  });
});
