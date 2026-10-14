/**
 * ConversationManager tool-loop + pending-confirmation tests (M4 tasks 3.2
 * and 3.3): fake LLM (scripted SSE-shaped deltas), fake dispatcher and a
 * scripted classifier — no network, no database.
 */
import { describe, expect, it, vi } from "vitest";
import type { AffirmationClassifier, AffirmationVerdict } from "../../src/agent/affirmation.js";
import {
  ConversationManager,
  type EscalationRequest,
} from "../../src/agent/conversation-manager.js";
import type { AgentEventAudit } from "../../src/agent/call-event-audit.js";
import { LanguageManager } from "../../src/agent/language-manager.js";
import {
  getConfirmationQuestion,
  getConfirmationReask,
  getToolFallback,
} from "../../src/agent/prompts/index.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type {
  ChatOptions,
  ChatStreamOptions,
  CompletedToolCall,
  OpenRouterClient,
  StreamDelta,
} from "../../src/llm/openrouter.js";
import type {
  DispatchResult,
  SkillDispatcher,
  SkillInvocation,
  SkillRegistry,
} from "../../src/skills/index.js";

const baseConfig: AppConfig = configSchema.parse({
  llm: { models: { conversation: "prov/conv", summarizer: "prov/sum", utility: "prov/util" } },
});

const boundConfig: AppConfig = configSchema.parse({
  llm: { models: { conversation: "prov/conv", summarizer: "prov/sum", utility: "prov/util" } },
  skills: { maxToolIterations: 2 },
});

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Consume a handleUtterance() stream fully and collect the deltas. */
async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

/** One completed tool call with JSON-encoded arguments. */
function toolCall(id: string, name: string, args: Record<string, unknown>): CompletedToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

