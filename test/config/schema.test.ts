/**
 * Unit tests for the M4 config additions (skills/consent/escalation/retention):
 * schema defaults, env parsing through loadConfig, file<->env merging for the
 * skills records, and rejection of invalid values.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";

/** Deterministic loadConfig: no config file unless a test writes one. */
const fromEnv = (env: NodeJS.ProcessEnv): AppConfig =>
  loadConfig({ ...env, CONFIG_FILE: "./test-config-does-not-exist.json" });

describe("config schema: M4 section defaults", () => {
  it("defaults skills/consent/escalation/retention", () => {
    const c = configSchema.parse({});
    expect(c.skills).toEqual({ dir: "./skills", maxToolIterations: 5, http: {}, auth: {} });
    expect(c.consent).toEqual({ enabled: true, initialLanguage: "et" });
    expect(c.escalation).toEqual({ staffNumber: "" });
    expect(c.retention).toEqual({ enabled: true, days: 90, hashSalt: "" });
  });

  it("fills endpoint/auth entry defaults (method POST, timeout 10000)", () => {
    const c = configSchema.parse({
      skills: {
        http: { booking: { url: "https://cal.example/book" } },
        auth: { calendar: { header: "X-Calendar-Key", value: "k" } },
      },
    });
    expect(c.skills.http.booking).toEqual({
      url: "https://cal.example/book",
      method: "POST",
      timeoutMs: 10000,
    });
    expect(c.skills.auth.calendar).toEqual({ header: "X-Calendar-Key", value: "k" });
  });

  it("accepts an empty hashSalt while retention is enabled (job-level guard)", () => {
    const c = configSchema.parse({ retention: { enabled: true } });
    expect(c.retention.hashSalt).toBe("");
  });
});

describe("config schema: tts.api transport selection", () => {
  it("defaults to auto (transport picked by model family)", () => {
    expect(configSchema.parse({}).tts.api).toBe("auto");
  });

  it("parses TTS_API from the environment", () => {
    expect(fromEnv({ TTS_API: "dialogue" }).tts.api).toBe("dialogue");
    expect(fromEnv({ TTS_API: "tts" }).tts.api).toBe("tts");
    expect(fromEnv({ TTS_API: "auto" }).tts.api).toBe("auto");
  });

  it("rejects unknown transports", () => {
    expect(configSchema.safeParse({ tts: { api: "grpc" } }).success).toBe(false);
    expect(() => fromEnv({ TTS_API: "grpc" })).toThrow();
  });
});

describe("config schema: M4 values from environment", () => {
  it("parses the new sections from env vars into their nested paths", () => {
    const c = fromEnv({
      SKILLS_DIR: "/srv/skills",
      SKILLS_MAX_TOOL_ITERATIONS: "3",
      SKILLS_HTTP_BOOKING_URL: "https://cal.example/book",
      SKILLS_HTTP_BOOKING_METHOD: "PUT",
      SKILLS_HTTP_BOOKING_TIMEOUT_MS: "2500",
      SKILLS_AUTH_CALENDAR_HEADER: "X-Calendar-Key",
      SKILLS_AUTH_CALENDAR_VALUE: "cal-secret-4321",
      CONSENT_ENABLED: "false",
      CONSENT_INITIAL_LANGUAGE: "ru",
      ESCALATION_STAFF_NUMBER: "+372555111",
      RETENTION_ENABLED: "false",
      RETENTION_DAYS: "30",
      RETENTION_HASH_SALT: "pepper-9876",
    });
    expect(c.skills.dir).toBe("/srv/skills");
    expect(c.skills.maxToolIterations).toBe(3);
    expect(c.skills.http.booking).toEqual({
      url: "https://cal.example/book",
      method: "PUT",
      timeoutMs: 2500,
    });
    expect(c.skills.auth.calendar).toEqual({ header: "X-Calendar-Key", value: "cal-secret-4321" });
    expect(c.consent).toEqual({ enabled: false, initialLanguage: "ru" });
    expect(c.escalation.staffNumber).toBe("+372555111");
    expect(c.retention).toEqual({ enabled: false, days: 30, hashSalt: "pepper-9876" });
  });

  it("fills endpoint defaults from a bare booking url env var", () => {
    const c = fromEnv({ SKILLS_HTTP_BOOKING_URL: "https://cal.example/book" });
    expect(c.skills.http.booking).toEqual({
      url: "https://cal.example/book",
      method: "POST",
      timeoutMs: 10000,
    });
    expect(c.skills.auth).toEqual({});
  });

  it("emits no record entries (and no CONSENT/RETENTION overrides) without env keys", () => {
    const c = fromEnv({});
    expect(c.skills.http).toEqual({});
    expect(c.skills.auth).toEqual({});
    expect(c.skills.maxToolIterations).toBe(5);
    expect(c.retention.days).toBe(90);
  });
});

describe("config schema: M4 skills records merge file <- env", () => {
  it("layers env booking keys over file entries without dropping file-only leaves", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "m4-config-"));
    const file = path.join(dir, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        skills: {
          http: {
            booking: { url: "file-url", timeoutMs: 4321 },
            lookup: { url: "https://lookup.example" },
          },
        },
      }),
    );
    const c = loadConfig({ CONFIG_FILE: file, SKILLS_HTTP_BOOKING_URL: "env-url" });
    expect(c.skills.http.booking).toEqual({ url: "env-url", method: "POST", timeoutMs: 4321 });
    expect(c.skills.http.lookup).toEqual({
      url: "https://lookup.example",
      method: "POST",
      timeoutMs: 10000,
    });
  });
});

describe("config schema: M4 invalid values are rejected", () => {
  const invalid: Array<[string, unknown]> = [
    ["skills.maxToolIterations 0", { skills: { maxToolIterations: 0 } }],
    ["skills.maxToolIterations 11", { skills: { maxToolIterations: 11 } }],
    ["skills.maxToolIterations non-int", { skills: { maxToolIterations: 2.5 } }],
    ["http endpoint without url", { skills: { http: { booking: { method: "PUT" } } } }],
    ["auth ref without header", { skills: { auth: { calendar: { value: "k" } } } }],
    ["consent.initialLanguage unknown", { consent: { initialLanguage: "fr" } }],
    ["retention.days 0", { retention: { days: 0 } }],
    ["retention.days non-int", { retention: { days: 7.5 } }],
  ];
  for (const [name, bad] of invalid) {
    it(`rejects ${name}`, () => {
      expect(configSchema.safeParse(bad).success).toBe(false);
    });
  }

  it("rejects the same values when they arrive via env", () => {
    expect(() => fromEnv({ RETENTION_DAYS: "0" })).toThrow();
    expect(() => fromEnv({ CONSENT_INITIAL_LANGUAGE: "fr" })).toThrow();
    expect(() => fromEnv({ SKILLS_MAX_TOOL_ITERATIONS: "99" })).toThrow();
  });
});
