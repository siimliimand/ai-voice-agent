/**
 * ConversationManager: per-call conversation agent backed by the OpenRouter
 * streaming chat API. It owns the chat history for one call and implements
 * the ConversationAgent contract consumed by the voice pipeline
 * (src/pipeline/voice-pipeline.ts). The interface below mirrors the
 * pipeline's definition exactly, so this class satisfies it structurally
 * without a compile-time dependency on the pipeline module.
 *
 * Turn state machine (design D4 + D6):
 *
 *   utterance ──▶ [pending confirmation?] ── yes ─▶ classify reply (keywords,
 *         │                                        utility tiebreaker)
 *         │            ├─ affirmative ─▶ dispatch(confirmed) ─▶ loop ─▶ model
 *         │            │                speaks the outcome
 *         │            ├─ decline ─────▶ mark cancelled in history ─▶ loop
 *         │            ├─ unclear (1st) ▶ re-ask once, end turn (still pending)
 *         │            └─ unclear (2nd) ▶ mark cancelled in history ─▶ loop
 *         ▼ no
 *   [stream loop, ≤ skills.maxToolIterations tool phases]
 *         ├─ spoken reply            ▶ yield deltas to TTS (today's path)
 *         ├─ tool_calls              ▶ assistant(+tool_calls) → dispatch →
 *         │                            role:"tool" results → re-stream
 *         │    ├─ escalate_to_human (builtin, D7) ▶ handler records + speaks
 *         │    │    the announcement + hangs up → turn ends
 *         │    └─ requires_confirmation and nothing pending ▶ synthetic
 *         │      awaiting marker → spoken question → pending state → end turn
 *         └─ bound / refusal / error ▶ fixed spoken fallback, end turn
 *
 *   barge-in at any point aborts the loop via the existing abort controller;
 *   an in-flight dispatch result still appends to history (context kept) but
 *   is never spoken, and a pending confirmation is cancelled.
 */
import type { AppConfig } from "../config/schema.js";
import type {
  ChatMessage,
  CompletedToolCall,
  OpenRouterClient,
  ToolCallRequest,
  ToolDefinition,
} from "../llm/openrouter.js";
import { resolveModel } from "../llm/resolve-model.js";
import type { Logger } from "../logging.js";
import type { Language } from "../types.js";
import { AffirmationClassifier, type AffirmationClassifierDeps } from "./affirmation.js";
import type { AgentEventAudit } from "./call-event-audit.js";
import type { LanguageManager } from "./language-manager.js";
import {
  getConfirmationQuestion,
  getConfirmationReask,
  getGreeting,
  getSystemPrompt,
  getToolFallback,
} from "./prompts/index.js";
import type { DispatchResult, SkillDispatcher, SkillRegistry } from "../skills/index.js";

/** Conversation half of the voice pipeline (see src/pipeline/voice-pipeline.ts). */
export interface ConversationAgent {
  handleUtterance(text: string, language: Language | null): AsyncIterable<string>;
  onBargeIn(): void;
  setLanguage(language: Language | null): void;
  close(): void;
}

/** The skills stack wired into one call (design D1–D4); absent → no tools. */
export interface SkillLoopDeps {
  registry: SkillRegistry;
  /**
   * Skill dispatcher; absent (e.g. degraded mode without persistence) →
   * manifest skills are not offered and invocations refuse fail-closed.
   */
  dispatcher?: SkillDispatcher;
  /**
   * Numeric call id for the dispatcher's audit rows, resolved at dispatch
   * time (the calls row is inserted asynchronously at call start).
   */
  callId?: () => number | undefined;
  /** call_events auditor for confirmation outcomes (design D6). */
  audit?: AgentEventAudit;
  /** Classifier override (tests); defaults to keywords + utility tiebreaker. */
  classifier?: AffirmationClassifier;
  /**
   * Built-in escalation (design D7): invoked by the loop when the model calls
   * `escalate_to_human` — never through the dispatcher. Provided by the
   * composition root; present → the builtin tool is offered to the model even
   * with an empty skills directory.
   */
  escalate?: EscalationHandler;
}

/** Model-supplied escalation arguments (design D7); the reason is optional. */
export interface EscalationRequest {
  reason?: string;
}