/** Stream impl that ends with finish_reason "tool_calls" + the given calls. */
function toolPhase(calls: CompletedToolCall[]) {
  return async function* (opts: ChatStreamOptions): AsyncGenerator<StreamDelta> {
    if (opts.signal?.aborted) throw abortError();
    yield {
      toolCalls: calls.map((c, index) => ({
        index,
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
    yield { finishReason: "tool_calls", completedToolCalls: calls };
  };
}

/** Stream impl for a plain spoken reply. */
function spoken(text: string) {
  return async function* (opts: ChatStreamOptions): AsyncGenerator<StreamDelta> {
    if (opts.signal?.aborted) throw abortError();
    yield { content: text };
    yield { finishReason: "stop" };
  };
}

/** Registry double: the manager only reads size, listTools() and get(). */
function fakeRegistry(
  skills: Array<{ name: string; requiresConfirmation?: boolean }>,
): SkillRegistry {
  const loaded = skills.map((s) => ({
    manifest: {
      name: s.name,
      description: `${s.name} skill`,
      parameters: { type: "object", properties: {} },
      execution: "http" as const,
      endpoint: "stub",
      policies: { requires_confirmation: s.requiresConfirmation === true },
    },
    validateArguments: (() => true) as never,
  }));
  return {
    get size() {
      return loaded.length;
    },
    listTools: () =>
      loaded.map((s) => ({
        type: "function" as const,
        function: { name: s.manifest.name, parameters: s.manifest.parameters },
      })),
    get: (name: string) => loaded.find((s) => s.manifest.name === name),
    all: () => [...loaded],
  } as unknown as SkillRegistry;
}

/** Classifier double returning the scripted verdicts in order. */
function fakeClassifier(...verdicts: AffirmationVerdict[]): {
  decide: ReturnType<typeof vi.fn>;
} {
  const queue = [...verdicts];
  return {
    decide: vi.fn(async (_answer: string, _language: string): Promise<AffirmationVerdict> => {
      const next = queue.shift() ?? verdicts.at(-1);
      if (next === undefined) throw new Error("test setup: no classifier verdict scripted");
      return next;
    }),
  };
}

interface Harness {
  manager: ConversationManager;
  chatStream: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  escalate: ReturnType<typeof vi.fn>;
}

function makeHarness(options: {
  config?: AppConfig;
  streams: Array<(opts: ChatStreamOptions) => AsyncGenerator<StreamDelta>>;
  registry?: SkillRegistry;
  dispatchImpl?: (
    callId: number,
    invocation: SkillInvocation,
    opts?: { confirmed?: boolean },
  ) => Promise<DispatchResult>;
  classifier?: { decide: (answer: string, language: string) => Promise<AffirmationVerdict> };
  /** Builtin escalation handler override (task 5.1); vi.fn-backed. */
  escalateImpl?: (request: EscalationRequest) => Promise<void>;
}): Harness {
  const config = options.config ?? baseConfig;
  let streamIndex = 0;
  const chatStream = vi.fn((opts: ChatStreamOptions) => {
    const impl = options.streams[Math.min(streamIndex, options.streams.length - 1)];
    streamIndex += 1;
    if (impl === undefined) throw new Error("test setup: no stream scripted");
    return impl(opts);
  });
  const chat = vi.fn(async (_opts: ChatOptions) => '{"language":"et","confidence":0.9}');
  const llm = { chat, chatStream } as unknown as OpenRouterClient;
  const languageManager = new LanguageManager(config, llm);
  const dispatch = vi.fn(
    options.dispatchImpl ??
      (async (_callId: number, invocation: SkillInvocation): Promise<DispatchResult> => ({
        outcome: "executed",
        result: `ok:${invocation.name}`,
      })),
  );
  const audit = vi.fn(async (_type: string, _detail?: unknown): Promise<void> => undefined);
  const escalate = vi.fn(options.escalateImpl ?? (async (): Promise<void> => undefined));
  const manager = new ConversationManager({
    config,
    llm,
    language: languageManager,
    ...(options.registry === undefined && options.escalateImpl === undefined
      ? {}
      : {
          skills: {
            registry: options.registry ?? fakeRegistry([]),
            // Escalation-only wiring (no registry): no dispatcher, like the
            // composition root's degraded mode.
            ...(options.registry === undefined
              ? {}
              : { dispatcher: { dispatch } as unknown as SkillDispatcher }),
            callId: () => 42,
            audit: audit as unknown as AgentEventAudit,
            classifier: options.classifier as unknown as AffirmationClassifier,
            ...(options.escalateImpl === undefined
              ? {}
              : { escalate: escalate as unknown as (request: EscalationRequest) => Promise<void> }),
          },
        }),
  });
  return { manager, chatStream, dispatch, audit, escalate };
}

describe("ConversationManager tool loop (task 3.2)", () => {
  it("round-trips a tool call: dispatch → tool result → second stream speaks the result", async () => {
    const { manager, chatStream, dispatch } = makeHarness({
      streams: [
        toolPhase([toolCall("call_1", "find_slots", { date: "2026-05-01" })]),
        spoken("There are free slots on May the first."),
      ],
      registry: fakeRegistry([{ name: "find_slots" }]),
    });

    const chunks = await collect(manager.handleUtterance("Any free slots on May 1st?", null));

    expect(chunks).toEqual(["There are free slots on May the first."]);
    expect(chatStream).toHaveBeenCalledTimes(2);

    // The dispatcher got the parsed arguments and the wired call id.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      42,
      { name: "find_slots", arguments: { date: "2026-05-01" } },
      {},
    );

    // History: user → assistant(+tool_calls) → tool result → assistant reply.
    expect(manager.messages).toHaveLength(5);
    expect(manager.messages[2]).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "find_slots", arguments: '{"date":"2026-05-01"}' },
        },
      ],
    });
    expect(manager.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok:find_slots" });
    expect(manager.messages[4]).toEqual({ role: "assistant", content: "There are free slots on May the first." });

    // The re-stream saw the tool result and the tools array.
    const secondCall = chatStream.mock.calls[1]?.[0] as ChatStreamOptions;
    expect(secondCall.messages?.[3]).toMatchObject({ role: "tool", content: "ok:find_slots" });
    expect(secondCall.tools).toHaveLength(1);
  });

  it("dispatches multiple tool calls from one phase and answers each", async () => {
    const { manager, dispatch } = makeHarness({
      streams: [
        toolPhase([
          toolCall("call_a", "find_slots", { date: "2026-05-01" }),
          toolCall("call_b", "lookup_hours", { day: "friday" }),
        ]),
        spoken("We open at nine and have slots on May the first."),
      ],
      registry: fakeRegistry([{ name: "find_slots" }, { name: "lookup_hours" }]),
    });

    await collect(manager.handleUtterance("Hours and slots, please", null));

    expect(dispatch).toHaveBeenCalledTimes(2);
    const toolMessages = manager.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["call_a", "call_b"]);
    expect(toolMessages.map((m) => m.content)).toEqual(["ok:find_slots", "ok:lookup_hours"]);
  });

  it("stops at the iteration bound and speaks the fixed fallback", async () => {
    const { manager, chatStream, dispatch } = makeHarness({
      config: boundConfig, // maxToolIterations: 2
      streams: [
        toolPhase([toolCall("call_1", "find_slots", { date: "1" })]),
        toolPhase([toolCall("call_2", "find_slots", { date: "2" })]),
      ],
      registry: fakeRegistry([{ name: "find_slots" }]),
    });

    const chunks = await collect(manager.handleUtterance("Find me a slot", null));

    expect(chunks).toEqual([getToolFallback(null)]);
    expect(chatStream).toHaveBeenCalledTimes(2); // never a third stream
    expect(dispatch).toHaveBeenCalledTimes(2); // both phases still dispatched
    const last = manager.messages.at(-1);
    expect(last).toMatchObject({ role: "assistant", content: getToolFallback(null) });
  });

  it("keeps the exact pre-tools path on a tool-free turn (regression)", async () => {
    const { manager, chatStream } = makeHarness({
      streams: [spoken("Eks ma aita!")],
      registry: fakeRegistry([]), // skills wired but nothing loaded
    });

    const chunks = await collect(manager.handleUtterance("Tere, mul on küsimus", null));
    expect(chunks).toEqual(["Eks ma aita!"]);
    expect(chatStream).toHaveBeenCalledTimes(1);

    const call = chatStream.mock.calls[0]?.[0] as ChatStreamOptions;
    expect(call.tools).toBeUndefined(); // identical request shape to pre-M4
    expect(call.messages).toHaveLength(2); // system + user only
    expect(manager.messages).toHaveLength(3); // + assistant reply
  });

  it("barge-in mid-loop cancels the re-stream; the in-flight result is kept but never spoken", async () => {
    let release!: (result: DispatchResult) => void;
    const gated = new Promise<DispatchResult>((resolve) => {
      release = resolve;
    });
    const { manager, chatStream, dispatch } = makeHarness({
      streams: [toolPhase([toolCall("call_1", "find_slots", { date: "1" })]), spoken("never")],
      registry: fakeRegistry([{ name: "find_slots" }]),
      dispatchImpl: () => gated,
    });

    const chunks: string[] = [];
    const consumer = (async () => {
      for await (const chunk of manager.handleUtterance("Find a slot", null)) chunks.push(chunk);
    })();

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    manager.onBargeIn(); // caller talks over the (silent) tool phase
    release({ outcome: "executed", result: "Slot at ten." });
    await consumer;

    expect(chatStream).toHaveBeenCalledTimes(1); // pending re-stream was cancelled
    expect(chunks).toEqual([]); // nothing spoken after the abort
    const tool = manager.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("Slot at ten."); // context kept in history
  });

  it("speaks the fixed fallback when the dispatcher reports an error outcome", async () => {
    const { manager, chatStream } = makeHarness({
      streams: [toolPhase([toolCall("call_1", "find_slots", { date: "1" })]), spoken("never")],
      registry: fakeRegistry([{ name: "find_slots" }]),
      dispatchImpl: async () => ({
        outcome: "execution_error",
        result: "Skill 'find_slots' failed: boom",
      }),
    });

    const chunks = await collect(manager.handleUtterance("Find a slot", null));

    expect(chunks).toEqual([getToolFallback(null)]);
    expect(chatStream).toHaveBeenCalledTimes(1); // turn ends on the refusal
    const tool = manager.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("Skill 'find_slots' failed: boom");
  });

  it("routes malformed argument JSON through the dispatcher as a refusal", async () => {
    const raw = toolCall("call_1", "find_slots", {});
    raw.arguments = "{not json";
    const { manager, dispatch } = makeHarness({
      streams: [toolPhase([raw]), spoken("never")],
      registry: fakeRegistry([{ name: "find_slots" }]),
      dispatchImpl: async (_callId, invocation) => ({
        outcome: "validation_error",
        result: `Invalid arguments for skill '${invocation.name}': arguments must be a JSON object.`,
      }),
    });

    const chunks = await collect(manager.handleUtterance("Find a slot", null));

    expect(chunks).toEqual([getToolFallback(null)]);
    expect(dispatch).toHaveBeenCalledWith(42, { name: "find_slots", arguments: "{not json" }, {});
  });
});

