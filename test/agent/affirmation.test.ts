import { describe, expect, it, vi } from "vitest";
import { AffirmationClassifier } from "../../src/agent/affirmation.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import type { ChatOptions, OpenRouterClient } from "../../src/llm/openrouter.js";
import type { Language } from "../../src/types.js";

const config: AppConfig = configSchema.parse({
  llm: { models: { conversation: "prov/conv", summarizer: "prov/sum", utility: "prov/util" } },
});

/** Classifier whose utility model fails the test if the keywords were enough. */
function strictClassifier(): { classifier: AffirmationClassifier; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async () => {
    throw new Error("utility model must not be needed for keyword hits");
  });
  const classifier = new AffirmationClassifier({
    config,
    llm: { chat } as unknown as OpenRouterClient,
  });
  return { classifier, chat };
}

/** Classifier with a scripted utility tiebreaker. */
function tiebreakClassifier(reply: string | Error): {
  classifier: AffirmationClassifier;
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn(async (_opts: ChatOptions): Promise<string> => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const classifier = new AffirmationClassifier({
    config,
    llm: { chat } as unknown as OpenRouterClient,
  });
  return { classifier, chat };
}

describe("AffirmationClassifier", () => {
  it("resolves affirmative answers deterministically in all languages", async () => {
    const { classifier } = strictClassifier();
    const cases: Array<[Language, string]> = [
      ["et", "Jah"],
      ["et", "Jaa, oleks vaja"],
      ["et", "Tehke palun"],
      ["et", "Olgu, hästi"],
      ["et", "Muidugi"],
      ["ru", "Да"],
      ["ru", "Да-да, конечно"],
      ["ru", "Хорошо, запишите"],
      ["ru", "Ладно, давайте"],
      ["ru", "Обязательно"],
      ["en", "Yes please"],
      ["en", "Yep, go ahead"],
      ["en", "Sure, book it"],
      ["en", "Please do."],
      ["en", "OK, definitely"],
    ];
    for (const [language, answer] of cases) {
      await expect(classifier.decide(answer, language)).resolves.toBe("affirmative");
    }
  });

  it("resolves declines deterministically in all languages", async () => {
    const { classifier } = strictClassifier();
    const cases: Array<[Language, string]> = [
      ["et", "Ei"],
      ["et", "Ei, kahjuks mitte"],
      ["et", "Ei taha"],
      ["ru", "Нет"],
      ["ru", "Нет, не надо"],
      ["ru", "Отмените, пожалуйста"],
      ["en", "No"],
      ["en", "Nope"],
      ["en", "No, cancel it"],
      ["en", "Stop, do not do that"], // "not"/"stop" decline; "don't" → "dont" token
    ];
    for (const [language, answer] of cases) {
      await expect(classifier.decide(answer, language)).resolves.toBe("decline");
    }
  });

  it("treats ambiguous phrases and questions as unclear (tiebreaker consulted)", async () => {
    const { classifier, chat } = tiebreakClassifier("unclear");
    const cases: Array<[Language | null, string]> = [
      ["et", "võib-olla"],
      ["et", "Kui palju maksab?"],
      ["ru", "наверное"],
      ["ru", "А сколько это стоит?"],
      [null, "maybe"],
      [null, "How much does it cost?"],
      [null, ""],
      [null, "   "],
    ];
    for (const [language, answer] of cases) {
      await expect(classifier.decide(answer, language)).resolves.toBe("unclear");
    }
    expect(chat).toHaveBeenCalled();
  });

  it("treats mixed yes/no answers as unclear (fail-closed)", async () => {
    const { classifier } = strictClassifier();
    const cases: Array<[Language | null, string]> = [
      [null, "yes no"],
      ["ru", "да, но нет"],
      ["et", "Jah, ei... ma ei tea"], // jah + ei + ei
    ];
    for (const [language, answer] of cases) {
      await expect(classifier.decide(answer, language)).resolves.toBe("unclear");
    }
  });

  it("breaks ties with the utility model and maps its word to a verdict", async () => {
    const yes = tiebreakClassifier("yes");
    await expect(yes.classifier.decide("sounds good to me", "en")).resolves.toBe("affirmative");
    expect(yes.chat).toHaveBeenCalledTimes(1);
    const tiebreakOpts = yes.chat.mock.calls[0]?.[0] as ChatOptions;
    expect(tiebreakOpts.model).toBe("prov/util");
    expect(tiebreakOpts.temperature).toBe(0);
    expect(tiebreakOpts.messages).toHaveLength(2);

    const no = tiebreakClassifier("No.");
    await expect(no.classifier.decide("don't book it", "en")).resolves.toBe("decline");

    const neither = tiebreakClassifier("I cannot tell");
    await expect(neither.classifier.decide("hm hm hm", "en")).resolves.toBe("unclear");
  });

  it("fails closed to unclear when the utility model errors", async () => {
    const { classifier } = tiebreakClassifier(new Error("utility down"));
    await expect(classifier.decide("võib-olla", "et")).resolves.toBe("unclear");
  });
});
