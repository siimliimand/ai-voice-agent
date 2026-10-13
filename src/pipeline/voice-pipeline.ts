import { EnergyVAD } from "../audio/vad.js";
import { PCM_SAMPLE_RATE_HZ } from "../audio/pcm.js";
import { PlaybackQueue } from "../audio/playback-queue.js";
import type { Logger } from "../logging.js";
import { logger } from "../logging.js";
import { TurnLatencyTracker, logTurn } from "../observability/latency.js";
import type { CallSession } from "../session/call-session.js";
import type { SttEvent, SttLanguage, SttProvider, SttStream } from "../stt/types.js";
import type { CallTransport } from "../telephony/transport.js";
import type { Language } from "../types.js";
import { SentenceChunker } from "../tts/sentence.js";
import type { TtsProvider, TtsStream } from "../tts/types.js";

/**
 * The conversation brain the pipeline drives. Implemented by src/agent;
 * declared here so the pipeline owns no agent imports.
 */
export interface ConversationAgent {
  /** Stream the agent reply to one finalized caller utterance, token by token. */
  handleUtterance(text: string, language: Language | null): AsyncIterable<string>;
  /** The caller interrupted playback; drop whatever reply is in flight. */
  onBargeIn(): void;
  /** Lock the conversation language (null = auto-detect per utterance). */
  setLanguage(language: Language | null): void;
  /** Release agent resources; no further calls after this. */
  close(): void;
}

/**
 * One spoken utterance, emitted as it happens: caller finals as they are
 * finalized and agent sentences as they are handed to TTS. Structurally
 * identical to the notes module's TranscriptWriteInput so the composition
 * root can pipe this straight into a TranscriptWriter.
 */
export interface PipelineUtterance {
  speaker: "caller" | "agent";
  text: string;
  language?: Language | null;
  /** Offset from call start, milliseconds (see UtteranceRecord). */
  atMs: number;
}

export interface VoicePipelineDeps {
  transport: CallTransport;
  session: CallSession;
  stt: SttProvider;
  tts: TtsProvider;
  agent: ConversationAgent;
  /** Pick the TTS voice for the call's current (or undetected) language. */
  resolveVoice: (language: Language | null) => string;
  logger?: Logger;
  /** Sample rate of caller PCM fed to STT. Default 16 kHz. */
  sampleRateHz?: number;
  /**
   * Optional live-utterance tap (persistence, live captions). Invoked for
   * every caller final and every agent sentence as it is spoken; must not
   * throw (a throw is reported like any other pipeline error).
   */
  onUtterance?: (u: PipelineUtterance) => void;
}

/**
 * Wires one call end to end: caller audio → STT → agent → TTS → paced
 * playback, with barge-in and per-turn latency reporting.
 *
 * Error isolation: every event handler catches its own failures, logs, and
 * announces an error status — a failing turn never kills the session.
 *
 * Turns: one turn = one finalized caller utterance up to the first audio
 * back. Barge-in (caller speech while playback is active) flushes playback,
 * cancels the in-flight TTS stream and reply consumption, and resets turn
 * state so the interrupted reply cannot continue.
 */
export class VoicePipeline {
  private readonly log: Logger;
  private readonly sampleRateHz: number;
  private readonly playbackQueue: PlaybackQueue;
  private readonly vad = new EnergyVAD();

  private sttStream: SttStream | null = null;
  private activeTtsStream: TtsStream | null = null;
  private closed = false;

  /** Turn bookkeeping: 1-based turn counter, per-turn sentence counter. */
  private turnCount = 0;
  private sentenceIndex = 0;
  /** Bumped on every turn start / barge-in / close; stale loops abort on it. */
  private epoch = 0;
  private tracker: TurnLatencyTracker | null = null;
  private turnLogged = false;

  /** Greeting path: counter + pending resolvers, separate from reply turns. */
  private greetingTurn = 0;
  private greetingSettlers: Array<() => void> = [];

  constructor(private readonly deps: VoicePipelineDeps) {
    this.log = deps.logger ?? logger;
    this.sampleRateHz = deps.sampleRateHz ?? PCM_SAMPLE_RATE_HZ;
    this.playbackQueue = new PlaybackQueue(deps.transport);
  }

  /** Subscribe to transport audio and open the initial (auto) STT stream. */
  start(): void {
    this.deps.transport.on("audio", this.onTransportAudio);
    this.deps.transport.on("hangup", this.onHangup);
    this.startSttStream(this.deps.session.language);
  }

  /**
   * Lock the call language: store it on the session, tell the agent, and
   * restart the STT stream pinned to the language (or "auto" when null).
   */
  setLanguage(lang: Language | null): void {
    this.deps.session.language = lang;
    this.deps.agent.setLanguage(lang);
    this.startSttStream(lang);
  }

