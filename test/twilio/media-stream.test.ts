import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { resampleBuffer } from "../../src/audio/resample.js";
import { decodeUlaw, encodeUlaw } from "../../src/audio/ulaw.js";
import {
  PENDING_CALL_SID,
  TwilioMediaStreamTransport,
  attachTwilioMediaStream,
  type TwilioStartEvent,
} from "../../src/telephony/twilio/media-stream.js";

/**
 * Deterministic stand-in for a `ws` WebSocket: records everything the
 * transport sends and lets tests inject inbound frames, close, and error
 * events. No network, no timers.
 */
class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  sent: string[] = [];
  closeCalled = false;
  terminateCalled = false;

  send(data: string, _options?: unknown, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }

  close(): void {
    this.closeCalled = true;
    this.readyState = this.CLOSED;
  }

  terminate(): void {
    this.terminateCalled = true;
    this.readyState = this.CLOSED;
  }

  /** Simulate an inbound JSON text frame from Twilio. */
  frame(msg: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(msg), "utf8"), false);
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function asWs(fake: FakeWebSocket): WebSocket {
  return fake as unknown as WebSocket;
}

interface CapturedEvents {
  audio: Buffer[];
  marks: string[];
  hangups: string[];
  errors: Error[];
}

function makeTransport(callSid = "CA-manual"): {
  socket: FakeWebSocket;
  transport: TwilioMediaStreamTransport;
  events: CapturedEvents;
} {
  const socket = new FakeWebSocket();
  const transport = new TwilioMediaStreamTransport(asWs(socket), {
    callSid,
    from: "+1000",
    provider: "twilio",
  });
  const events: CapturedEvents = { audio: [], marks: [], hangups: [], errors: [] };
  transport.on("audio", (pcm: Buffer) => events.audio.push(pcm));
  transport.on("mark", (name: string) => events.marks.push(name));
  transport.on("hangup", (reason: string) => events.hangups.push(reason));
  transport.on("error", (err: Error) => events.errors.push(err));
  return { socket, transport, events };
}

/** Sine wave as 16-bit LE PCM, the shared language of all fixtures here. */
function sinePcm(sampleRateHz: number, count: number, freqHz: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    buf.writeInt16LE(
      Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRateHz)),
      i * 2,
    );
  }
  return buf;
}

function inboundMedia(payloadUlaw: Buffer, track?: "inbound" | "outbound"): unknown {
  return {
    event: "media",
    sequenceNumber: "1",
    media: {
      chunk: "1",
      timestamp: "0",
      payload: payloadUlaw.toString("base64"),
      ...(track ? { track } : {}),
    },
  };
}

function startEvent(fields: {
  streamSid?: string;
  callSid?: string;
  from?: string;
  to?: string;
  customParameters?: Record<string, string>;
}): TwilioStartEvent {
  return {
    event: "start",
    start: {
      streamSid: fields.streamSid ?? "MZ-default",
      callSid: fields.callSid ?? "CA-default",
      accountSid: "AC-default",
      ...(fields.from ? { from: fields.from } : {}),
      ...(fields.to ? { to: fields.to } : {}),
      ...(fields.customParameters ? { customParameters: fields.customParameters } : {}),
    },
  };
}

