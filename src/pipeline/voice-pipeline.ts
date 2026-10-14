import { EnergyVAD } from "../audio/vad.js";
import { PCM_SAMPLE_RATE_HZ } from "../audio/pcm.js";
import { PlaybackQueue } from "../audio/playback-queue.js";
import type { Logger } from "../logging.js";
import { logger } from "../logging.js";
import { TurnLatencyTracker, logTurn } from "../observability/latency.js";
import type { ErrorCategory, MetricsRegistry } from "../observability/metrics.js";
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

/* --------------------------------------------------- consent gate (design D5) */

/** Verdict for one classified consent-window reply (design D6). */
export type ConsentVerdict = "affirmative" | "decline" | "unclear";

/** Definitive consent decisions reported to the call-start flow. */
export type ConsentDecision = "granted" | "declined";

/**
 * One caller reply heard on the ephemeral consent stream. Consent-window
 * speech is never persisted: it must not reach a TranscriptWriter, the
 * session transcript, conversation history, or transcript announcements.
 */
export interface ConsentUtterance {
  text: string;
  language: Language | null;
  confidence?: number;
  /** Offset from call start, milliseconds (same semantics as PipelineUtterance). */
  atMs: number;
}

/** A consent-window reply together with its classification verdict. */
export interface ConsentReply extends ConsentUtterance {
  verdict: ConsentVerdict;
}

/**
 * Structural surface of the agent's AffirmationClassifier (design D6) the
 * pipeline needs; the composition root injects the real instance so the
 * pipeline owns no agent imports.
 */
export interface ConsentReplyClassifier {
  decide(answer: string, language: Language | null): Promise<ConsentVerdict>;
}

/** Per-call consent gate options (present ⇔ consent.enabled for this call). */
export interface ConsentGateOptions {
  /** Yes/no judge for the caller's reply to the spoken consent notice. */
  classifier: ConsentReplyClassifier;
  /**
   * Language the notice is spoken in; the ephemeral reply stream opens
   * pinned to it ("auto" when absent). The caller's actual language still
   * comes from the language vote below.
   */
  initialLanguage?: Language;
  /**
   * Language vote for consent-window replies — per D5 the ephemeral output
   * does double duty. The composition root feeds the same LanguageManager
   * path the first normal utterance would take; a non-null result is
   * applied to the session and agent (but cannot open the main STT stream,
   * which does not exist until consentGrant()).
   */
  languageVote?: (
    text: string,
    hint: { language?: Language; confidence?: number },
  ) => Promise<Language | null>;
}

/** Callbacks the call-start flow registers to drive the consent phase. */
export interface ConsentPhaseHandlers {
  /**
   * Every classified consent-window reply, as its final transcript arrives —
   * including "unclear" ones. The re-ask-once-then-cancel loop is the
   * call-start flow's decision; this is the signal it re-asks on.
   */
  onReply?: (reply: ConsentReply) => void;
  /**
   * Fired once, on the first definitive reply ("granted" | "declined").
   * The pipeline does NOT unlock anything on its own: the flow drives
   * consentGrant() / consentDecline() from here.
   */
  onDecision?: (decision: ConsentDecision, utterance: ConsentUtterance) => void;
}

interface ConsentPhase {
  stream: SttStream;
  handlers: ConsentPhaseHandlers;
  /** True once a definitive reply fired onDecision; later replies are ignored. */
  decided: boolean;
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
  /**
   * Optional process metrics registry (design D10). Fed from the existing
   * turn-latency hook below (no timing logic duplicated) and from the
   * error-catch points via reportError's category.
   */
  metrics?: MetricsRegistry;
  /**
   * Consent-gated start (design D5). Present ⇒ start() opens NO main STT
   * stream and no caller audio is transcribed, persisted, or announced
   * until consentGrant() unlocks normal operation; until then a separate,
   * short-lived ephemeral stream (beginConsentPhase) recognizes the
   * caller's reply to the spoken notice for the grant/decline decision and
   * the language vote only. Absent ⇒ today's exact flow, unchanged.
   */
  consentGate?: ConsentGateOptions;
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
 *
 * Consent gate (design D5): when deps.consentGate is present the pipeline
 * starts WITHOUT the main STT stream and with the transcript tap locked —
 * no caller audio is transcribed, persisted, or announced. The call-start
 * flow opens an ephemeral reply-detection window via beginConsentPhase()
 * and unlocks normal operation with consentGrant() (or settles with
 * consentDecline() / cancelConsentPhase()); the ephemeral stream's output
 * feeds only the grant/decline classifier and the language vote and is
 * discarded. Without consentGate today's exact flow runs unchanged.
 */
export class VoicePipeline {
  private readonly log: Logger;
  private readonly sampleRateHz: number;
  private readonly playbackQueue: PlaybackQueue;
  private readonly vad = new EnergyVAD();