  /** Tear everything down; idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1; // abort any in-flight reply consumption
    this.deps.transport.removeListener("audio", this.onTransportAudio);
    this.deps.transport.removeListener("hangup", this.onHangup);
    const stt = this.sttStream;
    this.sttStream = null;
    if (stt) void stt.close();
    this.cancelTts();
    this.playbackQueue.stop();
    this.deps.agent.close();
  }

  /**
   * Speak a fixed greeting text (usually agent.greet()) through the same
   * sentence → TTS → playback path as a reply turn, but with its own turn
   * counter and without touching the agent or the chat history. Nothing is
   * auto-played: the composition root decides when (and whether) to call
   * this. Resolves once every sentence's TTS stream has drained — or as soon
   * as a barge-in / close() cancels the remaining sentences; playback itself
   * continues asynchronously through the playback queue.
   */
  async speakGreeting(text: string): Promise<void> {
    if (this.closed) return;
    const epoch = this.epoch;
    this.greetingTurn += 1;
    const prefix = `g${this.greetingTurn}`;
    const chunker = new SentenceChunker();
    const pending: Promise<void>[] = [];
    for (const sentence of [...chunker.feed(text), ...chunker.flush()]) {
      if (this.closed || epoch !== this.epoch) break;
      pending.push(this.speakGreetingSentence(sentence, epoch, `${prefix}-s${pending.length}`));
    }
    await Promise.all(pending);
  }

  // ---------------------------------------------------------------- internals

  private startSttStream(lang: Language | null): void {
    const old = this.sttStream;
    this.sttStream = null;
    if (old) void old.close();
    const language: SttLanguage = lang ?? "auto";
    const stream = this.deps.stt.startStream({ language, sampleRateHz: this.sampleRateHz });
    stream.on(this.onSttEvent);
    this.sttStream = stream;
  }

  /** Caller audio: feed STT, and while we are playing, watch for barge-in. */
  private readonly onTransportAudio = (pcm: Buffer): void => {
    if (this.closed) return;
    try {
      this.sttStream?.write(pcm);
      if (this.playbackQueue.active) {
        const result = this.vad.process(pcm);
        if (result.started) this.handleBargeIn();
      }
    } catch (err) {
      this.reportError(err);
    }
  };

  private readonly onHangup = (reason: string): void => {
    this.log.info({ callSid: this.deps.session.callSid, reason }, "voice_pipeline_hangup");
    this.close();
  };

  private readonly onSttEvent = (e: SttEvent): void => {
    if (this.closed) return;
    try {
      if (e.type === "partial") {
        this.deps.transport.announce({
          type: "transcript",
          speaker: "caller",
          text: e.text,
          partial: true,
        });
        return;
      }
      this.handleFinal(e);
    } catch (err) {
      this.reportError(err);
    }
  };

  private handleFinal(e: SttEvent): void {
    this.turnCount += 1;
    this.sentenceIndex = 0;
    this.turnLogged = false;
    this.tracker = new TurnLatencyTracker();
    this.tracker.markSttFinal();

    // Providers emit wall-clock atMs; transcripts (memory + DB at_ms INTEGER)
    // are call-relative offsets, matching the agent-utterance semantics.
    const atMs = Math.max(0, e.atMs - this.deps.session.startedAt);
    this.deps.session.addUtterance({
      speaker: "caller",
      text: e.text,
      language: e.language,
      atMs,
    });
    this.deps.onUtterance?.({
      speaker: "caller",
      text: e.text,
      language: e.language ?? null,
      atMs,
    });
    this.deps.transport.announce({
      type: "transcript",
      speaker: "caller",
      text: e.text,
      partial: false,
    });

    this.epoch += 1; // supersede any still-streaming previous reply
    void this.consumeReply(e.text, this.epoch);
  }

  /** Consume the agent reply for one utterance, speaking completed sentences. */
  private async consumeReply(text: string, epoch: number): Promise<void> {
    const chunker = new SentenceChunker();
    let markedFirstToken = false;
    try {
      for await (const delta of this.deps.agent.handleUtterance(text, this.deps.session.language)) {
        if (this.closed || epoch !== this.epoch) return;
        if (!markedFirstToken) {
          this.tracker?.markLlmFirstToken();
          markedFirstToken = true;
        }
        for (const sentence of chunker.feed(delta)) {
          this.speak(sentence, epoch);
        }
      }
      if (this.closed || epoch !== this.epoch) return;
      for (const sentence of chunker.flush()) {
        this.speak(sentence, epoch);
      }
    } catch (err) {
      this.reportError(err);
    }
  }

