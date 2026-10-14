import pino from "pino";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deepMerge } from "../../src/config/index.js";
import { EDITABLE_PATHS, EDITABLE_SECTIONS, isEditablePath } from "../../src/config/editable.js";
import {
  EffectiveConfigResolver,
  getSourcePaths,
  resolveEffectiveConfig,
} from "../../src/config/effective.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { maskSecretValues } from "../../src/api/settings.js";
import { deleteAtPath, getAtPath, saveSettingsDoc, setAtPath } from "../../src/db/settings.js";
import type { Database } from "../../src/db/schema.js";
import { createScratchDb, type ScratchDb } from "../helpers/scratch-db.js";

const silent = pino({ level: "silent" });
const databaseUrl = process.env.DATABASE_URL;

const baseConfig = (): AppConfig =>
  configSchema.parse({ llm: { apiKey: "sk-test-abcd1234" }, admin: { password: "pw" } });

describe("deepMerge", () => {
  it("merges nested overrides without mutating the inputs", () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, keep: { z: 3 } };
    const override = { nested: { y: 20 }, b: 2 };
    const merged = deepMerge(base, override);
    expect(merged).toEqual({ a: 1, nested: { x: 1, y: 20 }, keep: { z: 3 }, b: 2 });
    expect(base).toEqual({ a: 1, nested: { x: 1, y: 2 }, keep: { z: 3 } });
  });

  it("replaces arrays and scalars wholesale", () => {
    expect(deepMerge({ list: [1, 2] }, { list: [3] }).list).toEqual([3]);
    expect(deepMerge({ a: 1 }, { a: "x" }).a).toBe("x");
  });

  it("skips undefined override values", () => {
    expect(deepMerge({ a: 1 }, { a: undefined }).a).toBe(1);
  });

  it("treats a non-object base as empty", () => {
    expect(deepMerge(null, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("settings path helpers", () => {
  it("getAtPath/setAtPath/deleteAtPath round-trip, incl. nested overrides", () => {
    const doc: Record<string, unknown> = {
      llm: { models: { conversation: "a/b" } },
      vad: { threshold: 0.02 },
    };

    expect(getAtPath(doc, "llm.models.conversation")).toBe("a/b");
    expect(getAtPath(doc, "llm.models.missing")).toBeUndefined();
    expect(getAtPath(doc, "vad.threshold.deep")).toBeUndefined(); // traversal stops at scalars

    // setAtPath clones along the path; the input doc is untouched.
    const overridden = setAtPath(doc, "llm.models.conversation", "c/d");
    expect(getAtPath(overridden, "llm.models.conversation")).toBe("c/d");
    expect(getAtPath(doc, "llm.models.conversation")).toBe("a/b");

    // setting creates missing intermediate objects
    const created = setAtPath(doc, "twilio.accountSid", "AC123");
    expect(getAtPath(created, "twilio.accountSid")).toBe("AC123");

    // sibling overrides stack into one nested object
    const both = setAtPath(
      setAtPath({}, "llm.models.conversation", "x"),
      "llm.models.summarizer",
      "y",
    );
    expect(both).toEqual({ llm: { models: { conversation: "x", summarizer: "y" } } });

    // deleteAtPath removes only the target leaf, pruning emptied branches
    const removed = deleteAtPath(created, "llm.models.conversation");
    expect(getAtPath(removed, "llm.models.conversation")).toBeUndefined();
    expect(getAtPath(removed, "vad.threshold")).toBe(0.02);
    expect(removed).not.toHaveProperty("llm"); // empty branch pruned
    expect(getAtPath(created, "llm.models.conversation")).toBe("a/b"); // input untouched

    // deleting one of several siblings keeps the others
    const keptSibling = deleteAtPath(both, "llm.models.conversation");
    expect(keptSibling).toEqual({ llm: { models: { summarizer: "y" } } });

    // deleting a missing path is a no-op (by value)
    expect(deleteAtPath(doc, "no.such.path")).toEqual(doc);
  });
});

describe("editable contract", () => {
  it("indexes every section field and excludes infra paths", () => {
    for (const section of EDITABLE_SECTIONS) {
      for (const field of section.fields) {
        expect(isEditablePath(field.path), field.path).toBe(true);
        expect(EDITABLE_PATHS.has(field.path), field.path).toBe(true);
      }
    }
    for (const infra of ["port", "host", "databaseUrl", "publicBaseUrl"]) {
      expect(isEditablePath(infra), infra).toBe(false);
    }
    // flattened llm overrides + restart-required paths are part of the contract
    expect(EDITABLE_PATHS.has("llm.overrides.et.conversation")).toBe(true);
    expect(EDITABLE_PATHS.has("llm.overrides.ru.conversation")).toBe(true);
    expect(EDITABLE_PATHS.has("llm.overrides.en.conversation")).toBe(true);
    expect(EDITABLE_PATHS.has("twilio.mediaWsPath")).toBe(true);
    expect(EDITABLE_PATHS.has("devBrowserCalls")).toBe(true);
    // M4: consent/retention/escalation are operator-editable...
    for (const path of [
      "consent.enabled",
      "consent.initialLanguage",
      "retention.enabled",
      "retention.days",
      "retention.hashSalt",
      "escalation.staffNumber",
    ]) {
      expect(EDITABLE_PATHS.has(path), path).toBe(true);
    }
    // ...while the skills surface stays file/env-only by design.
    for (const path of [
      "skills.dir",
      "skills.maxToolIterations",
      "skills.http.booking.url",
      "skills.auth.calendar.value",
    ]) {
      expect(EDITABLE_PATHS.has(path), path).toBe(false);
    }
  });
});

describe("maskSecretValues", () => {
  it("replaces set secrets with { set: true, hint } and never leaks raw values", () => {
    const config = baseConfig();
    const masked = maskSecretValues(config);
    expect(getAtPath(masked, "llm.apiKey")).toEqual({ set: true, hint: "…1234" });
    expect(JSON.stringify(masked)).not.toContain("sk-test-abcd1234");
    // non-secret fields pass through untouched
    expect(getAtPath(masked, "llm.models.conversation")).toBe(config.llm.models.conversation);
    expect(getAtPath(masked, "tts.voiceEt")).toBe(config.tts.voiceEt);
  });

  it("reports unset secrets with { set: false, hint: null }", () => {
    const masked = maskSecretValues(configSchema.parse({}));
    expect(getAtPath(masked, "elevenlabs.apiKey")).toEqual({ set: false, hint: null });
    expect(getAtPath(masked, "admin.password")).toEqual({ set: false, hint: null });
  });
});

describe("EffectiveConfigResolver cache (stub db)", () => {
  it("coalesces concurrent misses into a single load", async () => {
    let loads = 0;
    const stubDb = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => {
              loads += 1;
              await new Promise((resolve) => setTimeout(resolve, 10));
              return { value: { llm: { models: { conversation: "stub/model" } } } };
            },
          }),
        }),
      }),
    } as unknown as Kysely<Database>;

    const resolver = new EffectiveConfigResolver(baseConfig(), stubDb, silent);
    const [a, b] = await Promise.all([resolver.get(), resolver.get()]);
    expect(loads).toBe(1);
    expect(a.llm.models.conversation).toBe("stub/model");
    expect(b.llm.models.conversation).toBe("stub/model");
  });

  it("returns the base config unchanged when there is no database", async () => {
    const base = baseConfig();
    const resolver = new EffectiveConfigResolver(base, undefined, silent);
    expect(await resolver.get()).toBe(base);
  });
});

