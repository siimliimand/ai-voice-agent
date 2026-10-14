import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdminApi, type MetricsResponseDto } from "../../src/api/routes.js";
import { kyselyAdminDb } from "../../src/api/db.js";
import { registerBasicAuth } from "../../src/auth/basic-auth.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { closeDb, createDb } from "../../src/db/client.js";
import { countCallsByStatus, finalizeCall, insertCall } from "../../src/db/queries.js";
import { runMigrations } from "../../src/db/migrate.js";
import { LATENCY_STAGES, MetricsRegistry } from "../../src/observability/metrics.js";
import type { Database } from "../../src/db/schema.js";

const USERNAME = "admin";
const PASSWORD = "s3cret";
const BOOT = new Date("2026-10-13T10:00:00.000Z");
const databaseUrl = process.env.DATABASE_URL;

const authHeader = (user = USERNAME, pass = PASSWORD): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

const makeConfig = (): AppConfig =>
  configSchema.parse({ admin: { user: USERNAME, password: PASSWORD } });

function makeFakeDb() {
  return {
    listCalls: vi.fn(async () => []),
    getCallById: vi.fn(async () => null),
    getCallBySid: vi.fn(async () => null),
    getTranscript: vi.fn(async () => []),
    getNote: vi.fn(async () => null),
    countCallsByStatus: vi.fn(async () => ({ in_progress: 1, completed: 4, failed: 2 })),
  };
}
type FakeDb = ReturnType<typeof makeFakeDb>;

function buildApp(db: FakeDb, config: AppConfig, metrics?: MetricsRegistry): FastifyInstance {
  const app = Fastify({ logger: false });
  registerBasicAuth(app, config);
  // Mirrors buildApp's wiring; `metrics` is passed through the same options
  // object. buildApp always constructs a registry, so the undefined case is
  // only reachable through direct registration (tested below).
  registerAdminApi(app, { db, config, ...(metrics ? { metrics } : {}) });
  return app;
}

/** Populates a registry so every fixed bucket holds a known value. */
function makePopulatedRegistry(): MetricsRegistry {
  const registry = new MetricsRegistry(() => BOOT);
  for (const ms of [10, 20, 30, 40, 50]) registry.recordLatency("stt_finalize", ms);
  registry.recordLatency("llm_first_token", 42);
  registry.incrementCallStatus("in_progress", 7);
  registry.incrementCallStatus("completed", 5);
  registry.incrementCallStatus("failed", 1);
  registry.incrementError("llm", 2);
  registry.incrementError("stream", 1);
  registry.incrementCounter("skills_invoked", 3);
  registry.setActiveSessions(2);
  return registry;
}