/**
 * Escalation trigger implemented by the composition root (db rows, session
 * flag, announcement, hangup). Errors are the handler's to log — the loop
 * ends the turn regardless.
 */
export type EscalationHandler = (request: EscalationRequest) => Promise<void>;

export interface ConversationManagerDeps {
  config: AppConfig;
  llm: OpenRouterClient;
  language: LanguageManager;
  logger?: Logger;
  /** Skills stack (design D4/D6). Absent or empty registry → today's path. */
  skills?: SkillLoopDeps;
}

/** History cap in messages; the system prompt at index 0 is always kept. */
const MAX_HISTORY_MESSAGES = 40;
const CONVERSATION_TEMPERATURE = 0.7;
const CONVERSATION_MAX_TOKENS = 300;

const LANGUAGE_NAMES: Record<Language, string> = {
  et: "Estonian",
  ru: "Russian",
  en: "English",
};

/** Synthetic tool result left while a gated skill awaits the caller's yes. */
const AWAITING_CONFIRMATION = { status: "awaiting_user_confirmation" } as const;
/** Synthetic tool result recorded when the caller does not confirm. */
const CANCELLED_BY_USER = { status: "cancelled_by_user" } as const;
/** Synthetic tool result left while the escalation handler runs (design D7). */
const ESCALATING = { status: "escalating" } as const;

/**
 * Built-in escalation tool (design D7): code-owned, NOT a skill from the
 * skills directory. The loop recognizes it by name and never dispatches it;
 * the LLM-facing description mirrors the escalation guidance already in the
 * system prompts (task 3.4).
 */
export const ESCALATE_TO_HUMAN = "escalate_to_human";
const ESCALATION_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: ESCALATE_TO_HUMAN,
    description:
      "Hand this phone call over to a human colleague. Use it when the caller asks " +
      "for a person or when the request exceeds what you can do. The call ends " +
      "after the handover; do not call any other tool afterwards.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short free-text reason for the handover, for the audit log and the call note.",
        },
      },
      additionalProperties: false,
    },
  },
};

/** Per-session pending confirmation (design D6). */
interface PendingConfirmation {
  skill: string;
  args: Record<string, unknown>;
  /** tool_call_id the real (or cancelled) result must answer. */
  toolCallId: string;
  askedAt: number;
  /** Unclear answers already re-asked; the second one cancels. */
  reasks: number;
}

export class ConversationManager implements ConversationAgent {
  private history: ChatMessage[];
  private currentLanguage: Language | null = null;
  private abort: AbortController | null = null;
  private closed = false;
  /** Confirmation-gated invocation awaiting the caller's next-turn reply. */
  private pendingConfirmation: PendingConfirmation | null = null;
  private readonly classifier: AffirmationClassifier;

  constructor(private readonly deps: ConversationManagerDeps) {
    // Default to the English persona until the language is locked.
    this.history = [{ role: "system", content: getSystemPrompt(this.currentLanguage) }];
    const classifierDeps: AffirmationClassifierDeps = {
      config: deps.config,
      llm: deps.llm,
      logger: deps.logger,
    };
    this.classifier = deps.skills?.classifier ?? new AffirmationClassifier(classifierDeps);
  }

  /** Opening utterance for the call, in the currently locked language. */
  async greeting(): Promise<string> {
    return this.greet();
  }

  /** Synchronous variant of greeting(). */
  greet(): string {
    return getGreeting(this.currentLanguage);
  }

  /** Currently locked conversation language, or null before setLanguage(). */
  get language(): Language | null {
    return this.currentLanguage;
  }

  /** Chat history snapshot (introspection for tests/pipeline summaries). */
  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  /** Pending confirmation (introspection for tests/dev), or null. */
  get pending(): Readonly<PendingConfirmation> | null {
    return this.pendingConfirmation;
  }

  /**
   * Switch the conversation language: rebuild the system prompt, drop an
   * explicit note into the history so replies follow immediately, and pin
   * the language on the LanguageManager (which fires the pipeline's
   * relock/voice-swap events). Null is a no-op: an unknown language never
   * un-locks a known one.
   */
  setLanguage(language: Language | null): void {
    if (language === null || language === this.currentLanguage || this.closed) return;
    const previous = this.currentLanguage;
    this.currentLanguage = language;
    this.history[0] = { role: "system", content: getSystemPrompt(language) };
    const name = LANGUAGE_NAMES[language];
    this.history.push({
      role: "system",
      content: `[client now speaks ${name}; reply in ${name} from now on]`,
    });
    this.deps.language.pin(language);
    this.deps.logger?.debug({ from: previous, to: language }, "conversation language switched");
  }