describe.skipIf(!databaseUrl)("resolveEffectiveConfig (postgres)", () => {
  // Scratch database (shared helper): this suite WRITES the settings doc
  // for its whole run — an isolated database removes any cross-file race
  // with other DB-backed suites and can never touch operator data.
  let scratch: ScratchDb;
  let db: Kysely<Database>;

  beforeAll(async () => {
    scratch = await createScratchDb("effective_config");
    db = scratch.db;
  });

  afterAll(async () => {
    if (scratch) await scratch.destroy();
  });

  it("deep-merges the stored doc over the base config (base <- DB)", async () => {
    const base = baseConfig();
    await saveSettingsDoc(db, {
      llm: { models: { conversation: "db/override" } },
      vad: { threshold: 0.05 },
    });

    const effective = await resolveEffectiveConfig(base, db, silent);
    expect(effective.llm.models.conversation).toBe("db/override");
    expect(effective.vad.threshold).toBe(0.05);
    // untouched fields keep their base (schema default) values
    expect(effective.llm.models.summarizer).toBe(base.llm.models.summarizer);
    expect(effective.tts.model).toBe(base.tts.model);
    expect(effective).not.toBe(base);
  });

  it("re-validates: an invalid override falls back to base without crashing", async () => {
    const base = baseConfig();
    await saveSettingsDoc(db, { vad: { threshold: 7 } });
    const effective = await resolveEffectiveConfig(base, db, silent);
    expect(effective.vad.threshold).toBe(base.vad.threshold);
    expect(effective.llm.models.conversation).toBe(base.llm.models.conversation);

    // a structurally corrupt branch is rejected the same way
    await saveSettingsDoc(db, { vad: "corrupt" });
    const fallback = await resolveEffectiveConfig(base, db, silent);
    expect(fallback.vad.threshold).toBe(base.vad.threshold);
    expect(fallback.logLevel).toBe(base.logLevel);
  });

  it("returns the base config when no settings row exists", async () => {
    await db.deleteFrom("settings").where("key", "=", "global").execute();
    const base = baseConfig();
    const effective = await resolveEffectiveConfig(base, db, silent);
    expect(effective).toEqual(base);
  });

  it("getSourcePaths lists only editable paths that have overrides", async () => {
    await db.deleteFrom("settings").where("key", "=", "global").execute();
    await saveSettingsDoc(db, {
      llm: { models: { conversation: "db/override" } },
      notAnEditableSection: { thing: 1 },
    });
    const paths = await getSourcePaths(db);
    expect(paths.has("llm.models.conversation")).toBe(true);
    expect(paths.has("notAnEditableSection.thing")).toBe(false);
  });

  it("EffectiveConfigResolver caches per TTL and invalidates on demand", async () => {
    await db.deleteFrom("settings").where("key", "=", "global").execute();
    await saveSettingsDoc(db, { llm: { models: { conversation: "v1" } } });
    const resolver = new EffectiveConfigResolver(baseConfig(), db, silent, 60);
    expect((await resolver.get()).llm.models.conversation).toBe("v1");

    // within the TTL the change is not visible yet
    await saveSettingsDoc(db, { llm: { models: { conversation: "v2" } } });
    expect((await resolver.get()).llm.models.conversation).toBe("v1");

    resolver.invalidate();
    expect((await resolver.get()).llm.models.conversation).toBe("v2");

    // ...and TTL expiry re-reads on its own
    await saveSettingsDoc(db, { llm: { models: { conversation: "v3" } } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await resolver.get()).llm.models.conversation).toBe("v3");
  });
});
