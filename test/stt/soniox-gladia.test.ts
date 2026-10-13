import { describe, expect, it } from "vitest";
import { buildGladiaInitBody, parseGladiaMessage } from "../../src/stt/gladia.js";
import { buildSonioxConfig, parseSonioxMessage } from "../../src/stt/soniox.js";

const AT = 1_000;

describe("parseSonioxMessage", () => {
  it("joins tokens into text and marks finals on the <fin> control token", () => {
    const raw = JSON.stringify({
      tokens: [
        { text: "Hello", confidence: 0.9, language: "en" },
        { text: " world", confidence: 0.8, language: "en" },
        { text: "<fin>" },
      ],
    });
    const result = parseSonioxMessage(raw, AT);
    expect(result?.text).toBe("Hello world");
    expect(result?.isFinal).toBe(true);
    expect(result?.language).toBe("en");
    expect(result?.confidence).toBeCloseTo(0.85, 5);
    expect(result?.atMs).toBe(AT);
  });

  it("treats <end> (endpoint) as final even without <fin>", () => {
    const raw = JSON.stringify({ tokens: [{ text: "Tere", language: "et" }, { text: "<end>" }] });
    const result = parseSonioxMessage(raw, AT);
    expect(result?.isFinal).toBe(true);
    expect(result?.text).toBe("Tere");
  });

  it("keeps unfinished token streams as non-final (partials)", () => {
    const raw = JSON.stringify({
      tokens: [
        { text: "как", language: "ru", confidence: 0.7 },
        { text: " дела", language: "ru", confidence: 0.9 },
      ],
    });
    const result = parseSonioxMessage(raw, AT);
    expect(result?.isFinal).toBe(false);
    expect(result?.text).toBe("как дела");
    expect(result?.language).toBe("ru");
    expect(result?.confidence).toBeCloseTo(0.8, 5);
  });

  it("marks final when the session-level finished flag is set", () => {
    const raw = JSON.stringify({ tokens: [], finished: true });
    expect(parseSonioxMessage(raw, AT)?.isFinal).toBe(true);
  });

  it("surfaces server errors", () => {
    const raw = JSON.stringify({ error_code: 401, error_message: "bad key" });
    const result = parseSonioxMessage(raw, AT);
    expect(result?.error).toBe("401: bad key");
    expect(result?.text).toBe("");
  });

  it("ignores malformed and empty payloads", () => {
    expect(parseSonioxMessage("{{nope", AT)).toBeNull();
    expect(parseSonioxMessage(JSON.stringify({ tokens: [] }), AT)).toBeNull();
  });
});

describe("buildSonioxConfig", () => {
  it("pins a single language strictly", () => {
    const config = buildSonioxConfig("et", 16_000, "stt-rt-preview");
    expect(config.language_hints).toEqual(["et"]);
    expect(config.language_hints_strict).toBe(true);
    expect(config.enable_language_identification).toBe(false);
    expect(config.model).toBe("stt-rt-preview");
    expect(config.sample_rate).toBe(16_000);
  });

  it("uses our language set as identification candidates in auto mode", () => {
    const config = buildSonioxConfig("auto", 16_000, "stt-rt-preview");
    expect(config.language_hints).toEqual(["et", "ru", "en"]);
    expect(config.language_hints_strict).toBe(false);
    expect(config.enable_language_identification).toBe(true);
  });
});

describe("parseGladiaMessage", () => {
  it("maps partial transcript messages", () => {
    const raw = JSON.stringify({
      type: "transcript",
      session_id: "s",
      created_at: "2026-01-01T00:00:00Z",
      data: {
        id: "00_1",
        is_final: false,
        utterance: { text: "kuidas läheb", language: "et", confidence: 0.91 },
      },
    });
    expect(parseGladiaMessage(raw, AT)).toEqual({
      text: "kuidas läheb",
      isFinal: false,
      language: "et",
      confidence: 0.91,
      atMs: AT,
    });
  });

  it("maps final transcript messages", () => {
    const raw = JSON.stringify({
      type: "transcript",
      data: { id: "00_1", is_final: true, utterance: { text: "Kuidas läheb?" } },
    });
    const result = parseGladiaMessage(raw, AT);
    expect(result?.isFinal).toBe(true);
    expect(result?.language).toBeUndefined();
  });

  it("ignores non-transcript message types and empty utterances", () => {
    expect(
      parseGladiaMessage(JSON.stringify({ type: "speech_start", data: { time: 1 } }), AT),
    ).toBeNull();
    expect(parseGladiaMessage(JSON.stringify({ type: "audio_chunk", data: {} }), AT)).toBeNull();
    expect(
      parseGladiaMessage(
        JSON.stringify({ type: "transcript", data: { is_final: true, utterance: { text: "  " } } }),
        AT,
      ),
    ).toBeNull();
    expect(parseGladiaMessage("nope", AT)).toBeNull();
  });
});

describe("buildGladiaInitBody", () => {
  it("configures a pinned mono PCM16 session", () => {
    const body = buildGladiaInitBody({ language: "ru", sampleRateHz: 16_000 }, "solaria-1");
    expect(body).toMatchObject({
      model: "solaria-1",
      encoding: "wav/pcm",
      sample_rate: 16_000,
      bit_depth: 16,
      channels: 1,
      language_config: { languages: ["ru"], code_switching: false },
    });
  });

  it("passes our three languages as candidates in auto mode", () => {
    const body = buildGladiaInitBody({ language: "auto", sampleRateHz: 16_000 }, "solaria-1");
    expect(body.language_config).toMatchObject({
      languages: ["et", "ru", "en"],
      code_switching: false,
    });
  });
});