  /**
   * Handle one caller utterance: stream the assistant reply token by token,
   * running the multi-step tool loop (design D4) and the pending-confirmation
   * classifier (design D6) when the skills stack is wired. The per-utterance
   * language argument is informational; the locked language on this manager
   * (kept in sync via setLanguage) drives prompt and model.
   */
  async *handleUtterance(text: string, _language: Language | null): AsyncGenerator<string> {
    if (this.closed || text.trim() === "") return;
    // A new utterance implicitly interrupts anything still being spoken.
    this.abort?.abort();

    this.history.push({ role: "user", content: text });
    this.trimHistory();

    const controller = new AbortController();
    this.abort = controller;
    try {
      // D6 seam: a pending confirmation is classified BEFORE the LLM runs.
      if (this.pendingConfirmation !== null) {
        const done = yield* this.resolvePendingConfirmation(text, controller);
        if (done) return;
      }
      yield* this.conversationLoop(controller);
    } catch (error) {
      // Aborts during classification/dispatch end the turn silently; the
      // stream phase finalizes its own partial answers (below).
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      if (this.abort === controller) this.abort = null;
      this.trimHistory();
    }
  }

  /**
   * Caller started talking over the assistant: abort the in-flight stream and
   * cancel a pending confirmation (fail-closed — the question dies with the
   * interruption and is audit-logged as cancelled).
   */
  onBargeIn(): void {
    const pending = this.pendingConfirmation;
    if (pending !== null) {
      this.pendingConfirmation = null;
      this.replaceToolMessage(pending.toolCallId, cancelledMessage(pending.toolCallId));
      void this.auditConfirmation("confirmation_cancelled", pending.skill, "interrupted");
    }
    this.abort?.abort();
  }

  /** Abort any in-flight stream and drop the per-call history. */
  close(): void {
    this.closed = true;
    const pending = this.pendingConfirmation;
    if (pending !== null) {
      this.pendingConfirmation = null;
      void this.auditConfirmation("confirmation_cancelled", pending.skill, "call_ended");
    }
    this.abort?.abort();
    this.abort = null;
    this.history = [];
  }

  // ------------------------------------------------------------- the D4 loop

  /**
   * Stream → (dispatch tool calls → re-stream)* until a spoken reply, the
   * iteration bound, a refusal, or an abort ends the turn. With no tools
   * attached this is exactly the pre-tools single-pass streaming path.
   */
  private async *conversationLoop(controller: AbortController): AsyncGenerator<string> {
    const skills = this.deps.skills;
    // Tools attach when manifest skills are loaded OR the escalation builtin
    // is wired (design D7) — escalation works even with an empty skills
    // directory. With neither, the request body stays byte-identical to the
    // tool-free path. Skill tools additionally require a dispatcher (absent
    // in degraded mode), so unrunnable skills are never offered.
    const skillTools =
      skills !== undefined &&
      skills.dispatcher !== undefined &&
      skills.registry.size > 0
        ? skills.registry.listTools()
        : [];
    const escalationEnabled = skills?.escalate !== undefined;
    const tools =
      skillTools.length > 0 || escalationEnabled
        ? [...skillTools, ...(escalationEnabled ? [ESCALATION_TOOL] : [])]
        : undefined;
    const maxToolPhases =
      tools !== undefined ? this.deps.config.skills.maxToolIterations : 0;
    let toolPhases = 0;

    for (;;) {
      let partial = "";
      let completed: CompletedToolCall[] | undefined;
      try {
        const stream = this.deps.llm.chatStream({
          model: resolveModel(this.deps.config, "conversation", this.currentLanguage),
          messages: [...this.history],
          temperature: CONVERSATION_TEMPERATURE,
          maxTokens: CONVERSATION_MAX_TOKENS,
          signal: controller.signal,
          ...(tools !== undefined ? { tools } : {}),
        });
        for await (const delta of stream) {
          if (delta.completedToolCalls !== undefined) completed = delta.completedToolCalls;
          if (delta.content === undefined) continue;
          partial += delta.content;
          yield delta.content;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          // Caller barged in: keep the partial answer as context so the model
          // does not lose track of what it already said.
          this.finalizeInterrupted(partial);
          return;
        }
        if (partial !== "") this.history.push({ role: "assistant", content: partial });
        throw error;
      }

      if (completed === undefined || completed.length === 0) {
        // Plain spoken turn.
        if (partial !== "") this.history.push({ role: "assistant", content: partial });
        return;
      }

      // Tool phase: record what the model asked for before anything runs.
      this.history.push({
        role: "assistant",
        content: partial,
        tool_calls: completed.map(completedToolCallToRequest),
      });
      if (skills === undefined) return; // tool calls without a skills stack: nothing to run

      const ended = yield* this.runToolPhase(completed, skills, controller);
      if (ended) return;

      toolPhases += 1;
      if (toolPhases >= maxToolPhases) {
        // Bound reached: stop looping, hand off with the fixed fallback
        // (the model still sees every tool result in its history).
        yield* this.speakFixed(getToolFallback(this.currentLanguage));
        return;
      }
    }
  }