describe("attachTwilioMediaStream", () => {
  it("updates info from the start event, Caller customParameter winning over fallbacks", () => {
    const socket = new FakeWebSocket();
    const attached: TwilioMediaStreamTransport[] = [];
    const dispose = attachTwilioMediaStream(
      asWs(socket),
      { from: "+37260000000", to: "+37251234567" },
      (t) => attached.push(t),
    );

    expect(attached.length).toBe(0); // placeholder exists inside attach, no handoff yet

    socket.frame(
      startEvent({
        streamSid: "MZ1",
        callSid: "CA123",
        from: "+1111",
        to: "+2222",
        customParameters: { Caller: "+37251234567", Callee: "+37260000000" },
      }),
    );
    expect(attached.length).toBe(1);
    const info = attached[0]!.info;
    expect(info.provider).toBe("twilio");
    expect(info.callSid).toBe("CA123"); // start.callSid replaces the placeholder
    expect(info.from).toBe("+37251234567"); // customParameters.Caller beats start.from + fallback
    expect(info.to).toBe("+37260000000"); // customParameters.Callee beats fallback

    dispose();
  });

  it("falls back to start.from and then the attach fallback for identity", () => {
    const socket = new FakeWebSocket();
    const attached: TwilioMediaStreamTransport[] = [];
    const dispose = attachTwilioMediaStream(asWs(socket), { from: "+37260000000" }, (t) =>
      attached.push(t),
    );
    socket.frame(startEvent({ streamSid: "MZ1", callSid: "CA1", from: "+1111" }));
    expect(attached[0]!.info.callSid).toBe("CA1");
    expect(attached[0]!.info.from).toBe("+1111"); // start.from beats fallback

    const socket2 = new FakeWebSocket();
    const attached2: TwilioMediaStreamTransport[] = [];
    const dispose2 = attachTwilioMediaStream(asWs(socket2), { from: "+37260000000" }, (t) =>
      attached2.push(t),
    );
    socket2.frame(startEvent({ streamSid: "MZ2", callSid: "CA2" }));
    expect(attached2[0]!.info.callSid).toBe("CA2");
    expect(attached2[0]!.info.from).toBe("+37260000000"); // fallback wins when start has nothing

    dispose();
    dispose2();
  });

  it("creates the transport eagerly and calls onTransport exactly once", () => {
    const socket = new FakeWebSocket();
    const attached: TwilioMediaStreamTransport[] = [];
    const dispose = attachTwilioMediaStream(asWs(socket), {}, (t) => attached.push(t));
    expect(attached.length).toBe(0); // exists inside attach, but no handoff yet

    socket.frame({ event: "connected", protocol: "CallMe", version: "1.0.0" });
    expect(attached.length).toBe(0);

    socket.frame(startEvent({ streamSid: "MZ9", callSid: "CA9" }));
    expect(attached.length).toBe(1);
    expect(attached[0]).toBeInstanceOf(TwilioMediaStreamTransport);
    expect(attached[0]!.info.callSid).toBe("CA9");

    socket.frame(startEvent({ streamSid: "MZ9", callSid: "CA9-duplicate" }));
    expect(attached.length).toBe(1); // exactly once — duplicate starts never re-hand off

    dispose();
  });

  it("disposer closes the socket", () => {
    const socket = new FakeWebSocket();
    const dispose = attachTwilioMediaStream(asWs(socket), {}, () => {});
    dispose();
    expect(socket.closeCalled).toBe(true);
  });
});

