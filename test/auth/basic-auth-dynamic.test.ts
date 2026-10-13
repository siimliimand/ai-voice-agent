import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  basicAuthScope,
  registerBasicAuth,
  type AdminCredentialsResolver,
} from "../../src/auth/basic-auth.js";
import { configSchema, type AppConfig } from "../../src/config/schema.js";

const authHeader = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

function buildDynamicApp(resolver: AdminCredentialsResolver): FastifyInstance {
  const app = Fastify({ logger: false });
  registerBasicAuth(app, { getAdminCredentials: resolver });
  basicAuthScope(app, "/api", (api) => {
    api.get("/ping", async () => ({ ok: true }));
  });
  return app;
}

const ping = async (
  app: FastifyInstance,
  user: string,
  password: string,
): Promise<{ status: number; wwwAuthenticate: string | undefined }> => {
  const res = await app.inject({
    method: "GET",
    url: "/api/ping",
    headers: { authorization: authHeader(user, password) },
  });
  return { status: res.statusCode, wwwAuthenticate: res.headers["www-authenticate"] as string };
};

describe("registerBasicAuth with dynamic credentials", () => {
  it("accepts credentials from the resolver and rejects stale ones (live-apply)", async () => {
    let creds: { user: string; password: string | undefined } = {
      user: "admin",
      password: "new-pass",
    };
    const app = buildDynamicApp(async () => creds);
    await app.ready();
    try {
      expect((await ping(app, "admin", "new-pass")).status).toBe(200);
      expect((await ping(app, "admin", "old-pass")).status).toBe(401);

      // Credentials rotate between requests — the change applies immediately.
      creds = { user: "admin", password: "rotated" };
      expect((await ping(app, "admin", "new-pass")).status).toBe(401);
      expect((await ping(app, "admin", "rotated")).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("honors user overrides from the resolver", async () => {
    const app = buildDynamicApp(async () => ({ user: "ops", password: "pw" }));
    await app.ready();
    try {
      expect((await ping(app, "ops", "pw")).status).toBe(200);
      expect((await ping(app, "admin", "pw")).status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the resolver yields no password", async () => {
    const app = buildDynamicApp(async () => ({ user: "admin", password: undefined }));
    await app.ready();
    try {
      const res = await ping(app, "admin", "anything");
      expect(res.status).toBe(401);
      expect(res.wwwAuthenticate).toBe('Basic realm="admin"');
    } finally {
      await app.close();
    }
  });

  it("fails closed when the resolver throws", async () => {
    const app = buildDynamicApp(async () => {
      throw new Error("settings unavailable");
    });
    await app.ready();
    try {
      expect((await ping(app, "admin", "pw")).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("registerBasicAuth static signature (backward compat)", () => {
  it("still accepts a plain AppConfig", async () => {
    const config: AppConfig = configSchema.parse({
      admin: { user: "admin", password: "s3cret" },
    });
    const app = Fastify({ logger: false });
    registerBasicAuth(app, config);
    basicAuthScope(app, "/api", (api) => {
      api.get("/ping", async () => ({ ok: true }));
    });
    await app.ready();
    try {
      expect((await ping(app, "admin", "s3cret")).status).toBe(200);
      expect((await ping(app, "admin", "wrong")).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
