import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackQueue } from "../../src/audio/playback-queue.js";
import type { CallTransport } from "../../src/telephony/transport.js";
import type { CallInfo } from "../../src/types.js";

const FRAME_MS = 20;
const FRAME_BYTES = 640; // 20 ms at 16 kHz PCM16

/** Constant-amplitude PCM16 buffer (every sample set to `value`). */
function pcmWithValue(value: number, bytes = FRAME_BYTES): Buffer {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return pcm;
}

/** Transport test double that records every call in order. */
class FakeTransport extends EventEmitter implements CallTransport {
  readonly info: CallInfo = {
    callSid: "CA-test",
    from: "+10000000000",
    to: "+37200000000",
    provider: "twilio",
  };
  /** Unified call log: "audio:<bytes>" and "mark:<name>" entries in order. */
  readonly calls: string[] = [];
  readonly sent: Buffer[] = [];
  readonly marks: string[] = [];
  flushCount = 0;

  start(): Promise<void> {
    return Promise.resolve();
  }

  sendAudio(pcm: Buffer): void {
    // Copy so assertions are independent of the queue's internal subarrays.
    const copy = Buffer.from(pcm);
    this.sent.push(copy);
    this.calls.push(`audio:${copy.length}`);
  }

  sendMark(name: string): void {
    this.marks.push(name);
    this.calls.push(`mark:${name}`);
  }

  flush(): void {
    this.flushCount += 1;
  }

  hangup(): Promise<void> {
    return Promise.resolve();
  }

  announce(_event: Record<string, unknown>): void {}
}

describe("PlaybackQueue", () => {
  let transport: FakeTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new FakeTransport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = (n = 1) => vi.advanceTimersByTime(FRAME_MS * n);

  it("is inactive until the first push and sends nothing before a tick", () => {
    const queue = new PlaybackQueue(transport);
    expect(queue.active).toBe(false);
    queue.push(pcmWithValue(100));
    expect(queue.active).toBe(true);
    expect(transport.sent).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("ignores empty pushes and does not start the timer", () => {
    const queue = new PlaybackQueue(transport);
    queue.push(Buffer.alloc(0));
    expect(queue.active).toBe(false);
  });

  it("paces 20 ms frames in order, one per tick, then drains", () => {
    const queue = new PlaybackQueue(transport);
    const a = pcmWithValue(100);
    const b = pcmWithValue(-500);
    const c = pcmWithValue(9000);
    queue.push(a);
    queue.push(b);
    queue.push(c);

    tick(1);
    expect(transport.sent).toEqual([a]);
    tick(2);
    expect(transport.sent).toEqual([a, b, c]);
    expect(transport.calls).toEqual(["audio:640", "audio:640", "audio:640"]);
    expect(queue.active).toBe(false);
  });

  it("emits drained exactly when the queue empties", () => {
    const drained = vi.fn();
    const queue = new PlaybackQueue(transport);
    queue.on("drained", drained);
    queue.push(pcmWithValue(1));
    queue.push(pcmWithValue(2));

    tick(1);
    expect(drained).not.toHaveBeenCalled();
    tick(1);
    expect(drained).toHaveBeenCalledTimes(1);
    tick(5);
    expect(drained).toHaveBeenCalledTimes(1);
  });

  it("splits oversized chunks and keeps the partial leftover frame", () => {
    const queue = new PlaybackQueue(transport);
    const big = Buffer.concat([
      pcmWithValue(1),
      pcmWithValue(2),
      pcmWithValue(3, 100), // 100-byte tail (50 samples) after two full frames
    ]);
    queue.push(big);

    tick(3);
    expect(transport.sent.map((b) => b.length)).toEqual([640, 640, 100]);
    expect(Buffer.concat(transport.sent)).toEqual(big);
    expect(queue.active).toBe(false);
  });

  it("fires a mark after all audio queued before it, then later audio", () => {
    const queue = new PlaybackQueue(transport);
    const events: string[] = [];
    queue.on("mark", (name: string) => events.push(`mark:${name}`));
    queue.on("drained", () => events.push("drained"));

    const a = pcmWithValue(1);
    const b = pcmWithValue(2);
    const c = pcmWithValue(3);
    queue.push(a);
    queue.push(b);
    queue.mark("end-of-greeting");
    queue.push(c); // queued after the mark: must still come after it

    tick(3);
    // Mark fired after a and b, while c was still pending.
    expect(transport.calls).toEqual(["audio:640", "audio:640", "mark:end-of-greeting"]);
    expect(transport.marks).toEqual(["end-of-greeting"]);
    expect(events).toEqual(["mark:end-of-greeting"]);

    tick(2);
    expect(transport.sent).toEqual([a, b, c]);
    expect(events).toEqual(["mark:end-of-greeting", "drained"]);
    expect(queue.active).toBe(false);
  });

  it("starts the timer for a mark with no preceding audio", () => {
    const queue = new PlaybackQueue(transport);
    queue.mark("lonely");
    expect(queue.active).toBe(true);

    tick(1);
    expect(transport.marks).toEqual(["lonely"]);
    expect(queue.active).toBe(false);
  });

  it("flush drops pending audio, stops pacing, flushes the transport once", () => {
    const flushed = vi.fn();
    const queue = new PlaybackQueue(transport);
    queue.on("flushed", flushed);

    const a = pcmWithValue(1);
    const b = pcmWithValue(2);
    const c = pcmWithValue(3);
    queue.push(a);
    queue.push(b);
    queue.push(c);

    tick(1);
    queue.flush();
    expect(transport.sent).toEqual([a]); // only the first frame got out
    expect(transport.flushCount).toBe(1);
    expect(queue.active).toBe(false);

    tick(10);
    expect(transport.sent).toEqual([a]); // nothing further is sent

    queue.flush(); // idempotent: nothing pending anymore
    expect(transport.flushCount).toBe(1);
    expect(flushed).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const queue = new PlaybackQueue(transport);
    queue.flush();
    expect(transport.flushCount).toBe(0);
    expect(queue.active).toBe(false);
  });

  it("push after flush restarts pacing cleanly", () => {
    const queue = new PlaybackQueue(transport);
    queue.push(pcmWithValue(1));
    queue.flush();

    const b = pcmWithValue(2);
    queue.push(b);
    expect(queue.active).toBe(true);

    tick(1);
    expect(transport.sent).toEqual([b]);
    tick(1);
    expect(queue.active).toBe(false);
  });

  it("stop() clears without calling transport.flush() and allows reuse", () => {
    const queue = new PlaybackQueue(transport);
    queue.push(pcmWithValue(1));
    queue.push(pcmWithValue(2));

    queue.stop();
    expect(queue.active).toBe(false);

    tick(5);
    expect(transport.sent).toHaveLength(0);
    expect(transport.flushCount).toBe(0);

    const c = pcmWithValue(3);
    queue.push(c);
    tick(1);
    expect(transport.sent).toEqual([c]);
  });

  it("honors a custom frame duration", () => {
    const queue = new PlaybackQueue(transport, { frameMs: 10 }); // 320 bytes
    queue.push(pcmWithValue(1, 640));

    vi.advanceTimersByTime(10);
    expect(transport.sent.map((b) => b.length)).toEqual([320]);
    vi.advanceTimersByTime(10);
    expect(transport.sent.map((b) => b.length)).toEqual([320, 320]);
    expect(queue.active).toBe(false);
  });
});
