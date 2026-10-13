import { EventEmitter } from "node:events";
import type { CallTransport } from "../telephony/transport.js";
import { frameBytesForMs, PCM_SAMPLE_RATE_HZ } from "./pcm.js";

/** One entry in the outbound playback stream. */
type QueueItem = { kind: "audio"; pcm: Buffer } | { kind: "mark"; name: string };

export interface PlaybackQueueOptions {
  /** Duration of one paced frame in milliseconds. Default 20 ms. */
  frameMs?: number;
  /** Sample rate of the PCM passed to push(). Default 16 kHz. */
  sampleRateHz?: number;
}

/**
 * Paces agent audio to a transport in real time.
 *
 * Audio chunks pushed via push() are sliced into fixed frames (20 ms =
 * 640 bytes at 16 kHz) and delivered one per interval tick, so a TTS stream
 * can enqueue faster than real time without flooding the far end. Marks
 * (mark()) fire strictly after every audio chunk queued before them, which
 * lets the pipeline know when a reply has actually finished playing (e.g.
 * Twilio <Play> mark callbacks or the browser flush control).
 *
 * Pacing accuracy: delivery uses a plain `setInterval`, not a precise sample
 * clock — ticks can drift or bunch by a few ms under load. This is fine for
 * the intended sinks: Twilio tolerates it because Media Streams playout is
 * paced by the duration already encoded in the audio, and the browser dev
 * client buffers before playing.
 *
 * Barge-in: flush() drops everything queued, stops pacing, and asks the
 * transport to stop audible output immediately. Callers must treat buffers
 * passed to push() as consumed (the queue keeps references, not copies).
 *
 * Events:
 * - "mark"    (name: string) — a queued mark fired (transport.sendMark called)
 * - "flushed"                — flush() dropped pending playback
 * - "drained"                — queue emptied and the pacing timer stopped
 */
export class PlaybackQueue extends EventEmitter {
  private readonly transport: CallTransport;
  private readonly frameMs: number;
  private readonly frameBytes: number;
  private queue: QueueItem[] = [];
  /** Read offset into the head audio item, which may be partially sent. */
  private headOffset = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(transport: CallTransport, opts: PlaybackQueueOptions = {}) {
    super();
    this.transport = transport;
    this.frameMs = opts.frameMs ?? 20;
    this.frameBytes = frameBytesForMs(this.frameMs, opts.sampleRateHz ?? PCM_SAMPLE_RATE_HZ);
  }

  /** True while the pacing timer is running (audio queued or being sent). */
  get active(): boolean {
    return this.timer !== null;
  }

  /**
   * Enqueue PCM16 audio at the configured sample rate; the pacing timer
   * starts lazily on the first non-empty chunk.
   */
  push(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.queue.push({ kind: "audio", pcm });
    this.startTimer();
  }

  /**
   * Enqueue a named mark. It fires — transport.sendMark(name) plus a local
   * "mark" event — after all audio queued before it has been sent. A mark
   * with no audio ahead of it fires on the next tick.
   */
  mark(name: string): void {
    this.queue.push({ kind: "mark", name });
    this.startTimer();
  }

  /**
   * Barge-in: drop all queued audio and marks, stop pacing, ask the
   * transport to stop audible output, and emit "flushed". Idempotent —
   * a no-op when nothing is pending.
   */
  flush(): void {
    if (this.timer === null && this.queue.length === 0) return;
    this.clearQueue();
    this.stopTimer();
    this.transport.flush();
    this.emit("flushed");
  }

  /** Stop pacing and drop everything queued WITHOUT touching the transport. */
  stop(): void {
    this.clearQueue();
    this.stopTimer();
  }

  private clearQueue(): void {
    this.queue = [];
    this.headOffset = 0;
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(this.onTick, this.frameMs);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Send at most one frame (or fire one mark) per tick. */
  private readonly onTick = (): void => {
    const item = this.queue[0];
    if (item === undefined) {
      this.stopTimer();
      this.emit("drained");
      return;
    }

    if (item.kind === "mark") {
      this.queue.shift();
      this.transport.sendMark(item.name);
      this.emit("mark", item.name);
    } else {
      const take = Math.min(this.frameBytes, item.pcm.length - this.headOffset);
      const frame = item.pcm.subarray(this.headOffset, this.headOffset + take);
      this.headOffset += take;
      if (this.headOffset >= item.pcm.length) {
        this.queue.shift();
        this.headOffset = 0;
      }
      this.transport.sendAudio(frame);
    }

    if (this.queue.length === 0) {
      this.stopTimer();
      this.emit("drained");
    }
  };
}
