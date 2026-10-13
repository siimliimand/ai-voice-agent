import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema.js";
import { registerTwilioRoutes } from "../../src/telephony/twilio/routes.js";
import { computeTwilioSignature } from "../../src/telephony/twilio/validate-signature.js";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../src/config/schema.js";

const AUTH_TOKEN = "test-auth-token";
const HOST = "example.com";
const FULL_URL = `http://${HOST}/twiml`;
const PARAMS: Record<string, string> = {
  CallSid: "CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  From: "+37251234567",
  To: "+37260000000",
};
const FORM = new URLSearchParams(PARAMS).toString();

function makeApp(config: AppConfig): FastifyInstance {
  const app = Fastify();
  registerTwilioRoutes(app, { config });
  return app;
}

async function postTwiml(app: FastifyInstance, extraHeaders: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/twiml",
    headers: {
      host: HOST,
      "content-type": "application/x-www-form-urlencoded",
      ...extraHeaders,
    },
    payload: FORM,
  });
}

describe("POST /twiml", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = configSchema.parse({
      publicBaseUrl: `https://${HOST}`,
      twilio: { authToken: AUTH_TOKEN },
    });
    app = makeApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("responds 200 text/xml with <Connect><Stream> TwiML for a valid signature", async () => {
    const signature = computeTwilioSignature(AUTH_TOKEN, FULL_URL, PARAMS);
    const res = await postTwiml(app, { "x-twilio-signature": signature });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain(`<Stream url="ws://${HOST}/media/twilio">`);
    expect(res.body).toContain(`<Parameter name="Caller" value="${PARAMS.From}"/>`);
    expect(res.body).toContain(`<Parameter name="Callee" value="${PARAMS.To}"/>`);
  });

  it("responds 403 when the signature does not match", async () => {
    const res = await postTwiml(app, { "x-twilio-signature": "garbage==" });
    expect(res.statusCode).toBe(403);
  });

  it("responds 403 when the signature is missing", async () => {
    const res = await postTwiml(app);
    expect(res.statusCode).toBe(403);
  });

  it("responds 403 when the signature was computed for a different URL", async () => {
    const signature = computeTwilioSignature(AUTH_TOKEN, `https://attacker.example/twiml`, PARAMS);
    const res = await postTwiml(app, { "x-twilio-signature": signature });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /twiml (auth token not configured)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = configSchema.parse({ publicBaseUrl: `https://${HOST}` });
    app = makeApp(config);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("fails closed with 503 and an explanatory XML comment", async () => {
    const signature = computeTwilioSignature("anything", FULL_URL, PARAMS);
    const res = await postTwiml(app, { "x-twilio-signature": signature });

    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<!--");
    expect(res.body).toContain("TWILIO_AUTH_TOKEN");
  });
});
