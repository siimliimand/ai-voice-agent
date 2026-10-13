import { describe, expect, it, vi } from "vitest";
import { ConversationManager } from "../../src/agent/conversation-manager.js";
import { LanguageManager } from "../../src/agent/language-manager.js";
import { getGreeting, getSystemPrompt } from "../../src/agent/prompts/index.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type {
  ChatOptions,
  ChatStreamOptions,
  OpenRouterClient,
  StreamDelta,
} from "../../src/llm/openrouter.js";

const config: AppConfig = configSchema.parse({
  llm: { models: { conversation: "prov/conv", summarizer: "prov/sum", utility: "prov/util" } },
});

/** Error shape produced when fetch is aborted mid-stream. */
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Build a chatStream mock implementation replaying the given deltas. */
function streamOf(deltas: StreamDelta[]) {
  return async function* (opts: ChatStreamOptions) {
    for (const delta of deltas) {
      if (opts.signal?.aborted) throw abortError();
      yield delta;
    }
  };
}

/** Consume a handleUtterance() stream fully and collect the deltas. */
async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

interface Harness {
  manager: ConversationManager;
  languageManager: LanguageManager;
  chatStream: ReturnType<typeof vi.fn>;
}

function makeHarness(
  streamImpl?: (opts: ChatStreamOptions) => AsyncGenerator<StreamDelta>,
): Harness {
  const chatStream = vi.fn(
    streamImpl ?? streamOf([{ content: "Eks ma aita!" }, { finishReason: "stop" }]),
  );
  const llm = {
    chat: vi.fn(async (_opts: ChatOptions) => '{"language":"et","confidence":0.9}'),
    chatStream,
  } as unknown as OpenRouterClient;
  const languageManager = new LanguageManager(config, llm);
  const manager = new ConversationManager({ config, llm, language: languageManager });
  return { manager, languageManager, chatStream };
}

describe("ConversationManager", () => {
  it("streams content deltas in order and records the turn in history", async () => {
    const { manager, chatStream } = makeHarness(
      streamOf([{ content: "Tere" }, { content: "!" }, { finishReason: "stop" }]),
    );
    const chunks = await collect(manager.handleUtterance("Tere, mul on küsimus", null));
    expect(chunks).toEqual(["Tere", "!"]);

    expect(manager.messages).toHaveLength(3); // system + user + assistant
    expect(manager.messages[1]).toEqual({ role: "user", content: "Tere, mul on küsimus" });
    expect(manager.messages[2]).toEqual({ role: "assistant", content: "Tere!" });

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(chatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "prov/conv", // no language locked yet → role default
        temperature: 0.7,
        maxTokens: 300,
      }),
    );
  });

  it("grows the history across utterances", async () => {
    const { manager } = makeHarness();
    await collect(manager.handleUtterance("Esimene küsimus", null));
    await collect(manager.handleUtterance("Teine küsimus", null));
    expect(manager.messages).toHaveLength(5); // system + 2×(user + assistant)
    expect(manager.messages[3]).toEqual({ role: "user", content: "Teine küsimus" });
  });

  it("caps history to the last 40 messages, keeping the system prompt", async () => {
    const { manager } = makeHarness(streamOf([{ content: "selge" }]));
    for (let i = 0; i < 25; i++) {
      await collect(manager.handleUtterance(`küsimus number ${i}`, null));
    }
    // 25 turns would be 51 messages; capped to 40 with the system prompt first.
    expect(manager.messages).toHaveLength(40);
    expect(manager.messages[0]?.role).toBe("system");
    expect(manager.messages[0]?.content).toBe(getSystemPrompt(null));
    expect(manager.messages.at(-1)?.role).toBe("assistant");
  });

  it("swaps the system prompt, notes the switch, and pins the language manager", async () => {
    const { manager, languageManager, chatStream } = makeHarness();
    manager.setLanguage("ru");

    expect(manager.messages[0]?.content).toBe(getSystemPrompt("ru"));
    const notes = manager.messages.filter(
      (message) => message.role === "system" && message.content.startsWith("[client now speaks"),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("Russian");
    expect(languageManager.current).toBe("ru"); // delegated via pin()
    expect(manager.greet()).toBe(getGreeting("ru"));

    await collect(manager.handleUtterance("Здравствуйте", null));
    expect(chatStream).toHaveBeenLastCalledWith(expect.objectContaining({ model: "prov/conv" }));
  });

  it("treats setLanguage to the same or null language as a no-op", () => {
    const { manager } = makeHarness();
    manager.setLanguage("et");
    const length = manager.messages.length;
    manager.setLanguage("et");
    manager.setLanguage(null);
    expect(manager.messages).toHaveLength(length);
    expect(manager.language).toBe("et");
  });

  it("gives the English greeting before a language is locked", async () => {
    const { manager } = makeHarness();
    expect(manager.greet()).toBe(getGreeting("en"));
    await expect(manager.greeting()).resolves.toBe(getGreeting("en"));
  });

  it("aborts the in-flight stream on barge-in and keeps the partial answer", async () => {
    const { manager, chatStream } = makeHarness(async function* (opts) {
      yield { content: "Osaline vastus" };
      await new Promise<never>((_resolve, reject) => {
        const abort = (): void => reject(abortError());
        if (opts.signal?.aborted) abort();
        else opts.signal?.addEventListener("abort", abort, { once: true });
      });
    });

    const chunks: string[] = [];
    const consumer = (async () => {
      for await (const chunk of manager.handleUtterance("Kuulete mind?", null)) chunks.push(chunk);
    })();
    await vi.waitFor(() => expect(chunks).toEqual(["Osaline vastus"]));

    manager.onBargeIn();
    await consumer; // generator finishes cleanly after the abort

    expect(chatStream.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
    const last = manager.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("Osaline vastus [interrupted by caller]");
  });

  it("ignores barge-in when nothing is streaming and skips empty utterances", async () => {
    const { manager } = makeHarness();
    expect(() => manager.onBargeIn()).not.toThrow();
    expect(await collect(manager.handleUtterance("   ", null))).toEqual([]);
    expect(manager.messages).toHaveLength(1); // only the system prompt
  });

  it("closes by aborting and clearing the history", async () => {
    const { manager } = makeHarness();
    await collect(manager.handleUtterance("Tere", null));
    manager.close();
    expect(manager.messages).toHaveLength(0);
    expect(await collect(manager.handleUtterance("Tere veel", null))).toEqual([]);
  });
});