  /**
   * Run one tool phase: every model-requested call ends up with exactly one
   * role:"tool" result, whatever happens (OpenAI protocol requires it).
   *
   * - Plain calls dispatch immediately; a refusal/failure speaks the fixed
   *   fallback and ends the turn (the error result stays in history so the
   *   model can recover next turn).
   * - The FIRST confirmation-gated call is intercepted (D6): it never
   *   executes — a synthetic awaiting marker keeps the protocol valid, the
   *   caller is asked, and the turn ends with per-session pending state.
   *   Everything after the gate (or after a failure) is not run this turn and
   *   gets a synthetic skipped marker instead.
   * - `escalate_to_human` is the built-in (D7): recognized by name, never
   *   dispatched — the wired handler records + speaks + hangs up, a synthetic
   *   escalating marker keeps the protocol valid, and the turn ends.
   * - A barge-in mid-phase stops further dispatches; the in-flight result is
   *   kept in history but never spoken.
   *
   * Returns true when the turn must end.
   */
  private async *runToolPhase(
    calls: CompletedToolCall[],
    skills: SkillLoopDeps,
    controller: AbortController,
  ): AsyncGenerator<string, boolean> {
    let parked: PendingConfirmation | null = null;
    let stop: "refusal" | "aborted" | "escalated" | null = null;

    for (const call of calls) {
      if (parked !== null || stop !== null) {
        // Not run this turn; a marker keeps one result per tool_call_id so
        // the next request stays protocol-valid.
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({
            status:
              parked !== null
                ? "cancelled_pending_confirmation"
                : stop === "escalated"
                  ? "cancelled_after_escalation"
                  : "cancelled_after_error",
          }),
        });
        continue;
      }

