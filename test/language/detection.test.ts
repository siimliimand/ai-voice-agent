/**
 * Fixture-level language-detection tests (task 5.4).
 *
 * Every test drives the real LanguageManager with a fully MOCKED
 * OpenRouterClient (no network): the utility model's JSON votes are
 * scripted per scenario, mirroring the mock style of
 * test/agent/language-manager.test.ts but at the utterance-fixture level.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LanguageManager } from "../../src/agent/language-manager.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { ChatOptions, OpenRouterClient } from "../../src/llm/openrouter.js";
import type { Language } from "../../src/types.js";
import {
  ambiguousSamples,
  codeSwitchSamples,
  enSamples,
  etSamples,
  ruSamples,
  transcriptFixtures,
  type LanguageSample,
} from "./fixtures.js";

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

/** A well-formed utility-model vote as the LLM would emit it. */
const voteJson = (language: Language, confidence = 0.9): string =>
  JSON.stringify({ language, confidence });

/** First sample of a fixture group (arrays are guaranteed non-empty). */
const first = (samples: readonly LanguageSample[]): LanguageSample => samples[0]!;

/** The system prompt the manager actually sent to the (mocked) utility model. */
function systemPromptOf(chatMock: ReturnType<typeof vi.fn>): string {
  const call = chatMock.mock.calls[0]?.[0] as ChatOptions | undefined;
  const system = call?.messages[0];
  return system?.role === "system" ? system.content : "";
}

