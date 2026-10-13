import { describe, expect, it } from "vitest";
import { noteSchema, type Note } from "../../src/notes/note-schema.js";

const validNote = {
  summary: "Helistaja küsis arve kohta.",
  language: "et",
  client: null,
  intents: ["billing question"],
  actions_taken: ["explained the invoice line items"],
  unresolved_issues: [],
  follow_ups: ["email corrected invoice"],
  urgency: "normal",
  sentiment: "neutral",
} satisfies Note;

describe("noteSchema", () => {
  it("accepts a fully valid note", () => {
    const parsed = noteSchema.parse(validNote);
    expect(parsed).toEqual(validNote);
  });

  it("accepts empty arrays and a non-null client", () => {
    expect(() =>
      noteSchema.parse({ ...validNote, client: "OÜ Näidis", intents: [] }),
    ).not.toThrow();
  });

  it("rejects an empty summary", () => {
    expect(() => noteSchema.parse({ ...validNote, summary: "" })).toThrow();
  });

  it("rejects an unknown language", () => {
    expect(() => noteSchema.parse({ ...validNote, language: "fi" })).toThrow();
  });

  it("rejects an unknown urgency", () => {
    expect(() => noteSchema.parse({ ...validNote, urgency: "medium" })).toThrow();
  });

  it("rejects an unknown sentiment", () => {
    expect(() => noteSchema.parse({ ...validNote, sentiment: "angry" })).toThrow();
  });

  it("requires client to be a string or null (not undefined/missing)", () => {
    const { client: _client, ...missingClient } = validNote;
    expect(() => noteSchema.parse(missingClient)).toThrow();
  });

  it("rejects non-string array entries", () => {
    expect(() => noteSchema.parse({ ...validNote, intents: [1, 2] })).toThrow();
  });

  it("rejects missing fields entirely", () => {
    expect(() => noteSchema.parse({ summary: "only a summary" })).toThrow();
  });
});