      if (call.name === ESCALATE_TO_HUMAN) {
        const handler = skills.escalate;
        if (handler === undefined) {
          // No handler wired: refuse like a dispatcher rejection so the
          // model can recover on the next turn.
          this.history.push({
            role: "tool",
            tool_call_id: call.id,
            content: `Tool '${ESCALATE_TO_HUMAN}' is not available on this line.`,
          });
          stop = "refusal";
          continue;
        }
        // Synthetic result first (protocol validity), then the handler —
        // it records, speaks the announcement and hangs up (fire-and-forget:
        // its errors are logged there, and here, but never thrown onward).
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(ESCALATING),
        });
        const request = escalationRequestOf(call);
        try {
          await handler(request);
        } catch (err) {
          this.deps.logger?.error({ err, reason: request.reason }, "escalation handler failed");
        }
        stop = "escalated";
        continue;
      }

      const skill = skills.registry.get(call.name);
      if (skill?.manifest.policies.requires_confirmation === true) {
        const parsed = parseToolArguments(call.name, call.arguments);
        if (!parsed.ok) {
          this.history.push({ role: "tool", tool_call_id: call.id, content: parsed.error });
          stop = "refusal";
          continue;
        }
        parked = {
          skill: call.name,
          args: parsed.args,
          toolCallId: call.id,
          askedAt: Date.now(),
          reasks: 0,
        };
        this.pendingConfirmation = parked;
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(AWAITING_CONFIRMATION),
        });
        continue;
      }

      const result = await this.runDispatcher(call, skills, {});
      if (controller.signal.aborted) {
        // In-flight result kept in history (context kept) but never spoken;
        // remaining calls are skipped below.
        stop = "aborted";
      } else if (result.outcome !== "executed") {
        stop = "refusal";
      }
    }

    if (parked !== null) {
      this.deps.logger?.debug({ skill: parked.skill }, "confirmation question pending");
      yield* this.speakFixed(
        getConfirmationQuestion(this.currentLanguage, summarizeArgs(parked.args)),
      );
      return true;
    }
    if (stop === "refusal") {
      yield* this.speakFixed(getToolFallback(this.currentLanguage));
      return true;
    }
    return stop !== null; // "aborted"/"escalated" end the turn; null continues the loop
  }

  /**
   * Run the dispatcher for one completed tool call and append (or replace)
   * the role:"tool" result. Malformed argument JSON is passed through as the
   * raw string so the dispatcher validates, refuses, and audits it.
   */
  private async runDispatcher(
    call: CompletedToolCall,
    skills: SkillLoopDeps,
    opts: { confirmed?: boolean; replacesPending?: PendingConfirmation } = {},
  ): Promise<DispatchResult> {
    const parsed = parseToolArguments(call.name, call.arguments);
    const messageFor = (content: string): ChatMessage => ({
      role: "tool",
      tool_call_id: call.id,
      content,
    });
    const record = (message: ChatMessage): void => {
      if (opts.replacesPending === undefined) {
        this.history.push(message);
      } else {
        // One tool result per tool_call_id: the synthetic awaiting marker is
        // replaced in place by the real outcome.
        this.replaceToolMessage(opts.replacesPending.toolCallId, message);
      }
    };

    const dispatcher = skills.dispatcher;
    if (dispatcher === undefined) {
      // Degraded mode (no persistence): no skill can run — fail closed with
      // a descriptive result instead of offering/dropping the call silently.
      const result: DispatchResult = {
        outcome: "unknown_skill",
        result: `Skill '${call.name}' is not available on this line.`,
      };
      record(messageFor(result.result));
      return result;
    }

    const callId = skills.callId?.() ?? 0;
    const result = await dispatcher.dispatch(
      callId,
      { name: call.name, arguments: parsed.ok ? parsed.args : call.arguments },
      opts.confirmed === true ? { confirmed: true } : {},
    );
    record(messageFor(result.result));
    return result;
  }

  // ------------------------------------------------- the D6 confirmation seam

  /**
   * Resolve a pending confirmation with the caller's reply — before the LLM
   * sees the turn. Affirmative re-dispatches with the confirmation flag and
   * continues the loop (the model speaks the outcome); a decline or a second
   * unclear answer cancels and continues the loop (the model reads the
   * cancellation from history); one unclear answer re-asks and ends the turn.
   * Returns true when the turn ends here.
   */
  private async *resolvePendingConfirmation(
    answer: string,
    controller: AbortController,
  ): AsyncGenerator<string, boolean> {
    const skills = this.deps.skills;
    const pending = this.pendingConfirmation;
    if (skills === undefined || pending === null) return false;

    const verdict = await this.classifier.decide(answer, this.currentLanguage ?? "en");

    // A barge-in while classifying already cleared (and cancelled) the
    // pending dispatch — this utterance runs as a plain turn instead.
    if (this.pendingConfirmation !== pending) return false;
    if (controller.signal.aborted) return true;

    if (verdict === "affirmative") {
      this.pendingConfirmation = null;
      await this.auditConfirmation("confirmation_confirmed", pending.skill);
      const result = await this.runDispatcher(
        {
          id: pending.toolCallId,
          name: pending.skill,
          arguments: JSON.stringify(pending.args),
        },
        skills,
        { confirmed: true, replacesPending: pending },
      );
      if (controller.signal.aborted) return true; // result kept, never spoken
      if (result.outcome !== "executed") {
        yield* this.speakFixed(getToolFallback(this.currentLanguage));
        return true;
      }
      return false; // the loop re-streams so the model speaks the outcome
    }

    if (verdict === "decline") {
      this.cancelPending(pending, "declined");
      return false;
    }

    // Unclear: re-ask once, then cancel — ambiguity never dispatches.
    if (pending.reasks >= 1) {
      this.cancelPending(pending, "unclear");
      return false;
    }
    pending.reasks += 1;
    pending.askedAt = Date.now();
    this.deps.logger?.debug({ skill: pending.skill }, "confirmation re-ask after unclear reply");
    yield* this.speakFixed(
      getConfirmationReask(this.currentLanguage, summarizeArgs(pending.args)),
    );
    return true;
  }

  /** Fail-closed cancellation: swap the marker and audit the outcome. */
  private cancelPending(pending: PendingConfirmation, reason: string): void {
    this.pendingConfirmation = null;
    this.replaceToolMessage(pending.toolCallId, cancelledMessage(pending.toolCallId));
    void this.auditConfirmation("confirmation_cancelled", pending.skill, reason);
  }

  /** Fire-and-forget confirmation audit; failures never hit the audio path. */
  private async auditConfirmation(
    type: string,
    skill: string,
    reason?: string,
  ): Promise<void> {
    const audit = this.deps.skills?.audit;
    if (!audit) return;
    try {
      await audit(type, reason !== undefined ? { skill, reason } : { skill });
    } catch (err) {
      this.deps.logger?.error({ err, type, skill }, "confirmation audit write failed");
    }
  }

  // ------------------------------------------------------------- internals

  /** Speak one fixed agent sentence and record it as the assistant's turn. */
  private async *speakFixed(text: string): AsyncGenerator<string> {
    yield text;
    this.history.push({ role: "assistant", content: text });
  }

  /** Overwrite a tool result in place (one result per tool_call_id). */
  private replaceToolMessage(toolCallId: string, message: ChatMessage): void {
    const index = this.history.findIndex(
      (m) => m.role === "tool" && m.tool_call_id === toolCallId,
    );
    if (index >= 0) this.history[index] = message;
    else this.history.push(message);
  }

  /** Record an interrupted partial answer so the context is not lost. */
  private finalizeInterrupted(partial: string): void {
    if (partial.trim() === "") return;
    this.history.push({ role: "assistant", content: `${partial} [interrupted by caller]` });
  }

  /**
   * Cap history to the last N messages, always keeping the system prompt.
   * Slicing can orphan `role:"tool"` results (their assistant tool_calls
   * message was cut) — drop leading orphans so the OpenAI message protocol
   * stays valid on the next request.
   */
  private trimHistory(): void {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    const system = this.history[0];
    if (system === undefined) return;
    this.history = [system, ...this.history.slice(-(MAX_HISTORY_MESSAGES - 1))];
    while (this.history[1]?.role === "tool") this.history.splice(1, 1);
  }
}

