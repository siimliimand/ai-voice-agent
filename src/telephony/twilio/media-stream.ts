import type { RawData, WebSocket } from "ws";
import { PCM_SAMPLE_RATE_HZ } from "../../audio/pcm.js";
import { Resampler } from "../../audio/resample.js";
import { decodeUlaw, encodeUlaw } from "../../audio/ulaw.js";
import { logger } from "../../logging.js";
import type { CallInfo } from "../../types.js";
import { BaseCallTransport } from "../transport.js";

/** Twilio Media Streams wire sample rate: 8 kHz G.711 μ-law. */
const TWILIO_SAMPLE_RATE_HZ = 8_000;

/** callSid used until the stream "start" event reveals the real identity. */
export const PENDING_CALL_SID = "pending";

/**
 * How much encoded outbound audio may sit in the pre-start buffer. Twilio
 * sends "start" immediately after "connected", so this only bounds a
 * pathological peer; ~2 s caps memory without losing a whole reply.
 */
const PRE_START_BUFFER_MS = 2_000;
/** μ-law is one byte per sample: 8 000 bytes/s → 16 000 bytes for 2 s. */
const PRE_START_BUFFER_BYTES = (TWILIO_SAMPLE_RATE_HZ / 1000) * PRE_START_BUFFER_MS;

/**
 * Twilio Media Streams protocol (design D1/D2), JSON text frames over the
 * media websocket:
 *
 * - inbound  {event:"connected", protocol, version}
 * - inbound  {event:"start", start:{streamSid, callSid, accountSid, from?, to?,
 *            customParameters?:{Caller?, Callee?, ...}}} — always the first
 *            media-bearing event; identifies call and stream
 * - inbound  {event:"media", sequenceNumber, media:{chunk, timestamp,
 *            payload: <base64 μ-law 8 kHz>, track: "inbound"|"outbound"}}
 * - inbound  {event:"mark", mark:{name, track}} — echo of an outbound mark,
 *            fired when the media stream has played through it
 * - inbound  {event:"stop", stop:{accountSid, callSid, reason?}} — call ended
 * - outbound {event:"media", streamSid, media:{payload}}
 * - outbound {event:"mark", streamSid, mark:{name}}
 *
 * Audio conversion lives at the transport edge (design D2): inbound μ-law
 * 8 kHz is decoded and upsampled to 16 kHz PCM16 before emitAudio; outbound
 * 16 kHz PCM16 is downsampled, μ-law encoded and base64 packed. One
 * Resampler instance per direction per connection keeps chunk boundaries
 * invisible (a stream split into arbitrary frames converts identically to a
 * one-shot conversion).
 */

export interface TwilioConnectedEvent {
  event: "connected";
  protocol: string;
  version: string;
}

export interface TwilioStartEvent {
  event: "start";
  /** Defensive: a non-conforming peer may omit the payload. */
  start?: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    from?: string;
    to?: string;
    /** Parameters from <Parameter name="Caller"/...> in our TwiML. */
    customParameters?: Record<string, string>;
  };
}

export interface TwilioMediaEvent {
  event: "media";
  sequenceNumber?: string;
  media?: {
    chunk?: string;
    timestamp?: string;
    /** Base64-encoded G.711 μ-law at 8 kHz. */
    payload: string;
    track?: "inbound" | "outbound";
  };
}

export interface TwilioMarkEvent {
  event: "mark";
  mark?: { name?: string; track?: string };
}

export interface TwilioStopEvent {
  event: "stop";
  stop?: { accountSid?: string; callSid?: string; reason?: string };
}

export type TwilioStreamEvent =
  TwilioConnectedEvent | TwilioStartEvent | TwilioMediaEvent | TwilioMarkEvent | TwilioStopEvent;

/** A fully encoded outbound frame queued while streamSid was still unknown. */
type PendingOutbound = { kind: "audio"; payload: Buffer } | { kind: "mark"; name: string };

/** Split a PCM16-LE buffer into its Int16 samples. */
function samplesFromPcm16(pcm: Buffer): Int16Array {
  const out = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

/** Pack Int16 samples into a PCM16-LE buffer. */
function pcm16FromSamples(samples: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i] as number, i * 2);
  return out;
}

/** Convert a `ws` text-frame payload to UTF-8 across the shapes `ws` delivers. */
function frameToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

export class TwilioMediaStreamTransport extends BaseCallTransport {
  /**
   * Mutable identity. The attach layer constructs the transport eagerly with
   * a placeholder CallInfo and patches it when the stream "start" event
   * arrives; exposed through a getter because CallInfo is readonly-typed.
   */
  private callInfo: CallInfo;

  /** Set by the stream "start" event; gates every outbound frame. */
  private streamSid: string | null = null;

  /** 8 kHz μ-law → 16 kHz PCM for caller audio; per-connection for continuity. */
  private readonly inboundResampler = new Resampler(TWILIO_SAMPLE_RATE_HZ, PCM_SAMPLE_RATE_HZ);