describe("language detection with fixtures", () => {
  it("Detects each language correctly when the utility model votes correctly", async () => {
    for (const sample of [...etSamples, ...ruSamples, ...enSamples]) {
      const { manager, chatMock } = makeManager(async () => voteJson(sample.expected, 0.92));
      const onLocked = vi.fn();
      manager.on("locked", onLocked);

      await expect(manager.detect(sample.text)).resolves.toBe(sample.expected);
      expect(manager.current).toBe(sample.expected);
      expect(manager.locked).toBe(true);
      expect(onLocked).toHaveBeenCalledTimes(1);
      expect(onLocked).toHaveBeenCalledWith(sample.expected);
      expect(chatMock).toHaveBeenCalledTimes(1);
    }
  });

  it("Falls back to the STT hint when the utility model fails", async () => {
    const { manager, chatMock } = makeManager(async () => {
      throw new Error("utility model unavailable");
    });
    const onLocked = vi.fn();
    manager.on("locked", onLocked);

    await expect(
      manager.detect(first(etSamples).text, { language: "ru", confidence: 0.9 }),
    ).resolves.toBe("ru");
    expect(manager.current).toBe("ru");
    expect(manager.locked).toBe(true);
    expect(onLocked).toHaveBeenCalledWith("ru");
    // The utility model was attempted before falling back.
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it("Falls back to 'en' when everything fails", async () => {
    // The ambiguous fixtures document exactly this last-resort behavior.
    for (const sample of [...ambiguousSamples, first(ruSamples)]) {
      const { manager, chatMock } = makeManager(async () => {
        throw new Error("utility model unavailable");
      });
      await expect(manager.detect(sample.text)).resolves.toBe("en");
      expect(manager.current).toBe("en");
      expect(manager.locked).toBe(true);
      expect(manager.confidence).toBeCloseTo(0.3); // FALLBACK_CONFIDENCE
      expect(chatMock).toHaveBeenCalledTimes(1);
    }
  });

  it("Code-switch samples classify to the dominant language", async () => {
    // PROMPT CONTRACT: the detection prompt must carry code-switch guidance,
    // otherwise the scripted dominant-language votes below prove nothing.
    // (The prompt is not exported, so we capture it from the mocked call.)
    const probe = makeManager(async () => voteJson("et"));
    await probe.manager.detect(first(codeSwitchSamples).text);
    const prompt = systemPromptOf(probe.chatMock);
    expect(prompt).toMatch(/code-switch/i);
    expect(prompt).toMatch(/estonian/i);
    expect(prompt).toMatch(/russian/i);
    expect(prompt).toMatch(/dominant/i);
    expect(prompt).toMatch(/script|alphabet/i);
    // The vote contract itself: JSON-only reply over exactly et/ru/en.
    expect(prompt).toContain('"language"');
    expect(prompt).toContain('"et"');
    expect(prompt).toContain('"ru"');
    expect(prompt).toContain('"en"');

    for (const sample of codeSwitchSamples) {
      const { manager } = makeManager(async () => voteJson(sample.expected, 0.85));
      await expect(manager.detect(sample.text)).resolves.toBe(sample.expected);
      expect(manager.current).toBe(sample.expected);
      expect(manager.locked).toBe(true);
    }
  });

  it("Handles malformed LLM output via defensive parsing", async () => {
    // JSON embedded in prose is still parsed.
    const prose = makeManager(
      async () =>
        'Sure! The caller speaks Russian: {"language":"ru","confidence":0.83} — hope that helps.',
    );
    await expect(prose.manager.detect(first(ruSamples).text)).resolves.toBe("ru");
    expect(prose.chatMock).toHaveBeenCalledTimes(1);

    // JSON wrapped in markdown fences is still parsed.
    const fenced = makeManager(async () => '```json\n{"language":"et","confidence":0.91}\n```');
    await expect(fenced.manager.detect(first(etSamples).text)).resolves.toBe("et");

    // Garbage without any JSON: falls back to the STT hint.
    const garbageWithHint = makeManager(async () => "The caller seems happy overall.");
    await expect(
      garbageWithHint.manager.detect(first(enSamples).text, {
        language: "ru",
        confidence: 0.6,
      }),
    ).resolves.toBe("ru");

    // Garbage without a hint: last resort is "en".
    const garbageNoHint = makeManager(async () => "No JSON for you.");
    await expect(garbageNoHint.manager.detect(first(enSamples).text)).resolves.toBe("en");

    // Schema-invalid vote (unknown language code) also triggers the fallback chain.
    const invalidVote = makeManager(async () => '{"language":"fr","confidence":0.99}');
    await expect(
      invalidVote.manager.detect(first(etSamples).text, { language: "et", confidence: 0.7 }),
    ).resolves.toBe("et");
  });

  it("Lock persists across utterances; relock per manager policy", async () => {
    const { manager, chatMock } = makeManager(async () => voteJson("et", 0.9));
    const onLocked = vi.fn();
    const onRelocked = vi.fn();
    manager.on("locked", onLocked);
    manager.on("relocked", onRelocked);

    await manager.detect(etSamples[0]!.text);
    await manager.detect(etSamples[1]!.text);
    expect(manager.current).toBe("et");
    expect(manager.locked).toBe(true);
    expect(onLocked).toHaveBeenCalledTimes(1); // lock persists; no re-emit

    // Two consecutive confident votes for "ru" flip the lock per policy.
    chatMock.mockImplementation(async () => voteJson("ru", 0.9));
    await expect(manager.maybeRelock(ruSamples[0]!.text)).resolves.toBeNull();
    expect(manager.current).toBe("et");
    expect(manager.pendingVotes).toEqual(["ru"]);
    await expect(manager.maybeRelock(ruSamples[1]!.text)).resolves.toBe("ru");
    expect(manager.current).toBe("ru");
    expect(onRelocked).toHaveBeenCalledTimes(1);
    expect(onRelocked).toHaveBeenCalledWith({ from: "et", to: "ru" });
    expect(manager.pendingVotes).toEqual([]);

    // Stable after the relock: further "ru" votes change nothing.
    await expect(manager.maybeRelock(ruSamples[2]!.text)).resolves.toBeNull();
    expect(manager.current).toBe("ru");
    expect(onRelocked).toHaveBeenCalledTimes(1);
  });

  /**
   * The committed reference transcripts (test/fixtures/fixture-*.txt), each
   * classified via a scripted-correct utility model. A missing transcript
   * file skips its case with a clear log instead of failing the suite.
   */
  for (const fixture of transcriptFixtures) {
    const path = fileURLToPath(new URL(`../fixtures/${fixture.file}`, import.meta.url));
    const missing = !existsSync(path);
    if (missing) {
      console.warn(
        `[language tests] fixture transcript ${fixture.file} is missing — skipping its case`,
      );
    }
    const itMaybe = missing ? it.skip : it;

    itMaybe(
      `Fixture transcript ${fixture.file} classifies as "${fixture.expected}" via a scripted-correct utility model`,
      async () => {
        const text = (await readFile(path, "utf8")).trim();
        expect(text).not.toBe("");

        const { manager, chatMock } = makeManager(async () => voteJson(fixture.expected, 0.92));
        await expect(manager.detect(text)).resolves.toBe(fixture.expected);
        expect(manager.current).toBe(fixture.expected);
        expect(manager.locked).toBe(true);

        // The utterance itself must be passed to the utility model.
        const call = chatMock.mock.calls[0]?.[0] as ChatOptions;
        expect(call.messages.at(-1)?.content).toBe(text);
      },
    );
  }
});