  private sttStream: SttStream | null = null;
  private activeTtsStream: TtsStream | null = null;
  private closed = false;

  /**
   * Consent phase state (gated start only): the ephemeral reply-detection
   * stream, null whenever no consent window is open. The main sttStream
   * above does not exist until consentGrant() runs.
   */
  private consentPhase: ConsentPhase | null = null;
  /** True once the consent phase settled (granted or declined); idempotence guard. */
  private consentSettled = false;
  /**
   * Transcript tap gate: in gated mode the onUtterance tap (the transcript
   * writer pipe) stays locked until consentGrant() so nothing — caller or
   * agent speech, e.g. a pre-grant notice — is persisted before consent.
   */
  private transcriptTapLocked: boolean;

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
    this.transcriptTapLocked = deps.consentGate !== undefined;
  }

  /** Subscribe to transport audio and open the initial (auto) STT stream. */
  start(): void {
    this.deps.transport.on("audio", this.onTransportAudio);
    this.deps.transport.on("hangup", this.onHangup);
    // Gated start (design D5): no main STT stream exists and the transcript
    // tap stays locked until the call-start flow drives consentGrant().
    if (this.transcriptTapLocked) return;
    this.startSttStream(this.deps.session.language);
  }

  /**
   * Lock the call language: store it on the session, tell the agent, and
   * restart the STT stream pinned to the language (or "auto" when null).
   * Under the consent gate the restart is deferred to consentGrant() — the
   * ephemeral window's language vote lands here as a pure state update.
   */
  setLanguage(lang: Language | null): void {
    this.deps.session.language = lang;
    this.deps.agent.setLanguage(lang);
    if (this.transcriptTapLocked) return; // no main stream may exist pre-grant
    this.startSttStream(lang);
  }

  /* ------------------------------------------------- consent phase API (D5) */

  /**
   * Open the ephemeral consent-reply window: a short-lived STT stream whose
   * recognized utterances feed ONLY the grant/decline classifier and the
   * language vote — never a TranscriptWriter, the session transcript,
   * conversation history, or transcript announcements. Idempotent and
   * restartable (a previous window, e.g. one torn down by barge-in, is
   * closed first), so the call-start flow can re-ask after an unclear reply.
   *
   * The pipeline reports decisions but never acts on them: the flow drives
   * consentGrant()/consentDecline() (task 4.2). No-op on an ungated
   * pipeline, after consentGrant()/consentDecline(), or after close().
   */
  beginConsentPhase(handlers: ConsentPhaseHandlers = {}): void {
    if (this.closed || this.consentSettled) return;
    if (this.deps.consentGate === undefined) return;
    this.endConsentPhase(); // restartable: drop any previous window
    const language: SttLanguage = this.deps.consentGate.initialLanguage ?? "auto";
    const stream = this.deps.stt.startStream({ language, sampleRateHz: this.sampleRateHz });
    const phase: ConsentPhase = { stream, handlers, decided: false };
    this.consentPhase = phase;
    stream.on((e: SttEvent) => this.onConsentSttEvent(phase, e));
    this.log.debug({ callSid: this.deps.session.callSid }, "consent_phase_begin");
  }

  /**
   * Unlock normal operation: close + discard the ephemeral stream, THEN
   * open the main STT stream (pinned to the session language, which the
   * consent language vote may have set) and attach the transcript tap.
   * Everything after this point is today's unchanged flow. No-op when
   * already settled or ungated.
   */
  consentGrant(): void {
    if (this.closed || this.consentSettled) return;
    if (this.deps.consentGate === undefined) return;
    this.consentSettled = true;
    this.endConsentPhase(); // the ephemeral stream is closed and discarded
    this.transcriptTapLocked = false; // transcript writer attaches here
    this.startSttStream(this.deps.session.language);
    this.log.info({ callSid: this.deps.session.callSid }, "consent_granted");
  }

  /**
   * Settle the phase as declined: close the ephemeral stream, never open
   * the main STT stream, never attach the transcript tap — nothing about
   * this call is ever transcribed or persisted. No-op when already settled
   * or ungated.
   */
  consentDecline(): void {
    if (this.closed || this.consentSettled) return;
    if (this.deps.consentGate === undefined) return;
    this.consentSettled = true;
    this.endConsentPhase();
    this.log.info({ callSid: this.deps.session.callSid }, "consent_declined");
  }