  /** 16 kHz PCM → 8 kHz μ-law for agent audio; separate instance from inbound. */
  private readonly outboundResampler = new Resampler(PCM_SAMPLE_RATE_HZ, TWILIO_SAMPLE_RATE_HZ);

  /** Encoded outbound frames waiting for streamSid (see sendAudio/sendMark). */
  private pending: PendingOutbound[] = [];
  private pendingWireBytes = 0;

  /** Counter for flush marks so the pipeline can correlate barge-ins. */
  private flushCount = 0;

  constructor(
    private readonly socket: WebSocket,
    info: CallInfo,
  ) {
    super();
    this.callInfo = info;
  }

  /**
   * CallInfo is readonly-typed, but the attach layer must patch identity in
   * place when the stream "start" event arrives (the transport object is
   * created eagerly with placeholder identity), so the field behind this
   * getter is reassigned rather than mutated property-by-property.
   */
  override get info(): CallInfo {
    return this.callInfo;
  }

  /**
   * Fold a stream "start" event into the (possibly placeholder) CallInfo.
   * Called by the attach layer before onTransport fires, and again —
   * idempotently, same values — by our own "start" handler. Per-field
   * precedence: stream customParameters, then the start event's top-level
   * fields, then the fallbacks baked into the placeholder info.
   */
  applyStart(msg: TwilioStartEvent): void {
    const s: Partial<NonNullable<TwilioStartEvent["start"]>> = msg.start ?? {};
    const params = s.customParameters;
    this.callInfo = {
      ...this.callInfo,
      callSid: s.callSid || this.callInfo.callSid,
      from: params?.Caller || s.from || this.callInfo.from,
      to: params?.Callee || s.to || this.callInfo.to,
    };
  }