/* -------------------------------------------------------------- helpers */

/** OpenAI request shape for a completed tool call. */
function completedToolCallToRequest(call: CompletedToolCall): ToolCallRequest {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}

/** Synthetic cancelled_by_user tool result for a parked tool_call_id. */
function cancelledMessage(toolCallId: string): ChatMessage {
  return { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(CANCELLED_BY_USER) };
}

/**
 * Extract the escalation request from a builtin tool call: the optional
 * `reason` string, trimmed and capped (it goes into the audit event and the
 * note); malformed or missing arguments simply mean no reason.
 */
function escalationRequestOf(call: CompletedToolCall): EscalationRequest {
  const parsed = parseToolArguments(call.name, call.arguments);
  if (!parsed.ok) return {};
  const reason = parsed.args["reason"];
  if (typeof reason !== "string") return {};
  const trimmed = reason.trim();
  return trimmed === "" ? {} : { reason: trimmed.slice(0, 200) };
}

type ParsedToolArguments =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/** Parse a tool-call arguments string defensively; "" counts as no arguments. */
function parseToolArguments(name: string, raw: string): ParsedToolArguments {
  const text = raw.trim();
  if (text === "") return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `Invalid arguments for tool '${name}': arguments are not valid JSON.` };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return { ok: true, args: parsed as Record<string, unknown> };
  }
  return {
    ok: false,
    error: `Invalid arguments for tool '${name}': arguments must be a JSON object.`,
  };
}

/**
 * Short spoken restatement of confirmed arguments (date, time, service…):
 * string/number values joined, capped so the yes/no question stays short.
 */
function summarizeArgs(args: Record<string, unknown>): string {
  return Object.values(args)
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map((value) => String(value))
    .slice(0, 4)
    .join(", ");
}