  /**
   * Tear the ephemeral consent stream down without settling the phase —
   * the timeout-safe cancel. A later consentGrant() still unlocks normal
   * operation, and beginConsentPhase() can reopen a fresh window (the
   * re-ask path). No-op when no window is open.
   */
  cancelConsentPhase(): void {
    this.endConsentPhase();
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
    this.endConsentPhase(); // an open consent window is torn down cleanly
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
      // Before the consent grant the ephemeral window's stream (if open)
      // receives the audio; the main stream does not exist yet (D5).
      (this.sttStream ?? this.consentPhase?.stream)?.write(pcm);
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

  /**
   * Ephemeral consent-window transcript event. Finalized replies feed the
   * language vote (D5 double duty) and the grant/decline classifier; they
   * are never announced, never stored, and never shown as live captions —
   * before consent no transcript exists anywhere. Partials are ignored.
   */
  private readonly onConsentSttEvent = (phase: ConsentPhase, e: SttEvent): void => {
    if (this.closed || this.consentPhase !== phase || phase.decided) return;
    if (e.type !== "final") return;
    try {
      const utterance: ConsentUtterance = {
        text: e.text,
        language: e.language ?? null,
        confidence: e.confidence,
        // Same wall-clock → call-relative normalization as handleFinal.
        atMs: Math.max(0, e.atMs - this.deps.session.startedAt),
      };
      this.applyConsentLanguageVote(phase, utterance);
      void this.decideConsentReply(phase, utterance);
    } catch (err) {
      this.reportError(err);
    }
  };

  /**
   * Feed one consent-window reply through the same language path the first
   * normal utterance takes (injected from the composition root). A detected
   * language is applied to session + agent immediately — the greeting after
   * the grant is spoken in the caller's language — but cannot touch the
   * main STT stream, which does not exist until consentGrant().
   */
  private applyConsentLanguageVote(phase: ConsentPhase, u: ConsentUtterance): void {
    const vote = this.deps.consentGate?.languageVote;
    if (!vote) return;
    void vote(u.text, { language: u.language ?? undefined, confidence: u.confidence })
      .then((detected) => {
        if (this.closed || this.consentPhase !== phase) return;
        if (detected === null || detected === this.deps.session.language) return;
        // setLanguage is a pure state update while gated (see above).
        this.setLanguage(detected);
      })
      .catch((err: unknown) => this.reportError(err, "llm"));
  }

  /**
   * Classify one consent-window reply and report it. "unclear" is reported
   * via onReply only (the re-ask loop is the call-start flow's decision);
   * definitive verdicts additionally fire onDecision exactly once. A
   * classifier failure is fail-closed to "unclear" — ambiguity never grants.
   */
  private async decideConsentReply(phase: ConsentPhase, u: ConsentUtterance): Promise<void> {
    const gate = this.deps.consentGate;
    if (!gate) return;
    let verdict: ConsentVerdict;
    try {
      verdict = await gate.classifier.decide(u.text, this.deps.session.language);
    } catch (err) {
      this.reportError(err, "llm");
      verdict = "unclear";
    }
    if (this.closed || this.consentPhase !== phase || phase.decided) return;
    const reply: ConsentReply = { ...u, verdict };
    phase.handlers.onReply?.(reply);
    if (verdict === "unclear") return;
    phase.decided = true;
    phase.handlers.onDecision?.(verdict === "affirmative" ? "granted" : "declined", u);
  }

  /** Close + discard the ephemeral stream; the phase object becomes stale. */
  private endConsentPhase(): void {
    const phase = this.consentPhase;
    this.consentPhase = null;
    if (phase) void phase.stream.close();
  }

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
    // Structural invariant: no caller final is ever processed before the
    // consent grant — the main stream does not exist until consentGrant(),
    // and this guard holds even if one were somehow opened pre-grant.
    if (this.transcriptTapLocked) return;
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
      // The agent wraps the LLM client, so reply-consumption failures are
      // the LLM error category; everything else defaults to "pipeline".
      this.reportError(err, "llm");
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
          const report = this.tracker.report();
          logTurn(this.tracker, this.log, {
            callSid: this.deps.session.callSid,
            turn: this.turnCount,
            sentence: sentenceIndex,
          });
          // Feed the finished turn's four stage durations into the process
          // metrics rings (design D10); no-op when no registry is wired.
          if (report) this.deps.metrics?.recordTurnLatency(report);
        }
      } catch (err) {
        this.reportError(err);
      }
    });
    ttsStream.events.on("done", () => {
      if (this.activeTtsStream === ttsStream) this.activeTtsStream = null;
    });
    ttsStream.events.on("error", (err: Error) => {
      // Provider/socket failures on a media stream are the "stream" category.
      this.reportError(err, "stream");
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
    // Gated start: nothing is persisted before the consent grant — this
    // includes a notice/greeting spoken pre-grant (D5: the transcript
    // writer is not attached until then).
    if (this.transcriptTapLocked) return;
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
    // A caller interrupting during the consent window tears the ephemeral
    // stream down cleanly; the flow can beginConsentPhase() again to re-ask.
    this.endConsentPhase();
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
  private reportError(err: unknown, category: ErrorCategory = "pipeline"): void {
    this.deps.metrics?.incrementError(category);
    this.log.error({ callSid: this.deps.session.callSid, err }, "voice_pipeline_error");
    this.deps.transport.announce({ type: "status", text: "error" });
  }
}