describe("ConversationManager confirmation loop (task 3.3)", () => {
  const confirmRegistry = () => fakeRegistry([{ name: "book_appointment", requiresConfirmation: true }]);

  it("intercepts a confirmation-gated call: asks, parks pending state, ends the turn", async () => {
    const { manager, chatStream, dispatch, audit } = makeHarness({
      streams: [toolPhase([toolCall("call_1", "book_appointment", { date: "Friday", service: "cleaning" })])],
      registry: confirmRegistry(),
      classifier: fakeClassifier("affirmative"),
    });

    const chunks = await collect(manager.handleUtterance("Book a cleaning for Friday", null));

    // The spoken question restates the arguments; nothing else is said.
    expect(chunks).toEqual([getConfirmationQuestion(null, "Friday, cleaning")]);
    expect(chatStream).toHaveBeenCalledTimes(1); // no re-stream in the same turn
    expect(dispatch).not.toHaveBeenCalled();

    expect(manager.pending).toMatchObject({
      skill: "book_appointment",
      args: { date: "Friday", service: "cleaning" },
      toolCallId: "call_1",
      reasks: 0,
    });
    const tool = manager.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe(JSON.stringify({ status: "awaiting_user_confirmation" }));
    expect(audit).not.toHaveBeenCalled();
  });

  it("dispatches with confirmed:true on an affirmative next-turn reply and speaks the outcome", async () => {
    const { manager, chatStream, dispatch, audit } = makeHarness({
      streams: [
        toolPhase([toolCall("call_1", "book_appointment", { date: "Friday" })]),
        spoken("You are booked for Friday."),
      ],
      registry: confirmRegistry(),
      classifier: fakeClassifier("affirmative"),
    });

    await collect(manager.handleUtterance("Book me for Friday", null));
    const chunks = await collect(manager.handleUtterance("Jah", null));

    expect(chunks).toEqual(["You are booked for Friday."]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      42,
      { name: "book_appointment", arguments: { date: "Friday" } },
      { confirmed: true },
    );
    expect(manager.pending).toBeNull();
    expect(audit).toHaveBeenCalledWith("confirmation_confirmed", { skill: "book_appointment" });

    // The awaiting marker was replaced in place by the real tool result.
    const toolMessages = manager.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({ tool_call_id: "call_1", content: "ok:book_appointment" });
    const secondCall = chatStream.mock.calls[1]?.[0] as ChatStreamOptions;
    const toolInRequest = secondCall.messages?.find((m) => m.role === "tool");
    expect(toolInRequest).toMatchObject({ tool_call_id: "call_1", content: "ok:book_appointment" });
  });

  it("keeps one tool result per call in a mixed phase (gated + non-gated)", async () => {
    // Gate first: the plain call after it must not execute and still get a
    // result, so the next request stays protocol-valid.
    const { manager, dispatch } = makeHarness({
      streams: [
        toolPhase([
          toolCall("call_1", "book_appointment", { date: "Friday" }),
          toolCall("call_2", "lookup_hours", { day: "friday" }),
        ]),
        spoken("How else can I help?"),
      ],
      registry: fakeRegistry([
        { name: "book_appointment", requiresConfirmation: true },
        { name: "lookup_hours" },
      ]),
      classifier: fakeClassifier("affirmative"),
    });

    const chunks = await collect(manager.handleUtterance("Book Friday and tell me hours", null));

    expect(chunks).toEqual([getConfirmationQuestion(null, "Friday")]);
    expect(dispatch).not.toHaveBeenCalled(); // gate stops the whole phase
    const toolMessages = manager.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2); // every tool_call answered
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(toolMessages[1]?.content).toBe(
      JSON.stringify({ status: "cancelled_pending_confirmation" }),
    );

    // Plain calls before the gate still dispatch normally.
    const { manager: manager2, dispatch: dispatch2 } = makeHarness({
      streams: [
        toolPhase([
          toolCall("call_1", "lookup_hours", { day: "friday" }),
          toolCall("call_2", "book_appointment", { date: "Friday" }),
        ]),
      ],
      registry: fakeRegistry([
        { name: "book_appointment", requiresConfirmation: true },
        { name: "lookup_hours" },
      ]),
      classifier: fakeClassifier("affirmative"),
    });
    await collect(manager2.handleUtterance("Hours, then book Friday", null));
    expect(dispatch2).toHaveBeenCalledTimes(1);
    expect(dispatch2.mock.calls[0]?.[1]).toMatchObject({ name: "lookup_hours" });
    expect(manager2.pending).toMatchObject({ skill: "book_appointment", toolCallId: "call_2" });
  });

  it("cancels on a decline: cancel event + synthetic history entry, turn proceeds", async () => {
    const { manager, dispatch, audit } = makeHarness({
      streams: [
        toolPhase([toolCall("call_1", "book_appointment", { date: "Friday" })]),
        spoken("No problem, I will not book it."),
      ],
      registry: confirmRegistry(),
      classifier: fakeClassifier("decline"),
    });

    await collect(manager.handleUtterance("Book me for Friday", null));
    const chunks = await collect(manager.handleUtterance("Ei", null));

    expect(chunks).toEqual(["No problem, I will not book it."]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(manager.pending).toBeNull();
    expect(audit).toHaveBeenCalledWith("confirmation_cancelled", {
      skill: "book_appointment",
      reason: "declined",
    });
    const tool = manager.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe(JSON.stringify({ status: "cancelled_by_user" }));
  });

  it("re-asks once on an unclear reply and cancels on the second", async () => {
    const { manager, dispatch, audit } = makeHarness({
      streams: [
        toolPhase([toolCall("call_1", "book_appointment", { date: "Friday" })]),
        spoken("Alright, moving on then."),
      ],
      registry: confirmRegistry(),
      classifier: fakeClassifier("unclear"),
    });

    await collect(manager.handleUtterance("Book me for Friday", null));
    const reask = await collect(manager.handleUtterance("võib-olla", null));

    expect(reask).toEqual([getConfirmationReask(null, "Friday")]);
    expect(manager.pending).toMatchObject({ skill: "book_appointment", reasks: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();

    const chunks = await collect(manager.handleUtterance("maybe", null));

    expect(chunks).toEqual(["Alright, moving on then."]); // normal loop answers
    expect(dispatch).not.toHaveBeenCalled(); // ambiguity never dispatches
    expect(manager.pending).toBeNull();
    expect(audit).toHaveBeenCalledWith("confirmation_cancelled", {
      skill: "book_appointment",
      reason: "unclear",
    });
    const tool = manager.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe(JSON.stringify({ status: "cancelled_by_user" }));
  });

  it("a barge-in while pending clears the dispatch and audits the cancellation", async () => {
    const { manager, dispatch, audit } = makeHarness({
      streams: [
        toolPhase([toolCall("call_1", "book_appointment", { date: "Friday" })]),
        spoken("How else can I help?"),
      ],
      registry: confirmRegistry(),
      classifier: fakeClassifier("affirmative"),
    });

    await collect(manager.handleUtterance("Book me for Friday", null));
    expect(manager.pending).not.toBeNull();

    manager.onBargeIn();

    expect(manager.pending).toBeNull();
    expect(audit).toHaveBeenCalledWith("confirmation_cancelled", {
      skill: "book_appointment",
      reason: "interrupted",
    });
    const tool = manager.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe(JSON.stringify({ status: "cancelled_by_user" }));

    // The next utterance must not dispatch the cancelled skill.
    const chunks = await collect(manager.handleUtterance("Jah", null));
    expect(chunks).toEqual(["How else can I help?"]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("escalate_to_human builtin (task 5.1)", () => {
  it("attaches the builtin when escalation is enabled with an empty registry", async () => {
    const { manager, chatStream, dispatch } = makeHarness({
      streams: [spoken("Tere! Kuidas saan aidata?")],
      escalateImpl: async () => undefined,
    });

    const chunks = await collect(manager.handleUtterance("Tere", null));

    expect(chunks).toEqual(["Tere! Kuidas saan aidata?"]);
    const call = chatStream.mock.calls[0]?.[0] as ChatStreamOptions;
    expect(call.tools).toHaveLength(1);
    expect(call.tools?.[0]?.type).toBe("function");
    expect(call.tools?.[0]?.function.name).toBe("escalate_to_human");
    expect(call.tools?.[0]?.function.description).toContain("human colleague");
    expect(call.tools?.[0]?.function.parameters).toMatchObject({ type: "object" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("lists the builtin after the skill tools when both are available", async () => {
    const { manager, chatStream } = makeHarness({
      streams: [spoken("Sure.")],
      registry: fakeRegistry([{ name: "find_slots" }]),
      escalateImpl: async () => undefined,
    });

    await collect(manager.handleUtterance("hello", null));

    const call = chatStream.mock.calls[0]?.[0] as ChatStreamOptions;
    expect(call.tools?.map((t) => t.function.name)).toEqual(["find_slots", "escalate_to_human"]);
  });

  it("recognizes the builtin: never dispatches, appends the synthetic result, calls the handler with the reason, ends the turn", async () => {
    const { manager, chatStream, dispatch, escalate } = makeHarness({
      streams: [
        toolPhase([
          toolCall("call_e", "escalate_to_human", { reason: "Caller insists on a human" }),
        ]),
      ],
      registry: fakeRegistry([]),
      escalateImpl: async () => undefined,
    });

    const chunks = await collect(manager.handleUtterance("Get me a human colleague", null));

    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith({ reason: "Caller insists on a human" });
    expect(dispatch).not.toHaveBeenCalled(); // NOT via the skills dispatcher
    expect(chatStream).toHaveBeenCalledTimes(1); // turn ends after escalation
    // The handler speaks the announcement; the loop itself says nothing.
    expect(chunks).toEqual([]);
    // One synthetic role:"tool" result keeps the message protocol valid.
    expect(manager.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_e",
      content: JSON.stringify({ status: "escalating" }),
    });
  });

  it("omits the reason when the model sent none or sent malformed JSON", async () => {
    const malformed = toolCall("call_1", "escalate_to_human", {});
    malformed.arguments = "{not json";
    const { manager, escalate } = makeHarness({
      streams: [
        toolPhase([
          toolCall("call_0", "escalate_to_human", {}),
          malformed,
        ]),
      ],
      registry: fakeRegistry([]),
      escalateImpl: async () => undefined,
    });

    await collect(manager.handleUtterance("Human, please", null));

    // Only the first call runs (the malformed one is after the escalation);
    // it carried no usable reason.
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith({});
  });

  it("cancels the remaining phase calls after an escalation (protocol stays valid)", async () => {
    const { manager, dispatch, escalate } = makeHarness({
      streams: [
        toolPhase([
          toolCall("call_1", "escalate_to_human", { reason: "r" }),
          toolCall("call_2", "lookup_hours", { day: "friday" }),
        ]),
      ],
      registry: fakeRegistry([{ name: "lookup_hours" }]),
      escalateImpl: async () => undefined,
    });

    await collect(manager.handleUtterance("Human — and check the hours", null));

    expect(escalate).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    const toolMessages = manager.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["call_1", "call_2"]);
    expect(toolMessages[0]?.content).toBe(JSON.stringify({ status: "escalating" }));
    expect(toolMessages[1]?.content).toBe(
      JSON.stringify({ status: "cancelled_after_escalation" }),
    );
  });

  it("ends the turn even when the escalation handler throws (never reaches the audio path)", async () => {
    const { manager, chatStream, escalate } = makeHarness({
      streams: [toolPhase([toolCall("call_e", "escalate_to_human", { reason: "r" })])],
      registry: fakeRegistry([]),
      escalateImpl: async () => {
        throw new Error("handler exploded");
      },
    });

    const chunks = await collect(manager.handleUtterance("Get me a human", null));

    expect(escalate).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([]);
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(manager.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_e" });
  });

  it("refuses fail-closed when the builtin fires without a wired handler", async () => {
    // Registry given (dispatcher wired) but no escalateImpl → no escalate dep.
    const { manager, dispatch, escalate } = makeHarness({
      streams: [toolPhase([toolCall("call_e", "escalate_to_human", {})])],
      registry: fakeRegistry([]),
    });

    const chunks = await collect(manager.handleUtterance("Get me a human", null));

    expect(escalate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(chunks).toEqual([getToolFallback(null)]);
    const tool = manager.messages.find((m) => m.role === "tool");
    expect(tool?.content).toContain("not available");
  });
});
