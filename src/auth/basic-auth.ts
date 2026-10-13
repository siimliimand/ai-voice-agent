import { createHash, timingSafeEqual } from "node:crypto";
import basicAuth from "@fastify/basic-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config/schema.js";

/** Realm advertised in the WWW-Authenticate challenge. */
export const ADMIN_REALM = "admin";

/**
 * Resolves the admin credentials at request time instead of startup. Used
 * for live-apply: buildApp supplies a closure that reads the admin config
 * from the effective (settings-overridden) config.
 */
export type AdminCredentialsResolver = () => Promise<{
  user: string;
  password: string | undefined;
}>;

/** Alternative second argument to registerBasicAuth for dynamic credentials. */
export interface DynamicAdminAuth {
  getAdminCredentials: AdminCredentialsResolver;
}

function isAdminResolver(value: AppConfig | DynamicAdminAuth): value is DynamicAdminAuth {
  return typeof value === "object" && value !== null && "getAdminCredentials" in value;
}

/**
 * Register @fastify/basic-auth on the app. Credentials come either from a
 * static AppConfig (config.admin.user / config.admin.password — environment
 * in production) or, for live-apply, from a getAdminCredentials resolver
 * evaluated per authentication attempt.
 *
 * The plugin only installs a `basicAuth` hook decorator; scopes opt in via
 * basicAuthScope(), so unrelated routes (e.g. /health) stay public. Call this
 * before registering the admin API/pages on the same app.
 */
export function registerBasicAuth(
  app: FastifyInstance,
  config: AppConfig | DynamicAdminAuth,
): void {
  if (isAdminResolver(config)) {
    void app.register(basicAuth, {
      validate: makeDynamicValidate(config.getAdminCredentials),
      authenticate: { realm: ADMIN_REALM },
      utf8: false,
    });
    return;
  }
  if (!config.admin.password) {
    app.log.warn("ADMIN_PASSWORD not set — admin console locked");
  }
  void app.register(basicAuth, {
    validate: makeValidate(config),
    authenticate: { realm: ADMIN_REALM },
    utf8: false,
  });
}

/**
 * Register `setup` inside an encapsulated scope at `prefix` where every route
 * requires basic auth (401 + `WWW-Authenticate: Basic realm="admin"` otherwise).
 *
 * Fails closed: if the basic-auth plugin is not registered on the app, the
 * scope still answers 401 instead of exposing the routes.
 */
export function basicAuthScope(
  app: FastifyInstance,
  prefix: string,
  setup: (scope: FastifyInstance) => void,
): void {
  void app.register(
    async (scope) => {
      const guard = scope.basicAuth as
        | ((req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void)
        | undefined;
      scope.addHook("onRequest", (req, reply, done) => {
        if (!guard) {
          reply.header("www-authenticate", `Basic realm="${ADMIN_REALM}"`).code(401);
          done(new Error("Admin authentication is not configured"));
          return;
        }
        guard(req, reply, done);
      });
      setup(scope);
    },
    { prefix },
  );
}

function makeValidate(config: AppConfig): (username: string, password: string) => Promise<void> {
  const expectedUser = config.admin.user;
  const expectedPassword = config.admin.password;
  return async (username, password) => {
    // Fail closed: with no configured password nothing ever authenticates,
    // even if the client sends well-formed credentials.
    if (!expectedPassword) throw unauthorized("Admin console is locked (ADMIN_PASSWORD not set)");
    assertCredentials(username, password, expectedUser, expectedPassword);
  };
}

/**
 * Per-request credential check against dynamically resolved values. Same
 * fail-closed rule: when the resolver yields no password (or fails), every
 * request is rejected.
 */
function makeDynamicValidate(
  resolve: AdminCredentialsResolver,
): (username: string, password: string) => Promise<void> {
  return async (username, password) => {
    let expectedUser: string;
    let expectedPassword: string | undefined;
    try {
      ({ user: expectedUser, password: expectedPassword } = await resolve());
    } catch {
      throw unauthorized("Admin credentials are unavailable");
    }
    if (!expectedPassword) {
      throw unauthorized("Admin console is locked (no admin password configured)");
    }
    assertCredentials(username, password, expectedUser, expectedPassword);
  };
}

function assertCredentials(
  username: string,
  password: string,
  expectedUser: string,
  expectedPassword: string,
): void {
  if (
    !constantTimeEqual(username, expectedUser) ||
    !constantTimeEqual(password, expectedPassword)
  ) {
    throw unauthorized("Invalid admin credentials");
  }
}

/** 401 error; @fastify/basic-auth stamps the WWW-Authenticate challenge on it. */
function unauthorized(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 401 });
}

/**
 * Constant-time string comparison. Both sides are hashed to a fixed length so
 * timingSafeEqual never throws on unequal lengths and length itself does not
 * leak through early returns.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
