import Fastify from "fastify";
import pino from "pino";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  kyselySettingsDb,
  registerSettingsApi,
  type SettingsDb,
  type SettingsResponse,
} from "../../src/api/settings.js";
import { registerBasicAuth } from "../../src/auth/basic-auth.js";
import { EDITABLE_SECTIONS } from "../../src/config/editable.js";
import { resolveEffectiveConfig } from "../../src/config/effective.js";
import { deepMerge } from "../../src/config/index.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { closeDb, createDb } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { deleteAtPath, getAtPath } from "../../src/db/settings.js";
import type { Database } from "../../src/db/schema.js";

const USERNAME = "admin";
const PASSWORD = "s3cret";
const SECRET_KEY = "sk-test-abcd1234";
const silent = pino({ level: "silent" });
const databaseUrl = process.env.DATABASE_URL;

const authHeader = (user = USERNAME, pass = PASSWORD): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

const makeConfig = (): AppConfig =>
  configSchema.parse({
    admin: { user: USERNAME, password: PASSWORD },
    llm: { apiKey: SECRET_KEY },
  });

/** In-memory SettingsDb: mirrors saveSettingsDoc/clearSettingsPath semantics. */
function makeFakeSettingsDb(): SettingsDb & { doc(): Record<string, unknown> } {
  let doc: Record<string, unknown> = {};
  return {
    getSettingsDoc: vi.fn(async () => doc),
    saveSettingsDoc: vi.fn(async (partial: Record<string, unknown>) => {
      doc = deepMerge(doc, partial);
    }),
    clearSettingsPath: vi.fn(async (path: string) => {
      doc = deleteAtPath(doc, path);
    }),
    doc: () => doc,
  };
}

function buildApp(db: SettingsDb, config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: false });
  registerBasicAuth(app, config);
  registerSettingsApi(app, { db, config });
  return app;
}