  /**
   * Synthesize one sentence on its own TTS stream. Audio goes to the playback
   * queue; a mark names the sentence's stream start so the outbound stream is
   * annotated per sentence. The stream is ended immediately (the sentence's
   * text is complete), so it drains and finishes on its own.
   */
  private speak(sentence: string, epoch: number): void {
    if (this.closed || epoch !== this.epoch) return;
    const language = this.deps.session.language;
    const voiceId = this.deps.resolveVoice(language);
    const ttsStream = this.deps.tts.stream({ language: language ?? "en", voiceId });
    this.activeTtsStream = ttsStream;
    this.reportAgentUtterance(sentence);

    const sentenceIndex = this.sentenceIndex;
    this.sentenceIndex += 1;
    const mark = `t${this.turnCount}-s${sentenceIndex}`;

    ttsStream.events.on("audio", (pcm: Buffer) => {
      try {
        if (this.closed || epoch !== this.epoch) return;
        this.playbackQueue.push(pcm);
      } catch (err) {
        this.reportError(err);
      }
    });
    ttsStream.events.on("firstByte", () => {
      try {
        this.tracker?.markTtsFirstByte();
        if (!this.turnLogged && this.tracker) {
          this.turnLogged = true;
          logTurn(this.tracker, this.log, {
            callSid: this.deps.session.callSid,
            turn: this.turnCount,
            sentence: sentenceIndex,
          });
        }
      } catch (err) {
        this.reportError(err);
      }
    });
    ttsStream.events.on("done", () => {
      if (this.activeTtsStream === ttsStream) this.activeTtsStream = null;
    });
    ttsStream.events.on("error", (err: Error) => {
      this.reportError(err);
    });

    ttsStream.push(sentence);
    this.playbackQueue.mark(mark);
    ttsStream.end();
  }

  /**
   * One greeting sentence on the shared sentence → TTS → playback path.
   * Resolves on "done"/"error", or immediately when the stream is cancelled
   * (barge-in / close settle all pending greeting sentences), so the greeting
   * promise can never dangle.
   */
  private speakGreetingSentence(sentence: string, epoch: number, mark: string): Promise<void> {
    if (this.closed || epoch !== this.epoch) return Promise.resolve();
    const language = this.deps.session.language;
    const voiceId = this.deps.resolveVoice(language);
    const ttsStream = this.deps.tts.stream({ language: language ?? "en", voiceId });
    this.activeTtsStream = ttsStream;
    this.reportAgentUtterance(sentence);

    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        const at = this.greetingSettlers.indexOf(settle);
        if (at >= 0) this.greetingSettlers.splice(at, 1);
        if (this.activeTtsStream === ttsStream) this.activeTtsStream = null;
        resolve();
      };
      this.greetingSettlers.push(settle);
      ttsStream.events.once("done", settle);
      ttsStream.events.once("error", settle);
      ttsStream.events.on("audio", (pcm: Buffer) => {
        try {
          if (this.closed || epoch !== this.epoch) return;
          this.playbackQueue.push(pcm);
        } catch (err) {
          this.reportError(err);
        }
      });

      ttsStream.push(sentence);
      this.playbackQueue.mark(mark);
      ttsStream.end();
    });
  }

  /** Emit the optional onUtterance tap for one agent sentence as spoken. */
  private reportAgentUtterance(text: string): void {
    this.deps.onUtterance?.({
      speaker: "agent",
      text,
      language: this.deps.session.language,
      atMs: Date.now() - this.deps.session.startedAt,
    });
  }

  /** Resolve every pending greeting sentence (their streams were cancelled). */
  private settleGreetings(): void {
    const settlers = this.greetingSettlers;
    this.greetingSettlers = [];
    for (const settle of settlers) settle();
  }

  /** Caller spoke over playback: drop it all and reset turn state. */
  private handleBargeIn(): void {
    this.playbackQueue.flush();
    this.cancelTts();
    this.deps.agent.onBargeIn();
    this.deps.transport.announce({ type: "status", text: "barge-in" });
    this.epoch += 1; // interrupted reply must not continue
    this.vad.reset(); // require a fresh onset for the next barge-in
    this.log.debug({ callSid: this.deps.session.callSid }, "barge_in");
  }

  private cancelTts(): void {
    const stream = this.activeTtsStream;
    this.activeTtsStream = null;
    stream?.close();
    this.settleGreetings(); // cancelled greeting streams never fire "done"
  }

  /** Log + announce a handler failure without killing the session. */
  private reportError(err: unknown): void {
    this.log.error({ callSid: this.deps.session.callSid, err }, "voice_pipeline_error");
    this.deps.transport.announce({ type: "status", text: "error" });
  }
}