  /** Register socket handlers. Frames are JSON text; binary frames are ignored. */
  override async start(): Promise<void> {
    this.socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return; // Media Streams carries JSON text frames only
      let parsed: unknown;
      try {
        parsed = JSON.parse(frameToText(data));
      } catch (err) {
        logger.debug({ err }, "twilio media stream: ignoring malformed frame");
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const msg = parsed as TwilioStreamEvent;
      switch (msg.event) {
        case "connected":
          logger.debug(
            { protocol: msg.protocol, version: msg.version },
            "twilio media stream connected",
          );
          break;
        case "start":
          this.handleStart(msg);
          break;
        case "media":
          this.handleMedia(msg);
          break;
        case "mark":
          this.emit("mark", msg.mark?.name ?? "");
          break;
        case "stop":
          this.emitHangup(msg.stop?.reason ?? "twilio_stop");
          break;
        default:
          break; // unknown event types are ignored (forward compatibility)
      }
    });
    this.socket.on("close", () => this.emitHangup("socket_closed"));
    this.socket.on("error", (err: Error) => {
      this.emitError(err);
      this.emitHangup("socket_error");
    });
  }

  /**
   * Send synth audio (16 kHz mono PCM16) to Twilio: downsample to 8 kHz,
   * μ-law encode, base64 pack, ship as one media JSON frame.
   *
   * Frames are deliberately NOT split into 20 ms chunks: Twilio accepts
   * arbitrarily large media frames (playout duration is encoded in the
   * payload length itself), and the upstream PlaybackQueue already paces
   * delivery at 20 ms.
   *
   * Until the stream "start" event reveals streamSid, encoded frames are
   * buffered (capped at ~2 s, oldest dropped first) and flushed on start.
   */
  override sendAudio(pcm: Buffer): void {
    if (this.ended || pcm.length === 0) return;
    const down = this.outboundResampler.process(samplesFromPcm16(pcm));
    const payload = encodeUlaw(pcm16FromSamples(down));
    if (this.streamSid === null) {
      this.bufferPending({ kind: "audio", payload });
      return;
    }
    this.sendMediaFrame(payload);
  }

  /** Annotate the outbound stream with a named mark (echoed back on playout). */
  override sendMark(name: string): void {
    if (this.ended) return;
    if (this.streamSid === null) {
      this.bufferPending({ kind: "mark", name });
      return;
    }
    this.sendMarkFrame(name);
  }

  /**
   * Barge-in (design D7) — division of labor with the upstream PlaybackQueue:
   * audio that is queued but NOT yet handed to this transport is dropped by
   * the queue's own flush(), which then calls us. So at transport level the
   * only droppable audio is the pre-start buffer (encoded but never sent,
   * i.e. never audible — clearing it is free). Frames already shipped as
   * media events cannot be unsent here; the flush mark lets the pipeline
   * correlate the cut with Twilio's mark echo for playback bookkeeping.
   */
  override flush(): void {
    this.pending = [];
    this.pendingWireBytes = 0;
    this.sendMark(`flush-${++this.flushCount}`);
  }

  /**
   * Twilio tears the call down when the media websocket closes — there is no
   * in-band hangup message to send. Close the socket, then emit hangup
   * (idempotent: the socket "close" event that follows is a no-op).
   */
  override async hangup(reason: string): Promise<void> {
    try {
      this.socket.close();
    } catch {
      try {
        this.socket.terminate();
      } catch {
        // Socket already dead — nothing to do.
      }
    }
    this.emitHangup(reason);
  }

  /**
   * No-op by design: Twilio Media Streams has no UI/observability side
   * channel (unlike the browser dev transport). Required by CallTransport;
   * live transcripts reach the admin console via the database instead.
   */
  override announce(_event: Record<string, unknown>): void {
    // Intentionally empty.
  }

  private handleStart(msg: TwilioStartEvent): void {
    this.applyStart(msg);
    this.streamSid = msg.start?.streamSid ?? this.streamSid;
    // "Status announcement" for this transport is the structured log line:
    // Twilio has no UI channel (see announce()).
    logger.info(
      { callSid: this.callInfo.callSid, streamSid: this.streamSid },
      "twilio media stream started",
    );
    this.drainPending();
  }

  private handleMedia(msg: TwilioMediaEvent): void {
    // Feed only the caller's inbound track to the pipeline; the outbound
    // track is an echo of our own playout and must not re-enter STT. A
    // missing track is treated as inbound (defensive; Twilio always sets it).
    const track = msg.media?.track;
    if (track !== undefined && track !== "inbound") return;
    const ulaw = Buffer.from(msg.media?.payload ?? "", "base64");
    if (ulaw.length === 0) return;
    const up = this.inboundResampler.process(samplesFromPcm16(decodeUlaw(ulaw)));
    if (up.length > 0) this.emitAudio(pcm16FromSamples(up));
  }

  /** Queue an encoded outbound frame while streamSid is unknown. */
  private bufferPending(item: PendingOutbound): void {
    this.pending.push(item);
    if (item.kind === "audio") this.pendingWireBytes += item.payload.length;
    while (this.pendingWireBytes > PRE_START_BUFFER_BYTES) {
      const dropped = this.pending.shift();
      if (dropped === undefined) break;
      if (dropped.kind === "audio") {
        this.pendingWireBytes -= dropped.payload.length;
        logger.warn(
          { callSid: this.callInfo.callSid },
          "twilio pre-start outbound buffer overflow; dropped oldest audio",
        );
      }
    }
  }

  /** Send everything queued before "start" arrived, preserving order. */
  private drainPending(): void {
    const pending = this.pending;
    this.pending = [];
    this.pendingWireBytes = 0;
    for (const item of pending) {
      if (item.kind === "audio") this.sendMediaFrame(item.payload);
      else this.sendMarkFrame(item.name);
    }
  }

  private sendMediaFrame(payload: Buffer): void {
    if (this.streamSid === null) return;
    this.sendJson({
      event: "media",
      streamSid: this.streamSid,
      media: { payload: payload.toString("base64") },
    });
  }

  private sendMarkFrame(name: string): void {
    if (this.streamSid === null) return;
    this.sendJson({ event: "mark", streamSid: this.streamSid, mark: { name } });
  }

  private sendJson(msg: Record<string, unknown>): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(msg), { binary: false });
  }
}

/** Numbers used when the stream "start" event carries no identity at all. */
export interface TwilioAttachFallbacks {
  from?: string;
  to?: string;
}

/**
 * Attach to an incoming Twilio Media Streams websocket (mirror of
 * attachBrowserTransport). The transport object exists immediately with
 * placeholder identity; when the stream "start" event arrives, CallInfo is
 * patched in place (callSid, Caller/Callee customParameters with fallback
 * precedence — see applyStart) and onTransport fires exactly once.
 *
 * Listener order matters: the handoff listener below is registered BEFORE
 * transport.start()'s protocol handlers, so the pipeline receives the
 * transport with its final identity before buffered outbound audio is drained.
 *
 * Returns a disposer that removes the handoff listener and closes the socket.
 */
export function attachTwilioMediaStream(
  socket: WebSocket,
  fallbacks: TwilioAttachFallbacks,
  onTransport: (transport: TwilioMediaStreamTransport) => void,
): () => void {
  const transport = new TwilioMediaStreamTransport(socket, {
    callSid: PENDING_CALL_SID,
    from: fallbacks.from ?? "unknown",
    to: fallbacks.to,
    provider: "twilio",
  });
  let handedOff = false;

  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary || handedOff) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frameToText(data));
    } catch {
      return; // the transport's own handler logs malformed frames
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const msg = parsed as TwilioStreamEvent;
    if (msg.event !== "start") return;
    handedOff = true;
    socket.off("message", onMessage);
    transport.applyStart(msg);
    onTransport(transport);
  };

  socket.on("message", onMessage);
  void transport.start();

  return () => {
    socket.off("message", onMessage);
    socket.close();
  };
}
