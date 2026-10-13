/**
 * Smoke tests for the composed app (src/app.ts). Fast and hermetic: no
 * network, no database. The app is built in degraded mode (no provider
 * overrides, no external credentials) and must still boot, serve /health,
 * the dev harness, the auth-gated admin surface and the Twilio webhook.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type AppHandle } from "../../src/app.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";
import { computeTwilioSignature } from "../../src/telephony/twilio/validate-signature.js";

const TWILIO_AUTH_TOKEN = "smoke-auth-token";
const HOST = "smoke.example.com";

const basicAuthHeader = (user = "admin", pass = "smoke-password"): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return configSchema.parse({
    logLevel: "error", // keep degradation warnings out of test output
    admin: { user: "admin", password: "smoke-password" },
    twilio: { authToken: TWILIO_AUTH_TOKEN },
    ...overrides,
  });
}

describe("smoke: composed app (degraded mode, zero credentials)", () => {
  let handle: AppHandle;

  beforeAll(async () => {
    handle = await buildApp(makeConfig({ devBrowserCalls: true }));
    await handle.app.ready();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("boots and answers GET /health", async () => {
    const res = await handle.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; uptime_s: number };
    expect(body.ok).toBe(true);
    expect(body.uptime_s).toBeTypeOf("number");
  });

  it("serves the dev browser-call page and fixture list when devBrowserCalls is on", async () => {
    const page = await handle.app.inject({ method: "GET", url: "/dev/call" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");

    const fixtures = await handle.app.inject({ method: "GET", url: "/dev/fixtures" });
    expect(fixtures.statusCode).toBe(200);
    expect(Array.isArray(fixtures.json())).toBe(true);
  });

  it("locks /admin behind basic auth and renders the disabled page without a db", async () => {
    // Documented choice: with no DATABASE_URL the admin console is not
    // registered; an auth-gated placeholder page explains that instead of a
    // bare 404.
    const anon = await handle.app.inject({ method: "GET", url: "/admin" });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["www-authenticate"]).toBe('Basic realm="admin"');

    const authed = await handle.app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuthHeader() },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.headers["content-type"]).toContain("text/html");
    expect(authed.body).toContain("admin console is disabled");
  });

  it("does not register admin API routes without a database", async () => {
    // Degradation: no DATABASE_URL → no /api/calls at all (404), while
    // /health stays public. /admin is covered by the auth test above.
    const api = await handle.app.inject({ method: "GET", url: "/api/calls" });
    expect(api.statusCode).toBe(404);
  });
});

describe("smoke: dev routes disabled", () => {
  let handle: AppHandle;

  beforeAll(async () => {
    handle = await buildApp(makeConfig({ devBrowserCalls: false }));
    await handle.app.ready();
  });

  afterAll(async () => {
    await handle.close();
  });

  it("404s /dev/call when devBrowserCalls is false", async () => {
    const res = await handle.app.inject({ method: "GET", url: "/dev/call" });
    expect(res.statusCode).toBe(404);
  });
});

describe("smoke: POST /twiml", () => {
  let handle: AppHandle;

  beforeAll(async () => {
    handle = await buildApp(makeConfig({}));
    await handle.app.ready();
  });

  afterAll(async () => {
    await handle.close();
  });

  const PARAMS: Record<string, string> = {
    CallSid: "CAsmoke0000000000000000000000001",
    From: "+37251234567",
    To: "+37260000000",
  };

  it("answers a validly signed request with TwiML XML", async () => {
    const signature = computeTwilioSignature(TWILIO_AUTH_TOKEN, `http://${HOST}/twiml`, PARAMS);
    const res = await handle.app.inject({
      method: "POST",
      url: "/twiml",
      headers: {
        host: HOST,
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      payload: new URLSearchParams(PARAMS).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response>");
    expect(res.body).toContain(`ws://${HOST}/media/twilio`);
  });

  it("rejects a mismatched signature with 403", async () => {
    const res = await handle.app.inject({
      method: "POST",
      url: "/twiml",
      headers: {
        host: HOST,
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "garbage==",
      },
      payload: new URLSearchParams(PARAMS).toString(),
    });
    expect(res.statusCode).toBe(403);
  });
});
