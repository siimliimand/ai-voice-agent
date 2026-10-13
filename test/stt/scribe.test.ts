import { describe, expect, it } from "vitest";
import { parseScribeMessage, scribeErrorText } from "../../src/stt/scribe.js";

const AT = 1_000;

describe("parseScribeMessage", () => {
  it("maps a partial transcript to a partial event", () => {
    const raw = JSON.stringify({ message_type: "partial_transcript", text: "Tere, kas" });
    expect(parseScribeMessage(raw, { atMs: AT })).toEqual({
      type: "partial",
      text: "Tere, kas",
      language: undefined,
      atMs: AT,
    });
  });

  it("reads a language hint on a partial when the provider includes one", () => {
    const raw = JSON.stringify({
      message_type: "partial_transcript",
      text: "Hello",
      language_code: "en-US",
    });
    const event = parseScribeMessage(raw, { atMs: AT });
    expect(event?.type).toBe("partial");
    expect(event?.language).toBe("en");
  });

  it("normalizes ISO 639-2/3 and regional language codes", () => {
    const rus = parseScribeMessage(
      JSON.stringify({ message_type: "partial_transcript", text: "x", language_code: "rus" }),
      { atMs: AT },
    );
    const est = parseScribeMessage(
      JSON.stringify({ message_type: "partial_transcript", text: "x", language_code: "et-EE" }),
      { atMs: AT },
    );
    expect(rus?.language).toBe("ru");
    expect(est?.language).toBe("et");
  });

  it("maps committed_transcript to a final event", () => {
    const raw = JSON.stringify({
      message_type: "committed_transcript",
      text: "Tere, kuidas läheb?",
    });
    expect(parseScribeMessage(raw, { atMs: AT })).toEqual({
      type: "final",
      text: "Tere, kuidas läheb?",
      language: undefined,
      atMs: AT,
    });
  });

  it("ignores malformed JSON", () => {
    expect(parseScribeMessage("not-json{{", { atMs: AT })).toBeNull();
  });

  it("ignores unknown and non-transcript message types", () => {
    expect(
      parseScribeMessage(JSON.stringify({ message_type: "session_started", session_id: "s" }), {
        atMs: AT,
      }),
    ).toBeNull();
    expect(
      parseScribeMessage(JSON.stringify({ message_type: "warning", warning: "w" }), { atMs: AT }),
    ).toBeNull();
    expect(
      parseScribeMessage(
        JSON.stringify({ message_type: "committed_transcript_entities", text: "x", entities: [] }),
        { atMs: AT },
      ),
    ).toBeNull();
    expect(parseScribeMessage(JSON.stringify({}), { atMs: AT })).toBeNull();
  });

  it("treats empty partial text as a keepalive, not speech", () => {
    const raw = JSON.stringify({ message_type: "partial_transcript", text: "" });
    expect(parseScribeMessage(raw, { atMs: AT })).toBeNull();
  });

  it("suppresses the plain commit and uses the timestamped variant in detection mode", () => {
    const opts = { atMs: AT, timestampsAuthoritative: true };
    expect(
      parseScribeMessage(
        JSON.stringify({ message_type: "committed_transcript", text: "Tere" }),
        opts,
      ),
    ).toBeNull();
    expect(
      parseScribeMessage(
        JSON.stringify({
          message_type: "committed_transcript_with_timestamps",
          text: "Tere",
          language_code: "et",
          words: [],
        }),
        opts,
      ),
    ).toEqual({ type: "final", text: "Tere", language: "et", atMs: AT });
  });

  it("ignores the timestamped variant when it is not authoritative (no duplicates)", () => {
    const opts = { atMs: AT };
    expect(
      parseScribeMessage(
        JSON.stringify({
          message_type: "committed_transcript_with_timestamps",
          text: "Tere",
          language_code: "et",
        }),
        opts,
      ),
    ).toBeNull();
  });

  it("ignores empty committed text", () => {
    expect(
      parseScribeMessage(JSON.stringify({ message_type: "committed_transcript", text: "" }), {
        atMs: AT,
      }),
    ).toBeNull();
  });
});

describe("scribeErrorText", () => {
  it("extracts the error message from error payloads", () => {
    expect(scribeErrorText(JSON.stringify({ message_type: "auth_error", error: "bad key" }))).toBe(
      "auth_error: bad key",
    );
    expect(
      scribeErrorText(JSON.stringify({ message_type: "quota_exceeded", error: "limit" })),
    ).toBe("quota_exceeded: limit");
  });

  it("returns the type alone when no detail is present", () => {
    expect(scribeErrorText(JSON.stringify({ message_type: "rate_limited" }))).toBe("rate_limited");
  });

  it("returns null for transcripts and malformed frames", () => {
    expect(
      scribeErrorText(JSON.stringify({ message_type: "partial_transcript", text: "hi" })),
    ).toBeNull();
    expect(scribeErrorText("garbage")).toBeNull();
  });
});