describe("GET /api/metrics (fake db)", () => {
  let db: FakeDb;
  let registry: MetricsRegistry;
  let app: FastifyInstance;

  beforeEach(() => {
    db = makeFakeDb();
    registry = makePopulatedRegistry();
    app = buildApp(db, makeConfig(), registry);
  });

  it("answers 401 unauthenticated with a WWW-Authenticate challenge", async () => {
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="admin"');
    expect(db.countCallsByStatus).not.toHaveBeenCalled();
  });

  it("answers 401 with wrong credentials", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { authorization: authHeader(USERNAME, "nope") },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 200 with the documented shape for a valid admin", async () => {
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = res.json() as MetricsResponseDto;
    expect(Object.keys(body).sort()).toEqual(
      [
        "since",
        "latency",
        "callsByStatus",
        "callsByStatusDb",
        "activeSessions",
        "errors",
        "counters",
        "process",
      ].sort(),
    );

    // `since` is the registry boot timestamp, verbatim ISO-8601 UTC.
    expect(body.since).toBe(BOOT.toISOString());
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(body.since)).toBe(true);
    expect(body.process).toEqual({ since: body.since });

    // All four stages present; every percentile slot is number-or-null.
    expect(Object.keys(body.latency).sort()).toEqual([...LATENCY_STAGES].sort());
    for (const stage of LATENCY_STAGES) {
      const stats = body.latency[stage]!;
      expect(Object.keys(stats).sort()).toEqual(["count", "p50", "p95"]);
      expect(typeof stats.count).toBe("number");
      expect(stats.p50 === null || typeof stats.p50 === "number").toBe(true);
      expect(stats.p95 === null || typeof stats.p95 === "number").toBe(true);
    }
    // Known samples surface as exact nearest-rank percentiles.
    expect(body.latency.stt_finalize).toEqual({ count: 5, p50: 30, p95: 50 });
    expect(body.latency.tts_first_byte).toEqual({ count: 0, p50: null, p95: null });

    // Process counter layer + DB layer side by side.
    expect(body.callsByStatus).toEqual({ in_progress: 7, completed: 5, failed: 1 });
    expect(body.callsByStatusDb).toEqual({ in_progress: 1, completed: 4, failed: 2 });
    expect(body.activeSessions).toBe(2);
    expect(body.errors).toEqual({ pipeline: 0, llm: 2, stream: 1, skill: 0 });
    expect(body.counters).toEqual({ skills_invoked: 3 });
    expect(db.countCallsByStatus).toHaveBeenCalledTimes(1);

    // JSON round-trip is lossless (JSON-safe: no Dates, Maps, NaN).
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("reports zeroed buckets on a fresh registry", async () => {
    const freshApp = buildApp(makeFakeDb(), makeConfig(), new MetricsRegistry(() => BOOT));
    await freshApp.ready();
    try {
      const res = await freshApp.inject({
        method: "GET",
        url: "/api/metrics",
        headers: { authorization: authHeader() },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as MetricsResponseDto;
      expect(body.since).toBe(BOOT.toISOString());
      expect(body.callsByStatus).toEqual({ in_progress: 0, completed: 0, failed: 0 });
      expect(body.activeSessions).toBe(0);
      expect(body.counters).toEqual({});
      for (const stage of LATENCY_STAGES) {
        expect(body.latency[stage]).toEqual({ count: 0, p50: null, p95: null });
      }
    } finally {
      await freshApp.close();
    }
  });

  it("degrades to 503 {error} when no registry is wired", async () => {
    const noMetricsApp = buildApp(makeFakeDb(), makeConfig());
    await noMetricsApp.ready();
    try {
      const res = await noMetricsApp.inject({
        method: "GET",
        url: "/api/metrics",
        headers: { authorization: authHeader() },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toMatch(/metrics/i);
    } finally {
      await noMetricsApp.close();
    }
  });
});

describe.skipIf(!databaseUrl)("GET /api/metrics (postgres db layer)", () => {
  const SID_PREFIX = "CA-metrics-test-";
  // Scratch database: the assertions below expect EXACT per-status counts
  // over the calls table, and other DB-backed suites insert calls into the
  // shared database in parallel — an isolated database makes them
  // deterministic.
  let admin: Kysely<Database>;
  let db: Kysely<Database>;
  let app: FastifyInstance;
  const SCRATCH_DB = "voice_metrics_api_test";

  const insertCallWithStatus = async (
    sid: string,
    status: "in_progress" | "completed" | "failed",
  ): Promise<void> => {
    const callId = await insertCall(db, {
      callSid: sid,
      from: "+37250000000",
      provider: "browser",
    });
    if (status !== "in_progress") {
      await finalizeCall(db, callId, { status, durationS: 10 });
    }
  };

  beforeAll(async () => {
    admin = createDb(databaseUrl as string);
    await sql`DROP DATABASE IF EXISTS ${sql.raw(SCRATCH_DB)} WITH (FORCE)`.execute(admin);
    await sql`CREATE DATABASE ${sql.raw(SCRATCH_DB)}`.execute(admin);
    const scratchUrl = new URL(databaseUrl as string);
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    db = createDb(scratchUrl.toString());
    await runMigrations(db);
    // Idempotent cleanup of previous runs, then a fresh fixture set:
    // 2 completed + 1 failed finals, plus 1 still-open row.
    await db.deleteFrom("calls").where("call_sid", "like", `${SID_PREFIX}%`).execute();
    await insertCallWithStatus(`${SID_PREFIX}completed-1`, "completed");
    await insertCallWithStatus(`${SID_PREFIX}completed-2`, "completed");
    await insertCallWithStatus(`${SID_PREFIX}failed-1`, "failed");
    await insertCallWithStatus(`${SID_PREFIX}open-1`, "in_progress");

    const registry = new MetricsRegistry(() => BOOT);
    app = Fastify({ logger: false });
    registerBasicAuth(app, makeConfig());
    registerAdminApi(app, { db: kyselyAdminDb(db), config: makeConfig(), metrics: registry });
    await app.ready();
  });

  afterAll(async () => {
    await db.deleteFrom("calls").where("call_sid", "like", `${SID_PREFIX}%`).execute();
    await app?.close();
    if (db) await closeDb(db);
    if (admin) {
      await sql`DROP DATABASE IF EXISTS ${sql.raw(SCRATCH_DB)} WITH (FORCE)`.execute(admin);
      await closeDb(admin);
    }
  });

  it("groups the persisted rows per status (authoritative finals, D10)", async () => {
    const before = await countCallsByStatus(db);
    expect(before).toEqual({ in_progress: 1, completed: 2, failed: 1 }); // fixture guard

    const res = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MetricsResponseDto;

    // No call ever started through this app instance: the process layer is
    // zero while the DB layer counts the persisted rows — the two-layer
    // semantics the endpoint documents.
    expect(body.callsByStatus).toEqual({ in_progress: 0, completed: 0, failed: 0 });
    expect(body.callsByStatusDb).toEqual({ in_progress: 1, completed: 2, failed: 1 });
    expect(body.activeSessions).toBe(0);
    expect(body.since).toBe(BOOT.toISOString());
  });
});
