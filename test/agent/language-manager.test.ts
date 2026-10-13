import { describe, expect, it, vi } from "vitest";
import { LanguageManager } from "../../src/agent/language-manager.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { ChatOptions, OpenRouterClient } from "../../src/llm/openrouter.js";

const config: AppConfig = configSchema.parse({
  llm: { models: { conversation: "prov/conv", summarizer: "prov/sum", utility: "prov/util" } },
});

/** Build a LanguageManager whose utility LLM replies are fully scripted. */
function makeManager(chat: (opts: ChatOptions) => Promise<string>): {
  manager: LanguageManager;
  chatMock: ReturnType<typeof vi.fn>;
} {
  const chatMock = vi.fn(chat);
  const manager = new LanguageManager(config, { chat: chatMock } as unknown as OpenRouterClient);
  return { manager, chatMock };
}

const russian = '{"language":"ru","confidence":0.95}';
const estonianConfident = '{"language":"et","confidence":0.9}';
const estonianWeak = '{"language":"et","confidence":0.5}';

describe("LanguageManager", () => {
  it("detects and locks the language on the first utterance", async () => {
    const { manager, chatMock } = makeManager(async () => russian);
    const onLocked = vi.fn();
    manager.on("locked", onLocked);

    await expect(manager.detect("Здравствуйте, у меня вопрос по счёту")).resolves.toBe("ru");
    expect(manager.current).toBe("ru");
    expect(manager.locked).toBe(true);
    expect(manager.confidence).toBeCloseTo(0.95);
    expect(onLocked).toHaveBeenCalledWith("ru");

    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "prov/util",
        temperature: 0,
      }),
    );
    // The utterance is passed as the user message; the rules are in the system prompt.
    const call = chatMock.mock.calls[0]?.[0] as ChatOptions;
    expect(call.messages.at(-1)?.content).toContain("Здравствуйте");
    expect(call.messages[0]?.role).toBe("system");
  });

  it("does not relock before it is locked", async () => {
    const { manager } = makeManager(async () => estonianConfident);
    await expect(
      manager.maybeRelock("Tere", { language: "et", confidence: 0.99 }),
    ).resolves.toBeNull();
  });

  it("relocks after two confident votes for a different language and emits relocked", async () => {
    const { manager, chatMock } = makeManager(async () => russian);
    await manager.detect("Добрый день");
    const onRelocked = vi.fn();
    manager.on("relocked", onRelocked);

    chatMock.mockImplementation(async () => estonianConfident);
    // First vote alone is not enough…
    await expect(manager.maybeRelock("Tere, kas saate aidata?")).resolves.toBeNull();
    expect(manager.current).toBe("ru");
    expect(manager.pendingVotes).toEqual(["et"]);
    // …the second consecutive confident vote flips the language.
    await expect(manager.maybeRelock("Kas kuulete mind?")).resolves.toBe("et");
    expect(manager.current).toBe("et");
    expect(onRelocked).toHaveBeenCalledWith({ from: "ru", to: "et" });
    expect(manager.pendingVotes).toEqual([]);
    // Now a vote for the current language keeps everything stable.
    await expect(manager.maybeRelock("Aitäh!")).resolves.toBeNull();
    expect(manager.current).toBe("et");
  });

  it("ignores weak different-language votes (streak resets)", async () => {
    const { manager, chatMock } = makeManager(async () => russian);
    await manager.detect("Добрый день");
    chatMock.mockImplementation(async () => estonianWeak);
    await expect(manager.maybeRelock("Tere")).resolves.toBeNull();
    await expect(manager.maybeRelock("Tere veel")).resolves.toBeNull();
    expect(manager.current).toBe("ru");
    expect(manager.pendingVotes).toEqual([]);
  });

  it("relocks immediately on a high-confidence STT hint", async () => {
    const { manager, chatMock } = makeManager(async () => russian);
    await manager.detect("Добрый день");
    const onRelocked = vi.fn();
    manager.on("relocked", onRelocked);
    chatMock.mockImplementation(async () => russian); // utility still says ru

    await expect(
      manager.maybeRelock("Hello there", { language: "en", confidence: 0.95 }),
    ).resolves.toBe("en");
    expect(manager.current).toBe("en");
    expect(onRelocked).toHaveBeenCalledWith({ from: "ru", to: "en" });
  });

  it("falls back to a valid sttHint language when the LLM call throws", async () => {
    const { manager } = makeManager(async () => {
      throw new Error("OpenRouter down");
    });
    const onLocked = vi.fn();
    manager.on("locked", onLocked);

    await expect(
      manager.detect("Palun aidake mind", { language: "et", confidence: 0.8 }),
    ).resolves.toBe("et");
    expect(manager.current).toBe("et");
    expect(manager.locked).toBe(true);
    expect(onLocked).toHaveBeenCalledWith("et");
  });

  it("falls back to en when the LLM fails and no hint is usable", async () => {
    const { manager } = makeManager(async () => {
      throw new Error("OpenRouter down");
    });
    await expect(manager.detect("???")).resolves.toBe("en");
    expect(manager.current).toBe("en");
  });

  it("parses defensively: JSON buried in prose is fine, garbage falls back", async () => {
    const { manager, chatMock } = makeManager(
      async () => 'Sure, here you go: {"language":"et","confidence":0.8} — hope this helps!',
    );
    await expect(manager.detect("Tere, kas saate mind aidata?")).resolves.toBe("et");

    chatMock.mockImplementation(async () => "I think the caller speaks Russian.");
    await expect(manager.detect("Ещё раз, пожалуйста")).resolves.toBe("en");
  });

  it("pins a language manually for dev/testing", () => {
    const { manager } = makeManager(async () => russian);
    manager.pin("ru");
    expect(manager.current).toBe("ru");
    expect(manager.locked).toBe(true);
    expect(manager.confidence).toBe(1);
  });
});
