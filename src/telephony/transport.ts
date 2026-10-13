import { EventEmitter } from "node:events";
import type { CallInfo } from "../types.js";

/**
 * Transport-agnostic call channel (design D1). Implementations deliver
 * caller audio as 16 kHz mono PCM16 and accept synth audio in the same
 * format; protocol specifics (Twilio μ-law JSON events, browser binary
 * frames) stay inside each transport.
 *
 * Events emitted:
 * - "audio"  (pcm: Buffer)        — inbound caller audio, 16 kHz PCM16 LE
 * - "mark"   (name: string)       — an outbound mark was played/confirmed
 * - "hangup" (reason: string)     — the call/channel ended
 * - "error"  (err: Error)         — non-fatal transport error
 */
export interface CallTransport extends EventEmitter {
  readonly info: CallInfo;
  /** Begin receiving audio; resolves once the channel is ready. */
  start(): Promise<void>;
  /** Send synth audio (16 kHz mono PCM16 LE) to the caller. */
  sendAudio(pcm: Buffer): void;
  /** Barge-in: stop/drop any audible playback immediately. */
  flush(): void;
  /** Annotate the outbound stream position with a named mark. */
  sendMark(name: string): void;
  /** Terminate the call/channel. */
  hangup(reason: string): Promise<void>;
  /**
   * Push a UI/observability event to the far end when the transport supports
   * it (e.g. live transcripts on the browser dev transport). No-op elsewhere.
   */
  announce(event: Record<string, unknown>): void;
}

/** Base class providing typed event plumbing for transports. */
export abstract class BaseCallTransport extends EventEmitter implements CallTransport {
  abstract readonly info: CallInfo;

  abstract start(): Promise<void>;
  abstract sendAudio(pcm: Buffer): void;
  abstract flush(): void;
  abstract sendMark(name: string): void;
  abstract hangup(reason: string): Promise<void>;
  abstract announce(event: Record<string, unknown>): void;

  protected ended = false;

  protected emitAudio(pcm: Buffer): void {
    if (!this.ended) this.emit("audio", pcm);
  }

  protected emitHangup(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.emit("hangup", reason);
  }

  protected emitError(err: Error): void {
    if (!this.ended) this.emit("error", err);
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}