const getJson = async (app: FastifyInstance): Promise<SettingsResponse> => {
  const res = await app.inject({
    method: "GET",
    url: "/api/settings",
    headers: { authorization: authHeader() },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as SettingsResponse;
};

const putJson = async (
  app: FastifyInstance,
  payload: unknown,
): Promise<{
  status: number;
  body: SettingsResponse & {
    error?: string;
    paths?: string[];
    issues?: Array<{ path: string; message: string }>;
  };
}> => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: { authorization: authHeader(), "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
  return { status: res.statusCode, body: res.json() };
};

describe("settings api (fake db)", () => {
  let db: ReturnType<typeof makeFakeSettingsDb>;
  let app: FastifyInstance;

  beforeEach(() => {
    db = makeFakeSettingsDb();
    app = buildApp(db, makeConfig());
  });

  it("answers 401 unauthenticated GET with a WWW-Authenticate challenge", async () => {
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="admin"');
  });

  it("answers 401 unauthenticated PUT", async () => {
    await app.ready();
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ values: { notes: { enabled: false } } }),
    });
    expect(res.statusCode).toBe(401);
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
  });

  it("GET returns masked secrets, sections and empty overrides", async () => {
    await app.ready();
    const body = await getJson(app);
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
    expect(getAtPath(body.values, "llm.apiKey")).toEqual({ set: true, hint: "…1234" });
    expect(getAtPath(body.values, "admin.password")).toEqual({ set: true, hint: "…cret" });
    expect(getAtPath(body.values, "elevenlabs.apiKey")).toEqual({ set: false, hint: null });
    expect(body.overrides).toEqual([]);
    expect(body.sections).toEqual(EDITABLE_SECTIONS);
  });

  it("PUT persists an editable partial, reflects it on GET and reports the override", async () => {
    await app.ready();
    const put = await putJson(app, {
      values: { llm: { models: { conversation: "test/override-model" } } },
    });
    expect(put.status).toBe(200);
    expect(getAtPath(put.body.values, "llm.models.conversation")).toBe("test/override-model");
    expect(put.body.overrides).toContain("llm.models.conversation");

    const body = await getJson(app);
    expect(getAtPath(body.values, "llm.models.conversation")).toBe("test/override-model");
    // stored doc uses the nested shape
    expect(db.doc()).toEqual({ llm: { models: { conversation: "test/override-model" } } });
  });

  it("PUT rejects infra paths with 400, listing them", async () => {
    await app.ready();
    const put = await putJson(app, { values: { port: 9999, databaseUrl: "postgres://nope" } });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/infra/);
    expect(put.body.paths).toEqual(expect.arrayContaining(["port", "databaseUrl"]));
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
  });

  it("PUT rejects out-of-range values with the zod issue list", async () => {
    await app.ready();
    const put = await putJson(app, { values: { vad: { threshold: 7 } } });
    expect(put.status).toBe(400);
    expect(put.body.issues?.some((issue) => issue.path === "vad.threshold")).toBe(true);
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
  });

  it("PUT rejects invalid enum values", async () => {
    await app.ready();
    const put = await putJson(app, { values: { stt: { provider: "nope" } } });
    expect(put.status).toBe(400);
    expect(put.body.issues?.some((issue) => issue.path === "stt.provider")).toBe(true);
  });

  it("reset[] removes an override and restores the base value", async () => {
    await app.ready();
    await putJson(app, { values: { llm: { models: { conversation: "test/override-model" } } } });
    const reset = await putJson(app, { reset: ["llm.models.conversation"] });
    expect(reset.status).toBe(200);
    expect(reset.body.overrides).toEqual([]);
    expect(getAtPath(reset.body.values, "llm.models.conversation")).toBe("openai/gpt-4o-mini");
    expect(db.clearSettingsPath).toHaveBeenCalledWith("llm.models.conversation");
    expect(db.doc()).toEqual({});
  });

  it("empty-string and null secrets keep the current value", async () => {
    await app.ready();
    const empty = await putJson(app, { values: { elevenlabs: { apiKey: "" } } });
    expect(empty.status).toBe(200);
    expect(empty.body.overrides).toEqual([]);
    const nul = await putJson(app, { values: { elevenlabs: { apiKey: null } } });
    expect(nul.status).toBe(200);
    expect(db.saveSettingsDoc).not.toHaveBeenCalled();
  });

  it("a real secret value is stored but never echoed back", async () => {
    await app.ready();
    const put = await putJson(app, { values: { elevenlabs: { apiKey: "el-secret-9876" } } });
    expect(put.status).toBe(200);
    expect(put.body.overrides).toContain("elevenlabs.apiKey");
    expect(getAtPath(put.body.values, "elevenlabs.apiKey")).toEqual({ set: true, hint: "…9876" });
    expect(JSON.stringify(put.body)).not.toContain("el-secret-9876");
    expect(db.doc()).toEqual({ elevenlabs: { apiKey: "el-secret-9876" } });
  });

  it("drops unknown paths silently and coerces number strings before validating", async () => {
    await app.ready();
    const put = await putJson(app, {
      values: { madeUpSection: { thing: "x" }, vad: { threshold: "0.05" } },
    });
    expect(put.status).toBe(200);
    expect(db.doc()).toEqual({ vad: { threshold: 0.05 } });
    expect(put.body.overrides).toEqual(["vad.threshold"]);
  });
});

describe.skipIf(!databaseUrl)("settings api (postgres)", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  const config = makeConfig();

  beforeAll(async () => {
    db = createDb(databaseUrl as string);
    await runMigrations(db);
    await db.deleteFrom("settings").where("key", "=", "global").execute();
    app = buildApp(kyselySettingsDb(db), config);
    await app.ready();
  });

  afterAll(async () => {
    await db.deleteFrom("settings").where("key", "=", "global").execute();
    await app?.close();
    await closeDb(db);
  });

  it("persists a PUT, reflects it on GET and in the effective config", async () => {
    const put = await putJson(app, { values: { tts: { model: "db-model" } } });
    expect(put.status).toBe(200);
    expect(put.body.overrides).toContain("tts.model");

    const body = await getJson(app);
    expect(getAtPath(body.values, "tts.model")).toBe("db-model");

    const effective = await resolveEffectiveConfig(config, db, silent);
    expect(effective.tts.model).toBe("db-model");
  });

  it("reset[] deletes the stored override (row removed when empty)", async () => {
    const reset = await putJson(app, { reset: ["tts.model"] });
    expect(reset.status).toBe(200);
    expect(reset.body.overrides).toEqual([]);
    const rows = await db.selectFrom("settings").selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