describe("TwilioMediaStreamTransport inbound", () => {
  it("decodes inbound μ-law media into ~2× longer 16 kHz PCM within μ-law tolerance", () => {
    const { socket, transport, events } = makeTransport();
    void transport.start();

    const pcm8k = sinePcm(8000, 160, 100, 8000); // 20 ms of 100 Hz tone
    socket.frame(inboundMedia(encodeUlaw(pcm8k), "inbound"));

    expect(events.audio.length).toBe(1);
    const out = events.audio[0]!;
    const expected = resampleBuffer(pcm8k, 8000, 16000);
    // 160 samples at 8 kHz upsample to 319 samples at 16 kHz (~2× length).
    expect(out.length).toBe(319 * 2); // PCM16 bytes: 319 samples × 2
    expect(out.length).toBe(expected.length);
    // μ-law roundtrip tolerance, same bound as test/audio/ulaw.test.ts.
    for (let i = 0; i < expected.length >> 1; i++) {
      const exp = expected.readInt16LE(i * 2);
      const got = out.readInt16LE(i * 2);
      expect(Math.abs(got - exp)).toBeLessThanOrEqual(Math.max(16, Math.abs(exp) * 0.05));
    }
  });

  it("ignores the outbound track and treats a missing track as inbound", () => {
    const { socket, transport, events } = makeTransport();
    void transport.start();
    const ulaw = encodeUlaw(sinePcm(8000, 80, 100, 4000));

    socket.frame(inboundMedia(ulaw, "outbound"));
    expect(events.audio.length).toBe(0);

    socket.frame(inboundMedia(ulaw)); // no track field
    expect(events.audio.length).toBe(1);
  });

  it("is chunk-boundary invariant: two half media events equal one whole event", () => {
    const ulaw = encodeUlaw(sinePcm(8000, 400, 130, 12000));
    const half = ulaw.length >> 1;

    const single = makeTransport();
    void single.transport.start();
    single.socket.frame(inboundMedia(ulaw, "inbound"));
    const oneShot = single.events.audio[0]!;

    const chunked = makeTransport();
    void chunked.transport.start();
    chunked.socket.frame(inboundMedia(ulaw.subarray(0, half), "inbound"));
    chunked.socket.frame(inboundMedia(ulaw.subarray(half), "inbound"));
    expect(chunked.events.audio.length).toBe(2);
    const joined = Buffer.concat(chunked.events.audio);

    expect(joined.length).toBe(oneShot.length);
    for (let i = 0; i < oneShot.length >> 1; i++) {
      expect(Math.abs(joined.readInt16LE(i * 2) - oneShot.readInt16LE(i * 2))).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("re-emits mark echoes and hangs up on stop (reason passthrough)", () => {
    const { socket, transport, events } = makeTransport();
    void transport.start();

    socket.frame({ event: "mark", mark: { name: "flush-1", track: "outbound" } });
    expect(events.marks).toEqual(["flush-1"]);

    socket.frame({
      event: "stop",
      stop: { accountSid: "AC", callSid: "CA", reason: "call_ended" },
    });
    expect(events.hangups).toEqual(["call_ended"]);
  });

  it('defaults the stop hangup reason to "twilio_stop"', () => {
    const { socket, transport, events } = makeTransport();
    void transport.start();
    socket.frame({ event: "stop", stop: { accountSid: "AC", callSid: "CA" } });
    expect(events.hangups).toEqual(["twilio_stop"]);
  });

  it("hangs up when the socket closes and on socket error", () => {
    const closed = makeTransport();
    void closed.transport.start();
    closed.socket.emit("close");
    expect(closed.events.hangups).toEqual(["socket_closed"]);

    const errored = makeTransport();
    void errored.transport.start();
    errored.socket.emit("error", new Error("boom"));
    expect(errored.events.errors.length).toBe(1);
    expect(errored.events.hangups).toEqual(["socket_error"]);
  });

  it("ignores malformed, non-object, and binary frames without dying", () => {
    const { socket, transport, events } = makeTransport();
    void transport.start();

    socket.emit("message", Buffer.from("{{nope", "utf8"), false);
    socket.emit("message", Buffer.from("5", "utf8"), false); // valid JSON, not an object
    socket.emit("message", Buffer.from([0x01, 0x02]), true); // binary frames ignored
    socket.frame({ event: "connected", protocol: "CallMe", version: "1.0.0" });

    expect(events.errors.length).toBe(0);
    expect(events.audio.length).toBe(0);
    expect(events.hangups.length).toBe(0);
  });
});

describe("TwilioMediaStreamTransport outbound", () => {
  it("buffers audio and marks before start, then flushes in order with streamSid", () => {
    const { socket, transport } = makeTransport();
    void transport.start();

    const pcm16 = sinePcm(16000, 320, 150, 4000); // 20 ms at 16 kHz
    transport.sendAudio(pcm16);
    transport.sendMark("m1");
    expect(socket.sent.length).toBe(0); // streamSid unknown — nothing on the wire

    socket.frame(startEvent({ streamSid: "MZ42", callSid: "CA42" }));
    const frames = socket.sentJson();
    expect(frames.length).toBe(2); // buffered audio first, then the mark

    const mediaFrame = frames[0] as {
      event: string;
      streamSid: string;
      media: { payload: string };
    };
    expect(mediaFrame.event).toBe("media");
    expect(mediaFrame.streamSid).toBe("MZ42");
    const decoded8k = decodeUlaw(Buffer.from(mediaFrame.media.payload, "base64"));
    const expected8k = resampleBuffer(pcm16, 16000, 8000);
    expect(decoded8k.length).toBe(expected8k.length);
    // Full-range μ-law roundtrip tolerance (see test/audio/ulaw.test.ts):
    // small magnitudes err absolutely (~16), large ones relatively (~5%).
    for (let i = 0; i < expected8k.length >> 1; i++) {
      const exp = expected8k.readInt16LE(i * 2);
      expect(Math.abs(decoded8k.readInt16LE(i * 2) - exp)).toBeLessThanOrEqual(
        Math.max(16, Math.abs(exp) * 0.05),
      );
    }

    expect(frames[1]).toMatchObject({ event: "mark", streamSid: "MZ42", mark: { name: "m1" } });

    // Post-start audio goes out immediately.
    transport.sendAudio(pcm16);
    expect(socket.sent.length).toBe(3);
    expect(socket.sentJson()[2]).toMatchObject({ event: "media", streamSid: "MZ42" });
  });

  it("caps the pre-start buffer at ~2 s of wire audio, dropping oldest first", () => {
    const { socket, transport } = makeTransport();
    void transport.start();

    // 250 ms per chunk at 16 kHz → 2000 μ-law bytes on the wire.
    const chunk = sinePcm(16000, 4000, 100, 4000);
    for (let i = 0; i < 10; i++) transport.sendAudio(chunk);
    expect(socket.sent.length).toBe(0);

    socket.frame(startEvent({ streamSid: "MZ7", callSid: "CA7" }));
    const frames = socket.sentJson();
    // Cap is 16 000 wire bytes (2 s at 8 kHz μ-law) → exactly the last 8 chunks.
    expect(frames.length).toBe(8);
    let wireBytes = 0;
    for (const frame of frames) {
      const media = frame as { event: string; media: { payload: string } };
      expect(media.event).toBe("media");
      wireBytes += Buffer.from(media.media.payload, "base64").length;
    }
    expect(wireBytes).toBe(16000);
  });

  it("flush clears the pre-start buffer and sends a numbered flush mark", () => {
    const { socket, transport } = makeTransport();
    void transport.start();

    transport.sendAudio(sinePcm(16000, 320, 150, 4000));
    transport.flush(); // pre-start: buffer cleared, flush mark itself is buffered
    expect(socket.sent.length).toBe(0);

    socket.frame(startEvent({ streamSid: "MZ5", callSid: "CA5" }));
    const frames = socket.sentJson();
    expect(frames.length).toBe(1); // the audio did NOT survive flush
    expect(frames[0]).toMatchObject({ event: "mark", streamSid: "MZ5", mark: { name: "flush-1" } });

    transport.flush(); // post-start: only the mark goes out, numbered up
    expect(socket.sent.length).toBe(2);
    expect(socket.sentJson()[1]).toMatchObject({ event: "mark", mark: { name: "flush-2" } });
  });

  it("hangup closes the socket, sends nothing, and ends the transport", async () => {
    const { socket, transport, events } = makeTransport();
    void transport.start();
    socket.frame(startEvent({ streamSid: "MZ3", callSid: "CA3" }));
    socket.sent.length = 0;

    await transport.hangup("agent_goodbye");
    expect(socket.closeCalled).toBe(true);
    expect(socket.terminateCalled).toBe(false);
    expect(socket.sent.length).toBe(0); // no in-band hangup frame — Twilio hangs up on WS close
    expect(events.hangups).toEqual(["agent_goodbye"]);

    // Ended transport is inert: no more wire frames, no more audio events.
    transport.sendAudio(sinePcm(16000, 320, 150, 4000));
    transport.sendMark("late");
    socket.frame(inboundMedia(encodeUlaw(sinePcm(8000, 80, 100, 4000)), "inbound"));
    expect(socket.sent.length).toBe(0);
    expect(events.audio.length).toBe(0);
  });

  it("announce is a no-op (no UI channel on Twilio)", () => {
    const { socket, transport } = makeTransport();
    void transport.start();
    transport.announce({ type: "transcript", speaker: "agent", text: "Tere" });
    expect(socket.sent.length).toBe(0);
  });
});

describe("placeholder identity", () => {
  it("exposes PENDING_CALL_SID semantics via a direct transport start", () => {
    const { socket, transport } = makeTransport("CA-manual");
    void transport.start();
    expect(transport.info.callSid).toBe("CA-manual");
    expect(PENDING_CALL_SID).toBe("pending");

    socket.frame(startEvent({ streamSid: "MZ8", callSid: "CA8" }));
    expect(transport.info.callSid).toBe("CA8"); // start re-identifies even without attach
  });
});
